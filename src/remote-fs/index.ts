/**
 * dsh-shell-host `./remote-fs` entry (#137) — the ADDITIVE remote file service
 * (`ctx.remoteFs`) plus the `remote_ls` tool.
 *
 * `ctx.fs` is untouched (ADR-0016 修订 Q14/Q15: additive, never a replacement):
 * the platform backend keeps serving every upstream file tool, so a bug here
 * cannot break a local workspace. What remains is the two-vocabulary risk of
 * decision 9 — inside an anchor the local tools see an empty directory — and
 * the mitigations are the `remote_*` descriptions plus the hint `remote_open`
 * returns.
 *
 * The channel is strictly BEHIND the service (ADR-0016 decision 10): this entry
 * reaches the remote only through `ctx.remote.exec`, and `remote_ls` in turn
 * only through `ctx.remoteFs` (`resolve` + `listDir`). No frame, no command
 * text, and no channel handle ever appears on the tool surface — that is what
 * makes a later swap to an upstream workspace-scoped `ctx.fs` a re-point, not a
 * rewrite.
 *
 * #137提供路径/元数据/目录面；#138提供有界分块字节读与严格UTF-8文本读。
 * #139提供原子writeText/editText与远程专用观察策略；watch仍响亮拒绝。
 *
 * @module dsh-shell-host/remote-fs
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { posix as posixPath } from 'node:path'
import { posixQuote } from '../posix-quote.ts'
import {
  FsError,
  type FsDirEntry,
  type FsInfo,
  type FsTarget,
  type FsTargetKey,
  type FsVersion,
  type FsSandboxPolicy,
  type RemoteFileSystem,
} from './contract.ts'
import {
  isAbsoluteRemotePath,
  normalizeRemotePath,
  type RemoteWorkspaceService,
  type RemoteWorkspaceStatus,
} from '../remote/service.ts'
import { requireAgentFor } from '../tool-support.ts'
import { registerRemoteRead } from './read-tool.ts'
import { createRemoteMutations, REMOTE_STAT_VERSION_FORMAT, assertRemoteMutationPolicy } from './mutations.ts'
import { registerRemoteMutations } from './mutation-tools.ts'
import { RemoteObservations } from './observation.ts'

const name = 'dsh-shell-host-remote-fs'
// `remote` is the workspace service this entry's file face executes through —
// it is a REAL dependency: mounting `./remote-fs` without `./remote` is a
// configuration error, not a per-call surprise (the row then refuses to
// activate instead of serving tools that can only fail).
const inject = ['tools', 'remote']

/** The default `remote_ls` row budget (a directory with 50k entries must not
 * become one tool result). Overflow is REPORTED (`truncated`), never silent. */
export const REMOTE_LS_LIMIT_DEFAULT = 500

/** The `./remote-fs` settings namespace. */
export interface RemoteFsConfig {
  /** Max rows one `remote_ls` returns (the remainder is reported as truncated). */
  listLimit: number
}

const Config = z.object({
  listLimit: z.number().default(REMOTE_LS_LIMIT_DEFAULT),
})

function resolveConfig(raw: unknown): RemoteFsConfig {
  const c = (raw ?? {}) as Partial<RemoteFsConfig>
  const listLimit = c.listLimit ?? REMOTE_LS_LIMIT_DEFAULT
  if (!Number.isInteger(listLimit) || listLimit < 1) {
    throw new Error(`remote-fs: listLimit must be a positive integer, got: ${JSON.stringify(c.listLimit)}`)
  }
  return { listLimit }
}

/** The tool-execution context slice this entry consumes (duck-typed seam). */
interface RemoteFsCtx {
  provide: (name: string, value: unknown) => void
  tools: { register: (tool: unknown) => void }
  get: (name: string) => unknown
  on?: (event: 'dispose', callback: () => void) => unknown
}

/** The `workingDirectory` slice (optional: a tools-only deployment may have none). */
interface WorkingDirectorySlice {
  ensure?: (agent: unknown, signal?: AbortSignal) => Promise<string>
}

/** The opaque key encodes `<host>\0<canonical remote path>`. Workspaces on
 * the same host may overlap: their aliases must still identify the same file. */
const TARGET_KEY_SEPARATOR = '\u0000'

/** Build one target key (opaque to consumers; the encoding is this backend's own). */
function targetKeyFor(host: string, path: string): FsTargetKey {
  return `${host}${TARGET_KEY_SEPARATOR}${path}` as FsTargetKey
}

/** Parse a target key back into (workspace, path). A foreign key is a loud error. */
function targetOf(target: FsTarget): { host: string; path: string } {
  const raw = String(target.targetKey)
  const at = raw.indexOf(TARGET_KEY_SEPARATOR)
  if (at <= 0 || !isAbsoluteRemotePath(raw.slice(at + 1)) || raw.indexOf(TARGET_KEY_SEPARATOR, at + 1) !== -1) {
    throw new FsError(
      `targetKey ${JSON.stringify(raw)} was not issued by the remote backend — a target from another backend cannot be used here`,
      'FS_IO_ERROR',
    )
  }
  return { host: raw.slice(0, at), path: raw.slice(at + 1) }
}

/** Throw the typed abort error when the caller already cancelled. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new FsError('remote file operation aborted', 'FS_ABORTED')
}

/** The first line of a failure's stderr (diagnostics are noisy). */
function firstLine(text: string): string {
  return text.split(/\r?\n/u).find((line) => line.trim() !== '')?.trim() ?? ''
}

/** Map a non-zero remote exit into the contract's coded error vocabulary. */
function failureFor(what: string, path: string, exitCode: number, stderr: string): FsError {
  const detail = firstLine(stderr) || `exit ${String(exitCode)}`
  if (exitCode === 126 || exitCode === 127) return new FsError(`${what} ${path} failed on the remote: ${detail}`, 'FS_IO_ERROR')
  if (/permission denied/iu.test(stderr)) {
    return new FsError(`${what} ${path} failed: ${detail}`, 'FS_PERMISSION_DENIED')
  }
  if (/No such file or directory|Not a directory/u.test(stderr)) {
    return new FsError(`${what} ${path} failed: ${detail}`, 'FS_NOT_FOUND')
  }
  return new FsError(`${what} ${path} failed on the remote: ${detail}`, 'FS_IO_ERROR')
}

/** Strict records: an unterminated field is corruption, never an empty listing. */
function nulFields(buffer: Buffer, width: number): string[] {
  if (buffer.length === 0) return []
  const fields = buffer.toString('utf8').split('\u0000')
  if (fields.pop() !== '' || fields.length % width !== 0) {
    throw new FsError('remote filesystem returned truncated NUL records', 'FS_IO_ERROR')
  }
  return fields
}

/** stat与lstat共享线路字段校验；是否跟随符号链接由调用方命令决定。 */
function fileMetadata(buffer: Buffer, path: string): { version: FsVersion; mode: number; size: number } {
  const fields = nulFields(buffer, 3), [version, modeText, sizeText] = fields
  if (fields.length !== 3 || !version || !/^[0-9a-f]+$/iu.test(modeText!) || !/^\d+$/u.test(sizeText!)) {
    throw new FsError(`stat ${path} returned invalid metadata`, 'FS_IO_ERROR')
  }
  return { version: version as FsVersion, mode: Number.parseInt(modeText!, 16) & 0xf000, size: Number(sizeText) }
}

/** Cancellation settles the caller even if a shared channel cannot cancel a
 * single remote process. The background result is observed, not left rejected. */
function cancellable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener('abort', abort)
      reject(new FsError('remote file operation aborted', 'FS_ABORTED'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { throwIfAborted(signal); return operation() }).then(value => {
      throwIfAborted(signal)
      resolve(value)
    }).catch((error: unknown) => {
      reject(error instanceof FsError ? error : new FsError(
        `remote filesystem request failed: ${error instanceof Error ? error.message : String(error)}`,
        'FS_IO_ERROR', { cause: error },
      ))
    }).finally(() => signal?.removeEventListener('abort', abort))
  })
}

const REMOTE_LOCALE = 'LC_ALL=C; export LC_ALL; '


/**
 * Build the file service over the workspace service.
 *
 * 路径、元数据、目录、读写均经工作区服务进入远端。
 */
export function createRemoteFileSystem(remote: RemoteWorkspaceService): RemoteFileSystem {
  const workspaces = (): RemoteWorkspaceStatus[] => remote.list()
  const workspaceTarget = (target: FsTarget) => {
    const parsed = targetOf(target)
    const candidates = workspaces().filter(workspace => workspace.host === parsed.host)
    const workspace = candidates.find(candidate => candidate.state === 'ready') ?? candidates[0]
    if (!workspace) throw new FsError('target host has no registered workspace', 'FS_IO_ERROR')
    return { ...parsed, workspaceId: workspace.workspaceId }
  }

  /** The single-workspace fallback: a deployment with exactly one workspace
   * does not need the caller to name it (documented on `remote_ls`). */
  const singleWorkspace = (): RemoteWorkspaceStatus | undefined => {
    const all = workspaces()
    return all.length === 1 ? all[0] : undefined
  }

  /**
   * Pick the workspace a call belongs to.
   *
   * Order (each step is a MEASURED fact, never a guess):
   *   1. `cwd` is an ANCHOR (or inside one) ⇒ that workspace — ADR-0016
   *      decision 6 makes the anchor the session's carrier;
   *   2. `cwd` is a remote absolute path inside a workspace root ⇒ that
   *      workspace (stateless, so an internal caller needs no anchor);
   *   3. exactly one workspace is registered ⇒ it;
   *   4. otherwise the call is ambiguous ⇒ `FS_IO_ERROR`, naming the
   *      anchors so the caller can open its session there.
   */
  const workspaceFor = (cwd?: string): RemoteWorkspaceStatus => {
    if (cwd !== undefined && cwd !== '') {
      const byAnchor = remote.workspaceForAnchor(cwd)
      if (byAnchor !== undefined) return byAnchor
      if (isAbsoluteRemotePath(cwd)) {
        const normalized = normalizeRemotePath(cwd)
        const candidates = workspaces()
          .filter((workspace) => normalized === workspace.root || normalized.startsWith(workspace.root === '/' ? '/' : `${workspace.root}/`))
          .sort((a, b) => b.root.length - a.root.length)
        const hit = candidates[0]
        if (hit !== undefined) {
          if (candidates.some(candidate => candidate.host !== hit.host)) {
            throw new FsError('remote cwd matches multiple hosts; select a local workspace anchor', 'FS_IO_ERROR')
          }
          return hit
        }
      }
    }
    const single = singleWorkspace()
    if (single !== undefined) return single
    const all = workspaces()
    throw new FsError(
      all.length === 0
        ? 'no remote workspace is registered — call remote_open first (the file face has nothing to talk to)'
        : `this call does not name a remote workspace: ${String(all.length)} are registered ` +
          `(${all.map((workspace) => `${workspace.workspaceId} → anchor ${workspace.anchor}`).join('; ')}). ` +
          'Open the session inside one of those anchors; an absolute path alone cannot select a host.',
      'FS_IO_ERROR',
    )
  }

  /** The absolute remote path a `resolve` input names. */
  const absolutePathFor = (workspace: RemoteWorkspaceStatus, path: string, cwd?: string): string => {
    if (path === '' || path.trim() === '') {
      throw new FsError('resolve: the path is empty — pass an absolute remote path (or "." for the workspace root)', 'FS_NOT_FOUND')
    }
    if (isAbsoluteRemotePath(path)) return path
    // A Windows-shaped path is not "a relative path on this host" — it is a path
    // for a world this backend does not serve (ADR-0017 decision 6). Joining it
    // onto the root would invent a meaning it does not have.
    if (/^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')) {
      throw new FsError(
        `resolve: ${JSON.stringify(path)} is a Windows-shaped path — the remote workspace speaks absolute POSIX paths only ` +
          '(ADR-0017 decision 6: Windows remotes are out of scope for v1).',
        'FS_IO_ERROR',
      )
    }
    // Relative input resolves against the workspace root: `cwd` semantics are a
    // RESOLUTION DEFAULT upstream (not containment), so the same holds here.
    const anchorWorkspace = cwd === undefined ? undefined : remote.workspaceForAnchor(cwd)
    const base = anchorWorkspace === undefined
      ? (cwd !== undefined && isAbsoluteRemotePath(cwd) ? cwd : workspace.root)
      : posixPath.join(workspace.root, cwd!.slice(anchorWorkspace.anchor.length).replaceAll('\\', '/'))
    // 保留..到远端realpath -P阶段；先词法折叠会改变symlink后的物理父目录。
    return `${base.replace(/\/+$/u, '')}/${path}`
  }

  const resolveTarget = async (path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ workspace: RemoteWorkspaceStatus; target: FsTarget }> => {
    throwIfAborted(opts?.signal)
    const workspace = workspaceFor(opts?.cwd)
    if (path.includes('\u0000') || opts?.cwd?.includes('\u0000')) throw new FsError('resolve: NUL in path', 'FS_IO_ERROR')
    const absolute = absolutePathFor(workspace, path, opts?.cwd)
    // realpath -m follows symlinks in the nearest existing parent, retaining
    // missing suffixes. stat first prevents -m from accepting ENOTDIR/EACCES as
    // if it were a missing path. LC_ALL makes errno diagnostics deterministic.
    const script = REMOTE_LOCALE + [
      `p=${posixQuote(absolute)}`,
      `error=$(stat -L -c '' -- "$p" 2>&1 >/dev/null); code=$?`,
      'if [ "$code" -ne 0 ]; then case "$code:$error" in 127:*) printf "%s" "$error" >&2; exit "$code";; *"No such file or directory"*) :;; *) printf "%s" "$error" >&2; exit "$code";; esac; fi',
      'realpath -m -z -- "$p"',
    ].join('; ')
    const result = await cancellable(() => remote.exec(workspace.workspaceId, script), opts?.signal)
    if (result.exitCode !== 0) throw failureFor('resolve', absolute, result.exitCode, result.stderr.toString())
    const paths = nulFields(result.stdout, 1)
    if (paths.length !== 1 || !isAbsoluteRemotePath(paths[0]!)) throw new FsError('resolve returned an invalid canonical path', 'FS_IO_ERROR')
    return { workspace, target: { targetKey: targetKeyFor(workspace.host, paths[0]!), displayPath: paths[0]! } }
  }

  // 每次请求最多256KiB原始字节（base64后远低于8MiB帧上限）。
  // 不用shell变量承载文件内容；dd直接输出字节，由既有帧循环编码。
  const chunkBytes = 256 * 1024
  const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0
  const fileInfo = async (target: FsTarget, signal?: AbortSignal) => {
    const info = await filesystem.stat(target, signal)
    if (!info) throw new FsError(`read ${target.displayPath}: not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`read ${target.displayPath}: not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (info.size === undefined || !validCount(info.size)) throw new FsError('read: invalid file size', 'FS_IO_ERROR')
    return info as FsInfo & { size: number }
  }
  const checkVersion = async (target: FsTarget, info: FsInfo, signal?: AbortSignal) => {
    if ((await fileInfo(target, signal)).version !== info.version) {
      throw new FsError(`read ${target.displayPath}: file changed during read`, 'FS_STALE_VERSION')
    }
  }
  async function* byteChunks(target: FsTarget, info: FsInfo & { size: number }, offset: number, length: number, signal?: AbortSignal): AsyncIterable<Buffer> {
    const { workspaceId, path } = workspaceTarget(target)
    const end = offset + length
    for (let at = offset; at < end;) {
      throwIfAborted(signal)
      await checkVersion(target, info, signal)
      const count = Math.min(chunkBytes, end - at)
      const result = await cancellable(() => remote.exec(workspaceId,
        REMOTE_LOCALE + `dd if=${posixQuote(path)} iflag=skip_bytes,count_bytes skip=${String(at)} count=${String(count)} bs=${String(chunkBytes)} status=none`,
      ), signal)
      if (result.exitCode !== 0) throw failureFor('read', path, result.exitCode, result.stderr.toString())
      const received = result.stdout.length
      if (received > count || (received < count && at + received < Math.min(info.size, end))) {
        throw new FsError(`read ${path}: truncated or oversized chunk`, 'FS_IO_ERROR')
      }
      await checkVersion(target, info, signal)
      at += received
      if (received > 0) yield result.stdout
      if (received < count) break
    }
    await checkVersion(target, info, signal)
  }
  const filesystem: RemoteFileSystem = {
    async resolve(path, opts) {
      const { target } = await resolveTarget(path, opts)
      return target
    },

    processPath(target) {
      return targetOf(target).path
    },

    processPathFromHostPath() {
      // A LOCAL host path is not a remote path. Upstream's local backend returns
      // its input here; this backend has no local host path to map, and
      // returning a plausible-looking path would be a lie.
      return undefined
    },

    fileUrl(target) {
      const { path } = targetOf(target)
      // dsh-fs约定执行世界里的canonical file: URI；路由/主机身份只在opaque key中。
      return `file://${path.split('/').map(encodeURIComponent).join('/')}`
    },

    contains(parent, child) {
      const left = targetOf(parent)
      const right = targetOf(child)
      if (left.host !== right.host) return false
      return right.path === left.path || right.path.startsWith(left.path.endsWith('/') ? left.path : `${left.path}/`)
    },

    async stat(target, signal) {
      throwIfAborted(signal)
      const { workspaceId, path } = workspaceTarget(target)
      // Numeric mode avoids translated %F labels; %y/%z retain nanoseconds,
      // unlike %Y/%Z (two same-size writes in one second must not share a token).
      const result = await cancellable(() => remote.exec(
        workspaceId,
        REMOTE_LOCALE + `stat -L --printf '${REMOTE_STAT_VERSION_FORMAT}\\0%f\\0%s\\0' -- ${posixQuote(path)}`,
      ), signal)
      if (result.exitCode !== 0) {
        const error = failureFor('stat', path, result.exitCode, result.stderr.toString())
        if (error.code === 'FS_NOT_FOUND') return undefined
        throw error
      }
      const { version, mode, size } = fileMetadata(result.stdout, path)
      const type = mode === 0x8000 ? 'file' : mode === 0x4000 ? 'directory' : 'other'
      return { version, type, ...(type === 'file' ? { size } : {}) }
    },

    async lstat(path, opts, signal) {
      throwIfAborted(signal)
      if (path.includes('\u0000') || opts?.cwd?.includes('\u0000')) throw new FsError('lstat: NUL in path', 'FS_IO_ERROR')
      const workspace = workspaceFor(opts?.cwd), absolute = absolutePathFor(workspace, path, opts?.cwd)
      const result = await cancellable(() => remote.exec(workspace.workspaceId,
        REMOTE_LOCALE + `stat --printf '${REMOTE_STAT_VERSION_FORMAT}\\0%f\\0%s\\0' -- ${posixQuote(absolute)}`,
      ), signal)
      if (result.exitCode !== 0) {
        const error = failureFor('lstat', absolute, result.exitCode, result.stderr.toString())
        if (error.code === 'FS_NOT_FOUND') return undefined
        throw error
      }
      const { version, mode, size } = fileMetadata(result.stdout, absolute)
      const type = mode === 0x8000 ? 'file' : mode === 0x4000 ? 'directory' : mode === 0xa000 ? 'symlink' : 'other'
      return { version, type, ...(type === 'file' ? { size } : {}) }
    },

    async readText(target, signal) {
      let text = ''
      for await (const chunk of await filesystem.streamText(target, signal)) text += chunk
      return text
    },

    async streamText(target, signal) {
      const info = await fileInfo(target, signal)
      return (async function* () {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampled = 0
        const decode = (bytes?: Buffer) => {
          try { return decoder.decode(bytes, { stream: bytes !== undefined }) }
          catch (cause) { throw new FsError(`read ${target.displayPath}: invalid UTF-8 text`, 'FS_NOT_TEXT', { cause }) }
        }
        for await (const bytes of byteChunks(target, info, 0, Infinity, signal)) {
          const sampleLength = Math.min(bytes.length, 8192 - sampled)
          if (bytes.subarray(0, sampleLength).includes(0)) throw new FsError(`read ${target.displayPath}: binary file`, 'FS_NOT_TEXT')
          sampled += sampleLength
          const text = decode(bytes)
          if (text !== '') yield text
        }
        const tail = decode()
        if (tail !== '') yield tail
      })()
    },

    async readBytes(target, signal, maxBytes) {
      throwIfAborted(signal)
      if (!validCount(maxBytes)) throw new FsError('readBytes: invalid maxBytes', 'FS_IO_ERROR')
      const info = await fileInfo(target, signal)
      if (info.size > maxBytes) throw new FsError(`read ${target.displayPath}: exceeds ${String(maxBytes)} bytes`, 'FS_TOO_LARGE')
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of byteChunks(target, info, 0, maxBytes + 1, signal)) {
        total += chunk.length
        if (total > maxBytes) throw new FsError(`read ${target.displayPath}: exceeds ${String(maxBytes)} bytes`, 'FS_TOO_LARGE')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    },

    async readByteRange(target, range, signal) {
      throwIfAborted(signal)
      if (!validCount(range.offset) || !validCount(range.length) || !Number.isSafeInteger(range.offset + range.length)) {
        throw new FsError('readByteRange: invalid offset/length', 'FS_IO_ERROR')
      }
      const info = await fileInfo(target, signal), chunks: Buffer[] = []
      for await (const chunk of byteChunks(target, info, range.offset, range.length, signal)) chunks.push(chunk)
      return Buffer.concat(chunks)
    },

    async listDir(target, signal) {
      throwIfAborted(signal)
      const { workspaceId, path, host } = workspaceTarget(target)
      // One round trip decides existence, directory-ness AND lists: the
      // explicit exit codes are what let the client keep `stat`-absent
      // (`undefined`) and `listDir`-absent (`FS_NOT_FOUND`) apart.
      const script = REMOTE_LOCALE + [
        `stat -L -c '' -- ${posixQuote(path)} >/dev/null || exit $?`,
        `if [ ! -d ${posixQuote(path)} ]; then exit 43; fi`,
        // realpath yields the child's identity too (including symlink aliases).
        // Failures are preserved on stderr; never turn permission denial into []
        // or collapse it with absence by using test -e.
        `find -L ${posixQuote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\0%s\\0%f\\0' -exec realpath -m -z -- '{}' \\;`,
      ].join('; ')
      const result = await cancellable(() => remote.exec(workspaceId, script), signal)
      if (result.exitCode === 43) {
        throw new FsError(`listDir ${path}: not a directory`, 'FS_NOT_DIRECTORY')
      }
      if (result.exitCode !== 0) throw failureFor('listDir', path, result.exitCode, result.stderr.toString())
      const fields = nulFields(result.stdout, 4)
      const entries: FsDirEntry[] = []
      for (let index = 0; index < fields.length; index += 4) {
        const kind = fields[index] ?? ''
        const sizeText = fields[index + 1] ?? ''
        const entryName = fields[index + 2] ?? ''
        const canonical = fields[index + 3]!
        if (!entryName || entryName.includes('/') || !isAbsoluteRemotePath(canonical) || !/^\d+$/u.test(sizeText) || !/^[bcdflpsD?]$/u.test(kind)) {
          throw new FsError('listDir returned invalid metadata', 'FS_IO_ERROR')
        }
        const type = kind === 'd' ? 'directory' : kind === 'f' ? 'file' : 'other'
        const absolute = posixPath.join(target.displayPath, entryName)
        const size = Number(sizeText)
        entries.push({
          name: entryName,
          type,
          target: { targetKey: targetKeyFor(host, canonical), displayPath: absolute },
          ...(type === 'file' && Number.isFinite(size) ? { size } : {}),
        })
      }
      // Stable name order (the contract's ordering fact) — sorted here, because
      // the remote `find` order is filesystem-dependent.
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    },

    writeText: (...args) => mutations.writeText(...args),
    editText: (...args) => mutations.editText(...args),

    async watch(target, changed, signal) {
      throwIfAborted(signal)
      void target
      void changed
      // Upstream's own base implementation refuses with this wording; the remote
      // backend does the same until ADR-0016 decision 4's revisit trigger fires.
      throw new FsError('Filesystem watching is not supported by this provider.', 'FS_IO_ERROR')
    },
  }
  const mutations = createRemoteMutations(filesystem, (target, command) => {
    const { workspaceId } = workspaceTarget(target)
    return remote.exec(workspaceId, command)
  }, target => targetOf(target).path)
  return filesystem
}

/** Register the `remote_ls` tool over the file service (the tool's ONLY door). */
function registerRemoteLs(ctx: RemoteFsCtx, fs: RemoteFileSystem, config: RemoteFsConfig): void {
  ctx.tools.register(defineTool({
    name: 'remote_ls',
    description:
      'List a directory in the REMOTE workspace (the workspace root by default). ' +
      'Paths are ABSOLUTE POSIX paths on the remote host (/srv/app); a relative path is refused — omit `path` to list the workspace root. ' +
      'The workspace is picked from the session\'s working directory (the local anchor names it, ADR-0016 decision 6); ' +
      'with no anchor in play and exactly one workspace registered, that one is used. ' +
      'This tool reaches the remote only through ctx.remoteFs — never through the channel directly. ' +
      'The local read / write / edit tools see the anchor as an EMPTY directory on purpose: the files live on the remote (use the remote_* family).',
    parameters: {
      path: { type: 'string', description: 'Remote directory to list — an absolute POSIX path. Omit for the workspace root.' },
      limit: { type: 'number', description: `Max rows to return (default and ceiling resolve to the deployment's listLimit, currently ${String(config.listLimit)}); the remainder is reported as truncated.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string', required: true, description: 'The resolved remote directory (absolute POSIX path).' },
          entries: {
            type: 'array',
            required: true,
            description: 'Entries in stable name order.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string', required: true, description: 'Entry name (basename).' },
                type: { type: 'string', required: true, description: '"file" / "directory" / "other".' },
                path: { type: 'string', required: true, description: 'Absolute remote path of the entry.' },
                size: { type: 'number', description: 'Byte size, files only.' },
              },
            },
          },
          truncated: { type: 'boolean', required: true, description: 'True when more entries existed than the limit returned.' },
          total: { type: 'number', required: true, description: 'How many entries the directory held in total.' },
        },
      },
      render: (_args: unknown, value: { path?: string; entries?: Array<{ name: string; type: string; size?: number }>; truncated?: boolean }) => {
        const rows = value.entries ?? []
        const head = `${value.path ?? '(remote)'} — ${String(rows.length)} entries${value.truncated === true ? ' (truncated)' : ''}`
        const lines = rows.map((row) => `${row.type === 'directory' ? 'd' : row.type === 'file' ? 'f' : '?'} ${row.name}${row.size === undefined ? '' : `  ${String(row.size)}`}`)
        return [{ type: 'text' as const, text: [head, ...lines].join('\n') }]
      },
    },
    async execute(args: { path?: string; limit?: number }, exec: { agent?: unknown; signal?: AbortSignal }) {
      const owner = requireAgentFor('remote', exec)
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
        throw Object.assign(new Error(`remote_ls: limit must be a positive integer, got: ${JSON.stringify(args.limit)}`), { code: 'INVALID_ARGS' })
      }
      const requested = args.path
      if (requested !== undefined && !isAbsoluteRemotePath(requested)) {
        throw Object.assign(
          new Error(
            `remote_ls: ${JSON.stringify(requested)} is not an absolute remote path — the remote workspace uses absolute POSIX paths only ` +
              '(e.g. /srv/app). Omit `path` to list the workspace root.',
          ),
          { code: 'INVALID_ARGS' },
        )
      }
      const cwd = await agentCwd(ctx, owner, exec.signal)
      const target = await fs.resolve(requested ?? '.', {
        ...(cwd === undefined ? {} : { cwd }),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
      const entries = await fs.listDir(target, exec.signal)
      const limit = Math.min(args.limit ?? config.listLimit, config.listLimit)
      return {
        path: target.displayPath,
        entries: entries.slice(0, limit).map((entry) => ({
          name: entry.name,
          type: entry.type,
          path: fs.processPath(entry.target),
          ...(entry.size === undefined ? {} : { size: entry.size }),
        })),
        truncated: entries.length > limit,
        total: entries.length,
      }
    },
    presentCall: (args: { path?: string }) => ({ card: 'generic' as const, title: `remote_ls ${args.path ?? ''}`.trim() }),
  }))
}

/**
 * The owning session's working directory, when the deployment has a
 * `workingDirectory` service. Optional on purpose: a tools-only deployment still
 * gets `remote_ls` (the single-workspace fallback covers it), and a deployment
 * that mounts the service later starts getting anchor-based selection without a
 * remount.
 */
async function agentCwd(ctx: RemoteFsCtx, owner: unknown, signal?: AbortSignal): Promise<string | undefined> {
  const service = ctx.get('workingDirectory') as WorkingDirectorySlice | undefined
  if (service?.ensure === undefined) return undefined
  // If the service exists its failure is authoritative: a broken/aborted cwd
  // lookup must not silently select some other workspace via the fallback.
  return cancellable(() => service.ensure!(owner, signal), signal)
}

/** Plugin entry: provide `ctx.remoteFs` and register `remote_ls`. */
function apply(ctx: RemoteFsCtx, config: unknown): void {
  const remote = ctx.get('remote') as RemoteWorkspaceService | undefined
  if (remote === undefined) {
    throw new Error('remote-fs: the remote workspace service is missing — mount the dsh-shell-host/remote entry alongside ./remote-fs')
  }
  const resolved = resolveConfig(config)
  const fs = createRemoteFileSystem(remote)
  ctx.provide('remoteFs', fs)
  registerRemoteLs(ctx, fs, resolved)
  const observations = new RemoteObservations()
  const cwd = (exec: import('@deepseek-ai/dsh-tools').ToolExecution) => agentCwd(ctx, requireAgentFor('remote', exec), exec.signal)
  registerRemoteRead(ctx, fs, cwd, observations)
  registerRemoteMutations(ctx, fs, cwd, observations, exec => {
    // 既有连接/观察不是永久写授权；每次都取调用方当前session策略。
    const service = ctx.get('sandboxPolicy') as { resolve: (request: { session?: unknown }) => FsSandboxPolicy } | undefined
    if (typeof service?.resolve !== 'function') throw new FsError('remote mutation refused: sandboxPolicy service is missing', 'FS_SANDBOX_DENIED')
    const session = (exec.agent as { session?: unknown } | undefined)?.session
    const policy = service.resolve(session === undefined ? {} : { session })
    if (!policy) throw new FsError('remote mutation refused: sandboxPolicy returned no policy', 'FS_SANDBOX_DENIED')
    assertRemoteMutationPolicy(policy)
  })
  ctx.on?.('dispose', () => observations.clear())
}

export { Config, apply, inject, name }
export type { FsDirEntry, FsInfo, FsTarget, RemoteFileSystem }
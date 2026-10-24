/**
 * dsh-shell-host `./remote` entry (#137) — the remote WORKSPACE: registration,
 * the per-host long-lived channel, eager prewarm, and the three workspace tools.
 *
 *   remote_open({ host, root, anchor?, title?, port?, jump?, options? })
 *       register a workspace (host + remote root + LOCAL ANCHOR DIRECTORY) and
 *       connect; the result names the `remote_*` family and the anchor fact;
 *   remote_list({})      → the registered workspaces + their state;
 *   remote_status({ workspaceId? }) → the full connection facts, including the
 *       ADR-0017 transport shape this channel ACTUALLY opened in.
 *
 * What this entry does NOT do (each has its own home):
 *   - the remote FILE face is `./remote-fs` (`ctx.remoteFs` + `remote_ls`),
 *     which reaches the remote only through `ctx.remote.exec` (ADR-0016
 *     decision 10: the channel and the framing stay behind the service);
 *   - #140 的 openSession / list / closeWorkspace 编排同一PTY核心的独立shell；
 *     文件通道仍是非PTY传输，交互会话由 sessions.ts 启动。
 *   - 原有 ssh_* 工具留在 ./ssh，不导入姐妹入口。
 *
 * Prewarm (AC: "组合装载时预热"): the `workspaces` setting is connected at
 * composition load — `apply` STARTS the connect and never awaits it, so a
 * deployment whose host is unreachable still boots, and the failure is a
 * reading (`state: "unavailable"` + a stable code) instead of a startup error.
 *
 * Permission model (#102, unchanged): `remote_open` starts a LOCAL process
 * (`ssh`) and writes the anchor directory, so it drives the host gate — a
 * `read-only` session cannot open a workspace, and under `workspace-write` the
 * spawn starts inside the session workspace. Reads through an existing channel
 * (`remote_ls`) are NOT gated, for the same reason `pty_tail` is not: a read
 * widens nothing. The write face (#139, `./remote-fs`) re-resolves the calling
 * session policy per write; an existing channel is not permanent write authorization.
 *
 * @module dsh-shell-host/remote
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile, writeFile, realpath, lstat, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve as resolvePath, dirname, basename } from 'node:path'
import { composeSshArgv } from '../ssh/compose.ts'
import {
  REMOTE_WORKSPACE_ERRORS,
  isAbsoluteRemotePath,
  type RemoteWorkspaceDeclaration,
  type RemoteWorkspaceService,
  type RemoteWorkspaceStatus,
  type RemoteSessionKind,
  type RemoteSessionStatus,
} from './service.ts'
import { openRemoteSession, type RemoteSessionCore } from './sessions.ts'
import { REMOTE_CHANNEL_ERRORS, RemoteChannel, remoteError, workspaceTransport, type ChannelOptions, type RemoteResult } from './channel.ts'
import {
  SANDBOX_EXECUTION_SEMANTICS,
  createPermissionGate,
  isInsideWorkspace,
  sandboxPermissionParameters,
  sessionOf,
  type PermissionGate,
} from '../permission-gate.ts'
import { jsonRender, requireAgentFor } from '../tool-support.ts'

const name = 'dsh-shell-host-remote'
// #102: `remote_open` spawns ssh and writes the anchor, so both host permission
// services are REAL dependencies (the gate fails closed without them) — the
// same posture as `./pty` / `./ssh` / `./terminal`.
const inject = ['tools', 'pty', 'sandboxPolicy', 'approval']

/** Idle keepalive period (an idle channel must not look alive while it is dead). */
export const REMOTE_KEEPALIVE_DEFAULT = 30_000
/** Bounded reconnect attempts after an unexpected exit (never unbounded). */
export const REMOTE_RECONNECT_MAX_DEFAULT = 3
/** First reconnect backoff step; step N waits `base * N`. */
export const REMOTE_RECONNECT_BASE_DEFAULT = 1_000
/** One request's budget (the open-time probe uses it too). */
export const REMOTE_REQUEST_TIMEOUT_DEFAULT = 30_000

/** The anchor marker: the anchor is an IDENTITY (host + remote root), never a copy. */
export const ANCHOR_MARKER_FILE = '.dsh-remote-workspace.json'

/** The sentence `remote_open` returns (AC: the result says to use `remote_*`). */
export const REMOTE_WORKSPACE_HINT =
  'This directory is a LOCAL ANCHOR, not a copy: it holds only the marker file, and the files live on the remote host. ' +
  'Use remote_ls / remote_read / remote_write / remote_edit for files, and remote_open_session for an interactive shell (then pty_send / pty_tail / pty_close) — ' +
  'the local read / write / edit tools see the anchor as empty, which is expected (ADR-0016 decision 9).'

/** Runtime configuration — the `./remote` entry's own settings namespace. */
export interface RemoteConfig {
  /** Where anchors are created when a declaration omits `anchor`. Defaults to
   * `<deployment workspaceRoot>/.dsh-remote`. */
  anchorRoot?: string
  keepaliveMs: number
  reconnectMax: number
  reconnectBaseMs: number
  requestTimeoutMs: number
  /** Workspaces connected EAGERLY at composition load (AC: prewarm). */
  workspaces: RemoteWorkspaceDeclaration[]
}

const Config = z.object({
  anchorRoot: z.string(),
  keepaliveMs: z.number().default(REMOTE_KEEPALIVE_DEFAULT),
  reconnectMax: z.number().default(REMOTE_RECONNECT_MAX_DEFAULT),
  reconnectBaseMs: z.number().default(REMOTE_RECONNECT_BASE_DEFAULT),
  requestTimeoutMs: z.number().default(REMOTE_REQUEST_TIMEOUT_DEFAULT),
  workspaces: z.array(z.any()).default([]),
})

function resolveConfig(raw: unknown): RemoteConfig {
  const c = (raw ?? {}) as Partial<RemoteConfig>
  const positive = (key: 'keepaliveMs' | 'reconnectMax' | 'reconnectBaseMs' | 'requestTimeoutMs', value: unknown, fallback: number, allowZero = false): number => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(`remote: ${key} must be a ${allowZero ? 'non-negative' : 'positive'} integer, got: ${JSON.stringify(value)}`)
    }
    return value
  }
  return {
    ...(c.anchorRoot === undefined ? {} : { anchorRoot: c.anchorRoot }),
    keepaliveMs: positive('keepaliveMs', c.keepaliveMs, REMOTE_KEEPALIVE_DEFAULT, true),
    reconnectMax: positive('reconnectMax', c.reconnectMax, REMOTE_RECONNECT_MAX_DEFAULT, true),
    reconnectBaseMs: positive('reconnectBaseMs', c.reconnectBaseMs, REMOTE_RECONNECT_BASE_DEFAULT, true),
    requestTimeoutMs: positive('requestTimeoutMs', c.requestTimeoutMs, REMOTE_REQUEST_TIMEOUT_DEFAULT),
    workspaces: Array.isArray(c.workspaces) ? (c.workspaces as RemoteWorkspaceDeclaration[]) : [],
  }
}

/** The tool-execution context slice the entry consumes (duck-typed seam). */
interface RemoteCtx {
  provide: (name: string, value: unknown) => void
  effect: (fn: () => () => Promise<void>, label: string) => void
  tools: { register: (tool: unknown) => void }
  get: (name: string) => unknown
}

/** The `sandboxPolicy` slice read for the anchor root default. */
interface PolicySlice {
  resolve?: (request?: { session?: unknown }) => { workspaceRoot?: string }
}

/** The anchor marker's content (the anchor's identity, written once). */
interface AnchorMarker {
  connection?: string
  version: 1
  workspaceId: string
  host: string
  root: string
  title?: string
}

/** Deterministic workspace id: readable host slug + a root-derived suffix. */
export function workspaceIdFor(host: string, root: string): string {
  const slug = host.replace(/[^\w.@-]/gu, '_').slice(0, 32)
  const digest = createHash('sha256').update(`${host}\u0000${root}`).digest('hex').slice(0, 8)
  return `${slug}-${digest}`
}

/** Validate one declaration at the seam (loud, before any I/O). */
function normalizeDeclaration(declaration: RemoteWorkspaceDeclaration): RemoteWorkspaceDeclaration {
  if (declaration === null || typeof declaration !== 'object') {
    throw remoteError(REMOTE_WORKSPACE_ERRORS.INVALID_DECLARATION, `remote workspace declaration must be an object, got ${JSON.stringify(declaration)}`)
  }
  const { host, root } = declaration
  if (typeof host !== 'string' || host.trim() === '') {
    throw remoteError(REMOTE_WORKSPACE_ERRORS.INVALID_DECLARATION, 'remote workspace needs a non-empty `host` ([user@]host, an ssh destination)')
  }
  if (typeof root !== 'string' || !root.startsWith('/')) {
    throw remoteError(
      REMOTE_WORKSPACE_ERRORS.INVALID_DECLARATION,
      `remote workspace root must be an ABSOLUTE POSIX path (got ${JSON.stringify(root)}); ` +
        'Windows remotes are out of scope for v1 (ADR-0017 decision 6), so a drive-letter or UNC root is refused rather than half-interpreted.',
    )
  }
  if (host.startsWith('-') || root.includes('\u0000') || !isAbsoluteRemotePath(root)) {
    throw remoteError(REMOTE_WORKSPACE_ERRORS.INVALID_DECLARATION, 'remote host/root has an invalid destination or path shape')
  }
  return { ...declaration, host: host.trim(), root: root.replace(/\/+$/u, '') || '/' }
}

/** The loud "no such workspace" error, shared by `require` and `exec`. */
function unknownWorkspace(workspaceId: string, known: readonly string[]): Error {
  return remoteError(
    REMOTE_WORKSPACE_ERRORS.UNKNOWN_WORKSPACE,
    `remote workspace ${JSON.stringify(workspaceId)} is not registered` +
      (known.length === 0 ? ' (none is — call remote_open first)' : `; registered: ${known.join(', ')}`),
  )
}

/** One registered workspace (the mutable record; the status is derived from it). */
interface WorkspaceRecord {
  workspaceId: string
  declaration: RemoteWorkspaceDeclaration
  anchor: string
  channel: RemoteChannel
  error?: { code: string; message: string }
  /** True once this record took its ref-count slot on the channel. */
  bound: boolean
  closing?: boolean
  sessions: Map<string, { owner: unknown; kind: RemoteSessionKind; cwd: string; connectionId: string; transport: RemoteSessionStatus['transport']; remoteShell?: { uname: string; shell: string } }>
}

/**
 * Build the workspace service. Kept as a factory (not a class) so the entry's
 * `apply` stays a thin seam and the unit lane can boot it over a fake spawner
 * without a service container.
 */
export function createRemoteWorkspaceService(ctx: RemoteCtx, config: RemoteConfig, deps: { spawner?: ChannelOptions['spawner']; sleep?: ChannelOptions['sleep']; platform?: NodeJS.Platform } = {}) {
  const records = new Map<string, WorkspaceRecord>()
  const channels = new Map<string, RemoteChannel>()
  const connections = new Map<string, string>()
  let disposed = false
  const core = ctx.get('pty') as RemoteSessionCore | undefined
  const gate = createPermissionGate(ctx)
  const requireCore = () => {
    if (core === undefined) throw new Error('remote: pty service is missing — mount ./pty for workspace sessions')
    return core
  }
  const usable = (record: WorkspaceRecord) => {
    active()
    if (record.closing) throw remoteError(REMOTE_CHANNEL_ERRORS.CLOSED, `remote workspace ${record.workspaceId} is closing`)
  }
  // 注册与锚点写入共用队列；同一身份不能在 await 后被另一次注册覆盖。
  let operations: Promise<unknown> = Promise.resolve()
  const active = () => {
    if (disposed) throw remoteError(REMOTE_CHANNEL_ERRORS.CLOSED, 'remote workspace service is disposed')
  }
  const fingerprint = (d: RemoteWorkspaceDeclaration) => createHash('sha256')
    .update(JSON.stringify({ port: d.port ?? null, jump: d.jump ?? '', options: d.options ?? [] })).digest('hex')
  const policyRoot = () => (ctx.get('sandboxPolicy') as PolicySlice | undefined)?.resolve?.({})?.workspaceRoot ?? process.cwd()
  const anchorFor = (d: RemoteWorkspaceDeclaration, id: string, cwd?: string) => resolvePath(cwd ?? process.cwd(), d.anchor ?? join(config.anchorRoot ?? join(cwd ?? policyRoot(), '.dsh-remote'), id))
  const conflict = (message: string) => remoteError(REMOTE_WORKSPACE_ERRORS.ANCHOR_CONFLICT, message)
  const coded = (error: unknown) => {
    const e = error as { code?: unknown; message?: unknown }
    return { code: typeof e?.code === 'string' ? e.code : REMOTE_CHANNEL_ERRORS.DEAD, message: typeof e?.message === 'string' ? e.message : String(error) }
  }
  const connectionIdOf = (record: WorkspaceRecord) => `${record.declaration.host}:files:${record.channel.status().pid ?? 'pending'}:${record.channel.status().reconnects}`
  const sessionsOf = (record: WorkspaceRecord, owner?: unknown): RemoteSessionStatus[] => {
    const rows: RemoteSessionStatus[] = []
    for (const [id, session] of record.sessions) {
      if (owner !== undefined && session.owner !== owner) continue
      const live = core?.list(session.owner).find((row) => row.id === id)
      if (live === undefined) continue // pty_close/idle回收后不能编造仍存活的id。
      const { owner: _owner, ...metadata } = session
      rows.push({ ...live, ...metadata, reconnectPolicy: 'manual' })
    }
    return rows
  }
  const statusOf = (record: WorkspaceRecord, owner?: unknown): RemoteWorkspaceStatus => {
    const channel = record.channel.status()
    const state = record.closing || channel.state === 'closed' ? 'unavailable' : channel.state
    const error = channel.lastError ?? (state === 'unavailable' ? record.error : undefined)
    return {
      workspaceId: record.workspaceId, host: record.declaration.host, root: record.declaration.root, anchor: record.anchor,
      ...(record.declaration.title === undefined ? {} : { title: record.declaration.title }),
      state, channel, connectionId: connectionIdOf(record), sessions: sessionsOf(record, owner), ...(error === undefined ? {} : { error }),
    }
  }
  const channelFor = (d: RemoteWorkspaceDeclaration, cwd?: string) => {
    const found = channels.get(d.host)
    if (found !== undefined) return found
    const created = new RemoteChannel({
      host: d.host, requestTimeoutMs: config.requestTimeoutMs, keepaliveMs: config.keepaliveMs,
      reconnectMax: config.reconnectMax, reconnectBaseMs: config.reconnectBaseMs,
      ...deps, ...(cwd === undefined ? {} : { cwd }),
      ssh: { port: d.port, jump: d.jump, options: d.options },
    })
    channels.set(d.host, created)
    return created
  }
  const settle = async (record: WorkspaceRecord) => {
    usable(record)
    try {
      if (record.bound) await record.channel.ensureReady()
      else { record.bound = true; await record.channel.acquire() }
      usable(record)
      record.error = undefined
    } catch (error) { record.error = coded(error); throw error }
  }
  // 不存在的锚点由最近存在祖先的 realpath 派生，避免通过目录链接越过根。
  const canonicalLocal = async (path: string): Promise<string> => {
    let current = resolvePath(path)
    const missing: string[] = []
    for (;;) {
      try { return resolvePath(await realpath(current), ...missing) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = dirname(current)
        if (parent === current) throw error
        missing.unshift(basename(current)); current = parent
      }
    }
  }
  const ensureAnchor = async (path: string, marker: AnchorMarker, boundary?: string): Promise<string> => {
    const anchor = await canonicalLocal(path)
    active()
    if (boundary !== undefined && (!isInsideWorkspace(path, boundary) || !isInsideWorkspace(anchor, await canonicalLocal(boundary)))) {
      throw remoteError('SANDBOX_DENIED', `[sandbox: remote_open anchor ${JSON.stringify(path)} is outside the session workspace]`)
    }
    const markerPath = join(anchor, ANCHOR_MARKER_FILE)
    await mkdir(anchor, { recursive: true })
    active()
    let metadata
    try { metadata = await lstat(markerPath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    active()
    if (metadata?.isSymbolicLink() || (metadata !== undefined && !metadata.isFile())) throw conflict('remote anchor marker must be a regular file, never a symbolic link')
    if (metadata === undefined) {
      if ((await readdir(anchor)).length !== 0) throw conflict('remote anchor without a marker must be an empty directory')
      active()
      try { await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    active()
    const checked = await lstat(markerPath)
    if (!checked.isFile() || checked.isSymbolicLink()) throw conflict('remote anchor marker is not a regular file')
    let parsed: Partial<AnchorMarker>
    try { parsed = JSON.parse(await readFile(markerPath, 'utf8')) as Partial<AnchorMarker> }
    catch { throw conflict(`unreadable marker in remote anchor ${JSON.stringify(anchor)}`) }
    if (parsed.version !== 1 || parsed.workspaceId !== marker.workspaceId || parsed.host !== marker.host || parsed.root !== marker.root || parsed.connection !== marker.connection) {
      throw conflict(`remote anchor ${JSON.stringify(anchor)} already names a different workspace or ssh connection`)
    }
    return anchor
  }
  const register = async (declaration: RemoteWorkspaceDeclaration, options: { spawnCwd?: string; anchorBoundary?: string } = {}) => {
    active()
    const d = normalizeDeclaration(declaration)
    // 提前执行 argv 验证，不能在锚点写完后才发现 host/port/options 非法。
    composeSshArgv({ ...d, tty: false })
    workspaceTransport(deps.platform, d.options)
    const connection = fingerprint(d)
    const existingConnection = connections.get(d.host)
    if (existingConnection !== undefined && existingConnection !== connection) throw remoteError('REMOTE_CONNECTION_CONFLICT', `ssh destination ${d.host} is already registered with different port/jump/options; use a distinct OpenSSH host alias`)
    const id = workspaceIdFor(d.host, d.root)
    const found = records.get(id)
    const anchorPath = found?.anchor ?? anchorFor(d, id, options.spawnCwd)
    const anchor = await ensureAnchor(anchorPath, { version: 1, workspaceId: id, host: d.host, root: d.root, connection, ...(d.title === undefined ? {} : { title: d.title }) }, options.anchorBoundary)
    active()
    // 兼容纯工具组合；完整宿主提供登记簿时，锚点就是普通项目的路径（ADR-0016 决策6）。
    const registry = ctx.get('workspaceRegistry') as { create(path: string, title?: string): Promise<unknown> } | undefined
    if (registry !== undefined) { await registry.create(anchor, d.title); active() }
    if (found !== undefined) return found
    connections.set(d.host, connection)
    const record: WorkspaceRecord = { workspaceId: id, declaration: d, anchor, channel: channelFor(d, options.spawnCwd), bound: false, sessions: new Map() }
    records.set(id, record)
    return record
  }
  const service: RemoteWorkspaceService = {
    open(declaration, options) {
      const registered = operations.then(() => register(declaration, options))
      operations = registered.catch(() => {})
      // 只串行注册/锚点IO；各主机握手并行，坏主机不能阻塞其他预热。
      return registered.then(async (record) => { await settle(record); return statusOf(record) })
    },
    list: (owner) => [...records.values()].map((record) => statusOf(record, owner)),
    openSession(id, kind, options) {
      const opening = operations.then(async () => {
        active()
        const record = records.get(id)
        if (record === undefined) throw unknownWorkspace(id, [...records.keys()])
        usable(record)
        if (options?.owner === undefined || options.owner === null) throw remoteError('NO_AGENT', 'remote sessions require an owning agent')
        const authorization = await gate.authorizeSpawn({
          toolName: 'remote_open_session', agent: options.owner, session: sessionOf(options.owner),
          callId: options.callId, signal: options.signal, sandboxPermissions: options.sandboxPermissions,
          justification: options.justification, subject: 'command',
        })
        usable(record)
        // master必须先就绪；独立PTY永不借文件通道的POSIX探测当自己的证据。
        await settle(record)
        const transport = record.channel.status().transport
        let expectedConnection: string | undefined
        if (transport.shape === 'control-master') {
          const measured = await record.channel.request('# dsh-connection\nprintf "%s" "${SSH_CONNECTION:-}"')
          const value = measured.stdout.toString()
          if (measured.exitCode !== 0 || !/^\S+ \d+ \S+ \d+$/u.test(value)) {
            throw remoteError('REMOTE_SESSION_CONNECTION_UNPROBED', 'master did not report a usable SSH_CONNECTION; refusing unverified sharing')
          }
          expectedConnection = value
        }
        usable(record)
        const metadata = {
          owner: options.owner, kind, cwd: options.cwd ?? record.declaration.root,
          connectionId: transport.shape === 'control-master' ? connectionIdOf(record) : '', transport,
        }
        try {
          const opened = await openRemoteSession(requireCore(), options.owner, {
            declaration: record.declaration, kind, cwd: options.cwd, env: options.env,
            spawnCwd: authorization.cwd, authorizedMode: authorization.grantedMode,
            signal: options.signal, platform: deps.platform, timeoutMs: config.requestTimeoutMs, expectedConnection,
          })
          const connectionId = opened.transport.shape === 'control-master' ? metadata.connectionId : `${record.declaration.host}:session:${opened.sessionId}`
          record.sessions.set(opened.sessionId, { ...metadata, connectionId, transport: opened.transport, remoteShell: opened.remoteShell })
          if (disposed || record.closing) {
            await requireCore().close(options.owner, opened.sessionId)
            record.sessions.delete(opened.sessionId)
            usable(record)
          }
          return { ...opened, connectionId, sandboxMode: authorization.grantedMode }
        } catch (error) {
          // 探测失败且close也失败时，不能丢掉下次closeWorkspace的重试责任。
          const failedId = (error as { sessionId?: string }).sessionId
          if (failedId !== undefined && !record.sessions.has(failedId)) record.sessions.set(failedId, { ...metadata, connectionId: metadata.connectionId || `${record.declaration.host}:session:${failedId}` })
          throw error
        }
      })
      operations = opening.catch(() => {})
      return opening
    },
    closeWorkspace(id) {
      const closing = operations.then(async () => {
        active()
        const record = records.get(id)
        if (record === undefined) return { closed: false, sessionIds: [] }
        record.closing = true
        const sessionIds = [...record.sessions.keys()]
        const failures: unknown[] = []
        for (const [sessionId, session] of record.sessions) {
          try { await requireCore().close(session.owner, sessionId); record.sessions.delete(sessionId) }
          catch (error) { failures.push(error) }
        }
        if (failures.length > 0) throw new AggregateError(failures, `remote workspace ${id}: session cleanup failed; retry closeWorkspace`)
        if (record.bound) { record.channel.release(); record.bound = false }
        records.delete(id)
        if (![...records.values()].some((r) => r.declaration.host === record.declaration.host)) {
          channels.delete(record.declaration.host); connections.delete(record.declaration.host)
        }
        return { closed: true, sessionIds }
      })
      operations = closing.catch(() => {})
      return closing
    },
    workspace(id) { const record = records.get(id); return record === undefined ? undefined : statusOf(record) },
    require(id, owner) { const record = records.get(id); if (record === undefined) throw unknownWorkspace(id, [...records.keys()]); return statusOf(record, owner) },
    workspaceForAnchor(path) {
      const candidate = resolvePath(path)
      const found = [...records.values()].filter((r) => isInsideWorkspace(candidate, r.anchor)).sort((a, b) => b.anchor.length - a.anchor.length)[0]
      return found === undefined ? undefined : statusOf(found)
    },
    async exec(id, command) {
      active()
      const record = records.get(id)
      if (record === undefined) throw unknownWorkspace(id, [...records.keys()])
      usable(record)
      return record.channel.request(command)
    },
    async dispose() {
      disposed = true
      // 先关活连接，让可能正在探测的注册立刻拒绝，再等待注册队列收口。
      for (const channel of channels.values()) channel.close()
      await operations
      for (const channel of channels.values()) channel.close()
      const failures: unknown[] = []
      for (const record of records.values()) {
        for (const [id, session] of record.sessions) {
          try { await requireCore().close(session.owner, id); record.sessions.delete(id) }
          catch (error) { failures.push(error) }
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'remote: session cleanup failed during dispose')
      records.clear(); channels.clear(); connections.clear()
    },
  }
  return {
    service, channels,
    prewarm() {
      for (const declaration of config.workspaces) void service.open(declaration).catch(() => {})
    },
  }
}

/** The result properties every workspace row carries (both tools share them). */
const WORKSPACE_ROW_PROPERTIES = {
  workspaceId: { type: 'string', required: true, description: 'Stable workspace id (host + remote root) — pass it to remote_status.' },
  host: { type: 'string', required: true, description: 'The ssh destination this workspace runs on.' },
  root: { type: 'string', required: true, description: 'The remote working root (absolute POSIX path).' },
  anchor: { type: 'string', required: true, description: 'The LOCAL anchor directory — its marker names host + remote root.' },
  title: { type: 'string', description: 'Human-facing label, when the declaration carried one.' },
  state: { type: 'string', required: true, description: '"connecting" / "ready" / "unavailable" — the file connection state, never a guess.' },
  connectionId: { type: 'string', required: true, description: 'File connection identity. A shared-master session carries the same identity; independent sessions carry their own.' },
  sessions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: 'Current owner’s PTY rows: id, kind, cwd, status (running/exited), transport, connectionId, remoteShell, reconnectPolicy=manual. Other owners are not exposed.' },
  reconnectScope: { type: 'string', required: true, description: "'shared-master' when interactive sessions ride the file connection's ControlMaster; 'file-connection-only' when each session pays its own connection (e.g. Windows)." },
  sessionReconnectPolicy: { type: 'string', required: true, description: "'manual' — interactive sessions are never auto-reconnected; a dropped session reports exited and a new one must be opened." },
} as const

/**
 * Flatten one workspace status into the TOOL-FACING row.
 *
 * The service's status shape is the RICH one (nested `channel`); the tool face
 * is a flat JSON row. The conversion lives here, once, so `remote_open` /
 * `remote_list` / `remote_status` cannot disagree about what a workspace row
 * carries. Typed loosely (`any`) because the row is exactly what the tool output
 * schema declares — the schema is the contract, not this helper's TS shape.
 */
function statusRow(status: RemoteWorkspaceStatus): any {
  const channel = status.channel
  return {
    workspaceId: status.workspaceId,
    host: status.host,
    root: status.root,
    anchor: status.anchor,
    ...(status.title === undefined ? {} : { title: status.title }),
    state: status.state,
    sessions: status.sessions,
    connectionId: status.connectionId,
    reconnectScope: channel.transport.shape === 'control-master' ? 'shared-master' : 'file-connection-only',
    sessionReconnectPolicy: 'manual',
    transport: { shape: channel.transport.shape, controlMasterUsable: channel.transport.controlMasterUsable },
    users: channel.users,
    reconnects: channel.reconnects,
    pending: channel.pending,
    ...(channel.remoteShell === undefined ? {} : { remoteShell: channel.remoteShell }),
    ...(channel.lastError === undefined ? {} : { lastError: channel.lastError }),
    ...(channel.pid === undefined ? {} : { pid: channel.pid }),
    ...(status.error === undefined ? {} : { error: status.error }),
  }
}

/** Register the three workspace tools over the service. */
function registerRemoteTools(ctx: RemoteCtx, service: RemoteWorkspaceService): void {
  const gate: PermissionGate = createPermissionGate(ctx)

  ctx.tools.register(defineTool({
    name: 'remote_open_session',
    description: 'Open a separate remote POSIX shell for a registered workspace. kind (shell/build/test) labels its purpose; every kind starts its own shell. cwd and env apply ONLY on the remote, never to the local ssh process. Returns a real PTY sessionId for pty_send / pty_tail / pty_close; shares their owner registry and soft cap. A dropped session is exited and never auto-reconnected; open a new one. ' + SANDBOX_EXECUTION_SEMANTICS,
    parameters: {
      workspaceId: { type: 'string', required: true, description: 'Workspace id from remote_open.' },
      kind: { type: 'string', required: true, enum: ['shell', 'build', 'test'], description: 'Purpose label only, not an automatic command.' },
      cwd: { type: 'string', description: 'Absolute remote POSIX path; defaults to workspace root.' },
      env: { type: 'object', additionalProperties: true, description: 'Remote shell environment only (POSIX variable names, string values).' },
      ...sandboxPermissionParameters('command'),
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {
        sessionId: { type: 'string', required: true },
        status: { type: 'object', additionalProperties: true },
        initialOutput: { type: 'string' },
        transport: { type: 'object', additionalProperties: true },
        connectionId: { type: 'string', required: true },
        remoteShell: { type: 'object', additionalProperties: true },
        sandboxMode: { type: 'string', required: true },
      } },
      render: jsonRender as any,
    },
    async execute(args: { workspaceId: string; kind: RemoteSessionKind; cwd?: string; env?: Record<string, string>; sandbox_permissions?: string; justification?: string }, exec: { agent?: unknown; signal?: AbortSignal; callId?: string }) {
      const owner = requireAgentFor('remote', exec)
      const opened = await service.openSession(args.workspaceId, args.kind, {
        owner, cwd: args.cwd, env: args.env, signal: exec.signal, callId: exec.callId,
        sandboxPermissions: args.sandbox_permissions, justification: args.justification,
      })
      return { ...opened, transport: { ...opened.transport } }
    },
    presentCall: (args: { workspaceId: string; kind: string }) => ({ card: 'terminal' as const, title: `remote_open_session ${args.workspaceId} ${args.kind}` }),
  }))
  ctx.tools.register(defineTool({
    name: 'remote_close_workspace',
    description: 'Close a registered remote workspace and reclaim ALL its PTY sessions, including other owners’ sessions. This is workspace-wide cleanup, not pty_close. Waits for queued opens and cleanup, then unregisters the workspace; the local anchor is retained. Other workspaces and unrelated PTYs are untouched. Idempotent when already closed.',
    parameters: { workspaceId: { type: 'string', required: true, description: 'Workspace id to close as a whole.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {
        closed: { type: 'boolean', required: true },
        sessionIds: { type: 'array', required: true, items: { type: 'string' } },
      } }, render: jsonRender as any,
    },
    async execute(args: { workspaceId: string }, exec: { agent?: unknown }) {
      requireAgentFor('remote', exec)
      return service.closeWorkspace(args.workspaceId)
    },
    presentCall: (args: { workspaceId: string }) => ({ card: 'generic' as const, title: `remote_close_workspace ${args.workspaceId}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'remote_open',
    description:
      'Open a REMOTE WORKSPACE: register (host + remote root) and connect over one long-lived ssh channel. ' +
      'Creates a LOCAL ANCHOR directory holding a marker (host + remote root) — the anchor is an identity, never a copy of the remote tree. ' +
      'The connection is owned by the workspace service: tools never open it, and a dead channel reports a stable code instead of stalling. ' +
      'The remote must expose a POSIX login shell plus sh/coreutils (ADR-0017 decision 6); a non-POSIX or sh-less remote is refused loudly, ' +
      'and Windows remotes are out of scope for v1. ' +
      'Calling this again with the same host+root is idempotent (and retries a connection that is not ready). ' +
      SANDBOX_EXECUTION_SEMANTICS,
    parameters: {
      host: { type: 'string', required: true, description: 'ssh destination ([user@]host). Host/user/port/key/jump come from your OpenSSH configuration; this package stores no credential.' },
      root: { type: 'string', required: true, description: 'Remote working root — an ABSOLUTE POSIX path (e.g. /srv/app). A relative path or a Windows path is refused.' },
      title: { type: 'string', description: 'Human-facing label for the workspace (never part of its identity).' },
      anchor: { type: 'string', description: 'Local anchor directory. Omit to derive one under the configured anchorRoot. An existing anchor naming a different host/root is refused.' },
      port: { type: 'number', description: 'ssh port (-p), when the host is not on 22.' },
      jump: { type: 'string', description: 'Jump host (-J), a single argv atom.' },
      options: { type: 'array', description: 'Extra ssh -o options (#50 dual shape: atomic "Key=value" / "Key", or { key, value }). ControlMaster accepts yes/no; Windows refuses yes. ControlMaster=no or ControlPath=none disables sharing. Custom socket paths apply only while sharing is enabled; auto/ask are refused and ControlPersist is fixed to no.' },
      ...sandboxPermissionParameters('command'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...WORKSPACE_ROW_PROPERTIES,
          transport: { type: 'object', additionalProperties: true, description: 'The ADR-0017 transport fact this channel actually opened in: shape ("control-master" on a POSIX client, "per-session-connection" on Windows) + controlMasterUsable.' },
          remoteShell: { type: 'object', additionalProperties: true, description: 'The measured remote login-shell facts ({ uname, shell }) — the ADR-0017 decision 6 probe reading.' },
          error: { type: 'object', additionalProperties: true, description: 'Present when state is unavailable: { code, message } with a stable code.' },
          sandboxMode: { type: 'string', description: 'The sandbox mode this workspace open ran under (the session policy, or the approved one-shot escalation target).' },
          hint: { type: 'string', description: 'The anchor contract: this directory is empty on purpose; use the remote_* tools.' },
        },
      },
      render: jsonRender as any,
    },
    async execute(args: {
      host: string
      root: string
      title?: string
      anchor?: string
      port?: number
      jump?: string
      options?: RemoteWorkspaceDeclaration['options']
      sandbox_permissions?: string
      justification?: string
    }, exec: { agent?: unknown; signal?: AbortSignal; callId?: string }) {
      const owner = requireAgentFor('remote', exec)
      const authorization = await gate.authorizeSpawn({
        toolName: 'remote_open',
        agent: owner,
        session: sessionOf(owner),
        callId: exec.callId,
        signal: exec.signal,
        sandboxPermissions: args.sandbox_permissions,
        justification: args.justification,
        subject: 'command',
      })
      const declaration: RemoteWorkspaceDeclaration = {
        host: args.host,
        root: args.root,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.anchor === undefined ? {} : { anchor: args.anchor }),
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.jump === undefined ? {} : { jump: args.jump }),
        ...(args.options === undefined ? {} : { options: args.options }),
      }
      const status = await service.open(declaration, {
        ...(authorization.cwd === undefined ? {} : { spawnCwd: authorization.cwd }),
        ...(authorization.grantedMode === 'workspace-write' ? { anchorBoundary: authorization.cwd } : {}),
      })
      return {
        ...statusRow(service.require(status.workspaceId, owner)),
        sandboxMode: authorization.grantedMode,
        hint: REMOTE_WORKSPACE_HINT,
      }
    },
    presentCall: (args: { host: string; root: string }) => ({ card: 'generic' as const, title: `remote_open ${args.host}:${args.root}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'remote_list',
    description:
      'List the registered remote workspaces (host + remote root + local anchor + connection state). ' +
      'Order is registration order. An unavailable workspace stays listed until the deployment restarts — its state names the reason.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          workspaces: { type: 'array', required: true, description: 'The registered workspaces, registration order (empty when none).', items: { type: 'object', additionalProperties: true, properties: WORKSPACE_ROW_PROPERTIES } },
        },
      },
      render: (_args: unknown, value: { workspaces?: Array<{ workspaceId: string; host: string; root: string; state: string }> }) => {
        const rows = value.workspaces ?? []
        if (rows.length === 0) return [{ type: 'text' as const, text: '(no remote workspaces)' }]
        return [{ type: 'text' as const, text: rows.map((row) => `${row.workspaceId}  ${row.state}  ${row.host}:${row.root}`).join('\n') }]
      },
    },
    async execute(_args: Record<string, never>, exec: { agent?: unknown }) {
      const owner = requireAgentFor('remote', exec)
      return { workspaces: service.list(owner).map(statusRow) }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'remote_list' }),
  }))

  ctx.tools.register(defineTool({
    name: 'remote_status',
    description:
      'Report the remote workspaces\' CONNECTION state: the state, the ADR-0017 transport shape the channel actually opened in, ' +
      'the measured remote login shell, the ref-count (workspaces bound to that host), the reconnect count, requests in flight, ' +
      'and the last failure with its stable code. Omit workspaceId to report every workspace.',
    parameters: {
      workspaceId: { type: 'string', description: 'One workspace id (from remote_open / remote_list). Omit for all of them.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          workspaces: { type: 'array', required: true, description: 'The reported workspaces.', items: { type: 'object', additionalProperties: true, properties: WORKSPACE_ROW_PROPERTIES } },
        },
      },
      render: jsonRender as any,
    },
    async execute(args: { workspaceId?: string }, exec: { agent?: unknown }) {
      const owner = requireAgentFor('remote', exec)
      const workspaces = args.workspaceId === undefined ? service.list(owner) : [service.require(args.workspaceId, owner)]
      return { workspaces: workspaces.map(statusRow) }
    },
    presentCall: (args: { workspaceId?: string }) => ({ card: 'generic' as const, title: `remote_status ${args.workspaceId ?? '(all)'}` }),
  }))
}

/** Plugin entry: provide `ctx.remote`, register the tools, prewarm the configured workspaces. */
function apply(ctx: RemoteCtx, config: unknown, deps: { spawner?: ChannelOptions['spawner']; sleep?: ChannelOptions['sleep']; platform?: NodeJS.Platform } = {}): void {
  const resolved = resolveConfig(config)
  const built = createRemoteWorkspaceService(ctx, resolved, deps)
  ctx.provide('remote', built.service)
  ctx.effect(() => () => built.service.dispose(), 'dsh-shell-host/remote channel cleanup')
  registerRemoteTools(ctx, built.service)
  built.prewarm()
}

export type { RemoteResult }
export { Config, apply, inject, name }
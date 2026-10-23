/**
 * The `ctx.remoteFs` CONTRACT (#137, ADR-0016 decisions 2/10) — a
 * name-for-name, shape-for-shape mirror of `dsh-fs`'s `ctx.fs`.
 *
 * Why mirror instead of inventing: ADR-0016 decision 10 makes isomorphism a HARD
 * constraint ("we must be able to put their implementation in place of ours with
 * almost no friction — measured in edits, not in intent"). So the types and the
 * method list below are transcribed from the installed DSH `dsh-fs` contract
 * (`@deepseek-ai/dsh-tool-cordis`'s API catalog carries the verbatim
 * declarations; see that package's filesystem service catalog).
 * `remote_ls` is this increment's directory tool; upstream has no standalone
 * `ls` tool to copy. Later read/write tools retain their upstream parameters.
 *
 * Three contract details that are easy to get WRONG by assuming (each is
 * verbatim upstream, not a choice made here):
 *   1. `stat` returns `Promise<FsInfo | undefined>` — a missing target is
 *      `undefined`, it does NOT throw. `listDir` on a missing target DOES throw
 *      `FS_NOT_FOUND`. The asymmetry is the contract.
 *   2. `streamText` returns `Promise<AsyncIterable<string>>` — callers await it
 *      once, then iterate.
 *   3. `watch` resolves to an async CLOSE FUNCTION (`() => Promise<void>`), not
 *      a `{ dispose }` object.
 *
 * #137实现路径/元数据/目录面，#138实现读面：`readText` / `streamText` /
 * `readBytes` / `readByteRange` / `lstat`。写面 `writeText` / `editText` 仍留给
 * #139；watch仍按上游基类边界响亮拒绝。
 * A stub that throws the same vocabulary is honest; a stub that returns empty
 * data is a lie a consumer cannot detect.
 *
 * @module dsh-shell-host/remote-fs/contract
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Preserve the upstream dsh-brand unique-symbol key through an already
 * declared peer's public brand type. This is nominal (no optional __brand),
 * and needs no undeclared direct dependency on the transitive dsh-brand. */
export type Branded<T extends string> = string & {
  readonly [K in Exclude<keyof MessageId, keyof string>]: T
}

/** The opaque identity of one remote file/dir (upstream: `Branded<'FsTargetKey'>`). */
export type FsTargetKey = Branded<'FsTargetKey'>
/** The opaque freshness token (upstream: `Branded<'FsVersion'>`). */
export type FsVersion = Branded<'FsVersion'>

/** What `resolve` returns: the opaque key plus the display path. */
export interface FsTarget {
  targetKey: FsTargetKey
  displayPath: string
}

/** `stat`'s answer — `type` (not `isDirectory`), optional `size`, no mtime. */
export interface FsInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}

/** `lstat`'s answer (it adds `'symlink'`, which is why it is a separate type). */
export interface FsPathInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
}

/** One `listDir` row. `size` appears for files; `version` only when it was read. */
export interface FsDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: FsTarget
  version?: FsVersion
  size?: number
}

/** The literal-edit request (`#139`'s face; declared here so the shape is one). */
export interface FsEditRequest {
  oldString: string
  newString: string
  replaceAll: boolean
}

/** `writeText`'s outcome (it carries `operation`; `editText`'s does not). */
export interface FsWriteOutcome {
  operation: 'create' | 'update'
  version: FsVersion
  before: string | null
  after: string
}

/** `editText`'s outcome. */
export interface FsEditOutcome {
  version: FsVersion
  before: string
  after: string
}

/** The expected-state guard a write may carry (upstream shape). */
export type FsWriteIntent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }

/** The observation facts the observation-policy events carry (upstream shape). */
export type FsObservation = { readonly kind: 'present'; readonly version: FsVersion } | { readonly kind: 'absent' }

/** Exact upstream fifth argument (mode union + branded sessionId included). */
export type FsSandboxPolicy = SandboxExecutionPolicy

/**
 * The stable `FS_*` vocabulary this backend raises.
 *
 * HONEST PROVENANCE: upstream's `FsErrorCode` union declaration lives in a
 * `.d.ts` that the installed package does not ship, so this list is the set of
 * codes its own code paths demonstrably raise — not a verbatim transcription of
 * the union. No exhaustive-union claim is made.
 */
export type FsErrorCode =
  | 'FS_ABORTED'
  | 'FS_IO_ERROR'
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_NOT_TEXT'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_NOT_OBSERVED'
  | 'FS_STALE_VERSION'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_SANDBOX_DENIED'

/**
 * The typed filesystem error, mirroring upstream's `FsError extends HarnessError`
 * (a `code` property plus `cause` chaining, so a consumer branches on `code`,
 * never on prose).
 */
export class FsError extends HarnessError {
  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/** The options `resolve` accepts (upstream: a resolution default, NOT a
 * containment boundary — containment is `contains(parent, child)`). */
export interface FsResolveOptions {
  cwd?: string
  signal?: AbortSignal
}

/**
 * The remote file service (`ctx.remoteFs`).
 *
 * Method-for-method the `dsh-fs` surface: the same names, the same parameter
 * order (including the quirky `signal` positions) and the same return shapes.
 * An implementation of this interface can be dropped in where `ctx.fs` is
 * expected once DSH supports a workspace-scoped `ctx.fs` (ADR-0016 decision 10).
 */
export interface RemoteFileSystem {
  resolve(path: string, opts?: FsResolveOptions): Promise<FsTarget>
  processPath(target: FsTarget): string
  processPathFromHostPath(hostPath: string): string | undefined
  fileUrl(target: FsTarget): string
  contains(parent: FsTarget, child: FsTarget): boolean
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: FsSandboxPolicy): Promise<FsWriteOutcome>
  editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: FsSandboxPolicy): Promise<FsEditOutcome>
  watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
}
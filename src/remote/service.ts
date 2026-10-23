/**
 * The remote workspace SERVICE contract (#137, ADR-0016 decisions 1/6/8,
 * revised by ADR-0017 decision 5) — the types `./remote` PROVIDES and
 * `./remote-fs` CONSUMES.
 *
 * This module is deliberately not an entry: it carries no `apply`, registers
 * nothing, and is imported by two entries (a type-only import from
 * `./remote-fs` plus the runtime path helpers), so the service surface has ONE
 * spelling while neither entry grows a dependency on the other entry module
 * (the #136 rule: entries never import entries).
 *
 * What the service owns (ADR-0016 decision 8: "connection lifecycle is owned by
 * the workspace service, not the model"):
 *   - the workspace registry (host + remote root + LOCAL ANCHOR DIRECTORY, the
 *     ADR's decision 6 carrier);
 *   - one channel per host, ref-counted (ADR-0017: the ref-count unit is a
 *     CONNECTION);
 *   - eager prewarm at composition load, so the first agent turn never spends
 *     itself connecting;
 *   - `exec(workspaceId, command)` — the ONE way a file face reaches the remote.
 *     `remote_*` tools never touch a channel; only the service does.
 *
 * Path semantics: remote paths are ABSOLUTE POSIX paths (`/srv/app`). The
 * remote workspace is a POSIX-only surface in v1 (ADR-0017 decision 6), so a
 * Windows-shaped path (`C:\x`, `\\host\share`) is not a remote path at all and
 * is refused rather than half-interpreted.
 *
 * @module dsh-shell-host/remote/service
 */

import { posix as posixPath } from 'node:path'
import type { SshOptionInput } from '../ssh/compose.ts'
import type { SshTransport } from '../ssh/transport.ts'
import type { ChannelStatus, RemoteResult } from './channel.ts'

/** The stable codes the WORKSPACE layer reports (channel codes live in `channel.ts`). */
export const REMOTE_WORKSPACE_ERRORS = {
  /** The declaration itself is unusable (relative root, empty host, …). */
  INVALID_DECLARATION: 'REMOTE_INVALID_DECLARATION',
  /** The anchor path already names a DIFFERENT host/root — two identities, one dir. */
  ANCHOR_CONFLICT: 'REMOTE_ANCHOR_CONFLICT',
  /** `remote_status` for an id nobody registered. */
  UNKNOWN_WORKSPACE: 'REMOTE_WORKSPACE_UNKNOWN',
  /** No workspace could be resolved for the call (no anchor matches the session cwd). */
  NO_WORKSPACE: 'REMOTE_NO_WORKSPACE',
  /** A path the remote face cannot interpret (a relative or Windows-shaped one). */
  INVALID_PATH: 'REMOTE_INVALID_PATH',
} as const

/** One workspace declaration: what a human/config row (or `remote_open`) states. */
export interface RemoteWorkspaceDeclaration {
  /** ssh destination (`[user@]host`) — the ADR-0017 connection key. */
  host: string
  /** The remote working root: an ABSOLUTE POSIX directory. */
  root: string
  /** Local anchor directory (ADR-0016 decision 6). Omitted = derived from the
   * configured `anchorRoot` + the workspace id. */
  anchor?: string
  /** Human-facing label; never used for identity. */
  title?: string
  /** ssh port (`-p`), when the host is not on 22. */
  port?: number
  /** Jump host (`-J`). */
  jump?: string
  /** Extra `-o` options (the #50 dual shape, unchanged). */
  options?: SshOptionInput[]
}

/** The workspace's own liveness, as `remote_open` / `remote_status` report it. */
export type RemoteWorkspaceState = 'connecting' | 'ready' | 'unavailable'

/** One workspace, rich enough for `remote_status` (channel internals included). */
export interface RemoteWorkspaceStatus {
  readonly workspaceId: string
  readonly host: string
  readonly root: string
  readonly anchor: string
  readonly title?: string
  readonly state: RemoteWorkspaceState
  /** The channel facts: transport shape (ADR-0017), users, reconnects, last error. */
  readonly channel: ChannelStatus
  /** Set only when the workspace is not ready — the coded reason. */
  readonly error?: { readonly code: string; readonly message: string }
}

/** Is `path` an absolute POSIX path (the only remote path shape v1 accepts)? */
export function isAbsoluteRemotePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//')
}

/**
 * Normalize one remote absolute path (POSIX rules, `.`/`..` collapsed).
 *
 * Normalization is what makes {@link FsTargetKey} identity hold for the file
 * contract's requirement ("the same file under different aliases must yield the
 * same key"): `/srv/./app/../app` and `/srv/app` are one path, so they are one
 * key. Relative input is refused loudly here — callers that legitimately accept
 * a relative path resolve it against the workspace root FIRST (that is a
 * resolution default, exactly as `dsh-fs`'s `resolve(path, { cwd })` treats it).
 */
export function normalizeRemotePath(path: string): string {
  if (!isAbsoluteRemotePath(path)) {
    throw Object.assign(
      new Error(
        `remote path ${JSON.stringify(path)} is not an absolute POSIX path — the remote workspace speaks absolute POSIX paths only ` +
          '(pass something like /srv/app; a Windows-shaped path is never a remote path, per ADR-0017 decision 6).',
      ),
      { code: REMOTE_WORKSPACE_ERRORS.INVALID_PATH },
    )
  }
  const normalized = posixPath.normalize(path)
  // `normalize` keeps a trailing slash; the file contract's identity does not.
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.replace(/\/+$/u, '') : normalized
}

/**
 * The `ctx.remote` service surface (`./remote` provides it, `./remote-fs` and
 * #140's orchestration consume it).
 *
 * Every mutation of the registry goes through {@link open}; every remote I/O
 * goes through {@link exec}. There is deliberately no "connect" method: tools
 * never open connections (ADR-0016 decision 8).
 */
export interface RemoteWorkspaceService {
  /** Register (idempotently) and connect. Connection or remote-contract failure
   * rejects with a stable code and remains recorded on workspace status.
   * Composition prewarm observes that rejection without blocking host startup.
   *
   * `options.spawnCwd` is the cwd the host permission gate allowed for the
   * spawning call (`workspace-write` hands back the session workspace root; the
   * gate's promise is that the process starts inside it) — it is applied to the
   * channel's ssh spawn, first channel creation wins. */
  open(declaration: RemoteWorkspaceDeclaration, options?: { spawnCwd?: string; anchorBoundary?: string }): Promise<RemoteWorkspaceStatus>
  /** Every registered workspace, registration order. */
  list(): RemoteWorkspaceStatus[]
  /** One workspace by id (`undefined` when unknown — `require` is the loud form). */
  workspace(workspaceId: string): RemoteWorkspaceStatus | undefined
  /** One workspace by id, throwing `REMOTE_WORKSPACE_UNKNOWN` when absent. */
  require(workspaceId: string): RemoteWorkspaceStatus
  /** The workspace whose LOCAL ANCHOR contains `anchorPath` (ADR-0016 decision 6:
   * a session's cwd is the anchor, so the anchor is how a call names its
   * workspace). */
  workspaceForAnchor(anchorPath: string): RemoteWorkspaceStatus | undefined
  /** Run one POSIX command on the workspace's channel. The file face's ONLY door. */
  exec(workspaceId: string, command: string): Promise<RemoteResult>
  /** Close every channel (the entry's dispose effect). */
  dispose(): Promise<void>
}
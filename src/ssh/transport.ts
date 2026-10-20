/**
 * The ssh transport-shape interface (ADR-0017 — `docs/adr/0017-per-session-cwd-on-one-ssh-host.md`).
 *
 * This module is the `./ssh` component's INTERFACE carriage of the ADR's three
 * interface-level requirements (#136 brief). It deliberately carries the
 * vocabulary and the client capability fact, not a second transport: the
 * session OPEN path stays byte-for-byte what it was (`ssh -tt`, one independent
 * connection per session), because #136 is a refactor.
 *
 * What the ADR requires, and where each part lives:
 *
 * 1. **Capability probe, cached, never "try a master then fall back"**
 *    ({@link controlMasterUsable}). Measured (ADR-0017 facts 2 and 4): the
 *    Windows client fails at the socket stage (`getsockname failed: Not a
 *    socket`), and even a POSIX-build client ON Windows fails at the fd-passing
 *    stage — so the client PLATFORM decides, not the client binary. A Windows
 *    client therefore defaults to one connection per session and must never log
 *    a failed master attempt on every start.
 * 2. **The remote login shell must be POSIX-family** (decision 6). The check is
 *    a probe at session open (`uname` / `$SHELL`), never a guess from the host
 *    name or port; a non-POSIX remote must be refused loudly, naming why.
 *    Windows remotes are OUT OF SCOPE for v1. The probe's home is the remote
 *    workspace's session-open path (#137) — it needs a live session, so it is
 *    not part of this component-only refactor.
 * 3. **The shape must be observable** (decision 5's accounting unit is a
 *    CONNECTION, not a host). Every shape reported here is a structured fact on
 *    the `ssh_start` result, so `remote_status` (#137–#140) can answer "which
 *    shape did this session run in?" without re-deriving it. Any opt-in
 *    transport that lands later (the P1 WSL-hosted client, P3 tmux) MUST be
 *    named in this enum and reported — an unexposed opt-in is a defect per
 *    ADR-0017's Consequences.
 *
 * @module dsh-shell-host/ssh/transport
 */

/**
 * The transport shapes ADR-0017 defines. Two are v1 (`control-master` on POSIX
 * clients, `per-session-connection` everywhere today); `wsl-hosted` (P1) and
 * `tmux` (P3) are the deferred opt-ins — they are named here so remote_status
 * cannot silently omit them when they land.
 */
export type SshTransportShape = 'control-master' | 'per-session-connection' | 'wsl-hosted' | 'tmux'

/** The transport facts a session can report (ADR-0017 decision 5 / Consequences). */
export interface SshTransport {
  /** The shape this session ACTUALLY opened in — never the merely-possible one. */
  readonly shape: SshTransportShape
  /** Whether this client could multiplex at all ({@link controlMasterUsable}). */
  readonly controlMasterUsable: boolean
}

/**
 * Can this client use OpenSSH connection multiplexing (ControlMaster)?
 *
 * Platform capability, cached by purity: both inputs are process constants and
 * ADR-0017 measured both directions. Windows is `false` — measured, not
 * assumed (`getsockname failed: Not a socket`; a POSIX-build client on Windows
 * fails one stage later, at `SCM_RIGHTS` fd passing). POSIX is `true`.
 */
export function controlMasterUsable(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/**
 * The transport a NEW session opens in today.
 *
 * v1 opens one independent connection per session on EVERY client (ADR-0017
 * decision 3): the per-session-cwd invariant is delivered by giving each
 * logical session its own remote shell, and the connection-sharing
 * optimisation is what is missing on Windows only. The POSIX ControlMaster
 * shape (decision 2) is the remote workspace's opt-in (#137); when it lands it
 * changes this function, and `remote_status` reads the recorded shape rather
 * than guessing.
 */
export function sessionTransport(platform: NodeJS.Platform = process.platform): SshTransport {
  return {
    shape: 'per-session-connection',
    controlMasterUsable: controlMasterUsable(platform),
  }
}

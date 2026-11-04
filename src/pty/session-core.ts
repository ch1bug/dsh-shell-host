/**
 * The self-managed PTY session core (#61, ADR-0010 乙方案): the seam-free
 * rewrite of what used to be a thin tool surface over the harness's
 * owner-scoped `terminals` seam. rc.2 exposes that seam only inside the
 * agent-execution world (ADR-0009 blocked conclusion), so the session
 * lifecycle is owned HERE now: node-pty (Windows ConPTY) spawn, an
 * owner-scoped session registry, per-session line buffer with a read
 * cursor, exclusive-send settle semantics, the #56 soft cap and optional
 * idle timeout — everything the old seam did for us, implemented and
 * tested in this repo.
 *
 * The spawner is injectable (deps.spawnPty): the unit lane drives fakes,
 * the machine lane runs the real node-pty spawn (#51 precedent).
 *
 * Read contract (the seam-era one, restated; #181 revised the tail half):
 * a read's `offset` counts back from the NEWEST retained line (0 = newest);
 * complete lines only (a partial trailing line is held back until its
 * newline arrives); a tail pages FORWARD from the session cursor in
 * `limit`-sized pages — repeated tails drain the buffer with nothing
 * skipped between calls, and `truncated` flags REAL loss only (lines the
 * scrollback cap dropped before the cursor ever reached them).
 *
 * Signal/listing surface (#119): `list(owner)` is the registry's structured
 * view (id + status + pid, stable creation order) and `signal(owner, id,
 * signal)` delivers one whitelisted signal with the platform semantics
 * spelled out in {@link PTY_SIGNAL_SEMANTICS} — POSIX best-effort real
 * delivery, Windows/ConPTY termination only, declared rather than faked.
 * @module dsh-shell-host/pty/session-core
 */

import { spawn as nodePtySpawn } from '@lydell/node-pty'
import { resolveExecutable } from '../detect.ts'
import type { SandboxMode } from '../permission-gate.ts'
import { codedError } from '../coded-error.ts'
import { TerminalSanitizer } from './terminal-sanitizer.ts'
import { hasRepaintMarker, stripRepaintPrefix } from './repaint-suppress.ts'
import { MarkerScanner, buildBashMarkerSetup, defaultRandomPayload, type MarkerToken } from './marker-wrapper.ts'

/** Default concurrent-session soft cap (#56 ruling 3, migrated onto the
 * core: the registry is the single source of truth, so an entry remount
 * can no longer reset the count — the #62 root cause dies here). */
export const DEFAULT_MAX_SESSIONS = 8

/** Default line budget for tail when the caller omits `limit`.
 * #185: renamed from `DEFAULT_TAIL_LINES` with the pagination-vocabulary
 * alignment (the `{offset, limit}` face of `read`/spill) — same value. */
export const DEFAULT_TAIL_LIMIT = 200

/** Output quiescence window for a send/open settle: the write settles once
 * no new bytes arrived for this long. */
const DEFAULT_SETTLE_QUIET_MS = 150
/** Poll period for the settle loop. */
const DEFAULT_SETTLE_TICK_MS = 25
/** Hard ceiling for any settle (a chatty process cannot hang a tool call). */
const DEFAULT_SETTLE_TIMEOUT_MS = 2000
/** #189: how long the initial settle keeps waiting for the FIRST printable
 * output when the open spec opts in (`waitForFirstOutput`). A cold spawn's
 * early bytes can be pure ConPTY control sequences — the sanitizer strips
 * them, so the settle's buffer never moves and the old settle judged "quiet"
 * after one quiet window with nothing ever published; the real banner lands
 * seconds later (measured 1.4–2.2s on a LAN ssh host — round 2 of
 * `.scratch/verify189/probe-chunks.log` arrived at 2248ms, already past the
 * 2s chatty-process ceiling). Once output exists, the normal quiet window
 * and the settle timeout ceiling apply again. */
export const DEFAULT_SETTLE_FIRST_OUTPUT_MS = 5000
/** Idle-watcher tick period: fine-grained enough for second-scale timeouts. */
const DEFAULT_IDLE_TICK_MS = 250
/** Retained scrollback lines per session; older lines are dropped (and a
 * tail that spans the drop reports truncated). */
const DEFAULT_SCROLLBACK_LINES = 10_000
/** Bounded wait for a kill to surface its exit event. */
const CLOSE_EXIT_WAIT_MS = 5000

/** #180 (contract A): the sanitizer's pending-escape budget in bytes — the
 * largest torn control sequence it will carry across chunks before giving up
 * on it. Every session's buffer ingestion runs through the sanitizer, so a
 * hostile stream cannot grow that carry without bound; 64 KiB is generous
 * for any real sequence while keeping the bound firm. The guard spec pins
 * the magnitude, not the value. */
export const DEFAULT_SANITIZER_PENDING_BYTES = 64 * 1024

/** Default hard deadline (#159) for a one-shot exec (autoClose: true): the
 * WHOLE tool call (wall clock) may take this long before the session's own
 * process tree is killed. Guards the waiting-for-stdin / pager class of
 * hangs; continuous output does NOT defer it. 0 = explicitly disabled
 * (only via an explicit pass — the default is finite). */
export const DEFAULT_DEADLINE_MS = 600_000
/** Grace window (#159) between the graceful stop (POSIX SIGTERM to the
 * process group) and the hard kill. Windows/ConPTY has no graceful lever,
 * so the grace does not apply there (kill() IS the tree teardown). */
export const DEFAULT_DEADLINE_GRACE_MS = 2_000

export interface SessionCoreConfig {
  /** #185: renamed from `tailLines` with the pagination-vocabulary alignment
   * (the tail default budget uses the `read`/spill `limit` word now). */
  tailLimit: number
  maxSessions: number
  settleQuietMs: number
  settleTickMs: number
  settleTimeoutMs: number
  /** #189: first-output window for a `waitForFirstOutput` open's initial
   * settle — how long it waits when the session has produced NO printable
   * output yet (see {@link DEFAULT_SETTLE_FIRST_OUTPUT_MS}). */
  settleFirstOutputMs: number
  idleTickMs: number
  scrollbackLines: number
  /** #159: default hard deadline (ms) for one-shot execs when the call does
   * not pass its own `deadlineMs`. 0 = disabled by configuration. */
  deadlineMs: number
  /** #159: grace window (ms) between the graceful stop and the hard kill. */
  deadlineGraceMs: number
}

/** #159: the config face of the deadline default. 0 is a MEANINGFUL value
 * (explicitly disabled), so the positiveInt helper does not apply — only a
 * non-negative integer is honored, anything else falls back to the default
 * (the tool surface's resolveConfig is where a bad user-authored value fails
 * loudly). */
const resolveDeadlineConfig = (value: unknown): number => {
  if (value === undefined) return DEFAULT_DEADLINE_MS
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : DEFAULT_DEADLINE_MS
}

/** Resolve partial config onto the defaults (the config surface is the
 * `./pty` entry's own settings namespace). */
export function resolveCoreConfig(raw: Partial<SessionCoreConfig> | undefined): SessionCoreConfig {
  const c = raw ?? {}
  const positiveInt = (value: unknown, fallback: number): number =>
    Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback
  return {
    tailLimit: positiveInt(c.tailLimit, DEFAULT_TAIL_LIMIT),
    maxSessions: positiveInt(c.maxSessions, DEFAULT_MAX_SESSIONS),
    settleQuietMs: positiveInt(c.settleQuietMs, DEFAULT_SETTLE_QUIET_MS),
    settleTickMs: positiveInt(c.settleTickMs, DEFAULT_SETTLE_TICK_MS),
    settleTimeoutMs: positiveInt(c.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS),
    settleFirstOutputMs: positiveInt(c.settleFirstOutputMs, DEFAULT_SETTLE_FIRST_OUTPUT_MS),
    idleTickMs: positiveInt(c.idleTickMs, DEFAULT_IDLE_TICK_MS),
    scrollbackLines: positiveInt(c.scrollbackLines, DEFAULT_SCROLLBACK_LINES),
    // #159: see resolveDeadlineConfig above — 0 = off is meaningful here.
    deadlineMs: resolveDeadlineConfig(c.deadlineMs),
    deadlineGraceMs: positiveInt(c.deadlineGraceMs, DEFAULT_DEADLINE_GRACE_MS),
  }
}

/**
 * #159 priority chain, resolved ONCE: per-call `deadlineMs` > configured
 * `deadlineMs` > {@link DEFAULT_DEADLINE_MS}. A selected 0 means the deadline
 * is explicitly OFF for that call (the default is finite; turning it off must
 * be explicit, never a silent fallback). Pure + exported so the spec can pin
 * the chain without waiting real time.
 */
export function resolveDeadlineMs(perCall: number | undefined, configured: number | undefined): number {
  if (perCall !== undefined) return perCall
  if (configured !== undefined) return configured
  return DEFAULT_DEADLINE_MS
}

/** The pty process slice the core drives (the @lydell/node-pty IPty
 * surface, narrowed to what the core touches — fakes implement this). */
export interface PtyLike {
  pid?: number
  write(data: string): void
  kill(): void
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown
}

/**
 * Strip undefined fields from a raw open-spec object (#65): the ONE
 * conditional-expansion site — the facade's spec aggregation, the core's
 * spawnPty spec, and the Session construction all derive from here
 * (behavior-identical to the previous per-field spread dance: same keys,
 * same insertion order, undefined simply absent).
 */
export function extractSpec<T extends object>(raw: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

/** The spawn spec: the launch command text plus the additive cwd/env
 * (#53 VS Code profile semantics — process-level injection at birth). */
export interface CoreSpawnSpec {
  command: string
  cwd?: string
  env?: Record<string, string>
}

export interface SessionCoreDeps {
  /** Defaults to the real @lydell/node-pty spawn of the command itself
   * (Windows: argv-tokenized direct spawn; POSIX: `/bin/sh -c`). */
  spawnPty?: (spec: CoreSpawnSpec) => PtyLike
  /** POSIX signal delivery (#119), defaults to the real `process.kill`.
   * Injected so the unit lane can pin the delivered pid/signal without a
   * real process — and so the win32 branch is testable on any host. */
  procKill?: (pid: number, signal: string) => void
  /** Platform guard for the signal semantics (#119), defaults to
   * `process.platform`. Injected for the same reason. */
  platform?: NodeJS.Platform
  /** #186: the per-session sentinel payload generator, defaults to
   * `defaultRandomPayload` (8 random bytes, hex). Injected so the unit lane
   * can pin exact sentinel bytes. The payload is session-private state — it
   * never appears on any tool result. */
  randomPayload?: () => string
}

/** #186 (ADR-0020): the per-session marker state — present exactly when the
 * opening surface declared a marker dialect (`marker: 'bash'`). Owns the
 * scanner, the segment state machine and the filtered-view bookkeeping. */
export interface SessionMarker {
  /** This session's high-entropy payload (the trust boundary: only
   * sentinels carrying exactly it are ever recognized). */
  payload: string
  scanner: MarkerScanner
  /** Whether a trusted OPEN has been seen — before it the filtered view
   * MIRRORS raw (banner/prompt/echo cannot be told apart yet, so nothing is
   * filtered out; the #186 Q2 fallback). From the first trusted open on, the
   * view filters to in-segment lines. */
  segMode: boolean
  /** Whether the stream is currently inside a trusted open..close segment. */
  segOpen: boolean
  /** The pending-buffer length AT the most recent trusted close — the
   * boundary between bytes the command had already produced before the
   * segment closed (an unterminated output tail, e.g. `printf abc` with no
   * trailing newline) and bytes that arrived after the close (the prompt
   * fragment parked in pending). The send-delta pending rule keeps the
   * former and drops only the latter; the review round flagged that the
   * previous whole-tail drop ate the output tail with it (a real data-loss
   * direction that contradicted the documented "never a data loss" face). */
  closePendingLen?: number
  /** Filtered-view accounting: lines the scrollback cap dropped that
   * BELONGED to the filtered view (the `truncated` real-loss base), and the
   * exact filtered line count (the filtered `totalLines`). */
  fDropped: number
  fCount: number
}

interface Session {
  id: string
  /** The owning agent — the registry is keyed owner→id, but the row
   * carries it too so kill/cleanup never needs a reverse scan. */
  owner: unknown
  pty: PtyLike
  /** #180 (contract A): streaming terminal sanitizer owning the RAW chunk
   * face — VT/CSI/OSC noise (banners' escape sequences, ConPTY redraw
   * frames) is stripped here, before line splitting, so the line buffer
   * below holds sanitized printable text only. One instance per session
   * (its escape-carry state is per-stream); EVERY session kind passes
   * through the same single ingestion point (`append`). */
  sanitizer: TerminalSanitizer
  /** Retained complete lines; `lines[0]` sits at absolute index absBase. */
  lines: string[]
  absBase: number
  /** Incomplete trailing line (no newline yet) — never delivered by reads. */
  pending: string
  exited: boolean
  exitCode?: number
  /** #146 one-shot: callbacks waiting for the REAL exit before the open result
   * is built. Notified (and drained) from the onExit tap; an aborted call
   * leaves its callback behind, which the exit then no-ops. */
  exitWaiters: Array<() => void>
  idleTimeoutMs?: number
  /** #159: set when the call's hard deadline fired and the kill sequence ran.
   * The autoClose result then carries `timeout: true` — distinct from an
   * abort (which sets nothing) and from the #56 idle timeout (a session-level
   * reclaim, not a call result marker). */
  deadlineExceeded?: boolean
  /** #162: the output-cut watermark, recorded when the deadline's kill
   * sequence STARTS — the absolute complete-line count and the pending-tail
   * length at that instant. The one-shot result's initialOutput is truncated
   * to it: output arriving after the cut is termination-race residue (the
   * killed shell's last execution window — it is causally downstream of the
   * kill), never the command's own output, and never reaches the result. */
  deadlineOutputCut?: { abs: number; pendingLen: number }
  /** One-shot mode (#64) — semantics have a single source of truth:
   * `AUTO_CLOSE_SEMANTICS` (OpenSpec doc). Reclaim rides the settle
   * window, then the single close path. Default (absent): persistent. */
  autoClose?: boolean
  /** Absolute line count at the last idle-watch observation. */
  idleLastLines: number
  lastActivityAt: number
  /** Shell target flag (#119) — declared by the opening surface, see
   * `OpenSpec.shell`; only `signal()`'s SIGKILL gate reads it. */
  shell?: boolean
  /** #102: the sandbox mode the session was AUTHORIZED under at open — the
   * mode the spawn actually ran at, i.e. the one-shot GRANT when an escalation
   * was approved. `pty_send` re-resolves the policy and refuses a write when the
   * current mode is NARROWER than this — a one-shot grant never outlives its
   * call, so it cannot become a standing write permission. */
  authorizedMode?: SandboxMode
  /** #186 (ADR-0020): present exactly when the opening surface declared a
   * marker dialect. When present, `append` runs the chunk through the
   * sentinel scanner first (the sentinels are stripped before the sanitizer
   * sees them) and maintains the per-line filtered-view flags; when absent
   * the ingestion path is byte-for-byte the pre-#186 one. */
  marker?: SessionMarker
  /** #186: true exactly when the arming setup line FAILED to be written into
   * the session (a dead-at-birth session): the marker never arms, every read
   * stays on the raw face, and the open result reports `markerArmed: false`
   * so the mirror degradation is observable at runtime instead of silently
   * swallowed (the review round's observability point). */
  markerSetupFailed?: boolean
  /** #186: parallel to `lines` (same indices, same splice points) — per-line
   * filtered-view membership. Present exactly for marker sessions (`undefined`
   * = every line is raw-only bookkeeping and the filtered view IS the raw
   * view, computed by the same code paths as before). */
  segFlags?: boolean[]
  /** #186: the raw-view tail cursor for a marker session (the default-view
   * cursor in `cursors` is the FILTERED coordinate there; raw-view evidence
   * readers page independently from this). */
  rawCursor?: number
}

/** Session status shape — the seam's sessionStatus contract, kept. */
export type SessionStatus = { kind: 'running' } | { kind: 'exited'; exitCode?: number; signal?: number }

/**
 * The signals `pty_signal` accepts (#119) — the same five the official
 * `terminal_signal` allows. SINGLE SOURCE (#66 keepalive / AUTO_CLOSE
 * precedent): the tool parameter enum, the core's validation, README and the
 * specs all derive from here, so the accepted list cannot drift between the
 * agent-facing surface and the implementation.
 */
export const PTY_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'] as const

/**
 * The subset Windows/ConPTY can actually act on (#119). node-pty's own API
 * contract says `kill(signal)` is "not supported on Windows" and THROWS, so
 * the only lever there is a plain `kill()` — a TERMINATION. Only these two
 * names are accepted on win32 (and both mean "terminate the session"); the
 * other three are refused loudly rather than silently mapped onto a kill.
 */
export const PTY_WINDOWS_SIGNALS = ['SIGTERM', 'SIGKILL'] as const

/**
 * The platform semantics of `pty_signal`, stated ONCE (#119 AC3; #66
 * precedent): the tool description quotes this constant verbatim and
 * README/GLOSSARY point here, so the agent-facing surface and the docs cannot
 * tell two different stories — and the Windows limitation is declared
 * instead of glossed over ("做不到等价就响亮报缺").
 *
 * Every claim here is checkable: POSIX delivery is our own `process.kill`
 * (group-addressed), the foreground group is unreachable because Node exposes
 * no `tcgetpgrp`, the win32 branch is node-pty's own throw (see the excerpt in
 * `.scratch/t119-pty-kill-fact.log`), and the idle-timeout caveat is the
 * core's own watcher below.
 */
export const PTY_SIGNAL_SEMANTICS =
  'Platform semantics, stated not glossed over: ' +
  'POSIX — the signal is delivered with process.kill to the session\'s process GROUP (negative pid; a forkpty child is a session leader, so its pid is also its group id). ' +
  'That is REAL signal delivery but only BEST EFFORT: the FOREGROUND process group cannot be addressed (Node exposes no tcgetpgrp), so an interactive shell that puts its foreground job in a separate group is not reached — ' +
  'for Ctrl-C prefer pty_send with "\\u0003" (0x03), which the terminal driver delivers to the foreground group. ' +
  'Windows/ConPTY — node-pty cannot deliver POSIX signals at all, so only SIGTERM and SIGKILL are accepted and BOTH mean TERMINATE (the ConPTY process tree is torn down); ' +
  'SIGINT / SIGTSTP / SIGHUP are refused loudly instead of being silently mapped. ' +
  'SIGKILL is refused for shell targets (a session opened by shell_open, or a pty_open session declared with shellCommand) on every platform — on POSIX a hard-killed shell cannot reclaim the children it owns, so use pty_close (the single close path); ' +
  'on Windows every accepted signal is a process-tree teardown anyway, so SIGTERM is the intended way to end a shell session there. ' +
  'Delivering a signal does not ITSELF close the session — read the aftermath with pty_tail, then pty_close (idempotent); an opted-in idleTimeoutMs can still reclaim it later if the signal stops its output.'

/** One row of the `pty_list` surface (#119): id + status, plus the pid when
 * the backend exposes one (command/cwd are #121's display-metadata ticket).
 * A TYPE LITERAL, not an interface: `defineTool`'s output inference maps an
 * open object (`additionalProperties: true`) to `Record<string, JsonValue>`,
 * and only object-literal types carry the implicit index signature that makes
 * them assignable to it (the same reason `SshOption` is a literal type). */
export type SessionSummary = {
  id: string
  status: SessionStatus
  pid?: number
}

/** One `pty_signal` outcome (#119). `delivered` is false only for an
 * already-exited session; `semantics` is present exactly when delivered and
 * names what the platform ACTUALLY did. (Type literal for the reason stated
 * on {@link SessionSummary}.) */
export type SignalResult = {
  id: string
  signal: string
  delivered: boolean
  semantics?: 'signal' | 'terminate'
  status: SessionStatus
}

export interface OpenSpec {
  command: string
  cwd?: string
  env?: Record<string, string>
  /** Opt-in per-session idle timeout (#56): auto-close after this much
   * time with no NEW OUTPUT (output-defined idle; opt-in per session). */
  idleTimeoutMs?: number
  /** One-shot mode (#64) — semantics have a single source of truth:
   * `AUTO_CLOSE_SEMANTICS` below. Default false: persistent, unchanged. */
  autoClose?: boolean
  /**
   * #159: per-call hard deadline (ms) for the WHOLE one-shot exec tool call
   * (wall clock). Priority: this value > the configured `deadlineMs` >
   * {@link DEFAULT_DEADLINE_MS}; 0 = explicitly disabled for this call.
   * Only meaningful on a one-shot (autoClose: true) — a persistent session is
   * governed by #56's opt-in `idleTimeoutMs`, so passing `deadlineMs` on a
   * persistent open is refused loudly rather than silently ignored.
   */
  deadlineMs?: number
  /**
   * Declared by the OPENING SURFACE (#119): the session's top-level process IS
   * a shell — `./terminal`'s shell_open sets it, because that layer is the one
   * that knows it resolved a launcher preset. Gates SIGKILL in `signal()`.
   * The core never guesses shell-ness from command text: a heuristic could not
   * be honest about `pty_open({ command: "bash" })`, so it does not try.
   */
  shell?: boolean
  /**
   * #102: the sandbox mode the opening surface authorized under — the mode the
   * spawn actually ran at (the one-shot grant when `permission-gate` approved an
   * escalation). Stored as session metadata, read back by `modeOf` so every
   * later write can compare the freshly resolved policy against the
   * authorization without caching a boolean "approved" flag.
   */
  authorizedMode?: SandboxMode
  /**
   * #186 (ADR-0020), declared by the OPENING SURFACE: the marker dialect this
   * session should carry — `'bash'` is the only v1 dialect (a top-level bash
   * shell, or an ssh session whose DECLARED remote shell is bash; the opening
   * surfaces decide via `bashMarkerDialect` / `sshBashShellDialect`).
   * Declaration over inference (#119 `shell` precedent). When present, the
   * core generates the per-session payload, writes the ONE bash setup line
   * after the initial settle (PS0 open sentinel + PROMPT_COMMAND close
   * sentinel), and maintains the filtered view; tail/send reads then consume
   * the filtered view by default (`view: 'raw'` names the raw one explicitly).
   * A one-shot exec (autoClose) never carries a marker.
   */
  marker?: 'bash'
  /**
   * #189, declared by the OPENING SURFACE: the initial settle waits for the
   * FIRST printable output before it judges quiescence (bounded by the
   * configured `settleFirstOutputMs`, default 5000ms). A cold spawn's early
   * bytes can be pure ConPTY control sequences — the sanitizer strips them,
   * the settle's buffer never moves — while the real banner/prompt lands
   * seconds later (measured 1.4–2.2s on a LAN ssh host), past the ~150ms
   * quiet window. `ssh_start` sets this (the remote banner is part of its
   * documented start result); without the opt-in the initial settle keeps
   * the pre-#189 face (empty initialOutput on a slow banner, output readable
   * from the tail — #154's documented reading), which is what pty_open /
   * shell_open keep.
   */
  waitForFirstOutput?: boolean
}

/**
 * Single source of truth for the autoClose semantics wording (#66, #49
 * keepalive precedent): the pty_open tool description and its autoClose
 * parameter description both quote this constant verbatim, so the wording
 * cannot drift between the agent-facing surfaces and the core's contract.
 * Doc comments elsewhere reference this constant instead of restating it.
 *
 * #146: "one-shot" is an EXEC contract — the call waits for the real exit, so
 * the result's status can carry the real exit code and the final output. The
 * wording states the waiting (and its abort escape) because both are agent-
 * visible behavior, not implementation detail.
 */
export const AUTO_CLOSE_SEMANTICS =
  'One-shot mode (#64): when true, the call WAITS for the process to actually exit before it returns — ' +
  'the settle window still runs after the exit, so buffered output lands in initialOutput, and the status ' +
  'is then { kind: "exited", exitCode } carrying the REAL exit code (the same shape pty_list / pty_send report). ' +
  'The session is reclaimed through the single close path afterwards — no pty_close needed, the soft-cap slot ' +
  'frees itself. An aborted call stops waiting and returns without the exit code; the process itself is untouched. ' +
  'A declared shell session (shellCommand / the configured defaultShellCommand) is PERSISTENT, not a one-shot: ' +
  'autoClose plus a shell declaration is refused loudly instead of waiting on a process that by design never ends. ' +
  'Default false: persistent, unchanged.'

/**
 * The two explicit-shell spellings, authored ONCE (#146): the agent-facing
 * {@link PTY_COMMAND_SEMANTICS} and the failure-facing {@link SPAWN_FAILURE_HINT}
 * both build on this constant, so "what the description tells you" and "what
 * the failure tells you" cannot name different fixes.
 */
const SHELL_SPELLINGS = 'cmd.exe /d /c "…" or bash -lc "…"'

/**
 * The command-spawn semantics, stated ONCE (#146; the #66/#119 precedent): the
 * pty_open tool description and its `command` parameter description both quote
 * this constant verbatim, and the spec pins them to it — the agent-facing
 * contract cannot drift from what {@link defaultSpawnPty} actually does.
 */
export const PTY_COMMAND_SEMANTICS =
  'Command semantics, stated not glossed over: win32 — the command line is tokenized with the OS argv rules and spawned DIRECTLY ' +
  '(argv[0] is the executable), so &&, pipes, redirection and shell built-ins are NOT interpreted: name the shell explicitly ' +
  '(' + SHELL_SPELLINGS + '). POSIX — the command runs under `/bin/sh -c` (real shell semantics).'

/**
 * The hard-deadline semantics, stated ONCE (#159; the AUTO_CLOSE /
 * PTY_COMMAND_SEMANTICS precedent): the pty_open tool description and its
 * `deadlineMs` parameter description both quote this constant verbatim, so
 * the agent-facing contract cannot drift from what the core enforces.
 */
export const DEADLINE_SEMANTICS =
  'Hard deadline (#159): a one-shot exec (autoClose: true) is bounded by a WALL-CLOCK deadline covering the WHOLE tool call. ' +
  // The default rides the constant — no second copy of the value that a
  // future re-tune could leave drifting in prose.
  `Priority: per-call deadlineMs > the configured deadlineMs (the ./pty settings namespace) > the default ${DEFAULT_DEADLINE_MS}ms (10 minutes); ` +
  'deadlineMs: 0 explicitly disables it for that call — turning the deadline off must be explicit, never a silent fallback. ' +
  'Total call time is the measure: continuous output, log tails or an early return of the settle window neither reset nor defer it — ' +
  'this is NOT the opt-in per-session idleTimeoutMs (output-defined idle, #56), which keeps governing persistent sessions. ' +
  'On expiry the session\'s OWN process tree is killed — POSIX: SIGTERM to the process group, a short grace window, then a hard kill; ' +
  'Windows/ConPTY: the tree termination is the only lever, so it happens immediately — and no other owner\'s session is ever touched. ' +
  'The result then carries timeout: true, the output captured so far, and the real exit code ONLY if the process actually reported one — ' +
  'a deadline kill never fabricates a success code. An aborted call (a different escape) never sets timeout. ' +
  // #162: the output-face ruling — the killed shell has one last execution
  // window before its own exit event, and anything it prints there is residue.
  'A timeout result\'s output is CUT at the moment the kill sequence starts: what the result carries is the command\'s own output up to that instant; ' +
  'output arriving after it (termination-race residue, #162 — e.g. the killed shell running one more command before it dies) is excluded, ' +
  'so the caller can tell real command output from kill residue by construction. ' +
  'Boundary: the deadline covers the TOOL CALL, not individual shell commands inside a persistent session — a PTY is a byte stream ' +
  'with no command-boundary protocol, so per-command timing inside a session is not assumed.'

export interface OpenResult {
  sessionId: string
  pid?: number
  status: SessionStatus
  initialOutput: string
  /** #159: true exactly when the call's hard deadline fired and the session's
   * own process tree was killed. Mutually exclusive by definition with the
   * other wait outcomes: an aborted call sets nothing, and the #56 idle
   * timeout reclaims a session WITHOUT a call result (it is a watcher, not
   * an awaited exec). Absent = the call ended by exit or abort. */
  timeout?: boolean
  /** #186: present exactly on a marker session. TRUE = the arming setup line
   * was written into the shell (the sentinel pipeline is delivered; the
   * filtered view still mirrors raw until the session's first trusted open —
   * the documented fallback). FALSE = the write itself failed (a
   * dead-at-birth session): the marker never arms, every read stays on the
   * raw face, and the mirror degradation is observable instead of silently
   * swallowed. The per-session payload never appears on any result. */
  markerArmed?: boolean
}

export interface SendRequest {
  data: string
  submit?: boolean
  signal?: AbortSignal
}

export interface SendResult {
  delta: string
  status: SessionStatus
}

/** One tail page. #185: the pagination vocabulary is aligned with the
 * `read`/spill window face (`{offset, limit}` + `totalLines` + a truncation
 * flag — the same words, same meanings: `offset` is the 1-based absolute
 * line number of the page's first line — unlike `read`'s offset, which is a
 * relative count back from the newest line; what IS shared with `read` is
 * the kept-when-empty rule, KEPT EVEN WHEN THE PAGE IS EMPTY);
 * `limit` is the page budget in effect;
 * `totalLines` the exact retained-line count; `truncated` flags REAL loss —
 * lines the scrollback cap dropped before the cursor reached them; a
 * backlog larger than `limit` is NOT loss, it just pages — repeat the tail
 * to keep draining). #181 revised the page ANCHOR from "the newest lines"
 * to "forward from the cursor": the previous anchor skipped the undelivered
 * middle of a backlog that exceeded the budget and jumped the cursor past
 * it, making those lines permanently unreachable — the #177 现象一
 * "86KB → 58.6KB then no new output" mechanism, measured hermetically in
 * .scratch/verify181/ (probe-tailskip). The old
 * `{text, lines: number, truncated}` counting shape is RETIRED, not aliased
 * — the rename is declared on the tool schema and in the entry docs (the
 * migration note), never silently kept dual.
 *
 * #186: on a marker session the page is the FILTERED view by default (the
 * core's `view: 'raw'` names the raw coordinate explicitly) — `offset` and
 * `totalLines` are filtered-view counts (out-of-view lines neither page nor
 * count), with the same kept-when-empty and real-loss-only rules. */
export interface TailPage {
  text: string
  offset: number
  limit: number
  totalLines: number
  truncated: boolean
}

export interface SessionCore {
  open(owner: unknown, spec: OpenSpec, signal?: AbortSignal): Promise<OpenResult>
  send(owner: unknown, id: string, request: SendRequest): Promise<SendResult>
  /** #185: the budget argument uses the `read`/spill `limit` word (was
   * `lines`). The tail stays cursor-incremental — no request-side `offset`
   * is added, because the offset vocabulary lives on the RESULT (where the
   * page reports the absolute position it covers), not on the request. */
  tail(owner: unknown, id: string, limit?: number, view?: 'filtered' | 'raw'): TailPage
  close(owner: unknown, id: string): Promise<{ closed: boolean }>
  /** Registry-derived liveness: every session id currently held for the
   * owner (the #62 fix — counting derives from HERE, not from any entry's
   * closure state). */
  active(owner: unknown): string[]
  /** Owner-scoped listing (#119): id + status (+ pid when exposed), stable
   * creation order. The data source is the same registry as `active` — this
   * is its structured view, not a second enumeration. */
  list(owner: unknown): SessionSummary[]
  /** #102: the sandbox mode the session was AUTHORIZED under when it opened —
   * the write baseline `pty_send` compares the freshly resolved policy against.
   * `undefined` for an unknown/foreign id, and for a session a consumer opened
   * through the facade without an authorization (that opener's own gate owns it). */
  modeOf(owner: unknown, id: string): SandboxMode | undefined
  /** Deliver one whitelisted signal to the owner's session (#119). Platform
   * semantics: {@link PTY_SIGNAL_SEMANTICS}. */
  signal(owner: unknown, id: string, signal: string): SignalResult
  /** Awaited dispose: kill every session this core spawned. */
  dispose(): Promise<void>
}

const terr = (code: string, message: string) => codedError(message, code)

/** Windows command-line tokenizer (the Microsoft argv rules cmd.exe itself
 * follows for double quotes): whitespace separates; `"` toggles quoting;
 * backslashes are literal except in the run before a quote. */
export function parseCommandLine(command: string): string[] {
  const argv: string[] = []
  let current = ''
  let hasCurrent = false
  let inQuotes = false
  let backslashes = 0
  for (const ch of command) {
    if (ch === '\\') {
      backslashes += 1
      continue
    }
    if (ch === '"') {
      // 2n backslashes + quote → n backslashes + quote toggle; 2n+1 → n
      // backslashes + a literal quote.
      current += '\\'.repeat(Math.floor(backslashes / 2))
      if (backslashes % 2 === 1) {
        current += '"'
      } else {
        inQuotes = !inQuotes
        hasCurrent = true
      }
      backslashes = 0
      continue
    }
    current += '\\'.repeat(backslashes)
    backslashes = 0
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (hasCurrent || current.length > 0) {
        argv.push(current)
        current = ''
        hasCurrent = false
      }
      continue
    }
    current += ch
    hasCurrent = true
  }
  current += '\\'.repeat(backslashes)
  if (hasCurrent || current.length > 0) argv.push(current)
  return argv
}

/** Test-injection seams for the default spawner: the real node-pty spawn,
 * the executable resolver (#67), and the platform guard. */
export interface DefaultSpawnDeps {
  spawn?: typeof nodePtySpawn
  resolveExecutable?: typeof resolveExecutable
  platform?: NodeJS.Platform
}

/**
 * The reminder every win32 spawn-failure diagnostic ends with (#146). ONE
 * authored copy: the failure specs assert this exact text, and it shares
 * {@link SHELL_SPELLINGS} with {@link PTY_COMMAND_SEMANTICS}, so the fix the
 * failure names is the fix the tool description names. It is phrased as a
 * COMMON CAUSE, not a verdict: the same wrapper also catches access-denied and
 * ConPTY-allocation failures, where the raw message is the real diagnosis.
 */
export const SPAWN_FAILURE_HINT =
  'a common cause: the win32 spawn is DIRECT (no shell interpretation) — shell built-ins (echo, cd, …) and shell syntax ' +
  '(&&, pipes, redirection) need an explicit shell: ' + SHELL_SPELLINGS

/**
 * The PATH/profile hint appended to a win32 spawn-failure diagnostic when the
 * target is a KNOWN INTERPRETER (#163): interpreters run non-interactively do
 * not load profile scripts, so their internal PATH (msys `/usr/bin`, …) is
 * missing and inner commands die with `command not found` (exit 127). One
 * authored copy; the failure specs assert this exact text. It names the three
 * documented workarounds (dev docs, same ticket): the login form, `env` PATH
 * injection, or an absolute path inside the command.
 */
export const PATH_PROFILE_HINT =
  'note: this target is an interpreter — invoked non-interactively it does NOT load its profile, so its own PATH entries ' +
  '(e.g. msys /usr/bin) are missing and inner commands may fail with `command not found` (exit 127). ' +
  'Workarounds: the login form (bash -lc "…"), inject PATH via env, or use absolute paths inside the command.'

/**
 * Whether a resolved win32 program is one of the known interpreters whose
 * non-login invocation has the profile/PATH gap (#163). Deliberately a
 * basename match over the interpreter families the spawn face realistically
 * sees (bash/sh/zsh/fish, pwsh/powershell, wsl, python): this is a predicate,
 * NOT a second argv/prefix table (ADR-0013 single source untouched).
 */
export function isKnownInterpreterExecutable(resolved: string): boolean {
  return /(?:^|[\\/])(?:bash|sh|zsh|fish|pwsh|powershell|wsl|python3?)(?:\.exe)?$/i.test(resolved)
}

/** Wrap a spawn failure into the agent-usable diagnostic (#146 AC3): the
 * program it tried, the path argv[0] was rewritten to, the machine's own words,
 * and the explicit-shell hint. The original error rides along as `cause`. */
function spawnFailed(requested: string, resolved: string, error: unknown): Error {
  const raw = (error instanceof Error ? error.message : String(error)).trim()
  // `File not found: ` ends in a colon with nothing after it — do not leave a
  // dangling separator in the composed sentence.
  const detail = raw.replace(/[:：]\s*$/u, '') || 'File not found'
  const target = resolved === requested
    ? `could not start ${JSON.stringify(requested)}`
    : `could not start ${JSON.stringify(requested)} (resolved to ${JSON.stringify(resolved)})`
  // #163: a known-interpreter target earns one extra PATH/profile line — same
  // error, same code shape; non-interpreters keep the bare #146 diagnostic.
  // (spawnFailed is only reached from the win32 branch; POSIX errors are raw.)
  const interpreterNote = isKnownInterpreterExecutable(resolved) ? `; ${PATH_PROFILE_HINT}` : ''
  return codedError(`pty: ${detail} — ${target}; ${SPAWN_FAILURE_HINT}${interpreterNote}`, 'SPAWN_FAILED', {
    cause: error,
  })
}

/** The default spawner. Windows: the command line is tokenized with the
 * OS argv rules (parseCommandLine above) and spawned DIRECTLY — argv[0] is
 * the executable, so quoted paths with spaces ride the spawn's argv, not
 * shell quoting. Consequence: the command IS the spawned process (#61
 * semantic, ADR-0010) — shell metacharacters and cmd builtins are NOT
 * interpreted; a shell (`cmd.exe /d /c ...`) must be named explicitly. The
 * agent-facing wording has ONE source: {@link PTY_COMMAND_SEMANTICS}.
 * argv[0] is resolved through {@link resolveExecutable} first (#67): ConPTY
 * CreateProcess needs the `.exe` extension on a bare name like `ssh`.
 * A failure is re-raised through {@link spawnFailed} so it names argv[0]
 * instead of the bare `File not found: ` ConPTY produces (#146).
 * POSIX keeps the `/bin/sh -c` wrapper (real shell semantics). */
export function defaultSpawnPty(spec: CoreSpawnSpec, deps: DefaultSpawnDeps = {}): PtyLike {
  const spawn = deps.spawn ?? nodePtySpawn
  const resolve = deps.resolveExecutable ?? resolveExecutable
  const win32 = (deps.platform ?? process.platform) === 'win32'
  if (win32) {
    const argv = parseCommandLine(spec.command)
    if (argv.length === 0) throw new Error('pty: empty command line')
    const program = resolve(argv[0])
    try {
      return spawn(program, argv.slice(1), {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: spec.cwd,
        ...(spec.env === undefined ? {} : { env: { ...(process.env as Record<string, string>), ...spec.env } }),
      })
    } catch (error) {
      throw spawnFailed(argv[0], program, error)
    }
  }
  return spawn('/bin/sh', ['-c', spec.command], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: spec.cwd,
    ...(spec.env === undefined ? {} : { env: { ...(process.env as Record<string, string>), ...spec.env } }),
  })
}

/** Create one self-managed core instance (the `pty` service). */
export function createSessionCore(rawConfig?: Partial<SessionCoreConfig>, deps: SessionCoreDeps = {}): SessionCore {
  const config = resolveCoreConfig(rawConfig)
  const spawnPty = deps.spawnPty ?? defaultSpawnPty
  /** Signal delivery seams (#119): the real platform + process.kill unless a
   * lane injects its own (the unit lane pins both branches hermetically). */
  const platform = deps.platform ?? process.platform
  const procKill = deps.procKill ?? ((pid: number, signal: string): void => { process.kill(pid, signal) })
  /** #186: the sentinel payload generator (the unit lane pins exact bytes). */
  const randomPayload = deps.randomPayload ?? defaultRandomPayload

  /** owner (Agent) -> Map<sessionId, Session>. THE registry — the fact
   * source for the cap, the idle watch, and dispose. */
  const registry = new Map<unknown, Map<string, Session>>()
  let nextId = 1

  const byOwner = (owner: unknown): Map<string, Session> => {
    let byId = registry.get(owner)
    if (!byId) registry.set(owner, (byId = new Map()))
    return byId
  }

  const requireSession = (owner: unknown, id: string): Session => {
    const s = registry.get(owner)?.get(id)
    if (s === undefined) throw terr('NO_SESSION', `no pty session ${JSON.stringify(id)} for this agent`)
    return s
  }

  const statusOf = (s: Session): SessionStatus =>
    s.exited ? { kind: 'exited', ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }) } : { kind: 'running' }

  /** Stable listing order (#119): creation order by the NUMERIC id suffix.
   * Plain lexicographic order would put `pty-10` before `pty-2`, so the same
   * two sessions would swap places at the 10th open — the contract says the
   * order must line up across calls. */
  const idOrder = (a: Session, b: Session): number => {
    const na = Number(a.id.slice(a.id.lastIndexOf('-') + 1))
    const nb = Number(b.id.slice(b.id.lastIndexOf('-') + 1))
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }

  const totalLines = (s: Session): number => s.absBase + s.lines.length

  /** Append one raw output chunk. #186: when the session carries a marker
   * (`s.marker`), the chunk runs through the sentinel scanner FIRST (the
   * scanner peels THIS session's open/close sentinels and reports them as
   * events, in stream order; every other byte — other control sequences
   * included — flows to the sanitizer untouched), and every complete line
   * gets a filtered-view flag taken from the segment state at the moment the
   * line completed. Without a marker the path is byte-for-byte the pre-#186
   * one (the scanner is simply not mounted). Both faces then do the same
   * thing: sanitize (#180 contract A — the single ingestion point; control
   * sequences die here, torn sequences carry in the sanitizer's pending
   * buffer), split complete lines (CR stripped, LF the terminator), hold the
   * partial tail back, enforce the scrollback cap. #177 (现象二): a chunk
   * carrying a full-screen repaint-marker CSI has its leading
   * duplicate-of-buffer-tail lines (the re-printed part of a ConPTY repaint
   * frame) dropped — stateless, that chunk only — and because the dropped
   * lines never reach the buffer, the filtered view never sees them either
   * (the Q2 coexistence: the heuristic guards the shared buffer, the
   * filtered view rides it). Fidelity: chunks without the raw marker signal
   * are never touched, repeated output always survives.
   *
   * The repaint decision scans the scanner's TEXT tokens (the chunk minus
   * our own sentinels) — equivalent to scanning the whole chunk, since an
   * OSC sentinel cannot carry the REPAINT_CSI signatures. */
  const append = (s: Session, chunk: string): void => {
    const m = s.marker
    const tokens: MarkerToken[] = m === undefined
      ? [{ kind: 'text', text: chunk }]
      : m.scanner.push(chunk)
    let repaintChunk = ''
    const fresh: string[] = []
    const freshFlags: boolean[] = []
    for (const token of tokens) {
      if (token.kind === 'open') {
        // A trusted OPEN (payload verified by the scanner). The first one
        // also switches the filtered view out of mirror mode (from here on,
        // out-of-segment lines — echo, banner, prompt — stop entering it).
        m!.segMode = true
        m!.segOpen = true
        continue
      }
      if (token.kind === 'close') {
        // The scanner only emits closes for THIS session's payload, so a
        // trusted open..close pair is structurally guaranteed (the grill
        // ruling: a close is trusted only when paired with this session's
        // open). A close before any open, or a repeated close, is ignored.
        if (m!.segMode) {
          m!.segOpen = false
          // Record the pending boundary AT the close: everything in pending
          // up to here is the command's own (unterminated) output tail;
          // everything after is prompt residue.
          m!.closePendingLen = s.pending.length
        }
        continue
      }
      repaintChunk += token.text
      s.pending += s.sanitizer.push(token.text).text
      let idx: number
      while ((idx = s.pending.indexOf('\n')) >= 0) {
        const line = s.pending.slice(0, idx).replace(/\r$/, '')
        s.pending = s.pending.slice(idx + 1)
        fresh.push(line)
        // The flag is the segment state at line-COMPLETION time. Sentinel
        // events land on line boundaries in practice (PS0 fires after the
        // echoed line's Enter, PROMPT_COMMAND before the next prompt), and a
        // line split across an event takes the newer state. A session
        // without a marker keeps the array parallel but all-true (its flag
        // array is never consulted — every read takes the raw path).
        freshFlags.push(m !== undefined && m.segMode ? m.segOpen : true)
      }
    }
    const repaint = hasRepaintMarker(repaintChunk)
    const kept = repaint ? stripRepaintPrefix(s.lines, fresh) : fresh
    const keptFlags = repaint ? freshFlags.slice(fresh.length - kept.length) : freshFlags
    s.lines.push(...kept)
    if (m !== undefined) {
      s.segFlags!.push(...keptFlags)
      for (const flag of keptFlags) if (flag) m.fCount += 1
    }
    if (s.lines.length > config.scrollbackLines) {
      const drop = s.lines.length - config.scrollbackLines
      if (m !== undefined) {
        for (let i = 0; i < drop; i += 1) {
          if (s.segFlags![i]) {
            m.fDropped += 1
            m.fCount -= 1
          }
        }
        s.segFlags!.splice(0, drop)
      }
      s.lines.splice(0, drop)
      s.absBase += drop
    }
  }

  /** The filtered view's exact ABSOLUTE line count — the same construction
   * as the raw `totalLines` (`absBase + lines.length`, the drop base plus
   * the survivors): the filtered drop base (`fDropped`) plus the in-view
   * survivors (`fCount`). Absolute continuity is what the #185 `offset`
   * semantics need (a scrollback drop moves the base, never renumbers). */
  const filteredTotal = (s: Session): number => s.marker === undefined ? totalLines(s) : s.marker.fDropped + s.marker.fCount

  /** The filtered view's absolute base: the number of in-view lines the
   * scrollback cap has already dropped (the filtered `absBase`). */
  const filteredBase = (s: Session): number => s.marker === undefined ? s.absBase : s.marker.fDropped

  /** Slice `count` in-view lines starting at filtered-ABSOLUTE `start`
   * (0-based in the filtered coordinate, where the surviving flag array
   * begins at `fDropped`) — a linear walk of the flag array; the buffer is
   * scrollback-capped, so this is bounded and cheap. */
  const filteredSlice = (s: Session, start: number, count: number): string[] => {
    const out: string[] = []
    if (count <= 0 || s.marker === undefined) return out
    // Shift the absolute start into the surviving array's local index space:
    // the first surviving in-view line IS global line `fDropped`.
    let seen = s.marker.fDropped
    const flags = s.segFlags!
    for (let i = 0; i < flags.length && out.length < count; i += 1) {
      if (!flags[i]) continue
      if (seen >= start) out.push(s.lines[i])
      seen += 1
    }
    return out
  }

  /** Read the newest `count` complete lines, `offset` lines back from the
   * newest retained line (the seam's read contract, kept verbatim).
   * #186: `view` picks the coordinate — `'filtered'` (the default for every
   * consumer) counts in-view lines only, with `offset`/`totalLines`
   * scoped to the filtered view (the #185 vocabulary, same words, filtered
   * semantics); `'raw'` is the untouched ADR-0019 face. A session without a
   * marker has ONE view: both spellings take the raw path. */
  const readNewest = (s: Session, offset: number, count: number, view: 'filtered' | 'raw' = 'filtered'): { text: string; totalLines: number; truncated: boolean } => {
    if (view === 'raw' || s.marker === undefined) {
      const total = totalLines(s)
      const newestStart = Math.max(s.absBase, total - Math.min(offset, total))
      const end = Math.min(total, newestStart + count)
      const begin = Math.max(newestStart, end - count)
      const slice = s.lines.slice(begin - s.absBase, end - s.absBase)
      return {
        text: slice.length === 0 ? '' : slice.join('\n') + '\n',
        totalLines: total,
        truncated: begin > s.absBase || end < total,
      }
    }
    const m = s.marker!
    const total = m.fDropped + m.fCount
    const base = m.fDropped
    const newestStart = Math.max(base, total - Math.min(offset, total))
    const end = Math.min(total, newestStart + count)
    const begin = Math.max(newestStart, end - count)
    const slice = filteredSlice(s, begin, end - begin)
    return {
      text: slice.length === 0 ? '' : slice.join('\n') + '\n',
      totalLines: total,
      truncated: begin > base || end < total,
    }
  }

  /** #162: the newest `count` complete lines BELOW the deadline output cut,
   * plus the pending tail clamped to its length at the cut — the
   * `timeout: true` result's initialOutput. Everything past the cut is
   * termination-race residue and is excluded (the same read shape as
   * {@link readNewest}: newline-terminated complete lines, then the tail). */
  const readNewestBelowCut = (s: Session, count: number, cut: { abs: number; pendingLen: number }): string => {
    const cutTotal = Math.max(s.absBase, Math.min(totalLines(s), cut.abs))
    const begin = Math.max(s.absBase, cutTotal - count)
    const slice = s.lines.slice(begin - s.absBase, cutTotal - s.absBase)
    const pending = s.pending.slice(0, Math.min(s.pending.length, cut.pendingLen))
    return [...slice.map((l) => l + '\n'), pending].join('')
  }

  /** The settle: wait until the session's byte production goes quiet —
   * the exclusive-send contract's "output read while the write settled".
   * An aborted signal resolves immediately (the write itself is not
   * cancelable; only the wait is). `ignoreExit` (#64 autoClose reclaim):
   * skip the exited short-circuit so the quiet window still runs AFTER the
   * process exit event — buffered output racing the exit gets to land.
   *
   * `waitForFirstOutput` (#189, the open's initial settle only): without
   * printable output the buffer never moves, so the plain quiet rule reads
   * "quiet" after one quiet window even though nothing was ever published —
   * a cold spawn whose early bytes are pure control sequences (sanitized
   * away) gets an empty initialOutput while its real banner lands seconds
   * later. With the opt-in, quiet may only be judged ONCE output exists,
   * and until then the wait is bounded by `settleFirstOutputMs` instead of
   * the chatty-process ceiling; after the first output the plain quiet and
   * timeout rules apply unchanged. WITHOUT the opt-in the behavior is
   * byte-for-byte the pre-#189 one (the #154 face: empty initialOutput on
   * a slow banner, output readable from the tail). */
  const settleFor = (s: Session, signal?: AbortSignal, opts?: { ignoreExit?: boolean; waitForFirstOutput?: boolean }): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const startedAt = Date.now()
      let lastDataAt = startedAt
      let lastChars = -1
      const waitForFirstOutput = opts?.waitForFirstOutput === true
      let sawOutput = false
      const finish = () => {
        clearInterval(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => finish()
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setInterval(() => {
        const chars = s.lines.reduce((n, l) => n + l.length + 1, 0) + s.pending.length
        if (chars !== lastChars) {
          lastChars = chars
          lastDataAt = Date.now()
          // #189: "output" means printable content — the first tick's change
          // from the -1 sentinel is the EMPTY buffer itself (chars 0), not
          // output; a sanitized-away control-sequence frame never moves the
          // buffer past 0 and must not start the quiet clock as "saw output".
          if (chars > 0) sawOutput = true
        }
        const wentQuiet = waitForFirstOutput
          ? sawOutput && Date.now() - lastDataAt >= config.settleQuietMs
          : Date.now() - lastDataAt >= config.settleQuietMs
        const ceiling = waitForFirstOutput && !sawOutput ? config.settleFirstOutputMs : config.settleTimeoutMs
        if ((opts?.ignoreExit !== true && s.exited) || signal?.aborted || wentQuiet || Date.now() - startedAt >= ceiling) {
          finish()
        }
      }, config.settleTickMs)
    })

  /** Wait for the process's REAL exit (#146 one-shot). The onExit tap is the
   * single exit source, so the waiter list settles with the status; an aborted
   * signal stops the WAIT only (the process keeps running and the exit tap
   * still runs the auto-reclaim path). No polling: exit events are pushed. */
  const waitForExit = (s: Session, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (s.exited || signal?.aborted) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      s.exitWaiters.push(finish)
      signal?.addEventListener('abort', finish, { once: true })
    })

  /** Bounded wait for an exit event (#159): poll the session's exited flag
   * for at most `ms`, then move on regardless (the caller decides what an
   * exit-less wait means — the kill paths below never fabricate a code). */
  const boundedExitWait = (s: Session, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const check = setInterval(() => {
        if (s.exited) {
          clearInterval(check)
          resolve()
        }
      }, 25)
      setTimeout(() => {
        clearInterval(check)
        resolve()
      }, ms)
    })

  /** #159: stop the session's OWN process tree after its deadline fired.
   * POSIX — graceful first: SIGTERM to the session's process GROUP (negative
   * pid, the same addressing `signal()` uses), wait the grace window, then a
   * group SIGKILL for a tree that ignored it, then the single close path
   * (pty.kill + bounded exit wait + idempotent reclaim). Windows/ConPTY —
   * kill() IS the tree teardown and there is no graceful lever, so the close
   * path runs immediately. Every lever addresses THIS session's own
   * pid/group; a foreign owner's sessions are unreachable by construction
   * (the registry hands out only the caller's own session objects). */
  const deadlineKill = async (s: Session): Promise<void> => {
    if (s.exited) return
    const pid = s.pty.pid
    if (platform !== 'win32' && pid !== undefined) {
      try {
        procKill(-pid, 'SIGTERM')
      } catch {
        // The tree died between the deadline and the graceful stop.
      }
      await boundedExitWait(s, config.deadlineGraceMs)
      if (s.exited) {
        await killSession(s, 'deadline exceeded (graceful stop)').catch(() => {})
        return
      }
      try {
        procKill(-pid, 'SIGKILL')
      } catch {
        // Same — the hard kill found nothing left to address.
      }
    }
    await killSession(s, 'deadline exceeded').catch(() => {})
  }

  /** Race the one-shot exit against the #159 deadline: resolves true when the
   * deadline fired FIRST, false on a real exit or an aborted call (an abort
   * is a different escape and never produces a timeout marker). The waiter
   * rides the same `exitWaiters` list `waitForExit` uses, so the exit tap's
   * single-source release covers both. */
  const waitForDeadlineOrExit = (s: Session, signal: AbortSignal | undefined, deadlineMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      // A fast exit (or an already-dead process) must win the race outright —
      // the deadline waiter registers after the initial settle, so the exit
      // may already have fired before it ever registers.
      if (s.exited || signal?.aborted) {
        resolve(false)
        return
      }
      let settled = false
      const onExit = () => finish(false)
      const onAbort = () => finish(false)
      const finish = (fired: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const i = s.exitWaiters.indexOf(onExit)
        if (i >= 0) s.exitWaiters.splice(i, 1)
        resolve(fired)
      }
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish(true), deadlineMs)
      timer.unref?.()
      s.exitWaiters.push(onExit)
      signal?.addEventListener('abort', onAbort, { once: true })
    })

  /** The idle watcher: one interval for every watched session; an
   * idle-expired session closes through the single close path. Output
   * activity (line-count movement) refreshes the clock — PTY input without
   * echo does not (#56 ruling: no reliable idle criterion, so opt-in). */
  let watcher: ReturnType<typeof setInterval> | undefined
  const watchedCount = (): number => {
    let n = 0
    for (const byId of registry.values()) for (const s of byId.values()) if (s.idleTimeoutMs !== undefined) n += 1
    return n
  }
  const ensureWatcher = (): void => {
    if (watcher !== undefined) return
    watcher = setInterval(() => {
      const now = Date.now()
      for (const byId of registry.values()) {
        for (const s of byId.values()) {
          if (s.idleTimeoutMs === undefined) continue
          const total = totalLines(s)
          if (total !== s.idleLastLines) {
            s.idleLastLines = total
            s.lastActivityAt = now
            continue
          }
          if (now - s.lastActivityAt >= s.idleTimeoutMs) {
            void killSession(s, 'idle timeout').catch(() => {})
          }
        }
      }
      if (watchedCount() === 0 && watcher !== undefined) {
        clearInterval(watcher)
        watcher = undefined
      }
    }, config.idleTickMs)
    watcher.unref?.()
  }

  /** Per-session tail cursor (absolute consumed line index). Lives next to
   * the registry so close/dispose dropping the session drops its cursor. */
  const cursors = new Map<Session, number>()

  /** Kill + await the exit (bounded), remove from the registry. The single
   * close path for pty_close, the idle watch, and dispose. Reclaim is
   * immediate (the registry row and cursor drop at initiation — cap slots
   * free and idempotency hold without waiting for the exit event); the
   * kill's exit is awaited bounded for the close tool's settlement. */
  const killSession = async (s: Session, _reason: string): Promise<void> => {
    const byId = registry.get(s.owner)
    if (byId === undefined || !byId.has(s.id)) return // already gone (idempotent per close)
    byId.delete(s.id)
    cursors.delete(s)
    if (!s.exited) {
      try {
        s.pty.kill()
      } catch {
        // A ConPTY close can throw on an already-dead session (#51).
      }
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (s.exited) {
            clearInterval(check)
            resolve()
          }
        }, 25)
        setTimeout(() => {
          clearInterval(check)
          resolve()
        }, CLOSE_EXIT_WAIT_MS)
      })
    }
  }

  /** Ownership boundary: an id held by ANOTHER owner is a loud error, never
   * a silent miss (the seam's owner-scoping contract, kept). */
  const ownerOf = (id: string): { owner: unknown; session: Session } | undefined => {
    for (const [owner, byId] of registry.entries()) {
      const s = byId.get(id)
      if (s !== undefined) return { owner, session: s }
    }
    return undefined
  }

  const core: SessionCore = {
    async open(owner, spec, signal) {
      // #159: the deadline measures the WHOLE tool call, so the clock starts
      // before the validation/spawn work, not at the exit wait.
      const callStartedAt = Date.now()
      const command = spec?.command
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new Error('command must be a non-empty string')
      }
      if (spec.autoClose !== undefined && typeof spec.autoClose !== 'boolean') {
        throw new Error(`autoClose must be a boolean, got: ${JSON.stringify(spec.autoClose)}`)
      }
      if (spec.shell !== undefined && typeof spec.shell !== 'boolean') {
        throw new Error(`shell must be a boolean, got: ${JSON.stringify(spec.shell)}`)
      }
      if (spec.waitForFirstOutput !== undefined && typeof spec.waitForFirstOutput !== 'boolean') {
        throw new Error(`waitForFirstOutput must be a boolean, got: ${JSON.stringify(spec.waitForFirstOutput)}`)
      }
      // #186: the marker dialect is declared, never inferred — and 'bash' is
      // the only v1 dialect (ADR-0020 Q1: one dialect to proven status, the
      // wider matrix undecided). An unknown spelling is a caller error.
      if (spec.marker !== undefined && spec.marker !== 'bash') {
        throw new Error(`marker must be "bash" (the only v1 dialect), got: ${JSON.stringify(spec.marker)}`)
      }
      // #186: a marker is a PERSISTENT-shell feature (the sentinels ride the
      // interactive line lifecycle: PS0 before each command, PROMPT_COMMAND
      // before each prompt). A one-shot exec has no such lifecycle.
      if (spec.marker !== undefined && spec.autoClose === true) {
        throw codedError(
          'pty open: marker is a persistent-shell contract (the bash sentinels ride the interactive line lifecycle) — a one-shot exec (autoClose: true) cannot carry it',
          'INVALID_ARGS',
        )
      }
      if (spec.idleTimeoutMs !== undefined && (!Number.isInteger(spec.idleTimeoutMs) || spec.idleTimeoutMs <= 0)) {
        throw new Error(`idleTimeoutMs must be a positive integer (ms), got: ${JSON.stringify(spec.idleTimeoutMs)}`)
      }
      // #159: the per-call deadline is a non-negative integer (0 = explicitly
      // off), and it only bounds a ONE-SHOT exec — a persistent session has no
      // call-length deadline (the #56 opt-in idleTimeoutMs governs it), so a
      // deadline on a persistent open is refused loudly instead of silently
      // ignored.
      if (spec.deadlineMs !== undefined && (!Number.isInteger(spec.deadlineMs) || spec.deadlineMs < 0)) {
        throw new Error(`deadlineMs must be a non-negative integer (ms; 0 = explicitly off), got: ${JSON.stringify(spec.deadlineMs)}`)
      }
      if (spec.deadlineMs !== undefined && spec.autoClose !== true) {
        throw codedError(
          'pty open: deadlineMs bounds a ONE-SHOT exec (autoClose: true) — a persistent session has no call-length deadline; ' +
            'use the opt-in idleTimeoutMs for idle reclamation (#56) or autoClose: true for exec semantics',
          'INVALID_ARGS',
        )
      }
      // #146 × #149: a DECLARED shell session is persistent by design (its close
      // path is pty_close), so waiting for its exit would pin this call to a
      // process that may never end. Refuse loudly BEFORE a spawn instead of
      // hanging, and name both workable fixes.
      if (spec.autoClose === true && spec.shell === true) {
        throw codedError(
          'pty_open: autoClose is one-shot exec semantics, but this call declares a shell session ' +
            '(shellCommand / the configured defaultShellCommand) — a shell is persistent, so close it with pty_close. ' +
            'For a one-shot that needs shell semantics, pass the LINE as `command`, e.g. ' + SHELL_SPELLINGS + '.',
          'INVALID_ARGS',
        )
      }
      // Soft cap over the owner's OWN held sessions (#56 migrated onto the
      // core — the #62 fix: remount-proof, the registry is the fact source).
      const held = byOwner(owner)
      if (held.size >= config.maxSessions) {
        throw new Error(
          `pty: concurrent session limit reached (max ${config.maxSessions}); ` +
            `${held.size} sessions already active for this agent: ${[...held.keys()].join(', ')}. ` +
            'Close one with pty_close before opening another.',
        )
      }
      const pty = spawnPty(extractSpec({
        command,
        cwd: spec.cwd,
        env: spec.env,
      }))
      const id = `pty-${nextId++}`
      const payload = spec.marker === undefined ? undefined : randomPayload()
      const s: Session = {
        id,
        owner,
        pty,
        sanitizer: new TerminalSanitizer(DEFAULT_SANITIZER_PENDING_BYTES),
        lines: [],
        absBase: 0,
        pending: '',
        exited: false,
        exitWaiters: [],
        ...extractSpec({
          idleTimeoutMs: spec.idleTimeoutMs,
          autoClose: spec.autoClose,
          shell: spec.shell,
          authorizedMode: spec.authorizedMode,
          ...(payload === undefined ? {} : {
            marker: {
              payload,
              scanner: new MarkerScanner(payload),
              segMode: false,
              segOpen: false,
              fDropped: 0,
              fCount: 0,
            } satisfies SessionMarker,
          }),
        }),
        ...(payload === undefined ? {} : { segFlags: [] as boolean[] }),
        idleLastLines: 0,
        lastActivityAt: Date.now(),
      }
      held.set(id, s)
      pty.onData((d) => append(s, d))
      pty.onExit(({ exitCode }) => {
        // #180: drain the sanitizer before the exit is recorded — a trailing
        // printable fragment (no newline yet) still belongs to the output,
        // an incomplete escape sequence is discarded (never printable).
        // #186: the marker scanner's torn-carry needs no flush — it only
        // ever holds a strict prefix of one of our sentinels (control bytes,
        // nothing printable).
        append(s, s.sanitizer.flush())
        s.exited = true
        s.exitCode = exitCode
        // #146: the one-shot open call is waiting on THIS event — release it
        // before anything else so a fast exit cannot be missed.
        for (const notify of s.exitWaiters.splice(0)) notify()
        // One-shot mode (#64): let the settle window drain the final output,
        // then reclaim through the single close path — already-exited
        // sessions skip the kill, the registry row drops, the slot frees.
        if (s.autoClose) {
          void settleFor(s, undefined, { ignoreExit: true }).then(() => killSession(s, 'autoClose')).catch(() => {})
        }
      })
      // Initial settle: the banner/prompt produced at birth lands in
      // initialOutput; the tail cursor starts from what exists now.
      // #189: with the spec's opt-in the settle waits for the first printable
      // output (a cold spawn's first bytes are ConPTY control sequences the
      // sanitizer strips — quiet must not be judged on an empty buffer).
      await settleFor(s, signal, spec.waitForFirstOutput === true ? { waitForFirstOutput: true } : undefined)
      // #186 (ADR-0020 Q1, the injection point): after the settle (the shell
      // is interactive-ready — profiles have run, so our PREPEND wins over
      // any rcfile PROMPT_COMMAND) write the ONE setup line that arms the
      // sentinels. Until the first trusted open arrives the filtered view
      // mirrors raw (the Q2 fallback), so a session whose setup never lands
      // (dead shell, exotic bash) degrades to the pre-#186 face, never to
      // lost output. A write failure on a dead-at-birth session is recorded
      // on the session and reported as `markerArmed: false` on the open
      // result — the degradation is observable at runtime, never silently
      // swallowed (the review round's observability point).
      if (s.marker !== undefined) {
        try {
          s.pty.write(buildBashMarkerSetup(s.marker.payload) + '\r')
        } catch {
          // The session died between the settle and the arming write — the
          // marker never arms; every read stays on the raw face.
          s.markerSetupFailed = true
        }
      }
      // #186: the default-view cursor lives in the DEFAULT coordinate —
      // filtered for a marker session (tail consumes it by default), raw
      // otherwise (where both views are one view). A marker session's raw
      // cursor starts independently so evidence readers page the raw view.
      cursors.set(s, s.marker === undefined ? totalLines(s) : s.marker.fDropped + s.marker.fCount)
      if (s.marker !== undefined) s.rawCursor = totalLines(s)
      if (spec.autoClose === true) {
        // #146: a one-shot is an EXEC — wait for the real exit, then drain the
        // output that raced the exit event (the #64 quiet-window rule) BEFORE
        // the result is built, so `status` carries the real code and
        // `initialOutput` carries the final output. Reclaim stays on the exit
        // tap above, so an aborted call still gets its slot back later.
        // #159: the wait races the call's hard deadline (measured from the
        // CALL START, not from the settle — boundary: the WHOLE tool call).
        // A fired deadline kills the session's own tree (graceful-then-hard,
        // see deadlineKill) and the result carries timeout: true with the
        // output captured so far and the real exit code only if one exists.
        const deadline = resolveDeadlineMs(spec.deadlineMs, config.deadlineMs)
        const deadlineRemaining = deadline - (Date.now() - callStartedAt)
        const deadlineFired = deadline > 0 && (deadlineRemaining <= 0 || (await waitForDeadlineOrExit(s, signal, deadlineRemaining)))
        if (deadlineFired) {
          s.deadlineExceeded = true
          // #162: freeze the output cut AT the kill-sequence start, BEFORE any
          // lever fires — output arriving after this point is termination-race
          // residue and is excluded from the result below.
          s.deadlineOutputCut = { abs: totalLines(s), pendingLen: s.pending.length }
          await deadlineKill(s)
        }
        if (!s.deadlineExceeded) await waitForExit(s, signal)
        if (s.exited) await settleFor(s, undefined, { ignoreExit: true })
        // #159: a deadline kill reclaims through the single close path even
        // when the exit event never surfaced (killSession is idempotent and
        // no-ops once the row is gone). If no real exit code exists at that
        // point, statusOf reports it honestly (running / no exitCode) — the
        // kill never fabricates a success code.
        if (s.deadlineExceeded) await killSession(s, 'deadline exceeded').catch(() => {})
      }
      if (spec.idleTimeoutMs !== undefined) ensureWatcher()
      // #162: a timeout result carries the output up to the kill-sequence
      // start only — the settle window above still DRAINS the race residue
      // (the exit event needs it to surface), but the cut keeps it out of the
      // result the caller sees.
      // #189: the waitForFirstOutput face appends the PENDING TAIL (the
      // incomplete trailing line) — the same shape the #162 cut face and
      // pty_send's delta report. A remote prompt carries no newline and lives
      // in the pending buffer: complete-lines-only meant a settled-but-lineless
      // banner still published an empty initialOutput, while the tail cursor
      // (which never covers pending) hid it from every page until the next
      // write completed the line ("visible only after the first write", the
      // second half of #189's phenomenon). Appending is OPT-IN only: an
      // unconditional append double-delivers the pending prefix (the tail
      // hands over the completed line in full) and broke remote's
      // initialOutput+tail marker-assembly consumer for real
      // (tests/remote-session-launch.spec.ts split-marker chunks, 1/17 red
      // before this scoping). Known residue on the opt-in face: the prompt
      // prefix reappears verbatim inside the first echoed line — that is what
      // a terminal echo looks like anyway, not a loss or a shift.
      const initialOutput =
        s.deadlineOutputCut !== undefined
          ? readNewestBelowCut(s, config.scrollbackLines, s.deadlineOutputCut)
          : readNewest(s, totalLines(s), config.scrollbackLines).text +
            (spec.waitForFirstOutput === true ? s.pending : '')
      return {
        sessionId: id,
        ...(pty.pid === undefined ? {} : { pid: pty.pid }),
        status: statusOf(s),
        initialOutput,
        // #159: present exactly when the hard deadline fired — never on an
        // exit or an abort (the marker's mutual exclusion, stated in
        // DEADLINE_SEMANTICS and on the tool's output schema).
        ...(s.deadlineExceeded ? { timeout: true as const } : {}),
        // #186: present exactly on a marker session — whether the arming
        // setup line reached the shell (false = the write failed and the
        // session stays on the raw face; observable, not swallowed).
        ...(s.marker === undefined ? {} : { markerArmed: s.markerSetupFailed !== true }),
      }
    },

    async send(owner, id, request) {
      const s = requireSession(owner, id)
      if (s.exited) return { delta: '', status: statusOf(s) }
      const payload = request.data + (request.submit ?? true ? '\r' : '')
      const startAbs = totalLines(s)
      const startPendingLen = s.pending.length
      // #186: consume the previous window's close boundary — only a close
      // INSIDE this window may bound this window's pending-tail delivery
      // (a close recorded during plain ingestion carries no delivery claim).
      if (s.marker !== undefined) s.marker.closePendingLen = undefined
      try {
        s.pty.write(payload)
      } catch {
        // Dead between check and write: report the exited status.
        return { delta: '', status: statusOf(s) }
      }
      await settleFor(s, request.signal)
      // Delta = the output produced while this write settled: every line
      // completed since send start, plus whatever partial tail accrued.
      // #186: the delta is a FILTERED read — on a marker session the lines
      // that completed out-of-segment during the settle (the command's echo
      // is the routine case) are not the command's own output and do not
      // reach it. The pending tail follows the segment state at settle end:
      // mirror phase and an open segment keep it (output still forming — the
      // live-measured shape); an ARMED CLOSED segment keeps only the bytes
      // produced BEFORE the close (an unterminated output tail, `printf abc`
      // with no trailing newline — the review round established that the
      // previous whole-tail drop ate it: a real data-loss direction) and
      // drops only what arrived after the close (the prompt fragment parked
      // in pending — the residue class this ticket removes; a real msys2
      // delta ended with a bare "$ " before the boundary rule,
      // .scratch/verify186/).
      const newLines = s.lines.slice(startAbs - s.absBase)
      const inView = s.marker === undefined
        ? newLines
        : newLines.filter((_line, i) => s.segFlags![startAbs - s.absBase + i])
      const m = s.marker
      let pendingTail: string
      if (m === undefined || !m.segMode || m.segOpen) {
        // No marker (raw face), still mirroring, or the segment is open:
        // everything is (or may still be) command output.
        pendingTail = s.pending.slice(startPendingLen)
      } else if (m.closePendingLen !== undefined) {
        // Armed and closed, with a close INSIDE this send window (a previous
        // window's boundary was consumed at the start of this one). The
        // close-time boundary bounds the command's own unterminated output
        // tail: everything in pending before it is delivered, everything
        // after it (the prompt fragment) is dropped. Real stream order
        // guarantees the pre-close pending holds only output: an open
        // always follows a completed echo line, which resets pending.
        pendingTail = s.pending.slice(0, m.closePendingLen)
      } else {
        // Armed and closed with no close this window: the pending content
        // is echo/prompt residue (the residue class this ticket removes).
        pendingTail = ''
      }
      const delta = [...inView.map((l) => l + '\n'), pendingTail].join('')
      return { delta, status: statusOf(s) }
    },

    tail(owner, id, limit, view) {
      const s = requireSession(owner, id)
      // 复审 #181-2: a non-positive / non-integer `limit` is a caller error —
      // refused LOUDLY, never silently folded (a budget < 1 would drive
      // `end` behind the cursor and silently rewind it, re-delivering lines
      // the caller already saw). The config side keeps its positiveInt
      // fallback (resolveCoreConfig); only the per-call argument is refused.
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw terr('INVALID_ARGS', `pty tail: limit must be a positive integer (got ${JSON.stringify(limit)})`)
      }
      // #186: `view` names the coordinate explicitly (the #119 declaration
      // posture on the read side). Everything except a literal 'raw' —
      // including the omitted argument — is the filtered default; an unknown
      // spelling is a loud caller error, never folded to a view.
      if (view !== undefined && view !== 'filtered' && view !== 'raw') {
        throw terr('INVALID_ARGS', `pty tail: view must be "filtered" or "raw" (got ${JSON.stringify(view)})`)
      }
      const budget = limit ?? config.tailLimit
      // Raw view: the pre-#186 path, byte-for-byte. A marker session pages
      // the raw view from its own raw cursor so evidence readers never move
      // the default (filtered) cursor.
      if (view === 'raw' || s.marker === undefined) {
        const consumed = view === 'raw' && s.marker !== undefined ? (s.rawCursor ?? 0) : (cursors.get(s) ?? 0)
        const total = totalLines(s)
        const backlog = total - consumed
        if (backlog <= 0) return { text: '', offset: consumed + 1, limit: budget, totalLines: total, truncated: false }
        const begin = Math.max(consumed, s.absBase)
        const lost = begin > consumed
        const count = Math.min(budget, total - begin)
        const end = begin + count
        const slice = s.lines.slice(begin - s.absBase, end - s.absBase)
        if (view === 'raw' && s.marker !== undefined) s.rawCursor = end
        else cursors.set(s, end)
        return {
          text: slice.length === 0 ? '' : slice.join('\n') + '\n',
          offset: begin + 1,
          limit: budget,
          totalLines: total,
          truncated: lost,
        }
      }
      // Filtered view (the default, #186 Q4): the SAME #181 cursor semantics
      // in the filtered coordinate — the page is anchored on the cursor and
      // walks FORWARD, nothing between calls is skipped, `offset` is the
      // 1-based absolute line number of the page's first line IN THE FILTERED
      // VIEW (kept even on an empty page), `totalLines` is the exact
      // filtered-line count, and `truncated` flags REAL loss — in-view lines
      // the scrollback cap dropped before the cursor reached them
      // (`fDropped` is that base). Out-of-view lines (echo/banner/prompt and
      // repaint residue) are invisible to this coordinate: they neither page
      // nor count.
      const m = s.marker!
      const consumed = cursors.get(s) ?? 0
      const total = m.fDropped + m.fCount
      const backlog = total - consumed
      if (backlog <= 0) return { text: '', offset: consumed + 1, limit: budget, totalLines: total, truncated: false }
      const begin = Math.max(consumed, filteredBase(s))
      const lost = begin > consumed
      const count = Math.min(budget, total - begin)
      const end = begin + count
      const slice = filteredSlice(s, begin, count)
      cursors.set(s, end)
      return {
        text: slice.length === 0 ? '' : slice.join('\n') + '\n',
        offset: begin + 1,
        limit: budget,
        totalLines: total,
        truncated: lost,
      }
    },

    async close(owner, id) {
      const s = registry.get(owner)?.get(id)
      if (s === undefined) {
        // An id held by another owner propagates loudly (foreign sessions
        // are never silently closed); a truly unknown id is closed:false.
        if (ownerOf(id) !== undefined) throw terr('SESSION_OWNED', `pty session ${JSON.stringify(id)} belongs to another agent`)
        return { closed: false }
      }
      await killSession(s, 'pty_close')
      return { closed: true }
    },

    active(owner) {
      return [...(registry.get(owner)?.keys() ?? [])]
    },

    list(owner) {
      const byId = registry.get(owner)
      if (byId === undefined) return []
      return [...byId.values()].sort(idOrder).map((s) => ({
        id: s.id,
        status: statusOf(s),
        ...(s.pty.pid === undefined ? {} : { pid: s.pty.pid }),
      }))
    },

    modeOf(owner, id) {
      // Deliberately silent for an unknown/foreign id: the caller's gate uses
      // this only to detect a DOWNGRADE, and the ownership/existence error
      // belongs to the operation that follows (pty_send's own NO_SESSION /
      // SESSION_OWNED), not to this metadata read.
      return registry.get(owner)?.get(id)?.authorizedMode
    },

    signal(owner, id, signal) {
      // Ownership/existence FIRST (#119 AC2): a foreign id is a loud
      // SESSION_OWNED no matter what signal name came with it (a privacy
      // posture that must not depend on the caller's other arguments), and a
      // truly unknown id is a loud NO_SESSION — never a silent miss.
      const s = registry.get(owner)?.get(id)
      if (s === undefined) {
        if (ownerOf(id) !== undefined) throw terr('SESSION_OWNED', `pty session ${JSON.stringify(id)} belongs to another agent`)
        throw terr('NO_SESSION', `no pty session ${JSON.stringify(id)} for this agent`)
      }
      // Then the NAME: a mistyped signal is a caller error on the caller's OWN
      // session (the tool surface's parameter enum is the same single source).
      if (!(PTY_SIGNALS as readonly string[]).includes(signal)) {
        throw terr('SIGNAL_INVALID', `pty_signal: ${JSON.stringify(signal)} is not an accepted signal; allowed: ${PTY_SIGNALS.join(', ')}`)
      }
      const status = statusOf(s)
      // An exited-but-unclosed session (persistent default) has nothing left
      // to signal — report it, do not pretend a delivery happened.
      if (s.exited) return { id, signal, delivered: false, status }
      if (signal === 'SIGKILL' && s.shell === true) {
        throw terr('SIGNAL_FORBIDDEN', `pty_signal: SIGKILL is refused for shell target ${JSON.stringify(id)} — killing a shell cannot reclaim the children it owns; use pty_close (the single close path)`)
      }
      if (platform === 'win32') {
        if (!(PTY_WINDOWS_SIGNALS as readonly string[]).includes(signal)) {
          throw terr('SIGNAL_UNSUPPORTED', `pty_signal: ${signal} cannot be delivered on Windows/ConPTY — node-pty exposes termination only (${PTY_WINDOWS_SIGNALS.join(' / ')}); for an interactive shell send "\\u0003" (Ctrl-C) with pty_send instead`)
        }
        try {
          // ConPTY's only lever: a plain kill() — the session terminates.
          s.pty.kill()
        } catch (error) {
          throw terr('SIGNAL_FAILED', `pty_signal: terminating ${JSON.stringify(id)} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return { id, signal, delivered: true, semantics: 'terminate', status }
      }
      const pid = s.pty.pid
      if (pid === undefined) {
        throw terr('SIGNAL_NO_PID', `pty_signal: session ${JSON.stringify(id)} exposes no pid — this backend cannot receive signals`)
      }
      try {
        // Negative pid = the session's process GROUP (forkpty's session
        // leader), so a `sh -c` child tree is reached as one unit.
        procKill(-pid, signal)
      } catch (error) {
        throw terr('SIGNAL_FAILED', `pty_signal: delivering ${signal} to the process group of ${JSON.stringify(id)} (pid ${pid}) failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { id, signal, delivered: true, semantics: 'signal', status }
    },

    async dispose() {
      const kills: Array<Promise<unknown>> = []
      for (const byId of registry.values()) {
        for (const s of byId.values()) {
          kills.push(killSession(s, 'dsh-pty-session disposed').catch(() => {}))
        }
      }
      await Promise.allSettled(kills)
      registry.clear()
      if (watcher !== undefined) {
        clearInterval(watcher)
        watcher = undefined
      }
    },
  }

  return core
}

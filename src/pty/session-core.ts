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
 * Read contract (the seam-era one, restated): a read's `offset` counts
 * back from the NEWEST retained line (0 = newest); complete lines only
 * (a partial trailing line is held back until its newline arrives); a
 * tail reports `truncated` when the backlog exceeded the requested
 * budget (older lines are then lost).
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

/** Default concurrent-session soft cap (#56 ruling 3, migrated onto the
 * core: the registry is the single source of truth, so an entry remount
 * can no longer reset the count — the #62 root cause dies here). */
export const DEFAULT_MAX_SESSIONS = 8

/** Default line budget for tail when the caller omits `lines`. */
export const DEFAULT_TAIL_LINES = 200

/** Output quiescence window for a send/open settle: the write settles once
 * no new bytes arrived for this long. */
const DEFAULT_SETTLE_QUIET_MS = 150
/** Poll period for the settle loop. */
const DEFAULT_SETTLE_TICK_MS = 25
/** Hard ceiling for any settle (a chatty process cannot hang a tool call). */
const DEFAULT_SETTLE_TIMEOUT_MS = 2000
/** Idle-watcher tick period: fine-grained enough for second-scale timeouts. */
const DEFAULT_IDLE_TICK_MS = 250
/** Retained scrollback lines per session; older lines are dropped (and a
 * tail that spans the drop reports truncated). */
const DEFAULT_SCROLLBACK_LINES = 10_000
/** Bounded wait for a kill to surface its exit event. */
const CLOSE_EXIT_WAIT_MS = 5000

export interface SessionCoreConfig {
  tailLines: number
  maxSessions: number
  settleQuietMs: number
  settleTickMs: number
  settleTimeoutMs: number
  idleTickMs: number
  scrollbackLines: number
}

/** Resolve partial config onto the defaults (the config surface is the
 * `./pty` entry's own settings namespace). */
export function resolveCoreConfig(raw: Partial<SessionCoreConfig> | undefined): SessionCoreConfig {
  const c = raw ?? {}
  const positiveInt = (value: unknown, fallback: number): number =>
    Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback
  return {
    tailLines: positiveInt(c.tailLines, DEFAULT_TAIL_LINES),
    maxSessions: positiveInt(c.maxSessions, DEFAULT_MAX_SESSIONS),
    settleQuietMs: positiveInt(c.settleQuietMs, DEFAULT_SETTLE_QUIET_MS),
    settleTickMs: positiveInt(c.settleTickMs, DEFAULT_SETTLE_TICK_MS),
    settleTimeoutMs: positiveInt(c.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS),
    idleTickMs: positiveInt(c.idleTickMs, DEFAULT_IDLE_TICK_MS),
    scrollbackLines: positiveInt(c.scrollbackLines, DEFAULT_SCROLLBACK_LINES),
  }
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
}

interface Session {
  id: string
  /** The owning agent — the registry is keyed owner→id, but the row
   * carries it too so kill/cleanup never needs a reverse scan. */
  owner: unknown
  pty: PtyLike
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
   * Declared by the OPENING SURFACE (#119): the session's top-level process IS
   * a shell — `./terminal`'s shell_open sets it, because that layer is the one
   * that knows it resolved a launcher preset. Gates SIGKILL in `signal()`.
   * The core never guesses shell-ness from command text: a heuristic could not
   * be honest about `pty_open({ command: "bash" })`, so it does not try.
   */
  shell?: boolean
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

export interface OpenResult {
  sessionId: string
  pid?: number
  status: SessionStatus
  initialOutput: string
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

export interface TailPage {
  text: string
  lines: number
  truncated: boolean
}

export interface SessionCore {
  open(owner: unknown, spec: OpenSpec, signal?: AbortSignal): Promise<OpenResult>
  send(owner: unknown, id: string, request: SendRequest): Promise<SendResult>
  tail(owner: unknown, id: string, lines?: number): TailPage
  close(owner: unknown, id: string): Promise<{ closed: boolean }>
  /** Registry-derived liveness: every session id currently held for the
   * owner (the #62 fix — counting derives from HERE, not from any entry's
   * closure state). */
  active(owner: unknown): string[]
  /** Owner-scoped listing (#119): id + status (+ pid when exposed), stable
   * creation order. The data source is the same registry as `active` — this
   * is its structured view, not a second enumeration. */
  list(owner: unknown): SessionSummary[]
  /** Deliver one whitelisted signal to the owner's session (#119). Platform
   * semantics: {@link PTY_SIGNAL_SEMANTICS}. */
  signal(owner: unknown, id: string, signal: string): SignalResult
  /** Awaited dispose: kill every session this core spawned. */
  dispose(): Promise<void>
}

const terr = (code: string, message: string) => Object.assign(new Error(message), { code })

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
  return Object.assign(new Error(`pty: ${detail} — ${target}; ${SPAWN_FAILURE_HINT}`), {
    code: 'SPAWN_FAILED',
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

  /** Append a raw output chunk: split complete lines (CR stripped, LF the
   * terminator), hold the partial tail back, enforce the scrollback cap. */
  const append = (s: Session, chunk: string): void => {
    s.pending += chunk
    let idx: number
    while ((idx = s.pending.indexOf('\n')) >= 0) {
      const line = s.pending.slice(0, idx).replace(/\r$/, '')
      s.pending = s.pending.slice(idx + 1)
      s.lines.push(line)
    }
    if (s.lines.length > config.scrollbackLines) {
      const drop = s.lines.length - config.scrollbackLines
      s.lines.splice(0, drop)
      s.absBase += drop
    }
  }

  /** Read the newest `count` complete lines, `offset` lines back from the
   * newest retained line (the seam's read contract, kept verbatim). */
  const readNewest = (s: Session, offset: number, count: number): { text: string; totalLines: number; truncated: boolean } => {
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

  /** The settle: wait until the session's byte production goes quiet —
   * the exclusive-send contract's "output read while the write settled".
   * An aborted signal resolves immediately (the write itself is not
   * cancelable; only the wait is). `ignoreExit` (#64 autoClose reclaim):
   * skip the exited short-circuit so the quiet window still runs AFTER the
   * process exit event — buffered output racing the exit gets to land. */
  const settleFor = (s: Session, signal?: AbortSignal, opts?: { ignoreExit?: boolean }): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const startedAt = Date.now()
      let lastDataAt = startedAt
      let lastChars = -1
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
        }
        if ((opts?.ignoreExit !== true && s.exited) || signal?.aborted || Date.now() - lastDataAt >= config.settleQuietMs || Date.now() - startedAt >= config.settleTimeoutMs) {
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
      if (spec.idleTimeoutMs !== undefined && (!Number.isInteger(spec.idleTimeoutMs) || spec.idleTimeoutMs <= 0)) {
        throw new Error(`idleTimeoutMs must be a positive integer (ms), got: ${JSON.stringify(spec.idleTimeoutMs)}`)
      }
      // #146 × #149: a DECLARED shell session is persistent by design (its close
      // path is pty_close), so waiting for its exit would pin this call to a
      // process that may never end. Refuse loudly BEFORE a spawn instead of
      // hanging, and name both workable fixes.
      if (spec.autoClose === true && spec.shell === true) {
        throw Object.assign(
          new Error(
            'pty_open: autoClose is one-shot exec semantics, but this call declares a shell session ' +
              '(shellCommand / the configured defaultShellCommand) — a shell is persistent, so close it with pty_close. ' +
              'For a one-shot that needs shell semantics, pass the LINE as `command`, e.g. ' + SHELL_SPELLINGS + '.',
          ),
          { code: 'INVALID_ARGS' },
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
      const s: Session = {
        id,
        owner,
        pty,
        lines: [],
        absBase: 0,
        pending: '',
        exited: false,
        exitWaiters: [],
        ...extractSpec({
          idleTimeoutMs: spec.idleTimeoutMs,
          autoClose: spec.autoClose,
          shell: spec.shell,
        }),
        idleLastLines: 0,
        lastActivityAt: Date.now(),
      }
      held.set(id, s)
      pty.onData((d) => append(s, d))
      pty.onExit(({ exitCode }) => {
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
      await settleFor(s, signal)
      cursors.set(s, totalLines(s))
      if (spec.autoClose === true) {
        // #146: a one-shot is an EXEC — wait for the real exit, then drain the
        // output that raced the exit event (the #64 quiet-window rule) BEFORE
        // the result is built, so `status` carries the real code and
        // `initialOutput` carries the final output. Reclaim stays on the exit
        // tap above, so an aborted call still gets its slot back later.
        await waitForExit(s, signal)
        if (s.exited) await settleFor(s, undefined, { ignoreExit: true })
      }
      if (spec.idleTimeoutMs !== undefined) ensureWatcher()
      const initialOutput = readNewest(s, totalLines(s), config.scrollbackLines).text
      return {
        sessionId: id,
        ...(pty.pid === undefined ? {} : { pid: pty.pid }),
        status: statusOf(s),
        initialOutput,
      }
    },

    async send(owner, id, request) {
      const s = requireSession(owner, id)
      if (s.exited) return { delta: '', status: statusOf(s) }
      const payload = request.data + (request.submit ?? true ? '\r' : '')
      const startAbs = totalLines(s)
      const startPendingLen = s.pending.length
      try {
        s.pty.write(payload)
      } catch {
        // Dead between check and write: report the exited status.
        return { delta: '', status: statusOf(s) }
      }
      await settleFor(s, request.signal)
      // Delta = the output produced while this write settled: every line
      // completed since send start, plus whatever partial tail accrued.
      const newLines = s.lines.slice(startAbs - s.absBase)
      const pendingTail = s.pending.slice(startPendingLen)
      const delta = [...newLines.map((l) => l + '\n'), pendingTail].join('')
      return { delta, status: statusOf(s) }
    },

    tail(owner, id, lines) {
      const s = requireSession(owner, id)
      const budget = lines ?? config.tailLines
      const consumed = cursors.get(s) ?? 0
      // Incremental read: fetch only lines past the session cursor, advance
      // the cursor to the newest retained line, and report truncation when
      // the backlog exceeded the requested budget (the seam-era tailPage
      // contract, kept verbatim — including the live-anchor retry).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const total = totalLines(s)
        const backlog = total - consumed
        if (backlog <= 0) return { text: '', lines: 0, truncated: false }
        const count = Math.min(budget, backlog)
        // The page read anchors on the LIVE newest line; output arriving
        // between probe and read would shift the window. Retry until the
        // probed total is stable, so the cursor only advances to a total
        // the returned page actually covers — nothing silently skipped.
        const page = readNewest(s, count, count)
        if (page.totalLines === total) {
          cursors.set(s, total)
          return { text: page.text, lines: count, truncated: backlog > count || page.truncated }
        }
      }
      // Persistently drifting: report no page rather than a misaligned one;
      // the cursor is untouched, so the next tail retries the whole backlog.
      return { text: '', lines: 0, truncated: true }
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

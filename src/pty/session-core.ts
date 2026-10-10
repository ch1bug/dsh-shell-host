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
 * @module dsh-shell-host/pty/session-core
 */

import { spawn as nodePtySpawn } from '@lydell/node-pty'

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
  idleTimeoutMs?: number
  /** One-shot mode (#64): reclaim through the single close path as soon as
   * the process exits — after the settle window so the final output has
   * landed. Default (absent): persistent semantics, zero change. */
  autoClose?: boolean
  /** Absolute line count at the last idle-watch observation. */
  idleLastLines: number
  lastActivityAt: number
}

/** Session status shape — the seam's sessionStatus contract, kept. */
export type SessionStatus = { kind: 'running' } | { kind: 'exited'; exitCode?: number; signal?: number }

export interface OpenSpec {
  command: string
  cwd?: string
  env?: Record<string, string>
  /** Opt-in per-session idle timeout (#56): auto-close after this much
   * time with no NEW OUTPUT (output-defined idle; opt-in per session). */
  idleTimeoutMs?: number
  /** One-shot mode (#64): when true, the core reclaims the session
   * automatically on process exit (settle window first, then the single
   * close path) — the soft-cap slot frees itself; tail afterwards reports
   * NO_SESSION. Default false: persistent, unchanged. */
  autoClose?: boolean
}

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

/** The default spawner. Windows: the command line is tokenized with the
 * OS argv rules (parseCommandLine above) and spawned DIRECTLY — argv[0] is
 * the executable, so quoted paths with spaces ride the spawn's argv, not
 * shell quoting. Consequence: the command IS the spawned process (#61
 * semantic, ADR-0010) — shell metacharacters and cmd builtins are NOT
 * interpreted; a shell (`cmd.exe /d /c ...`) must be named explicitly.
 * POSIX keeps the `/bin/sh -c` wrapper (real shell semantics). */
function defaultSpawnPty(spec: CoreSpawnSpec): PtyLike {
  const win32 = process.platform === 'win32'
  if (win32) {
    const argv = parseCommandLine(spec.command)
    if (argv.length === 0) throw new Error('pty: empty command line')
    return nodePtySpawn(argv[0], argv.slice(1), {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: spec.cwd,
      ...(spec.env === undefined ? {} : { env: { ...(process.env as Record<string, string>), ...spec.env } }),
    })
  }
  return nodePtySpawn('/bin/sh', ['-c', spec.command], {
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
      if (spec.idleTimeoutMs !== undefined && (!Number.isInteger(spec.idleTimeoutMs) || spec.idleTimeoutMs <= 0)) {
        throw new Error(`idleTimeoutMs must be a positive integer (ms), got: ${JSON.stringify(spec.idleTimeoutMs)}`)
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
        ...extractSpec({
          idleTimeoutMs: spec.idleTimeoutMs,
          autoClose: spec.autoClose,
        }),
        idleLastLines: 0,
        lastActivityAt: Date.now(),
      }
      held.set(id, s)
      pty.onData((d) => append(s, d))
      pty.onExit(({ exitCode }) => {
        s.exited = true
        s.exitCode = exitCode
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

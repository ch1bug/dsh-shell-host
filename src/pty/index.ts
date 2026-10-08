/**
 * dsh-shell-host `./pty` entry — absorbed from dsh-pty-session (issue #28,
 * ADR-0007 pure move; the source module stays anchored at
 * dsh-v0.2.1-alpha.1-r1 per ADR-0005): Layer 0 core, protocol-agnostic PTY
 * session lifecycle.
 *
 * Thin tool surface over the harness's owner-scoped PTY seam
 * (`ctx.terminals` — the same seam @deepseek-ai/dsh-tool-bash-persistent
 * uses). Four tools, no protocol knowledge:
 *
 *   pty_open({ command, cwd?, env? }) → { sessionId, ... }  spawn on a PTY,
 *       optionally export env vars then run the command; survives turns;
 *   pty_send({ id, data, submit? })  → write bytes, return the delta read;
 *   pty_tail({ id, lines? })         → incremental read from a per-session
 *       cursor — repeated tails never resend old lines;
 *   pty_close({ id })                → clean termination + reclaim.
 *
 * All sessions are owner-scoped: every call is authorized against
 * exec.agent and the registry reclaims sessions when the owning agent
 * disposes. The plugin additionally installs a dispose effect that closes
 * every session it opened.
 *
 * Explicitly OUT of scope (see the source repo README's instance matrix):
 * protocol parsing (gdb/MI, line framing — consumer-layer), non-PTY
 * long-running processes (probe servers, RTT, serial — use jobs + tail), no
 * sidecar process. Persistent/interactive session ownership (ADR-0004
 * decision 5) is unchanged — only the home moved into this package's
 * `./pty` entry, with its own settings namespace (ADR-0007).
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'dsh-pty-session'
const inject = ['tools', 'terminals']

const DEFAULT_TAIL_LINES = 200

/** Runtime configuration schema — the `./pty` entry's own settings namespace. */
export interface PtyConfig {
  /** Registered PTY backend type passed to terminals.spawn. */
  backendType: string
  /** Default line budget for pty_tail when the caller omits `lines`. */
  tailLines: number
}

/**
 * Runtime configuration schema. Exported per sibling-plugin convention;
 * settings-section wiring lands with the consumer tickets that need it.
 */
const Config = z.object({
  /** Registered PTY backend type passed to terminals.spawn. */
  backendType: z.string().default('shell'),
  /** Default line budget for pty_tail when the caller omits `lines`. */
  tailLines: z.number().default(DEFAULT_TAIL_LINES),
})

/** Default-fill a raw config (schemastery z.object has no .parse). */
function resolveConfig(raw: unknown): PtyConfig {
  const c = (raw ?? {}) as Partial<PtyConfig>
  return {
    backendType: c.backendType ?? 'shell',
    tailLines: c.tailLines ?? DEFAULT_TAIL_LINES,
  }
}

/** Shared render for structured tool output: one JSON text block. */
const jsonRender = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

/** POSIX single-quote a value for `export` lines on shell-type backends. */
function quotePosix(value: unknown) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/** The tool-execution context slice the plugin consumes (duck-typed seam). */
interface PtyCtx {
  provide: (name: string, value: unknown) => void
  effect: (fn: () => () => Promise<void>, label: string) => void
  terminals: any
  tools: { register: (tool: unknown) => void }
}

/** Owner (Agent) identity passed to every seam call. */
type Owner = unknown

/** Register the four pty_* tools against the owner-scoped terminals seam. */
function registerPtySession(ctx: PtyCtx, config: PtyConfig) {
  /** owner (Agent) -> Map<sessionId, absolute consumed line cursor>. */
  const cursorsByOwner = new Map<Owner, Map<string, number>>()

  const cursorOf = (owner: Owner, id: string) => cursorsByOwner.get(owner)?.get(id) ?? 0
  const setCursor = (owner: Owner, id: string, value: number) => {
    let byId = cursorsByOwner.get(owner)
    if (!byId) cursorsByOwner.set(owner, (byId = new Map()))
    byId.set(id, value)
  }

  /** Total retained lines for one owned session (hides the probe read). */
  const lineCount = (owner: Owner, id: string) =>
    ctx.terminals.read(owner, id, { offset: 0, count: 1 }).totalLines

  /**
   * Read the newest `count` lines, `fromEnd` lines back from the end.
   * Seam contract: a read request's `offset` counts back from the NEWEST
   * retained line (0 = newest), not from the beginning of the scrollback.
   */
  const readNewest = (owner: Owner, id: string, fromEnd: number, count: number) =>
    ctx.terminals.read(owner, id, { offset: fromEnd, count })

  /** Exclusive send: startSend, await settlement, return the output read. */
  const sendAndRead = async (owner: Owner, id: string, request: { text: string; submit?: boolean; signal?: AbortSignal }) => {
    const operation = ctx.terminals.startSend(owner, id, request)
    const result = await operation.done
    return { delta: operation.readOutput().delta, result }
  }

  /**
   * Incremental read: fetch only lines past the session cursor, advance the
   * cursor to the newest retained line, and report truncation when the
   * backlog exceeded the requested budget (older lines are then lost).
   */
  const tailPage = (owner: Owner, id: string, lines: number) => {
    const consumed = cursorOf(owner, id)
    let total: number = lineCount(owner, id)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const backlog = total - consumed
      if (backlog <= 0) return { text: '', lines: 0, truncated: false }
      const count = Math.min(lines, backlog)
      // The page read anchors on the LIVE newest line; output arriving
      // between probe and read would shift the window. Retry until the
      // probed total is stable, so the cursor only advances to a total the
      // returned page actually covers — nothing silently skipped.
      const page = readNewest(owner, id, count, count)
      if (page.totalLines === total) {
        setCursor(owner, id, total)
        return {
          text: page.text,
          lines: page.lineEnd - page.lineBegin,
          truncated: backlog > count || page.truncated === true,
        }
      }
      total = page.totalLines
    }
    // Persistently drifting: report no page rather than a misaligned one;
    // the cursor is untouched, so the next tail retries the whole backlog.
    return { text: '', lines: 0, truncated: true }
  }

  const requireAgent = (exec: { agent?: Owner }) => {
    const owner = exec?.agent
    if (owner === undefined) {
      throw Object.assign(new Error('pty_* tools require an owning agent session'), { code: 'NO_AGENT' })
    }
    return owner
  }

  /**
   * Programmatic facade: the four pty_* tool semantics as callable functions
   * for CONSUMER PLUGINS (T5 gdb, later ssh). Same cursors, same seam reads —
   * the tool surface and this facade are two views of one core. Consumers
   * pass the owner explicitly (`exec.agent` from their own tool execution);
   * they must never touch another agent's sessions (the seam enforces this).
   */
  const core = {
    /** Spawn on a PTY, export env (best-effort POSIX), run the command. */
    async open(owner: Owner, spec: { command?: string; cwd?: string; env?: Record<string, string> }, signal?: AbortSignal) {
      const command = spec?.command
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new Error('command must be a non-empty string')
      }
      const spawned = await ctx.terminals.spawn(owner, {
        type: config.backendType,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      }, signal)
      // env is best-effort POSIX `export` lines: only meaningful on
      // shell-type backends (TerminalSpawnRequest has no env field).
      const envLines = spec.env === undefined ? [] : Object.entries(spec.env)
        .map(([k, v]) => `export ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : quotePosix(k)}=${quotePosix(v)}`)
      for (const line of envLines) {
        await sendAndRead(owner, spawned.sessionId, { text: line, submit: true, signal })
      }
      const { delta, result } = await sendAndRead(owner, spawned.sessionId, {
        text: command,
        submit: true,
        signal,
      })
      const initial = delta || ctx.terminals.read(owner, spawned.sessionId, { offset: 0, count: 1000 }).text
      // Tail starts from what exists now: early output came back via this open.
      setCursor(owner, spawned.sessionId, lineCount(owner, spawned.sessionId))
      return {
        sessionId: spawned.sessionId,
        ...(spawned.pid === undefined ? {} : { pid: spawned.pid }),
        status: result.sessionStatus,
        initialOutput: initial,
      }
    },

    /** Exclusive send: startSend, await settlement, return the delta read. */
    async send(owner: Owner, id: string, request: { data: string; submit?: boolean; signal?: AbortSignal }) {
      const { delta, result } = await sendAndRead(owner, id, {
        text: request.data,
        submit: request.submit ?? true,
        signal: request.signal,
      })
      return { delta, status: result.sessionStatus }
    },

    /** Incremental read from the per-session cursor. */
    tail(owner: Owner, id: string, lines?: number) {
      return tailPage(owner, id, lines ?? config.tailLines)
    },

    /** Awaited cleanup via the seam; idempotent per close. */
    async close(owner: Owner, id: string) {
      let closed = false
      try {
        closed = await ctx.terminals.kill(owner, id, 'pty_close')
      } catch (error: any) {
        // Already gone (e.g. second close): the documented contract is
        // closed:false, not a throw. Foreign sessions still propagate.
        if (error?.code !== 'NO_SESSION') throw error
      }
      cursorsByOwner.get(owner)?.delete(id)
      return { closed }
    },

    /** Dispose effect: kill every session this plugin instance opened. */
    async dispose() {
      const kills: Array<Promise<unknown>> = []
      for (const [owner, byId] of cursorsByOwner) {
        for (const id of byId.keys()) {
          kills.push(ctx.terminals.kill(owner, id, 'dsh-pty-session disposed').catch(() => {}))
        }
      }
      cursorsByOwner.clear()
      await Promise.allSettled(kills)
    },
  }

  // Consumer plugins inject this service by name (`inject: [..., "pty"]`).
  ctx.provide('pty', core)

  ctx.effect(() => () => core.dispose(), 'dsh-pty-session session cleanup')

  ctx.tools.register(defineTool({
    name: 'pty_open',
    description:
      'Open a PTY session: spawn on the owner-scoped terminal seam, optionally set env vars, then run the command. ' +
      'The session stays alive across turns until pty_close or owner disposal. Byte-stream only — no protocol parsing.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Command to run on the PTY after spawn (env vars, if any, are exported first).',
      },
      cwd: {
        type: 'string',
        description: 'Optional initial working directory.',
      },
      env: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional env vars to export before the command (shell-type backends; POSIX quoting applied).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true, description: 'Opaque session id for send/tail/close.' },
          pid: { type: 'number', description: 'Top-level process id when the backend exposes one.' },
          status: { type: 'object', additionalProperties: true, description: 'Top-level process status at publication.' },
          initialOutput: { type: 'string', description: 'Output captured during spawn/command start.' },
        },
      },
      render: jsonRender as any,
    },
    async execute(args: { command: string; cwd?: string; env?: Record<string, string> }, exec: { agent?: Owner; signal?: AbortSignal }) {
      const owner = requireAgent(exec)
      return core.open(owner, args, exec.signal)
    },
    presentCall: (args: { command: string }) => ({ card: 'terminal', title: args.command }),
  }))

  ctx.tools.register(defineTool({
    name: 'pty_send',
    description: 'Write bytes into a live PTY session and return the output read while the write settled.',
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from pty_open.' },
      data: { type: 'string', required: true, description: 'Text to write into the session.' },
      submit: { type: 'boolean', description: 'Whether to write the backend\'s Enter sequence after data (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          delta: { type: 'string', description: 'Output produced since the previous read.' },
          status: { type: 'object', additionalProperties: true, description: 'Top-level session status at settlement.' },
        },
      },
      render: jsonRender as any,
    },
    async execute(args: { id: string; data: string; submit?: boolean }, exec: { agent?: Owner; signal?: AbortSignal }) {
      const owner = requireAgent(exec)
      return core.send(owner, args.id, { data: args.data, submit: args.submit, signal: exec.signal })
    },
    presentCall: (args: { data: string }) => ({ card: 'terminal', title: args.data }),
  }))

  ctx.tools.register(defineTool({
    name: 'pty_tail',
    description:
      'Incrementally read a PTY session\'s new output since the last tail (per-session cursor; repeated tails do not resend old lines).',
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from pty_open.' },
      lines: { type: 'number', description: 'Max lines to return this call (default from config; excess is marked truncated).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', description: 'New output since the cursor, chronological.' },
          lines: { type: 'number', description: 'Number of new lines returned.' },
          truncated: { type: 'boolean', description: 'True when older backlog exceeded the budget and was dropped.' },
        },
      },
      render: (_args: unknown, value: { text?: string }) => [{ type: 'text' as const, text: value.text || '(no new output)' }],
    },
    async execute(args: { id: string; lines?: number }, exec: { agent?: Owner }) {
      const owner = requireAgent(exec)
      return core.tail(owner, args.id, args.lines)
    },
    presentCall: (args: { id: string }) => ({ card: 'terminal', title: `tail ${args.id}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'pty_close',
    description: 'Terminate a PTY session via the seam\'s awaited cleanup and reclaim it. Idempotent per close.',
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from pty_open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          closed: { type: 'boolean', required: true, description: 'Whether this call newly closed the session.' },
        },
      },
      render: jsonRender as any,
    },
    async execute(args: { id: string }, exec: { agent?: Owner }) {
      const owner = requireAgent(exec)
      return core.close(owner, args.id)
    },
    presentCall: (args: { id: string }) => ({ card: 'terminal', title: `close ${args.id}` }),
  }))
}

/** Plugin entry: register the pty_* tool surface against the PTY seam. */
function apply(ctx: PtyCtx, config: unknown) {
  registerPtySession(ctx, resolveConfig(config))
}

export { Config, apply, inject, name }

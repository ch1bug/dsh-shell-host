/**
 * dsh-shell-host `./pty` entry — absorbed from dsh-pty-session (issue #28,
 * ADR-0007 pure move; the source module stays anchored at
 * dsh-v0.2.1-alpha.1-r1 per ADR-0005), now SEAM-FREE (issue #61, ADR-0010):
 * the session lifecycle is self-managed on node-pty (Windows ConPTY) —
 * own owner-scoped registry, read cursors, #56 soft-cap/idle semantics —
 * because rc.2's `terminals` seam is agent-execution-world scoped and
 * invisible to root-composition plugin rows (ADR-0009 blocked conclusion).
 *
 * Four tools, no protocol knowledge:
 *
 *   pty_open({ command, cwd?, env? }) → { sessionId, ... }  spawn the
 *       command on a ConPTY with process-level env injection; survives turns;
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
 * decision 5) is unchanged — only the transport moved from the harness seam
 * to this package's own node-pty core.
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { posixQuote } from '../posix-quote.ts'
import { createSessionCore, resolveCoreConfig, DEFAULT_TAIL_LINES, DEFAULT_MAX_SESSIONS, extractSpec, type SessionCore, type SessionCoreConfig, type OpenSpec, type CoreSpawnSpec, type PtyLike } from './session-core.ts'

const name = 'dsh-pty-session'
const inject = ['tools']

/** Runtime configuration schema — the `./pty` entry's own settings namespace. */
export interface PtyConfig {
  /** Default line budget for pty_tail when the caller omits `lines`. */
  tailLines: number
  /** Concurrent-session soft cap (#56, migrated onto the self-managed core
   * in #61): counted per owning agent over the core registry — remount-proof
   * (the #62 root cause is gone with the seam). */
  maxSessions: number
}

/**
 * Runtime configuration schema. Exported per sibling-plugin convention;
 * settings-section wiring lands with the consumer tickets that need it.
 */
const Config = z.object({
  /** Default line budget for pty_tail when the caller omits `lines`. */
  tailLines: z.number().default(DEFAULT_TAIL_LINES),
  /** Concurrent-session soft cap per owning agent (#56/#61). */
  maxSessions: z.number().default(DEFAULT_MAX_SESSIONS),
})

/** Default-fill a raw config (#64 fix: forward the FULL core config — the
 * settle/idle/scrollback knobs were previously dropped here, so tool-surface
 * config could never tune them; the core's own resolveCoreConfig defaults
 * fill the rest). */
function resolveConfig(raw: unknown): SessionCoreConfig {
  return resolveCoreConfig(raw as Partial<SessionCoreConfig>)
}

/** Shared render for structured tool output: one JSON text block. */
const jsonRender = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

/** The tool-execution context slice the plugin consumes (duck-typed seam). */
interface PtyCtx {
  provide: (name: string, value: unknown) => void
  effect: (fn: () => () => Promise<void>, label: string) => void
  tools: { register: (tool: unknown) => void }
}

/** Owner (Agent) identity passed to every core call. */
type Owner = unknown

/** Every pty/ssh tool requires an owning agent session (owner-scoped core). */
function requireAgent(exec: { agent?: Owner }): Owner {
  const owner = exec?.agent
  if (owner === undefined) {
    throw Object.assign(new Error('pty_* tools require an owning agent session'), { code: 'NO_AGENT' })
  }
  return owner
}

/** Injectable core dependencies (the unit lane's fake-spawn seam). */
interface PtyDeps {
  spawnPty?: (spec: CoreSpawnSpec) => PtyLike
}

/** Register the four pty_* tools over the self-managed session core. */
function registerPtySession(ctx: PtyCtx, config: PtyConfig, deps: PtyDeps = {}) {
  /** The self-managed core (src/pty/session-core.ts): the registry, cursors,
   * cap, idle watch and dispose all live in there — this tool surface and
   * the provided `pty` service are two views of one core. */
  const core: SessionCore = createSessionCore(config, deps)

  /**
   * Programmatic facade: the four pty_* tool semantics as callable functions
   * for CONSUMER PLUGINS (T5 gdb, terminal's shell_open, ssh). Consumers
   * pass the owner explicitly (`exec.agent` from their own tool execution);
   * they must never touch another agent's sessions (the core enforces this).
   */
  const facade = {
    /** Spawn the command on a ConPTY with env injected into the process. */
    open: (owner: Owner, spec: { command?: string; cwd?: string; env?: Record<string, string>; idleTimeoutMs?: number; autoClose?: boolean }, signal?: AbortSignal): Promise<any> =>
      core.open(owner, extractSpec(spec) as OpenSpec, signal),

    /** Exclusive send: write, await the settle, return the output read. */
    send: (owner: Owner, id: string, request: { data: string; submit?: boolean; signal?: AbortSignal }): Promise<any> =>
      core.send(owner, id, request),

    /** Incremental read from the per-session cursor. */
    tail: (owner: Owner, id: string, lines?: number): any => core.tail(owner, id, lines),

    /** Awaited cleanup; idempotent per close; foreign ids propagate loudly. */
    close: (owner: Owner, id: string): Promise<any> => core.close(owner, id),

    /** Registry-derived liveness for the owner's own sessions (#62: the
     * counting source of truth). */
    active: (owner: Owner) => core.active(owner),

    /** Dispose effect: kill every session this core instance spawned. */
    dispose: () => core.dispose(),
  }

  // Consumer plugins inject this service by name (`inject: [..., "pty"]`).
  ctx.provide('pty', facade)

  ctx.effect(() => () => facade.dispose(), 'dsh-pty-session session cleanup')

  ctx.tools.register(defineTool({
    name: 'pty_open',
    description:
      'Open a PTY session: spawn the command on a ConPTY, optionally set env vars (process-level injection). ' +
      'The session stays alive across turns until pty_close or owner disposal. Byte-stream only — no protocol parsing. ' +
      'For a run-once-and-done command pass autoClose: true — the session is reclaimed automatically when the ' +
      'process exits (the soft-cap slot frees itself); use the default persistent mode only for interactive sessions. ' +
      'Final output: read it via pty_tail before reclamation, or carry it in the send/publish deltas.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Command to run on the PTY after spawn (env vars, if any, are injected into the spawned process).',
      },
      cwd: {
        type: 'string',
        description: 'Optional initial working directory.',
      },
      env: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional env vars injected into the spawned terminal process (VS Code profile semantics, #53).',
      },
      autoClose: {
        type: 'boolean',
        description:
          'One-shot mode (#64): when true, the session is reclaimed automatically once the process exits — ' +
          'no pty_close needed, the soft-cap slot frees immediately. Final output must be read before ' +
          'reclamation (tail in the live window, or the returned deltas). Default false (persistent).',
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
    async execute(args: { command: string; cwd?: string; env?: Record<string, string>; autoClose?: boolean }, exec: { agent?: Owner; signal?: AbortSignal }) {
      const owner = requireAgent(exec)
      return facade.open(owner, args, exec.signal)
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
      return facade.send(owner, args.id, { data: args.data, submit: args.submit, signal: exec.signal })
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
      return facade.tail(owner, args.id, args.lines)
    },
    presentCall: (args: { id: string }) => ({ card: 'terminal', title: `tail ${args.id}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'pty_close',
    description: 'Terminate a PTY session (awaited cleanup + reclaim). Idempotent per close.',
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
      return facade.close(owner, args.id)
    },
    presentCall: (args: { id: string }) => ({ card: 'terminal', title: `close ${args.id}` }),
  }))

  registerSshTools(ctx, facade, config)
}

/**
 * Keepalive defaults injected on every ssh_start (#21 phase 1) — the SINGLE
 * SOURCE for these literals (#49): composeSshCommand below, the ssh_start
 * tool description, and the spec files all derive from these exports.
 * README cites the values and points here. Changing them changes behavior
 * everywhere at once; each default is individually suppressible via a
 * caller-supplied `options` entry with the same key (#50: exact key match
 * on the normalized {key, value} shape).
 */
export const SSH_KEEPALIVE_INTERVAL_DEFAULT = 'ServerAliveInterval=15'
export const SSH_KEEPALIVE_COUNT_DEFAULT = 'ServerAliveCountMax=4'

/** Suppression keys (#50), derived from the #49 atoms so the source stays single. */
const SSH_KEEPALIVE_INTERVAL_KEY: string = SSH_KEEPALIVE_INTERVAL_DEFAULT.split('=')[0]
const SSH_KEEPALIVE_COUNT_KEY: string = SSH_KEEPALIVE_COUNT_DEFAULT.split('=')[0]

/**
 * One ssh `-o` option (#50 structured shape). `value` omitted = valueless
 * option. The atomic-string form (`"Key=value"` / `"Key"`) is accepted as
 * sugar and normalized into this shape.
 */
// A type LITERAL, not an interface: defineTool's schema inference maps an
// unitems array parameter to JsonValue[], and only object-literal types get
// the implicit index signature that makes them assignable to JsonValue.
export type SshOption = {
  key: string
  value?: string
}

/** Tool-parameter shape: either form per entry (#50 additive dual shape). */
export type SshOptionInput = string | SshOption

/** Chars that force POSIX quoting of a structured value (one shell word). */
const SHELL_UNSAFE = /[\s'"`$\\;&|<>(){}*?[\]#~!]/

/**
 * Normalize the dual-shape `options` input into `SshOption[]` (#50): the
 * atomic string is split at its FIRST `=` (empty key rejected); a valueless
 * atom becomes `{ key }`. Suppression then matches on the normalized KEY —
 * exact, no prefix heuristics.
 */
const normalizeSshOptions = (options: SshOptionInput[] | undefined): SshOption[] => {
  if (options === undefined) return []
  return options.map((entry, i): SshOption => {
    const at = `ssh_start options[${i}]`
    if (typeof entry === 'string') {
      if (entry === '' || /\s/.test(entry)) {
        throw new Error(`${at} must be a single -o atom with no whitespace (spaced values: use the structured {key, value} form), got: ${JSON.stringify(entry)}`)
      }
      const eq = entry.indexOf('=')
      if (eq < 0) return { key: entry }
      if (eq === 0) throw new Error(`${at}: empty option key in ${JSON.stringify(entry)}`)
      return { key: entry.slice(0, eq), value: entry.slice(eq + 1) }
    }
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`${at} must be a -o atom string or a {key, value} object, got: ${JSON.stringify(entry)}`)
    }
    const { key, value } = entry as { key?: unknown; value?: unknown }
    if (typeof key !== 'string' || key === '' || /\s/.test(key) || key.includes('=')) {
      throw new Error(`${at}.key must be a non-empty ssh option name with no whitespace or '=', got: ${JSON.stringify(key)}`)
    }
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`${at}.value must be a string when present, got: ${JSON.stringify(value)}`)
    }
    return value === undefined ? { key } : { key, value }
  })
}

/**
 * Render one normalized option as the `-o` operand: valueless keys alone;
 * values POSIX-quoted only when they carry whitespace/shell metacharacters
 * (atom-shaped values keep their #21-era verbatim look).
 */
const renderSshOption = (option: SshOption): string =>
  option.value === undefined ? option.key : `${option.key}=${SHELL_UNSAFE.test(option.value) ? posixQuote(option.value) : option.value}`

/**
 * ssh 四工具（issue #24，承接 dsh-pty-session#3）: the interactive
 * full-duplex ssh instance over the same core. `ssh_start` composes the ssh
 * command line and opens it on the core PTY (long-lived remote shell, sees
 * intermediate output); tail/send/close are thin passthroughs with their own
 * tool names so agent-facing surfaces read coherently.
 *
 * Division of labor (README-documented): one-shot remote commands belong to
 * the ssh BACKEND (#23 `backends/ssh.ts`, ControlMaster) — this instance is
 * for sessions a human/agent converses with.
 *
 * Reconnect semantics (issue AC): explicit RECONNECT-NO — a dead session
 * (network cut, remote drop) surfaces `status.kind = "exited"` on the next
 * send/tail; nothing auto-reconnects. Recovery = `ssh_start` again (new
 * session id); the dead id is reclaimed by `ssh_close` (idempotent).
 *
 * Long-session hardening (#21 phase 1): keepalive defaults
 * (ServerAliveInterval=15 / ServerAliveCountMax=4) ride on every start —
 * NAT/firewall idle drops otherwise kill sessions silently — plus `port`
 * (-p) and free `-o` passthrough via `options` (survey decision: remote
 * workspace capabilities build on this surface next).
 */
/** The ssh launch argument clump, named once (#54) and shared by every caller. */
export interface SshLaunchArgs {
  host: string
  jump?: string
  port?: number
  shell?: string
  options?: SshOptionInput[]
}

/**
 * The ssh composition, single source (#49/#54): the ssh_start tool and the
 * launcher layer's ssh transport dimension (ADR-0008 decision 1) both derive
 * from this one function — the launcher never re-hardcodes keepalive or -o
 * semantics.
 */
export function composeSshCommand(args: SshLaunchArgs): string {
  /** argv ATOMS (host/jump) — never shell text; reject whitespace loudly. */
  const atom = (kind: string, value: string) => {
    if (!/^[\w.@:[\]-]+$/.test(value)) {
      throw new Error(`ssh ${kind} must be a single argv atom (no whitespace/shell metacharacters), got: ${JSON.stringify(value)}`)
    }
    return value
  }
  // -tt: force remote TTY allocation even when the local side is a pipe —
  // the interactive full-duplex contract (banner, prompt, echo) depends on
  // the remote shell being interactive.
  const parts = ['ssh', '-tt']
  if (args.jump !== undefined) parts.push('-J', atom('jump', args.jump))
  if (args.port !== undefined) {
    if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
      throw new Error(`ssh port must be an integer in 1..65535, got: ${args.port}`)
    }
    parts.push('-p', String(args.port))
  }
  const supplied = normalizeSshOptions(args.options)
  // Keepalive defaults first so an explicit caller option reads as the
  // override; each default is suppressed when the caller supplies an
  // option with the same KEY AND a value — exact match on the normalized
  // shape (#50), never a prefix heuristic. A valueless entry does not
  // "set" the option (and would compose an invalid bare `Key` anyway),
  // so it leaves the default in place.
  const setsKey = (key: string) => supplied.some((option) => option.key === key && option.value !== undefined)
  if (!setsKey(SSH_KEEPALIVE_INTERVAL_KEY)) {
    parts.push('-o', SSH_KEEPALIVE_INTERVAL_DEFAULT)
  }
  if (!setsKey(SSH_KEEPALIVE_COUNT_KEY)) {
    parts.push('-o', SSH_KEEPALIVE_COUNT_DEFAULT)
  }
  for (const option of supplied) parts.push('-o', renderSshOption(option))
  parts.push(atom('host', args.host))
  // `shell` is deliberately NOT an atom: it is remote SHELL TEXT appended
  // verbatim (e.g. "bash --login"). core.open delivers `command` as shell
  // text into the PTY (the PTY model has no argv array), so only host/jump
  // need atom validation — they are the pieces ssh itself parses.
  if (args.shell !== undefined && args.shell.trim() !== '') parts.push(args.shell.trim())
  return parts.join(' ')
}

function registerSshTools(ctx: PtyCtx, core: { open(owner: unknown, spec: { command: string }, signal?: AbortSignal): Promise<any>; send(owner: unknown, id: string, request: { data: string; submit?: boolean; signal?: AbortSignal }): Promise<any>; tail(owner: unknown, id: string, lines?: number): any; close(owner: unknown, id: string): Promise<{ closed: boolean }> }, _config: PtyConfig) {
  ctx.tools.register(defineTool({
    name: 'ssh_start',
    description:
      'Open an interactive ssh session on a PTY (full duplex: long-lived remote shell, intermediate output visible). ' +
      `Keepalive defaults (${SSH_KEEPALIVE_INTERVAL_DEFAULT}/${SSH_KEEPALIVE_COUNT_DEFAULT}) are injected unless overridden via options. ` +
      'Returns a sessionId for ssh_tail / ssh_send / ssh_close. One-shot remote commands should use the ssh backend instead. ' +
      'No auto-reconnect: a dropped session reports status exited; recover by calling ssh_start again.',
    parameters: {
      host: { type: 'string', required: true, description: 'ssh destination ([user@]host), a single argv atom.' },
      jump: { type: 'string', description: 'Jump host passed as -J (single argv atom).' },
      port: { type: 'number', description: 'Remote ssh port passed as -p (integer 1..65535; omit for the default 22).' },
      options: {
        type: 'array',
        description:
          'Extra ssh -o options (#50, both shapes accepted). Atomic form: a single atom with no whitespace, ' +
          '"Key=value" or a valueless "Key". Structured form: { key, value? } — value may carry spaces ' +
          '(POSIX-quoted into one shell word, e.g. ProxyCommand). An option whose key is ServerAliveInterval ' +
          'or ServerAliveCountMax suppresses its keepalive default (exact key match).',
      },
      shell: { type: 'string', description: 'Remote command/shell to run after connect (e.g. "bash --login"); omit for the login shell.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true, description: 'Opaque session id for ssh_tail/ssh_send/ssh_close.' },
          pid: { type: 'number', description: 'Local ssh process id when the backend exposes one.' },
          status: { type: 'object', additionalProperties: true, description: 'Session status at publication.' },
          initialOutput: { type: 'string', description: 'Banner/auth output captured during connect.' },
        },
      },
      render: jsonRender as any,
    },
    async execute(rawArgs: { host: string; jump?: string; port?: number; shell?: string; options?: SshOptionInput[] }, exec: { agent?: Owner; signal?: AbortSignal }) {
      const owner = requireAgent(exec)
      const command = composeSshCommand(rawArgs)
      return core.open(owner, { command }, exec.signal)
    },
    presentCall: (args: { host: string }) => ({ card: 'terminal', title: `ssh ${args.host}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'ssh_send',
    description: 'Write bytes into the live ssh session and return the output read while the write settled. Core passthrough.',
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from ssh_start.' },
      data: { type: 'string', required: true, description: 'Text to write into the session.' },
      submit: { type: 'boolean', description: 'Whether to write the backend\'s Enter sequence after data (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          delta: { type: 'string', description: 'Output produced since the previous read.' },
          status: { type: 'object', additionalProperties: true, description: 'Session status at settlement — kind "exited" means the session dropped (no auto-reconnect).' },
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
    name: 'ssh_tail',
    description:
      'Incrementally read the ssh session\'s new output since the last tail (per-session cursor; repeated tails do not resend old lines). Core passthrough.',
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from ssh_start.' },
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
    name: 'ssh_close',
    description: 'Terminate the ssh session via the seam\'s awaited cleanup and reclaim it. Idempotent per close. Core passthrough.',
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from ssh_start.' },
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

/** Plugin entry: register the pty_* tool surface over the self-managed core. */
function apply(ctx: PtyCtx, config: unknown, deps: PtyDeps = {}) {
  registerPtySession(ctx, resolveConfig(config), deps)
}

export { Config, apply, inject, name }

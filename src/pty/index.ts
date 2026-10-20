/**
 * dsh-shell-host `./pty` entry — absorbed from dsh-pty-session (issue #28,
 * ADR-0007 pure move; the source module stays anchored at
 * dsh-v0.2.1-alpha.1-r1 per ADR-0005), now SEAM-FREE (issue #61, ADR-0010):
 * the session lifecycle is self-managed on node-pty (Windows ConPTY) —
 * own owner-scoped registry, read cursors, #56 soft-cap/idle semantics —
 * because rc.2's `terminals` seam is agent-execution-world scoped and
 * invisible to root-composition plugin rows (ADR-0009 blocked conclusion).
 *
 * Six tools, no protocol knowledge:
 *
 *   pty_open({ command | shellCommand, cwd?, env?, autoClose? }) → { sessionId, ... }
 *       spawn the command on a ConPTY with process-level env injection;
 *       survives turns. #146: with autoClose: true the call is an EXEC — it
 *       waits for the real exit and the result's status is
 *       `{ kind: "exited", exitCode }` (the real code), so "run one command,
 *       give me output + exit code" holds. #149: `shellCommand` declares a SESSION-LEVEL SHELL
 *       (bare command line, e.g. a resolved bash with `--login -i`) — the two
 *       are mutually exclusive, the argument-less call shape falls back to the
 *       `defaultShellCommand` setting, and a shell session is a SHELL TARGET
 *       for `pty_signal` (SIGKILL refused, `pty_close` is the close path);
 *   pty_send({ id, data, submit?, run_in_background? })  → write bytes, return
 *       the delta read; #120's `run_in_background: true` instead registers a
 *       HOST job (`ctx.jobs`, the `@deepseek-ai/dsh-jobs` +
 *       `@deepseek-ai/dsh-tool-jobs` pair) and returns its id immediately —
 *       the foreground settle path is byte-for-byte unchanged;
 *   pty_tail({ id, lines? })         → incremental read from a per-session
 *       cursor — repeated tails never resend old lines;
 *   pty_close({ id })                → clean termination + reclaim;
 *   pty_list({})                     → the owner's own sessions (id +
 *       status + pid, stable creation order);
 *   pty_signal({ id, signal })       → one whitelisted signal, with the
 *       platform semantics stated in PTY_SIGNAL_SEMANTICS (#119: POSIX
 *       best-effort real delivery, Windows/ConPTY termination only).
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
import { createSessionCore, resolveCoreConfig, DEFAULT_TAIL_LINES, DEFAULT_MAX_SESSIONS, extractSpec, AUTO_CLOSE_SEMANTICS, PTY_COMMAND_SEMANTICS, PTY_SIGNALS, PTY_SIGNAL_SEMANTICS, type SessionCore, type SessionCoreConfig, type OpenSpec, type CoreSpawnSpec, type PtyLike, type SendResult } from './session-core.ts'
import {
  ENVIRONMENT_CONTEXT_NAME,
  ENVIRONMENT_CONTEXT_ORDER,
  createEnvironmentContextText,
  detectEnvironmentRows,
  type EnvironmentRow,
} from './environment-context.ts'
import {
  BACKGROUND_DISABLED_MESSAGE,
  startBackgroundSend,
  type BackgroundJobRegistry,
} from './background-send.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JobToolCall } from '@deepseek-ai/dsh-jobs'

const name = 'dsh-pty-session'
// #149 contributes a prompt context, but the TOOLS must never wait on the
// prompt registry: a tools-only deployment without one still gets the whole pty
// surface. The contribution rides a child fiber instead (see
// registerEnvironmentContext), so the entry's required set stays ['tools'].
const inject = ['tools']

/** Runtime configuration schema — the `./pty` entry's own settings namespace. */
export interface PtyConfig extends SessionCoreConfig {
  /** Global default session shell (#149 Q3/Q6): a bare command line, the same
   * shape as `pty_open({ shellCommand })`. Reached ONLY by the argument-less
   * `pty_open()` call shape — it never overrides an explicit `command` or
   * `shellCommand`. No default value = no global default. */
  defaultShellCommand?: string
  /** Background sends (#120): expose `run_in_background` on `pty_send` /
   * `ssh_send` and accept it. Default true — the official `terminal_send`
   * posture; false makes every background request fail loudly instead of
   * silently degrading to a foreground settle. */
  enableRunInBackground?: boolean
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
  /** Global default session shell (#149): used by the argument-less
   * `pty_open()` only; unset = no global default. */
  defaultShellCommand: z.string(),
  /** Background sends (#120): expose and accept `run_in_background`
   * (default true, the official posture). */
  enableRunInBackground: z.boolean().default(true),
})

/** Default-fill a raw config (#64 fix: forward the FULL core config — the
 * settle/idle/scrollback knobs were previously dropped here, so tool-surface
 * config could never tune them; the core's own resolveCoreConfig defaults
 * fill the rest). `defaultShellCommand` stays tool-surface policy (#149): it is
 * validated here and never reaches the core. */
function resolveConfig(raw: unknown): PtyConfig {
  const c = (raw ?? {}) as Partial<PtyConfig>
  const defaultShellCommand = c.defaultShellCommand
  if (defaultShellCommand !== undefined && (typeof defaultShellCommand !== 'string' || defaultShellCommand.trim() === '')) {
    throw new Error(`pty: defaultShellCommand must be a non-empty command line when configured, got: ${JSON.stringify(defaultShellCommand)}`)
  }
  return {
    ...resolveCoreConfig(c),
    ...(defaultShellCommand === undefined ? {} : { defaultShellCommand }),
    // #120: absent = the default (true). Only an explicit `false` closes the
    // background path — a non-boolean reaches the core untouched, where the
    // schema layer rejects it long before a send runs.
    enableRunInBackground: c.enableRunInBackground !== false,
  }
}

/** A caller error on the tool surface (a bad declaration pair): stable code so
 * a consumer can branch without matching prose. */
const invalidArgs = (message: string) => Object.assign(new Error(message), { code: 'INVALID_ARGS' })

/** One `pty_open` declaration resolved into the launch command (#149). */
export interface ShellDeclaration {
  /** The command line the core spawns (the existing channel, unchanged). */
  command: string
  /** True for a SHELL TARGET: the session's top-level process is a shell, so
   * `pty_signal` refuses SIGKILL on it. Declared here, never inferred from the
   * command text (`pty_open({ command: "bash" })` stays a plain target). */
  shell: boolean
  /** Present exactly for shell targets — the resolved command, echoed on the
   * result so the caller can SEE which interpreter the session got (and which
   * layer of the priority chain answered). */
  shellCommand?: string
}

/**
 * Resolve the mutually exclusive `command` / `shellCommand` pair (#149 Q5) and
 * the `defaultShellCommand` fallback (Q6). The priority chain is
 * explicit `shellCommand` > `command` > `defaultShellCommand` > loud error:
 * an explicit `command` is a plain process and never picks up the global
 * default, and a call with neither declaration fails loudly naming all three
 * alternatives instead of defaulting silently.
 */
export function resolveShellDeclaration(
  args: { command?: string; shellCommand?: string },
  defaultShellCommand?: string,
): ShellDeclaration {
  if (args.command !== undefined && args.shellCommand !== undefined) {
    throw invalidArgs(
      'pty_open: `command` and `shellCommand` are mutually exclusive — pass exactly one ' +
        '(`shellCommand` for a session-level shell, `command` for a plain process)',
    )
  }
  if (args.shellCommand !== undefined) {
    if (args.shellCommand.trim() === '') {
      throw invalidArgs('pty_open: `shellCommand` must be a non-empty command line (executable plus interactive argv)')
    }
    return { command: args.shellCommand, shell: true, shellCommand: args.shellCommand }
  }
  if (args.command !== undefined) return { command: args.command, shell: false }
  if (defaultShellCommand !== undefined) {
    return { command: defaultShellCommand, shell: true, shellCommand: defaultShellCommand }
  }
  throw invalidArgs(
    'pty_open: must be given `command` or `shellCommand`, or a configured defaultShellCommand ' +
      '(the `./pty` settings namespace)',
  )
}

/** Shared render for structured tool output: one JSON text block. */
const jsonRender = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

// ---------------------------------------------------------------------------
// #120 — the model-facing faces of a background send
//
// ONE definition, shared by `pty_send` and `ssh_send`: the parameter, the
// description tail, the two extra result properties, the render and the call
// card. The executor is already a single branch (`background-send.ts`); copying
// these four would leave the drift surface wide open — the exact failure the
// one-facade split exists to prevent.
// ---------------------------------------------------------------------------

/** The `run_in_background` parameter, advertised only while the path is open
 * (official posture: a disabled deployment does not offer a parameter it will
 * refuse). */
const RUN_IN_BACKGROUND_PARAM = {
  type: 'boolean',
  description: 'Return a job id immediately; collect with job_output or stop with job_kill.',
} as const

/** Description tail of both send tools while the background path is open. */
const RUN_IN_BACKGROUND_SUFFIX =
  ' With run_in_background: true the call returns a job id immediately instead of awaiting the settle — ' +
  'collect it with job_output, stop it with job_kill (that path needs the host job stack mounted).'

/** The two result properties a BACKGROUND call adds. The foreground result
 * keeps its shape (`{ delta, status }`), so both stay absent there. */
const BACKGROUND_RESULT_PROPERTIES = {
  kind: { type: 'string', description: 'Present exactly when the send ran in the background: "background".' },
  jobId: { type: 'string', description: 'Registry-issued job id (background calls only) — pass it to job_output / job_kill.' },
} as const

/** A background call renders ONLY its job id; every other outcome keeps the
 * structured JSON block. */
const renderSend = (_args: unknown, value: { kind?: string; jobId?: string }) =>
  value.kind === 'background'
    ? [{ type: 'text' as const, text: `started background job ${value.jobId ?? '(unknown id)'}` }]
    : jsonRender(_args, value)

/** Call card: the background form swaps to the generic card and carries the
 * text as raw input (the official `terminal_send` posture); the foreground
 * keeps the terminal card. */
const presentSendCall = (args: { id: string; data: string; run_in_background?: boolean }) =>
  args.run_in_background === true
    ? { card: 'generic' as const, title: `Send to session ${args.id} in background`, kind: 'execute' as const, rawInput: args.data }
    : { card: 'terminal' as const, title: args.data }

/** The tool-execution context slice the plugin consumes (duck-typed seam). */
interface PtyCtx {
  provide: (name: string, value: unknown) => void
  effect: (fn: () => () => Promise<void>, label: string) => void
  tools: { register: (tool: unknown) => void }
  /** Service lookup (the sibling `./terminal` entry's precedent). */
  get: (name: string) => unknown
  /** cordis's child-fiber loader: run `callback` once `deps` are available, and
   * re-run it if they change. Optional because the duck-typed test harnesses
   * boot `apply` directly with no service container — they get the tools and no
   * prompt contribution, which is exactly what a registry-less deployment sees. */
  inject?: (deps: string[], callback: (scope: PtyCtx) => void) => unknown
}

/** The prompt-registry slice this entry contributes to (duck-typed seam). */
interface SystemPromptCtx {
  context: (entry: { name: string; order: number; text: () => string; interpolate?: boolean; required?: boolean }) => unknown
}

/** Owner (Agent) identity passed to every core call. */
type Owner = unknown

/** The send-tool execution slice the background branch reads (#120): the
 * owning agent, its cancellation, and the two call ids the host's job record
 * carries. The ids are OPAQUE STRINGS at this boundary for the same reason
 * `Owner` is `unknown` — the seam is duck-typed (the unit harnesses pass plain
 * object literals), so the host's branded `ToolCallId` is asserted once, at the
 * job record, the only place that has to speak the host's type. `agent` is
 * optional because a harness may pass `{ agent }` alone. */
type SendExec = { agent?: Owner; signal?: AbortSignal; callId?: string; rootCallId?: string }

/** How a send tool reaches the background path (#120): the gate, then the job
 * start. One function, so `pty_send` and `ssh_send` cannot drift apart. */
type BackgroundStarter = (
  owner: Owner,
  exec: SendExec,
  label: string,
  send: (signal: AbortSignal) => Promise<SendResult>,
) => { kind: 'background'; jobId: string }

/** The background path as the ssh family sees it: whether it is open, and the
 * starter. A named clump because both fields travel together everywhere. */
interface BackgroundSendBridge {
  readonly enabled: boolean
  readonly start: BackgroundStarter
}

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
  /** Signal-delivery seam (#119) — see `SessionCoreDeps`. */
  procKill?: (pid: number, signal: string) => void
  platform?: NodeJS.Platform
  /** Environment-detection seam (#149 AC10): the default is the real launcher
   * resolution, which shells out on win32. The provider calls it LAZILY (first
   * assembly, then cached) — never during `apply`. The unit lane injects a
   * counted fake to prove the single computation. */
  detectEnvironments?: () => readonly EnvironmentRow[]
}

/** Register the six pty_* tools over the self-managed session core. */
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
    open: (owner: Owner, spec: { command?: string; cwd?: string; env?: Record<string, string>; idleTimeoutMs?: number; autoClose?: boolean; shell?: boolean }, signal?: AbortSignal): Promise<any> =>
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

    /** The owner's own sessions as structured rows (#119): id + status + pid,
     * stable creation order. Same registry as `active`, richer view. */
    list: (owner: Owner) => core.list(owner),

    /** Deliver one whitelisted signal (#119). Platform semantics:
     * `PTY_SIGNAL_SEMANTICS` — POSIX best-effort real delivery,
     * Windows/ConPTY termination only (declared, never faked). */
    signal: (owner: Owner, id: string, signal: string) => core.signal(owner, id, signal),

    /** Dispose effect: kill every session this core instance spawned. */
    dispose: () => core.dispose(),
  }

  // Consumer plugins inject this service by name (`inject: [..., "pty"]`).
  ctx.provide('pty', facade)

  ctx.effect(() => () => facade.dispose(), 'dsh-pty-session session cleanup')

  /** #120's gate, resolved ONCE: the parameter face, both tool descriptions and
   * the executor all read this value, so they cannot disagree about whether the
   * path is open. Absent = open (default true, the official posture); only an
   * explicit `false` closes it. */
  const enableRunInBackground = config.enableRunInBackground !== false

  /**
   * Background sends (#120): the ONE branch `pty_send` and `ssh_send` share —
   * they differ only in which core send runs, so the gate, the job record and
   * the output source all live in `background-send.ts`.
   *
   * `ctx.get('jobs')` is read PER CALL, never at apply time: a host that
   * mounts the job stack after this row still serves the tool, and a host
   * without one gets the loud two-package error on the first background
   * request instead of a tool that quietly never offers the path.
   */
  const background: BackgroundStarter = (owner, exec, label, send) => {
    if (!enableRunInBackground) throw new Error(BACKGROUND_DISABLED_MESSAGE)
    const jobs = ctx.get('jobs') as BackgroundJobRegistry | undefined
    return startBackgroundSend({
      jobs,
      // The job contract fences access by the owning agent's SESSION id; this
      // package treats the Agent as an opaque owner, so the id is read here
      // and branded at the one boundary that has to name the host type.
      owner: (owner as { id: SessionId }).id,
      ...(exec.callId === undefined || exec.rootCallId === undefined
        ? {}
        : { toolCall: { callId: exec.callId as JobToolCall['callId'], rootCallId: exec.rootCallId as JobToolCall['rootCallId'] } }),
      label,
      send,
    })
  }

  ctx.tools.register(defineTool({
    name: 'pty_open',
    description:
      'Open a PTY session: spawn the command on a ConPTY, optionally set env vars (process-level injection). ' +
      'The session stays alive across turns until pty_close or owner disposal. Byte-stream only — no protocol parsing. ' +
      'For a run-once-and-done command pass autoClose: true. ' +
      // #146: the command-spawn semantics, stated once and quoted by the
      // `command` parameter too — the agent must learn win32's direct spawn
      // from the face it reads, not from a failure.
      PTY_COMMAND_SEMANTICS + ' ' +
      // #149: the session-level shell, stated as the surface contract.
      'Declare a SESSION-LEVEL SHELL with shellCommand — one bare command line (executable plus its interactive argv): ' +
      'subsequent pty_send writes are then interpreted by that shell, so a plain `cd … && … | …` works across sends with no per-command wrapper ' +
      'and no wrapper echo. `command` and `shellCommand` are mutually exclusive; when both are omitted the configured ' +
      'defaultShellCommand applies, and with no default either the call fails loudly naming all three. ' +
      'A shell session is a SHELL TARGET: pty_signal refuses SIGKILL on it (killing a shell cannot reclaim the children it owns) — ' +
      'use pty_close, the single close path. ' + AUTO_CLOSE_SEMANTICS,
    parameters: {
      command: {
        type: 'string',
        description:
          'Plain command to run on the PTY. ' + PTY_COMMAND_SEMANTICS + ' ' +
          'Mutually exclusive with shellCommand; omit both to use the configured defaultShellCommand. ' +
          'For a PERSISTENT shell session use shellCommand instead.',
      },
      shellCommand: {
        type: 'string',
        description:
          'Session-level shell: a bare command line (executable plus interactive argv, e.g. a resolved bash/pwsh path with ' +
          '--login -i, or a plain `pwsh`). Its pty_send text is interpreted by that shell. Mutually exclusive with command. ' +
          'No preset resolution: the string is spawned literally (a value shaped like a launcher preset id stays a command). ' +
          'Windows spawns it directly; POSIX still rides /bin/sh -c, so expect one extra `sh` parent — the pid reported is that sh. ' +
          'Env/PATH are fixed at spawn: a temporary switch (typing another interpreter\'s launch line, then exit) changes the ' +
          'interpreter only, never the environment.',
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
        description: AUTO_CLOSE_SEMANTICS,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true, description: 'Opaque session id for send/tail/close.' },
          pid: { type: 'number', description: 'Top-level process id when the backend exposes one.' },
          status: {
            type: 'object',
            additionalProperties: true,
            description:
              'Top-level process status: { kind: "running" } while the process lives, or { kind: "exited", exitCode } once it ended — ' +
              'the same shape pty_list / pty_send report (the autoClose parameter states when a one-shot result is the exited form).',
            properties: {
              kind: { type: 'string', description: '"running" while the process lives; "exited" after its exit event.' },
              exitCode: { type: 'number', description: 'The process exit code on the exited form, when the backend reported one.' },
            },
          },
          initialOutput: { type: 'string', description: 'Output captured during spawn/command start.' },
          shellCommand: {
            type: 'string',
            description:
              'Present exactly when the session is a SHELL TARGET: the resolved interpreter command ' +
              '(the explicit shellCommand, or the configured defaultShellCommand when the call was argument-less).',
          },
        },
      },
      render: jsonRender as any,
    },
    async execute(args: { command?: string; shellCommand?: string; cwd?: string; env?: Record<string, string>; autoClose?: boolean }, exec: { agent?: Owner; signal?: AbortSignal }) {
      const owner = requireAgent(exec)
      const declaration = resolveShellDeclaration(args, config.defaultShellCommand)
      const opened = await facade.open(owner, {
        command: declaration.command,
        // The shell-target marker rides the core's existing open spec (#119);
        // no second public boolean is introduced on the tool surface.
        ...(declaration.shell ? { shell: true } : {}),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.env === undefined ? {} : { env: args.env }),
        ...(args.autoClose === undefined ? {} : { autoClose: args.autoClose }),
      }, exec.signal)
      return declaration.shellCommand === undefined ? opened : { ...opened, shellCommand: declaration.shellCommand }
    },
    presentCall: (args: { command?: string; shellCommand?: string }) => ({ card: 'terminal', title: args.shellCommand ?? args.command ?? 'pty_open' }),
  }))

  ctx.tools.register(defineTool({
    name: 'pty_send',
    description:
      'Write bytes into a live PTY session and return the output read while the write settled.' +
      (enableRunInBackground ? RUN_IN_BACKGROUND_SUFFIX : ''),
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from pty_open.' },
      data: { type: 'string', required: true, description: 'Text to write into the session.' },
      submit: { type: 'boolean', description: 'Whether to write the backend\'s Enter sequence after data (default true).' },
      ...(enableRunInBackground ? { run_in_background: RUN_IN_BACKGROUND_PARAM } : {}),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...BACKGROUND_RESULT_PROPERTIES,
          delta: { type: 'string', description: 'Output produced since the previous read (foreground calls).' },
          status: { type: 'object', additionalProperties: true, description: 'Top-level session status at settlement.' },
        },
      },
      render: renderSend,
    },
    async execute(args: { id: string; data: string; submit?: boolean; run_in_background?: boolean }, exec: SendExec) {
      const owner = requireAgent(exec)
      if (args.run_in_background === true) {
        return background(owner, exec, `${args.id}: ${args.data || '(input)'}`,
          (signal) => facade.send(owner, args.id, { data: args.data, submit: args.submit, signal }))
      }
      return facade.send(owner, args.id, { data: args.data, submit: args.submit, signal: exec.signal })
    },
    presentCall: presentSendCall,
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

  ctx.tools.register(defineTool({
    name: 'pty_list',
    description:
      'List the persistent PTY sessions owned by the CURRENT agent (owner-scoped: another agent\'s sessions are never listed). ' +
      'Each row carries the session id, its status ({ kind: "running" } or { kind: "exited", exitCode? }) and the top-level pid when the backend exposes one. ' +
      'Order is stable — creation order (the numeric id suffix) — so repeated calls line up. ' +
      'An exited session stays listed until pty_close reclaims it (the persistent-session contract).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            description: 'The owner\'s own sessions, creation order (empty when it holds none).',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', required: true, description: 'Session id — pass to pty_send / pty_tail / pty_close / pty_signal.' },
                status: { type: 'object', additionalProperties: true, description: 'Session status: { kind: "running" } or { kind: "exited", exitCode? }.' },
                pid: { type: 'number', description: 'Top-level process id, when the backend exposes one.' },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: { sessions?: Array<{ id: string; status?: { kind?: string }; pid?: number }> }) => {
        const rows = value.sessions ?? []
        if (rows.length === 0) return [{ type: 'text' as const, text: '(no sessions)' }]
        const lines = rows.map((row) => {
          const pid = row.pid === undefined ? '' : `  pid=${String(row.pid)}`
          return `${row.id}  ${row.status?.kind ?? 'unknown'}${pid}`
        })
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(_args: Record<string, never>, exec: { agent?: Owner }) {
      const owner = requireAgent(exec)
      return { sessions: facade.list(owner) }
    },
    presentCall: () => ({ card: 'terminal', title: 'pty_list' }),
  }))

  ctx.tools.register(defineTool({
    name: 'pty_signal',
    description:
      'Send an allowed signal to one of your own PTY sessions: ' + PTY_SIGNALS.join(' / ') + '. Owner-scoped like every pty_* call (a foreign id is a loud error). ' +
      'Delivering a signal never closes the session — read the aftermath with pty_tail, then pty_close. ' +
      PTY_SIGNAL_SEMANTICS,
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from pty_open / shell_open / ssh_start.' },
      signal: {
        type: 'string',
        required: true,
        enum: PTY_SIGNALS,
        description: 'The signal to deliver. On Windows/ConPTY only SIGTERM and SIGKILL are accepted (both terminate); see the tool description for the full platform semantics.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string', required: true, description: 'The session this call addressed.' },
          signal: { type: 'string', required: true, description: 'The accepted signal name.' },
          delivered: { type: 'boolean', required: true, description: 'False when the session had already exited — nothing was delivered.' },
          semantics: { type: 'string', description: '"signal" = real POSIX delivery, "terminate" = Windows/ConPTY teardown; absent when not delivered.' },
          status: { type: 'object', additionalProperties: true, description: 'Session status at call time (the exit event from a terminate lands asynchronously — re-read with pty_list / pty_tail).' },
        },
      },
      render: jsonRender as any,
    },
    async execute(args: { id: string; signal: string }, exec: { agent?: Owner }) {
      const owner = requireAgent(exec)
      return facade.signal(owner, args.id, args.signal)
    },
    presentCall: (args: { id: string; signal: string }) => ({ card: 'terminal', title: `signal ${args.signal} ${args.id}` }),
  }))

  registerSshTools(ctx, facade, { enabled: enableRunInBackground, start: background })
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
 * the remote one-shot world — the standalone `dsh-shell-remote` plugin since
 * ADR-0013 (route C; formerly this package's ssh backend) — this instance is
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

function registerSshTools(ctx: PtyCtx, core: { open(owner: unknown, spec: { command: string }, signal?: AbortSignal): Promise<any>; send(owner: unknown, id: string, request: { data: string; submit?: boolean; signal?: AbortSignal }): Promise<any>; tail(owner: unknown, id: string, lines?: number): any; close(owner: unknown, id: string): Promise<{ closed: boolean }> }, background: BackgroundSendBridge) {
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
    description:
      'Write bytes into the live ssh session and return the output read while the write settled. Core passthrough.' +
      (background.enabled ? RUN_IN_BACKGROUND_SUFFIX : ''),
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from ssh_start.' },
      data: { type: 'string', required: true, description: 'Text to write into the session.' },
      submit: { type: 'boolean', description: 'Whether to write the backend\'s Enter sequence after data (default true).' },
      ...(background.enabled ? { run_in_background: RUN_IN_BACKGROUND_PARAM } : {}),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...BACKGROUND_RESULT_PROPERTIES,
          delta: { type: 'string', description: 'Output produced since the previous read (foreground calls).' },
          status: { type: 'object', additionalProperties: true, description: 'Session status at settlement — kind "exited" means the session dropped (no auto-reconnect).' },
        },
      },
      render: renderSend,
    },
    async execute(args: { id: string; data: string; submit?: boolean; run_in_background?: boolean }, exec: SendExec) {
      const owner = requireAgent(exec)
      if (args.run_in_background === true) {
        return background.start(owner, exec, `${args.id}: ${args.data || '(input)'}`,
          (signal) => core.send(owner, args.id, { data: args.data, submit: args.submit, signal }))
      }
      return core.send(owner, args.id, { data: args.data, submit: args.submit, signal: exec.signal })
    },
    presentCall: presentSendCall,
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

/**
 * Register the entry's ONE prompt contribution (#149 AC10): the environment
 * fact listing this machine's resolved launcher environments.
 *
 * The registration rides a CHILD FIBER (`ctx.inject`) instead of being a
 * required service of the entry: the pty TOOLS must load in a tools-only
 * deployment that mounts no prompt registry (they would otherwise be gated on a
 * surface they do not use), while a registry mounted AFTER this row still gets
 * the context — the child fiber waits for it, which an opportunistic
 * `ctx.get('systemPrompt')` read at apply time would miss.
 *
 * Deliberately NOT `required`: a deployment that turns optional runtime context
 * off keeps its own choice (the pty tools never depend on this line).
 * `interpolate: false` because the text carries filesystem paths — a path
 * containing `{{` would otherwise make prompt assembly throw.
 */
function registerEnvironmentContext(ctx: PtyCtx, deps: PtyDeps): void {
  if (ctx.inject === undefined) return
  ctx.inject(['systemPrompt'], (scope) => {
    const systemPrompt = scope.get('systemPrompt') as SystemPromptCtx | undefined
    if (systemPrompt === undefined) {
      // cordis only runs the child fiber once the service exists; this is the
      // duck-typed harness's guard, kept loud rather than a silent no-op.
      throw new Error('dsh-shell-host/pty: the systemPrompt child fiber ran without the service')
    }
    const text = createEnvironmentContextText(deps.detectEnvironments ?? (() => detectEnvironmentRows()))
    systemPrompt.context({
      name: ENVIRONMENT_CONTEXT_NAME,
      order: ENVIRONMENT_CONTEXT_ORDER,
      interpolate: false,
      text,
    })
  })
}

/** Plugin entry: register the pty_* tool surface over the self-managed core,
 * plus the environment context (a fact the tool surface benefits from). */
function apply(ctx: PtyCtx, config: unknown, deps: PtyDeps = {}) {
  registerPtySession(ctx, resolveConfig(config), deps)
  registerEnvironmentContext(ctx, deps)
}

export { Config, apply, inject, name }

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
 * #136: the ssh family (`ssh_start` / `ssh_tail` / `ssh_send` / `ssh_close`)
 * moved to its own `./ssh` entry — this entry is the SESSION CORE only. It
 * still provides the `pty` service, so ssh sessions share this registry
 * (`pty_list` / `pty_signal` see them exactly as before); the two families'
 * model-facing helpers live in `src/tool-support.ts`.
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
import { createSessionCore, resolveCoreConfig, DEFAULT_TAIL_LINES, DEFAULT_MAX_SESSIONS, extractSpec, AUTO_CLOSE_SEMANTICS, PTY_COMMAND_SEMANTICS, PTY_SIGNALS, PTY_SIGNAL_SEMANTICS, type SessionCore, type SessionCoreConfig, type OpenSpec, type CoreSpawnSpec, type PtyLike } from './session-core.ts'
import {
  ENVIRONMENT_CONTEXT_NAME,
  ENVIRONMENT_CONTEXT_ORDER,
  createEnvironmentContextText,
  detectEnvironmentRows,
  type EnvironmentRow,
} from './environment-context.ts'
import {
  SANDBOX_EXECUTION_SEMANTICS,
  createPermissionGate,
  sandboxPermissionParameters,
  sandboxSessionWriteSemantics,
  sessionOf,
  type PermissionGate,
  type SandboxMode,
} from '../permission-gate.ts'
import {
  BACKGROUND_RESULT_PROPERTIES,
  RUN_IN_BACKGROUND_PARAM,
  RUN_IN_BACKGROUND_SUFFIX,
  createBackgroundStarter,
  jsonRender,
  presentSendCall,
  renderSend,
  requireAgent,
  type BackgroundStarter,
  type Owner,
  type SendExec,
} from '../tool-support.ts'

const name = 'dsh-pty-session'
// #149 contributes a prompt context, but the TOOLS must never wait on the
// prompt registry: a tools-only deployment without one still gets the whole pty
// surface. The contribution rides a child fiber instead (see
// registerEnvironmentContext), so the prompt surface is NOT a dependency.
// #102: the two HOST PERMISSION services ARE real dependencies now — every
// execution resolves `sandboxPolicy` and an escalation asks `approval`, and the
// gate fails closed without them. Declaring them here (host convention) makes a
// deployment that lacks either one refuse to activate this row instead of
// serving tools that can only fail per call.
const inject = ['tools', 'sandboxPolicy', 'approval']

/** Runtime configuration schema — the `./pty` entry's own settings namespace. */
export interface PtyConfig extends SessionCoreConfig {
  /** Global default session shell (#149 Q3/Q6): a bare command line, the same
   * shape as `pty_open({ shellCommand })`. Reached ONLY by the argument-less
   * `pty_open()` call shape — it never overrides an explicit `command` or
   * `shellCommand`. No default value = no global default. */
  defaultShellCommand?: string
  /** Background sends (#120): expose `run_in_background` on `pty_send` and
   * accept it. Default true — the official `terminal_send` posture; false makes
   * every background request fail loudly instead of silently degrading to a
   * foreground settle. #136: the ssh family moved to `./ssh` and carries its own
   * copy of this setting in ITS namespace (`ssh.enableRunInBackground`). */
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

  /** #102: the host permission model for every execution on this surface —
   * one gate instance, so `pty_open` / `ssh_start` authorize and `pty_send` /
   * `ssh_send` re-resolve against the SAME policy source. */
  const gate: PermissionGate = createPermissionGate(ctx)

  /**
   * Programmatic facade: the four pty_* tool semantics as callable functions
   * for CONSUMER PLUGINS (T5 gdb, terminal's shell_open, ssh). Consumers
   * pass the owner explicitly (`exec.agent` from their own tool execution);
   * they must never touch another agent's sessions (the core enforces this).
   *
   * #102: the facade is the raw execution channel — it does NOT authorize.
   * A consumer that opens sessions is responsible for driving its own
   * `permission-gate` (the `./terminal` entry does exactly that) and for
   * passing the resulting `authorizedMode` on the open spec, so the pty
   * surface can still detect a later policy downgrade.
   */
  const facade = {
    /** Spawn the command on a ConPTY with env injected into the process. */
    open: (owner: Owner, spec: { command?: string; cwd?: string; env?: Record<string, string>; idleTimeoutMs?: number; autoClose?: boolean; shell?: boolean; authorizedMode?: SandboxMode }, signal?: AbortSignal): Promise<any> =>
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

    /** #102: the sandbox mode the session was AUTHORIZED under (the mode the spawn
     * ran at — the one-shot grant when an escalation was approved). This is the
     * write baseline the send gate re-checks on every write. */
    modeOf: (owner: Owner, id: string): SandboxMode | undefined => core.modeOf(owner, id),

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
   * the output source all live in `background-send.ts`, and the bridge itself in
   * `src/tool-support.ts` (#136: the ssh family has its own entry and its own
   * `enableRunInBackground`, but uses this same builder).
   */
  const background: BackgroundStarter = createBackgroundStarter(ctx, enableRunInBackground)

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
      'use pty_close, the single close path. ' + AUTO_CLOSE_SEMANTICS + ' ' +
      // #102: the permission contract, stated on the face the model reads.
      SANDBOX_EXECUTION_SEMANTICS,
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
      ...sandboxPermissionParameters('command'),
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
          sandboxMode: {
            type: 'string',
            description:
              'The sandbox mode this spawn ran under (the session policy, or the approved one-shot escalation target).',
          },
        },
      },
      render: jsonRender as any,
    },
    async execute(args: { command?: string; shellCommand?: string; cwd?: string; env?: Record<string, string>; autoClose?: boolean; sandbox_permissions?: string; justification?: string }, exec: { agent?: Owner; signal?: AbortSignal; callId?: string }) {
      const owner = requireAgent(exec)
      const declaration = resolveShellDeclaration(args, config.defaultShellCommand)
      // #102: authorize BEFORE anything spawns — the gate resolves the policy
      // per execution and routes an escalation through the official approval
      // service (only 'allowed-once' grants; the grant covers this one call).
      const authorization = await gate.authorizeSpawn({
        toolName: 'pty_open',
        agent: owner,
        session: sessionOf(owner),
        callId: exec.callId,
        signal: exec.signal,
        cwd: args.cwd,
        sandboxPermissions: args.sandbox_permissions,
        justification: args.justification,
        subject: 'command',
        // The free-command-line spawn points at shell_open in its denial
        // (ticket 「命令白名单」§2).
        presetChannel: true,
      })
      const opened = await facade.open(owner, {
        command: declaration.command,
        // The shell-target marker rides the core's existing open spec (#119);
        // no second public boolean is introduced on the tool surface.
        ...(declaration.shell ? { shell: true } : {}),
        // Under workspace-write this is the concrete boundary cwd (see the
        // gate); under danger-full-access it is the caller's value, unchanged.
        ...(authorization.cwd === undefined ? {} : { cwd: authorization.cwd }),
        ...(args.env === undefined ? {} : { env: args.env }),
        ...(args.autoClose === undefined ? {} : { autoClose: args.autoClose }),
        // The mode the spawn was AUTHORIZED under (the one-shot grant when an
        // escalation was approved) is the session's write baseline: `pty_send`
        // re-resolves against it, so a grant never becomes a standing write
        // permission (it was one call only).
        authorizedMode: authorization.grantedMode,
      }, exec.signal)
      return {
        ...opened,
        ...(declaration.shellCommand === undefined ? {} : { shellCommand: declaration.shellCommand }),
        sandboxMode: authorization.grantedMode,
      }
    },
    presentCall: (args: { command?: string; shellCommand?: string }) => ({ card: 'terminal', title: args.shellCommand ?? args.command ?? 'pty_open' }),
  }))

  ctx.tools.register(defineTool({
    name: 'pty_send',
    description:
      'Write bytes into a live PTY session and return the output read while the write settled. ' +
      sandboxSessionWriteSemantics('pty_close') +
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
      // #102 §5: re-resolve on EVERY write; a session opened under a wider mode
      // must stop accepting bytes once the policy narrows (the old grant is
      // not reused). Reads (pty_tail) and the close path stay ungated.
      gate.assertSessionWritable({
        toolName: 'pty_send',
        agent: owner,
        session: sessionOf(owner),
        sessionId: args.id,
        authorizedMode: facade.modeOf(owner, args.id),
        closeTool: 'pty_close',
      })
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

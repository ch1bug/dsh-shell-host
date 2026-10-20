/**
 * dsh-shell-host `./ssh` entry (#136) — the interactive ssh instance as its
 * OWN component, over the `./pty` entry's session core.
 *
 * Four tools, unchanged in behavior from their pre-#136 home (`./pty`):
 *
 *   ssh_start({ host, jump?, port?, shell?, options? }) → { sessionId, … }
 *       compose the ssh command line (`src/ssh/compose.ts`, the single source
 *       shared with the launcher layer) and open it on the core PTY — a
 *       long-lived remote shell with intermediate output visible;
 *   ssh_tail({ id, lines? })  → incremental read from the per-session cursor;
 *   ssh_send({ id, data, submit?, run_in_background? }) → write bytes, return
 *       the delta read (or a host job id when run in background);
 *   ssh_close({ id })         → clean termination + reclaim (idempotent).
 *
 * Division of labor (README-documented): ONE-SHOT remote commands belong to the
 * standalone `dsh-shell-remote` plugin (ADR-0013, route C); this entry is for
 * sessions a human/agent converses with.
 *
 * Division of labor with `./pty`: the session CORE (registry, cursors, cap,
 * idle watch) stays in `./pty`, which provides it as the `pty` service. This
 * entry consumes that service — ssh sessions and pty sessions share ONE
 * registry, so `pty_list` / `pty_signal` see ssh sessions exactly as before.
 * The tools never touch another agent's sessions (the core enforces it).
 *
 * Independent settings namespace (`ssh`, via the Config export + the patch row
 * id): the ssh family owns `enableRunInBackground`. A deployment that mounted
 * only the `pty` row before #136 therefore LOSES the ssh tools until it adds
 * the `ssh` row — stated in the README (migration details live in T7).
 *
 * Permission model (#102, unchanged): `ssh_start` is a local PROCESS spawn and
 * `ssh_send` is a session write, so both drive the host gate — one gate
 * instance, so the open and the write re-resolve against the SAME policy
 * source. The `inject` declaration makes a deployment without either permission
 * service refuse to activate this row (the gate fails closed per call too).
 *
 * Transport shape (ADR-0017, `src/ssh/transport.ts`): v1 opens one independent
 * connection per session on every client; the result carries the shape as a
 * structured fact so `remote_status` (#137–#140) can report it. No ControlMaster
 * is attempted here — and never on Windows (measured unusable there, and a
 * failed attempt on every start would be pure noise).
 *
 * @module dsh-shell-host/ssh
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  SSH_KEEPALIVE_COUNT_DEFAULT,
  SSH_KEEPALIVE_INTERVAL_DEFAULT,
  composeSshCommand,
  type SshOptionInput,
} from './compose.ts'
import { sessionTransport, type SshTransport } from './transport.ts'
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
  type SendExec,
} from '../tool-support.ts'

const name = 'dsh-shell-host-ssh'
// #102: ssh_start/ssh_send drive the host permission gate, so both host
// services are REAL dependencies (the gate fails closed without them; declaring
// them makes the row refuse to activate instead of serving tools that can only
// fail per call). #136: `pty` is the session core this entry opens ssh sessions
// on — its absence is equally a configuration error, not a per-call surprise.
const inject = ['tools', 'pty', 'sandboxPolicy', 'approval']

/** Runtime configuration schema — the `./ssh` entry's own settings namespace. */
export interface SshConfig {
  /** Background sends (#120): expose `run_in_background` on `ssh_send` and
   * accept it. Default true — the official `terminal_send` posture; false makes
   * every background request fail loudly instead of silently degrading to a
   * foreground settle. Lives HERE (not on `./pty`) since #136: the ssh family
   * owns its own settings namespace. */
  enableRunInBackground: boolean
}

const Config = z.object({
  /** Background sends (#120): expose and accept `run_in_background`
   * (default true, the official posture). */
  enableRunInBackground: z.boolean().default(true),
})

function resolveConfig(raw: unknown): SshConfig {
  const c = (raw ?? {}) as Partial<SshConfig>
  return {
    // #120: absent = the default (true). Only an explicit `false` closes the
    // background path — a non-boolean reaches the schema layer, which rejects it
    // long before a send runs.
    enableRunInBackground: c.enableRunInBackground !== false,
  }
}

/** The tool-execution context slice the entry consumes (duck-typed seam). */
interface SshCtx {
  tools: { register: (tool: unknown) => void }
  get: (name: string) => unknown
}

/** The `pty` service slice this entry consumes (the `./pty` facade). Duck-typed
 * like the terminal entry's: the core owns owner scoping, cursors and the
 * authorized-mode bookkeeping; this entry only opens/sends/tails/closes. */
interface SshSessionCore {
  open(owner: unknown, spec: { command: string; cwd?: string; authorizedMode?: SandboxMode }, signal?: AbortSignal): Promise<any>
  send(owner: unknown, id: string, request: { data: string; submit?: boolean; signal?: AbortSignal }): Promise<any>
  tail(owner: unknown, id: string, lines?: number): any
  close(owner: unknown, id: string): Promise<{ closed: boolean }>
  modeOf(owner: unknown, id: string): SandboxMode | undefined
}

/**
 * Register the four ssh tools over the pty entry's session core.
 *
 * `ssh_start` composes the command line and opens it on the core PTY (long-lived
 * remote shell, sees intermediate output); tail/send/close are thin
 * passthroughs with their own tool names so agent-facing surfaces read
 * coherently.
 *
 * Reconnect semantics (issue AC): explicit RECONNECT-NO — a dead session
 * (network cut, remote drop) surfaces `status.kind = "exited"` on the next
 * send/tail; nothing auto-reconnects. Recovery = `ssh_start` again (new session
 * id); the dead id is reclaimed by `ssh_close` (idempotent).
 *
 * Long-session hardening (#21 phase 1): keepalive defaults
 * (ServerAliveInterval=15 / ServerAliveCountMax=4) ride on every start —
 * NAT/firewall idle drops otherwise kill sessions silently — plus `port` (-p)
 * and free `-o` passthrough via `options` (the remote workspace capabilities
 * build on this surface next).
 */
function registerSshTools(ctx: SshCtx, config: SshConfig): void {
  const core = ctx.get('pty') as SshSessionCore | undefined
  if (core === undefined) {
    throw new Error('ssh: the pty session core is missing — mount the dsh-shell-host/pty entry alongside ./ssh')
  }
  /** #102: one gate instance, so `ssh_start` authorizes and `ssh_send`
   * re-resolves against the SAME policy source. */
  const gate: PermissionGate = createPermissionGate(ctx)
  /** #120: the ssh family's own background gate (its own settings namespace).
   * Resolved ONCE: the parameter face, the description tail and the executor all
   * read this value, so they cannot disagree about whether the path is open. */
  const backgroundEnabled = config.enableRunInBackground
  const background: BackgroundStarter = createBackgroundStarter(ctx, backgroundEnabled)

  ctx.tools.register(defineTool({
    name: 'ssh_start',
    description:
      'Open an interactive ssh session on a PTY (full duplex: long-lived remote shell, intermediate output visible). ' +
      `Keepalive defaults (${SSH_KEEPALIVE_INTERVAL_DEFAULT}/${SSH_KEEPALIVE_COUNT_DEFAULT}) are injected unless overridden via options. ` +
      'Returns a sessionId for ssh_tail / ssh_send / ssh_close. One-shot remote commands should use the ssh backend instead. ' +
      'No auto-reconnect: a dropped session reports status exited; recover by calling ssh_start again. ' +
      // #102: ssh_start is a local PROCESS spawn (and `-o ProxyCommand=…` is
      // arbitrary local execution), so it takes the same policy gate as
      // pty_open — otherwise it would be the bypass that ticket removes.
      SANDBOX_EXECUTION_SEMANTICS,
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
      ...sandboxPermissionParameters('command'),
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
          sandboxMode: {
            type: 'string',
            description: 'The sandbox mode this ssh spawn ran under (the session policy, or the approved one-shot escalation target).',
          },
          transport: {
            type: 'object',
            additionalProperties: true,
            description:
              'The transport shape this session actually opened in (ADR-0017). shape = "per-session-connection" today on every ' +
              'client; controlMasterUsable reports whether this client could multiplex at all (POSIX only — the Windows client ' +
              'cannot, measured). remote_status (#137–#140) reports this rather than re-deriving it.',
          },
        },
      },
      render: jsonRender as any,
    },
    async execute(rawArgs: { host: string; jump?: string; port?: number; shell?: string; options?: SshOptionInput[]; sandbox_permissions?: string; justification?: string }, exec: SendExec) {
      const owner = requireAgent(exec)
      const command = composeSshCommand(rawArgs)
      const authorization = await gate.authorizeSpawn({
        toolName: 'ssh_start',
        agent: owner,
        session: sessionOf(owner),
        callId: exec.callId,
        signal: exec.signal,
        sandboxPermissions: rawArgs.sandbox_permissions,
        justification: rawArgs.justification,
        subject: 'command',
      })
      const opened = await core.open(owner, {
        command,
        ...(authorization.cwd === undefined ? {} : { cwd: authorization.cwd }),
        // The grant actually used is the ssh session's write baseline (one call only).
        authorizedMode: authorization.grantedMode,
      }, exec.signal)
      // ADR-0017 decision 5: the accounting unit is a connection, so the shape
      // travels with the session result instead of being re-derived later.
      const transport: SshTransport = sessionTransport()
      return { ...opened, sandboxMode: authorization.grantedMode, transport }
    },
    presentCall: (args: { host: string }) => ({ card: 'terminal', title: `ssh ${args.host}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'ssh_send',
    description:
      'Write bytes into the live ssh session and return the output read while the write settled. Core passthrough. ' +
      sandboxSessionWriteSemantics('ssh_close') +
      (backgroundEnabled ? RUN_IN_BACKGROUND_SUFFIX : ''),
    parameters: {
      id: { type: 'string', required: true, description: 'Session id from ssh_start.' },
      data: { type: 'string', required: true, description: 'Text to write into the session.' },
      submit: { type: 'boolean', description: 'Whether to write the backend\'s Enter sequence after data (default true).' },
      ...(backgroundEnabled ? { run_in_background: RUN_IN_BACKGROUND_PARAM } : {}),
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
      // #102 §5: same re-resolve rule as pty_send (one ambient policy source).
      gate.assertSessionWritable({
        toolName: 'ssh_send',
        agent: owner,
        session: sessionOf(owner),
        sessionId: args.id,
        authorizedMode: core.modeOf(owner, args.id),
        closeTool: 'ssh_close',
      })
      if (args.run_in_background === true) {
        return background(owner, exec, `${args.id}: ${args.data || '(input)'}`,
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
    async execute(args: { id: string; lines?: number }, exec: { agent?: unknown }) {
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
    async execute(args: { id: string }, exec: { agent?: unknown }) {
      const owner = requireAgent(exec)
      return core.close(owner, args.id)
    },
    presentCall: (args: { id: string }) => ({ card: 'terminal', title: `close ${args.id}` }),
  }))
}

/** Plugin entry: register the ssh tool surface over the pty entry's core. */
function apply(ctx: SshCtx, config: unknown): void {
  registerSshTools(ctx, resolveConfig(config))
}

export { Config, apply, inject, name }

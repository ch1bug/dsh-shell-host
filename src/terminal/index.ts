/**
 * dsh-shell-host `./terminal` entry (issue #55, ADR-0008; seam-free since
 * #61/ADR-0010): the launcher-layer PLUGIN-LAYER entry — the same entry form
 * as `./wsl` (defineTool + ctx.tools; registers model tools, not execution
 * backends, ADR-0007 "Entry form differences"). One tool, `shell_open
 * (preset, cwd?, env?, idleTimeoutMs?)`: resolves the (transport × shell-env)
 * preset through the #54 launcher layer (`src/launchers.ts`, whose
 * absent/unknown loud postures are inherited) and opens it on the pty
 * entry's session core — the returned sessionId IS the core session id,
 * operated afterwards with the existing pty_send / pty_tail / pty_close
 * tools. No forwarding tools (ADR-0008 decision 5, no Middle Man).
 *
 * A local preset composes `executable + interactive argv` as the launch
 * command; a custom ssh preset's composed command (keepalive defaults +
 * options semantics, single-sourced from the pty entry's composeSshCommand)
 * is the launch command verbatim — the same shape ssh_start opens. Env rides
 * the spawn spec at process birth (#53 VS Code profile semantics); the
 * preset's PATH prefix is prepended ahead of the inherited PATH under the
 * inherited key's own casing.
 *
 * Independent settings namespace (Config export, sibling-entry convention):
 * the custom preset data channel (shape finalized in #54, the later CRUD UI
 * reads/writes the same data). The built-in preset table is read-only — its
 * live view is surfaced by the loud unknown-id error, which enumerates the
 * resolved preset ids.
 *
 * #61: the cap count and the per-session idle timeout are CORE-derived now
 * (the pty core's registry is the single fact source — the #62 remount
 * zeroing is structurally gone): shell_open reads `core.active(owner)` for
 * the cap and hands `idleTimeoutMs` to the core's own watcher.
 * @module dsh-shell-host/terminal
 */

import z from '@deepseek-ai/schemastery'
import { delimiter } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveLauncherDetailed, type CustomLauncherConfig, type LauncherDeps, type LocalLauncherPreset, type ResolvedLauncher } from '../launchers.ts'
import { spawnableExists } from '../detect.ts'
import { DEFAULT_MAX_SESSIONS as CORE_DEFAULT_MAX_SESSIONS } from '../pty/session-core.ts'

const name = 'dsh-shell-host-terminal'
const inject = ['tools', 'pty']

/** Default concurrent-session soft cap (#56 ruling 3) — the terminal-side
 * settings surface; the pty core enforces its own copy of the same default. */
export const DEFAULT_MAX_SESSIONS = 8

/** Runtime configuration schema — the `./terminal` entry's own settings
 * namespace. `custom` is the custom-preset data channel (the #54
 * CustomLauncherConfig shape, persisted; CRUD UI is a later ticket).
 * `maxSessions` is the concurrent-session soft cap counted over the pty
 * CORE's registry (#61/#62) for the owning agent. */
export interface TerminalConfig {
  custom: CustomLauncherConfig[]
  maxSessions: number
}

const Config = z.object({
  /** Custom launcher presets (the #54 data shape): local rows declare
   * executable (or inherit a built-in `base`), ssh rows declare host (+ the
   * ssh connection fields). A custom id overrides a built-in view. */
  custom: z.array(z.any()).default([]),
  /** Concurrent-session soft cap (#56): shell_open fails loudly once an
   * owner's own active sessions reach this count. */
  maxSessions: z.number().default(DEFAULT_MAX_SESSIONS),
})

function resolveConfig(raw: unknown): TerminalConfig {
  const c = (raw ?? {}) as Partial<TerminalConfig>
  const maxSessions = c.maxSessions ?? DEFAULT_MAX_SESSIONS
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error(`terminal: maxSessions must be a positive integer, got: ${JSON.stringify(c.maxSessions)}`)
  }
  return { custom: Array.isArray(c.custom) ? c.custom : [], maxSessions }
}

/** The tool-execution context slice the entry consumes (duck-typed seam). */
interface TerminalCtx {
  tools: { register: (tool: unknown) => void }
  get: (name: string) => unknown
}

/** The pty entry's session core facade (provided as the `pty` service).
 * #61: `active` is the registry-derived liveness view (#62's fact source);
 * `open` accepts the opt-in per-session idleTimeoutMs, enforced by the
 * core's own watcher (output-defined idle, #56 ruling). */
interface PtyCore {
  open(owner: unknown, spec: { command: string; cwd?: string; env?: Record<string, string>; idleTimeoutMs?: number }, signal?: AbortSignal): Promise<{ sessionId: string; initialOutput?: string; [key: string]: unknown }>
  close(owner: unknown, id: string): Promise<{ closed: boolean }>
  active(owner: unknown): string[]
}

/**
 * The launch command for a local preset: the first EXISTING executable
 * candidate (resolveLauncher already proved at least one exists; re-checking
 * keeps the loud posture if the machine changed mid-flight) + the preset's
 * interactive argv. Paths with spaces double-quote — quoting that is valid
 * for every dialect the ConPTY wrapper can host (bash / pwsh / cmd); argv
 * atoms are passed verbatim. Returns the HIT candidate too — the shell_open
 * result's `executable` field (#56).
 */
function localLaunchCommand(preset: LocalLauncherPreset, deps: LauncherDeps): { executable: string; command: string; probed: string[] } {
  const exists = deps.exists ?? spawnableExists
  const executable = preset.executable.find(candidate => exists(candidate))
  if (executable === undefined) {
    throw new Error(`launcher: preset '${preset.id}' has no existing executable candidate. Probed: ${preset.executable.join(', ')}`)
  }
  const exe = executable.includes(' ') ? `"${executable}"` : executable
  return { executable, command: [exe, ...preset.argv].join(' '), probed: [...preset.probed] }
}

/**
 * Merge the preset env, the PATH prefix (ahead of the inherited PATH, under
 * the inherited key's own casing — Windows spells it `Path`), then the tool
 * args' overrides. A fresh object: the preset's env is never mutated.
 */
function launchEnv(preset: ResolvedLauncher, overrides: Record<string, string> | undefined, deps: LauncherDeps): Record<string, string> | undefined {
  // ssh presets carry no shell-env (ADR-0008: ssh is the transport dimension):
  // only tool-arg overrides apply, and they ride the spawn spec — a local
  // preset's env/PATH prefix never leaks onto an ssh connection.
  if (preset.transport === 'ssh') return overrides
  const env: Record<string, string> = { ...preset.env }
  if (preset.pathPrefix.length > 0) {
    const inherited = deps.env ?? process.env
    const pathKey = Object.keys(inherited).find(key => key.toLowerCase() === 'path') ?? 'PATH'
    env[pathKey] = [...preset.pathPrefix, inherited[pathKey] ?? ''].join(delimiter)
  }
  return { ...env, ...overrides }
}

/** Register the single shell_open tool against the pty session core. */
function registerShellOpen(ctx: TerminalCtx, config: TerminalConfig, deps: LauncherDeps): void {
  const core = ctx.get('pty') as PtyCore
  if (core === undefined) {
    throw new Error('terminal: the pty session core is missing — mount the dsh-shell-host/pty entry alongside ./terminal')
  }

  ctx.tools.register(defineTool({
    name: 'shell_open',
    description:
      'Open a persistent terminal for a launcher preset (e.g. msys2-ucrt, pwsh, powershell, wsl, cmd, git-bash, python-repl, zsh, bash, fish — POSIX rows on POSIX platforms — or a configured custom preset). ' +
      'Returns a sessionId that is a PTY session: operate it with pty_send / pty_tail / pty_close — no second tool family. ' +
      'Unknown ids fail loudly listing the available presets; uninstalled environments fail loudly naming every probe point. ' +
      'A per-agent concurrent-session cap applies; idleTimeoutMs opts ONE session into auto-close when it produces no new output for that long.',
    parameters: {
      preset: { type: 'string', required: true, description: 'Launcher preset id (built-in view or configured custom preset).' },
      cwd: { type: 'string', description: 'Working directory override; defaults to the preset\'s cwd.' },
      env: { type: 'object', additionalProperties: true, description: 'Env var overrides merged over the preset env (VS Code profile semantics).' },
      idleTimeoutMs: { type: 'number', description: 'Opt-in per-session idle timeout (ms, positive integer): auto-close the session after this much time with no new output. Omit = never idle-closed (persistent-session contract).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true, description: 'Core session id — pass to pty_send / pty_tail / pty_close.' },
          preset: { type: 'string', required: true, description: 'The resolved preset id.' },
          transport: { type: 'string', required: true, description: '"local" or "ssh".' },
          command: { type: 'string', required: true, description: 'The launch command opened on the PTY.' },
          initialOutput: { type: 'string', description: 'Output captured during launch.' },
          executable: { type: 'string', description: 'The executable candidate that hit (local presets).' },
          probed: { type: 'array', items: { type: 'string' }, description: 'Every probe point considered (local presets).' },
          cwd: { type: 'string', description: 'The effective working directory, when one applies.' },
          source: { type: 'string', required: true, description: '"builtin" or "custom" — where the preset view came from.' },
          overrode: { type: 'boolean', required: true, description: 'True when a custom preset REPLACED a built-in view of the same id (loud flag, never an error).' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args: { preset: string; cwd?: string; env?: Record<string, string>; idleTimeoutMs?: number }, exec: { agent?: unknown; signal?: AbortSignal }) {
      const owner = exec?.agent
      if (owner === undefined) {
        throw Object.assign(new Error('shell_open requires an owning agent session'), { code: 'NO_AGENT' })
      }
      if (args.idleTimeoutMs !== undefined && (!Number.isInteger(args.idleTimeoutMs) || args.idleTimeoutMs <= 0)) {
        throw new Error(`shell_open: idleTimeoutMs must be a positive integer (ms), got: ${JSON.stringify(args.idleTimeoutMs)}`)
      }
      // Soft cap over the owner's OWN active sessions (#56 ruling 3), counted
      // from the CORE registry (#61/#62) — dead rows are pruned there on
      // close, so a pty_close always frees its slot and an entry remount
      // cannot reset the count.
      const active = core.active(owner)
      if (active.length >= config.maxSessions) {
        throw new Error(
          `terminal: shell_open hit the concurrent session limit (max ${config.maxSessions}); ` +
          `${active.length} sessions already active for this agent: ${active.join(', ')}. ` +
          'Close one with pty_close before opening another.',
        )
      }
      const detail = resolveLauncherDetailed(args.preset, deps, config.custom)
      const launcher = detail.launcher
      let launched: { executable: string; command: string; probed: string[] } | undefined
      let command: string
      if (launcher.transport === 'local') {
        launched = localLaunchCommand(launcher, deps)
        command = launched.command
      } else {
        command = launcher.command
      }
      const cwd = launcher.transport === 'local' ? (args.cwd ?? launcher.cwd) : args.cwd
      const env = launchEnv(launcher, args.env, deps)
      const opened = await core.open(owner, {
        command,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
        ...(args.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: args.idleTimeoutMs }),
      }, exec.signal)
      return {
        sessionId: opened.sessionId,
        preset: launcher.id,
        transport: launcher.transport,
        command,
        ...(opened.initialOutput === undefined ? {} : { initialOutput: opened.initialOutput }),
        ...(launched === undefined ? {} : { executable: launched.executable, probed: launched.probed }),
        ...(cwd === undefined ? {} : { cwd }),
        source: detail.source,
        overrode: detail.overrode,
      }
    },
    presentCall: (args: { preset: string }) => ({ card: 'terminal', title: `shell_open ${args.preset}` }),
  }))
}

/** Plugin entry: register the launcher-layer tool surface over the pty core. */
function apply(ctx: TerminalCtx, config: unknown, deps: LauncherDeps = {}): void {
  registerShellOpen(ctx, resolveConfig(config), deps)
}

export { Config, apply, inject, name }

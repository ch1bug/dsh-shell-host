/**
 * dsh-shell-host `./terminal` entry (issue #55, ADR-0008): the launcher-layer
 * PLUGIN-LAYER entry — the same entry form as `./wsl` (defineTool +
 * ctx.tools; registers model tools, not execution backends, ADR-0007 "Entry
 * form differences"). One tool, `shell_open(preset, cwd?, env?)`: resolves
 * the (transport × shell-env) preset through the #54 launcher layer
 * (`src/launchers.ts`, whose absent/unknown loud postures are inherited) and
 * opens it on the pty entry's session core — the returned sessionId IS the
 * seam session id, operated afterwards with the existing pty_send / pty_tail
 * / pty_close tools. No forwarding tools (ADR-0008 decision 5, no Middle
 * Man).
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
 * @module dsh-shell-host/terminal
 */

import z from '@deepseek-ai/schemastery'
import { delimiter } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveLauncher, type CustomLauncherConfig, type LauncherDeps, type LocalLauncherPreset, type ResolvedLauncher } from '../launchers.ts'
import { spawnableExists } from '../detect.ts'

const name = 'dsh-shell-host-terminal'
const inject = ['tools', 'pty']

/** Runtime configuration schema — the `./terminal` entry's own settings
 * namespace. `custom` is the custom-preset data channel (the #54
 * CustomLauncherConfig shape, persisted; CRUD UI is a later ticket). */
export interface TerminalConfig {
  custom: CustomLauncherConfig[]
}

const Config = z.object({
  /** Custom launcher presets (the #54 data shape): local rows declare
   * executable (or inherit a built-in `base`), ssh rows declare host (+ the
   * ssh connection fields). A custom id overrides a built-in view. */
  custom: z.array(z.any()).default([]),
})

function resolveConfig(raw: unknown): TerminalConfig {
  const c = (raw ?? {}) as Partial<TerminalConfig>
  return { custom: Array.isArray(c.custom) ? c.custom : [] }
}

/** The tool-execution context slice the entry consumes (duck-typed seam). */
interface TerminalCtx {
  tools: { register: (tool: unknown) => void }
  get: (name: string) => unknown
}

/** The pty entry's session core facade (provided as the `pty` service). */
interface PtyCore {
  open(owner: unknown, spec: { command: string; cwd?: string; env?: Record<string, string> }, signal?: AbortSignal): Promise<{ sessionId: string; initialOutput?: string; [key: string]: unknown }>
}

/**
 * The launch command for a local preset: the first EXISTING executable
 * candidate (resolveLauncher already proved at least one exists; re-checking
 * keeps the loud posture if the machine changed mid-flight) + the preset's
 * interactive argv. Paths with spaces double-quote — quoting that is valid
 * for every dialect the seam's default terminal can host (bash / pwsh /
 * cmd); argv atoms are passed verbatim.
 */
function localLaunchCommand(preset: LocalLauncherPreset, deps: LauncherDeps): string {
  const exists = deps.exists ?? spawnableExists
  const executable = preset.executable.find(candidate => exists(candidate))
  if (executable === undefined) {
    throw new Error(`launcher: preset '${preset.id}' has no existing executable candidate. Probed: ${preset.executable.join(', ')}`)
  }
  const exe = executable.includes(' ') ? `"${executable}"` : executable
  return [exe, ...preset.argv].join(' ')
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
      'Open a persistent terminal for a launcher preset (e.g. msys2-ucrt, pwsh, powershell, wsl, cmd, git-bash, python-repl, or a configured custom preset). ' +
      'Returns a sessionId that is a PTY seam session: operate it with pty_send / pty_tail / pty_close — no second tool family. ' +
      'Unknown ids fail loudly listing the available presets; uninstalled environments fail loudly naming every probe point.',
    parameters: {
      preset: { type: 'string', required: true, description: 'Launcher preset id (built-in view or configured custom preset).' },
      cwd: { type: 'string', description: 'Working directory override; defaults to the preset\'s cwd.' },
      env: { type: 'object', additionalProperties: true, description: 'Env var overrides merged over the preset env (VS Code profile semantics).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true, description: 'Seam session id — pass to pty_send / pty_tail / pty_close.' },
          preset: { type: 'string', required: true, description: 'The resolved preset id.' },
          transport: { type: 'string', required: true, description: '"local" or "ssh".' },
          command: { type: 'string', required: true, description: 'The launch command opened on the PTY.' },
          initialOutput: { type: 'string', description: 'Output captured during launch.' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args: { preset: string; cwd?: string; env?: Record<string, string> }, exec: { agent?: unknown; signal?: AbortSignal }) {
      const owner = exec?.agent
      if (owner === undefined) {
        throw Object.assign(new Error('shell_open requires an owning agent session'), { code: 'NO_AGENT' })
      }
      const launcher = resolveLauncher(args.preset, deps, config.custom)
      const command = launcher.transport === 'ssh' ? launcher.command : localLaunchCommand(launcher, deps)
      const cwd = launcher.transport === 'local' ? (args.cwd ?? launcher.cwd) : args.cwd
      const env = launchEnv(launcher, args.env, deps)
      const opened = await core.open(owner, {
        command,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
      }, exec.signal)
      return {
        sessionId: opened.sessionId,
        preset: launcher.id,
        transport: launcher.transport,
        command,
        ...(opened.initialOutput === undefined ? {} : { initialOutput: opened.initialOutput }),
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

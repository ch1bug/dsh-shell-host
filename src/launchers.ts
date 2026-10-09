/**
 * Launcher preset layer (issue #54, ADR-0008): the declarative
 * `(transport × shell-env)` startup units behind the `./terminal` entry (T3,
 * #55). A preset is a REUSE VIEW of the backend descriptor layer — the
 * interactive argv templates and PATH-prefix shape come from
 * `src/backends.ts` (single source, no second argv table), the executable
 * candidates from `src/detect.ts` runtime scans — plus pure-data rows for
 * the shells the descriptor layer has no view of (git-bash/cmd/python-repl).
 * ssh is the transport dimension, not a preset: `composeSshLaunch` rides the
 * pty entry's `composeSshCommand` (keepalive defaults + suppression inherit,
 * ADR-0008 decision 1).
 *
 * Postures (#54 AC): an environment that is not installed is ABSENT from the
 * resolution result (never an error at resolution time); SELECTING an absent
 * preset fails loudly naming every probe point. Custom presets read from
 * config (the data shape is finalized here; the CRUD UI is a later ticket)
 * and merge with the built-in views — a custom id overrides a built-in view,
 * `base` references a resolved built-in as the inheritance source.
 * @module dsh-shell-host/launchers
 */

import { delimiter, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  MSYS2_INTERACTIVE_ARGV,
  PWSH_INTERACTIVE_ARGV,
  WSL_INTERACTIVE_ARGV,
  msys2PathPrefix,
  parseWslDistroList,
} from './backends.ts'
import {
  MSYS2_ROOT_CANDIDATES,
  detectMsysRoot,
  plainBashProbedLocations,
  pwshProbedLocations,
  spawnableExists,
  wslProbedLocations,
} from './detect.ts'
import { composeSshCommand, type SshLaunchArgs, type SshOptionInput } from './pty/index.ts'

/** Injected probes — tests fake the machine; production uses the real one. */
export interface LauncherDeps {
  exists?: (path: string) => boolean
  env?: NodeJS.ProcessEnv
  path?: string
  listDistros?: (wslExe: string) => readonly string[]
}

/** A resolved local preset: descriptor-view shell-env fields + cwd. */
export interface LocalLauncherPreset {
  id: string
  transport: 'local'
  /** Ordered executable candidates (VS Code ITerminalExecutable shape). */
  executable: readonly string[]
  /** Interactive argv template (descriptor-view, single-sourced). */
  argv: readonly string[]
  /** Process-level injected env (VS Code profile semantics, #53 seam). */
  env: Readonly<Record<string, string>>
  pathPrefix: readonly string[]
  cwd?: string
  /** The probe points a loud absence would name (empty = no probes). */
  probed: readonly string[]
}

/** A resolved ssh preset: the composed command (transport dimension). */
export interface SshLauncherPreset {
  id: string
  transport: 'ssh'
  /** The composed ssh command line (keepalive defaults + options semantics inherited). */
  command: string
}

export type ResolvedLauncher = LocalLauncherPreset | SshLauncherPreset

/** A built-in environment that is not installed on this machine. */
export interface AbsentLauncher {
  id: string
  /** Every probe point, for the loud selected-absent error. */
  probed: readonly string[]
}

/**
 * The custom-preset config shape (issue #54, shape finalized here; the
 * settings CRUD UI reads/writes the same shape in a later ticket). `base`
 * references a built-in preset id as the inheritance source (fields overlay
 * on its resolved view); a local preset without `base` must declare its own
 * `executable`; an ssh preset declares the connection, not a shell-env.
 */
export interface CustomLauncherConfig {
  id: string
  transport: 'local' | 'ssh'
  /** Inherit a built-in view, then overlay the declared fields. */
  base?: string
  executable?: readonly string[]
  argv?: readonly string[]
  env?: Readonly<Record<string, string>>
  pathPrefix?: readonly string[]
  cwd?: string
  // ssh transport fields (ADR-0008 decision 1 — the composition semantics
  // are the pty entry's, not redeclared here).
  host?: string
  jump?: string
  port?: number
  shell?: string
  options?: SshOptionInput[]
}

const MSYS2_SUBSYSTEMS = ['UCRT64', 'MINGW64', 'MSYS'] as const
/** Preset id per subsystem (grill story: `shell_open(preset: 'msys2-ucrt')`). */
const MSYS2_ID = (subsystem: string): string => (subsystem === 'UCRT64' ? 'msys2-ucrt' : `msys2-${subsystem.toLowerCase()}`)

/** The built-in local preset ids, in table order (the loud unknown-id error enumerates these). */
export function builtInLauncherIds(deps: LauncherDeps = {}): readonly string[] {
  const env = deps.env ?? process.env
  const distros = wslDistros(deps, env)
  return [
    ...MSYS2_SUBSYSTEMS.map(MSYS2_ID),
    'git-bash',
    'pwsh',
    'powershell',
    ...distros.map((d, i) => (i === 0 ? 'wsl' : `wsl-${d}`)),
    'cmd',
    'python-repl',
  ]
}

const msys2Bash = (root: string): string => join(root, 'usr', 'bin', 'bash.exe')

/** Distros discovered through the WSL launcher; [] when the launcher is absent. */
function wslDistros(deps: LauncherDeps, env: NodeJS.ProcessEnv): readonly string[] {
  const exists = deps.exists ?? spawnableExists
  const wslExe = wslProbedLocations(env).find(candidate => exists(candidate))
  if (wslExe === undefined) return []
  return (deps.listDistros ?? defaultListDistros)(wslExe)
}

/** The real distro discovery: `wsl.exe --list --quiet` (UTF-16LE) — the backends layer's parser. */
function defaultListDistros(wslExe: string): readonly string[] {
  return parseWslDistroList(execFileSync(wslExe, ['--list', '--quiet'], { encoding: 'utf16le' }))
}

/** The System32 powershell.exe candidate (pwsh probe list's last entry). */
function powershellCandidate(env: NodeJS.ProcessEnv): string {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Git Bash candidates: the plain-bash probe list minus the Cygwin/MSYS2 tails. */
function gitBashCandidates(env: NodeJS.ProcessEnv): readonly string[] {
  return plainBashProbedLocations(undefined, env).filter(candidate => !/cygwin|msys64/i.test(candidate))
}

/** git-bash interactive argv: no login flags — Git Bash bakes its own MSYSTEM and its profiles already load (plain-backend T4 note). */
const GIT_BASH_ARGV: readonly string[] = []
const CMD_CANDIDATE = (env: NodeJS.ProcessEnv): string => join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
const CMD_ARGV: readonly string[] = []
const PYTHON_CANDIDATES = ['python.exe', 'python3.exe', 'python']

/** Resolve python along PATH (bare names spawn through PATH at runtime; probing needs the same walk). */
function pythonCandidates(path: string | undefined): { candidates: readonly string[]; probed: readonly string[] } {
  const entries = (path ?? '').split(delimiter).filter(entry => entry.length > 0)
  return {
    candidates: PYTHON_CANDIDATES,
    probed: entries.flatMap(dir => PYTHON_CANDIDATES.map(name => join(dir, name))),
  }
}

/**
 * Resolve the full launcher table: built-in descriptor-view presets plus the
 * custom config entries. Uninstalled built-ins are ABSENT (listed in
 * `absent` with their probe points), never errors. A custom id overrides a
 * built-in view; a `base` field inherits a resolved built-in.
 */
export function resolveLaunchers(deps: LauncherDeps = {}, custom: readonly CustomLauncherConfig[] = []): {
  presets: ResolvedLauncher[]
  absent: AbsentLauncher[]
} {
  const exists = deps.exists ?? spawnableExists
  const env = deps.env ?? process.env
  const presets: ResolvedLauncher[] = []
  const absent: AbsentLauncher[] = []
  const put = (preset: LocalLauncherPreset | null, absentEntry: AbsentLauncher | null) => {
    if (preset !== null) presets.push(preset)
    else if (absentEntry !== null) absent.push(absentEntry)
  }

  // msys2 ×3 subsystems: one root probe, three env views (MSYSTEM carries
  // the subsystem — the descriptor's D1 default becomes an explicit choice).
  const msysRoot = detectMsysRoot(exists)
  const msysProbed = MSYS2_ROOT_CANDIDATES.map(msys2Bash)
  if (msysRoot === undefined) {
    for (const subsystem of MSYS2_SUBSYSTEMS) {
      absent.push({ id: MSYS2_ID(subsystem), probed: msysProbed })
    }
  } else {
    for (const subsystem of MSYS2_SUBSYSTEMS) {
      presets.push({
        id: MSYS2_ID(subsystem),
        transport: 'local',
        executable: [msys2Bash(msysRoot)],
        argv: MSYS2_INTERACTIVE_ARGV,
        env: { MSYSTEM: subsystem, CHERE_INVOKING: '1' },
        pathPrefix: msys2PathPrefix(msysRoot, subsystem),
        probed: msysProbed,
      })
    }
  }

  // git-bash (pure-data row over the VS Code candidate scan).
  const gitCandidates = gitBashCandidates(env)
  put(
    gitCandidates.some(c => exists(c))
      ? {
          id: 'git-bash', transport: 'local', executable: gitCandidates, argv: GIT_BASH_ARGV,
          env: {}, pathPrefix: [], probed: gitCandidates,
        }
      : null,
    { id: 'git-bash', probed: gitCandidates },
  )

  // pwsh / powershell: the descriptor probe list split at the two products.
  const pwshList = pwshProbedLocations(deps.path, env)
  const pwshCandidates = pwshList.filter(c => /pwsh\.exe$/i.test(c))
  const powershellCandidates = [powershellCandidate(env)]
  put(
    pwshCandidates.some(c => exists(c))
      ? {
          id: 'pwsh', transport: 'local', executable: pwshCandidates, argv: PWSH_INTERACTIVE_ARGV,
          env: {}, pathPrefix: [], probed: pwshCandidates,
        }
      : null,
    { id: 'pwsh', probed: pwshCandidates },
  )
  put(
    exists(powershellCandidates[0])
      ? {
          // Pure-data interactive row (ADR-0008 decision 2): `-Login` is
          // pwsh ≥7.4 only (CONTEXT.md D7); 5.1's keep-open terminal is
          // plain `-NoExit`.
          id: 'powershell', transport: 'local', executable: powershellCandidates, argv: ['-NoExit'],
          env: {}, pathPrefix: [], probed: powershellCandidates,
        }
      : null,
    { id: 'powershell', probed: powershellCandidates },
  )

  // wsl: one preset per discovered distro; the first is the plain `wsl`.
  const distros = wslDistros(deps, env)
  const wslProbes = wslProbedLocations(env)
  if (distros.length === 0) {
    absent.push({ id: 'wsl', probed: [...wslProbes, '(wsl.exe --list --quiet returned no installed distro)'] })
  } else {
    distros.forEach((distro, i) => {
      presets.push({
        id: i === 0 ? 'wsl' : `wsl-${distro}`,
        transport: 'local',
        executable: [...wslProbes],
        argv: WSL_INTERACTIVE_ARGV(distro),
        env: {},
        pathPrefix: [],
        probed: wslProbes,
      })
    })
  }

  // cmd (pure-data row; only the SystemRoot is probed).
  const cmd = CMD_CANDIDATE(env)
  put(
    exists(cmd)
      ? { id: 'cmd', transport: 'local', executable: [cmd], argv: CMD_ARGV, env: {}, pathPrefix: [], probed: [cmd] }
      : null,
    { id: 'cmd', probed: [cmd] },
  )

  // python-repl (pure-data row; bare names resolved along PATH).
  const python = pythonCandidates(deps.path)
  put(
    python.probed.some(c => exists(c))
      ? { id: 'python-repl', transport: 'local', executable: python.candidates, argv: [], env: {}, pathPrefix: [], probed: python.probed }
      : null,
    { id: 'python-repl', probed: python.probed },
  )

  // Custom presets merge over the built-ins: same id REPLACES the built-in
  // view (user customization wins); `base` inherits a resolved built-in.
  for (const entry of custom) {
    const index = presets.findIndex(p => p.id === entry.id)
    const resolvedLauncher = resolveCustom(entry, presets, absent)
    if (index >= 0) presets[index] = resolvedLauncher
    else presets.push(resolvedLauncher)
  }
  return { presets, absent }
}

function resolveCustom(entry: CustomLauncherConfig, resolved: ResolvedLauncher[], absent: readonly AbsentLauncher[]): ResolvedLauncher {
  if (entry.id === undefined || entry.id === '') {
    throw new Error('launcher: a custom preset requires a non-empty id')
  }
  if (entry.transport === 'ssh') {
    if (entry.host === undefined || entry.host === '') {
      throw new Error(`launcher: custom ssh preset '${entry.id}' requires a host`)
    }
    return {
      id: entry.id,
      transport: 'ssh',
      // The pty entry's composition is the single source (ADR-0008
      // decision 1) — keepalive defaults and -o semantics inherit.
      command: composeSshCommand({
        host: entry.host,
        jump: entry.jump,
        port: entry.port,
        shell: entry.shell,
        options: entry.options,
      }),
    }
  }
  const base = entry.base === undefined
    ? undefined
    : resolved.find((p): p is LocalLauncherPreset => p.id === entry.base && p.transport === 'local')
  if (entry.base !== undefined && base === undefined) {
    throw new Error(`launcher: custom preset '${entry.id}' references unknown or absent base preset '${entry.base}'`)
  }
  if (entry.executable === undefined && base === undefined) {
    throw new Error(`launcher: custom local preset '${entry.id}' requires an executable (or a base preset reference)`)
  }
  const executable = entry.executable ?? base?.executable ?? []
  return {
    id: entry.id,
    transport: 'local',
    executable,
    argv: entry.argv ?? base?.argv ?? [],
    env: { ...base?.env, ...entry.env },
    pathPrefix: entry.pathPrefix ?? base?.pathPrefix ?? [],
    ...(entry.cwd !== undefined || base?.cwd !== undefined ? { cwd: entry.cwd ?? base?.cwd } : {}),
    probed: executable,
  }
}

/**
 * Resolve ONE launcher by id. Unknown ids and absent built-ins both fail
 * loudly: the error names the id, the resolved preset ids (unknown case) or
 * every probe point (absent case) — the pwsh/wsl descriptor posture, never
 * a silent fallback.
 */
export function resolveLauncher(id: string, deps: LauncherDeps = {}, custom: readonly CustomLauncherConfig[] = []): ResolvedLauncher {
  const { presets, absent } = resolveLaunchers(deps, custom)
  const hit = presets.find(p => p.id === id)
  if (hit !== undefined) return hit
  const miss = absent.find(a => a.id === id)
  if (miss !== undefined) {
    throw new Error(`launcher: preset '${id}' is not serviceable on this machine. Probed: ${miss.probed.join(', ')}`)
  }
  throw new Error(`launcher: unknown preset '${id}'; resolved presets: ${presets.map(p => p.id).join(', ')}`)
}

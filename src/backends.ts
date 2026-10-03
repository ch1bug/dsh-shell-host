/**
 * Backend descriptor layer (ADR-0001): a declarative description of the shell
 * backend the executor spawns — ordered executable candidates, per-mode argv
 * templates, env injection (plain keys, caller-wins), and a PATH prefix
 * merged ahead of the caller PATH. Modeled on VS Code's terminal-profile
 * declaration (`ITerminalExecutable` ordered candidates, `IShellLaunchConfig`
 * argv templates, profile `env`). `msys2` supports explicit configuration and
 * VS Code-style auto-detection (T3); `pwsh` is the Windows-native PowerShell
 * backend (#3, D7 phase 1.5); `wsl` remains a reserved registry entry that
 * fails loudly when selected.
 * @module dsh-shell-host/backends
 */

import { delimiter, dirname, join } from 'node:path'
import { detectMsysRoot, detectPlainBash, detectPwsh, MSYS2_ROOT_CANDIDATES, PLAIN_BASH_CANDIDATES, pwshProbedLocations, spawnableExists } from './detect.ts'
import type { Config } from './index.ts'

/** Command-payload token inside an argv template (VS Code `{0}` analog). */
export const COMMAND_TOKEN = '{command}'

/**
 * Declarative backend description. Field provenance (ADR-0001): `executable`
 * ← VS Code `ITerminalExecutable` (ordered fallback candidates); `argv` ←
 * `IShellLaunchConfig.args` / `shellIntegrationArgs` mode templates; `env` ←
 * `ITerminalProfile.env`; PATH prefixing ← VS Code `addEnvMixinPathPrefix`.
 */
export interface BackendDescriptor {
  /** Registry id: `'plain' | 'msys2' | 'pwsh'` implemented; `'wsl'` reserved. */
  id: string
  /** Ordered executable candidates. A bare name spawns through PATH lookup (upstream `plain` behavior); absolute paths must exist. */
  executable: readonly string[]
  /** One-shot argv template; the entry containing {@link COMMAND_TOKEN} receives the command. */
  argv: {
    oneShot: readonly string[]
    /** Login-interactive argv template for a PTY terminal (D3, T4); empty = bare shell. */
    interactive: readonly string[]
  }
  /** Injected plain variables. Layering (issue #5, human-harmonized): caller env wins over these; only the PATH prefix merge cuts ahead. */
  env: Readonly<Record<string, string>>
  /** PATH entries prepended to the caller PATH (prefix-merge, never whole-key override). */
  pathPrefix: readonly string[]
  /** Bidirectional path mapping across the Windows↔shell boundary (VS Code `getWslPath` analog). */
  pathMapping: {
    toShell(winPath: string): Promise<string>
    fromShell(shellPath: string): Promise<string>
  }
}

const identityMapping = {
  toShell: async (path: string): Promise<string> => path,
  fromShell: async (path: string): Promise<string> => path,
}

/**
 * The upstream-equivalent backend: bare `bash` + `['-c', '{command}']`, no
 * injection. On POSIX this stays the byte-equivalent bare name (upstream
 * contract); on win32 the bare name is detected instead — PATH probe with the
 * WSL System32 stub excluded, then Git Bash/Cygwin/MSYS2 candidates — so the
 * subsystem-`'none'` surface (Git Bash, Cygwin) works with zero config and a
 * WSL bash can never be silently picked.
 */
function plainBackend(config: Config): BackendDescriptor {
  const base = {
    id: 'plain',
    // A plain PTY starts bare bash (T4 amendment): Git Bash bakes its own
    // MSYSTEM and its profiles already load without --login.
    argv: { oneShot: ['-c', COMMAND_TOKEN], interactive: [] },
    env: {},
    pathPrefix: [],
    pathMapping: identityMapping,
  } satisfies Omit<BackendDescriptor, 'executable'>
  if (process.platform !== 'win32') {
    // POSIX keeps the byte-equivalent bare name (upstream contract); nothing
    // to detect there (detectPlainBash is win32-only by design).
    return { ...base, executable: [config.bashPath.get() ?? 'bash'] }
  }
  // win32: the bare name is detected instead — PATH probe with the WSL
  // System32 stub excluded, then Git Bash/Cygwin/MSYS2 candidates — so the
  // subsystem-`'none'` surface (Git Bash, Cygwin) works with zero config and
  // a WSL bash can never be silently picked.
  const detected = detectPlainBash()
  if (detected === undefined) {
    throw new Error(
      `bash-local: no usable bash found for the plain backend; set bashPath explicitly. `
      + `Probed PATH entries (excluding the WSL C:\\Windows\\System32 stub) and: ${[...PLAIN_BASH_CANDIDATES].join(', ')}`,
    )
  }
  return { ...base, executable: [config.bashPath.get() ?? detected] }
}

/**
 * MSYS2 backend. `msysRoot` points at the install root (`C:\msys64`);
 * alternatively `bashPath` points at the bash executable directly and the
 * root is derived from it; with neither, the root is auto-detected (VS Code
 * probe order) — detection failure is loud and names the `msysRoot` knob plus
 * every probed location. `subsystem` selects the injected `MSYSTEM` (default
 * UCRT64, D1); `'none'` never reaches this backend (plain surface, no
 * injection). `CHERE_INVOKING=1` keeps the working directory across login
 * shells (VS Code's own MSYS2 profile env).
 */
function msys2Backend(config: Config): BackendDescriptor {
  const explicitRoot = config.msysRoot.get() ?? (config.bashPath.get() !== undefined
    // `<root>\usr\bin\bash.exe` → strip usr\bin\bash.exe: exactly three levels.
    ? dirname(dirname(dirname(config.bashPath.get()!)))
    : undefined)
  // Explicit configuration always wins over detection (VS Code compilerPath
  // semantics); detection failure is loud, never a silent fallback.
  const msysRoot = explicitRoot ?? detectMsysRoot()
  if (msysRoot === undefined) {
    throw new Error(
      `bash-local: backend 'msys2' could not resolve msysRoot; set msysRoot (or bashPath) explicitly. `
      + `Probed: ${MSYS2_ROOT_CANDIDATES.map(root => join(root, 'usr', 'bin', 'bash.exe')).join(', ')}`,
    )
  }
  const msystem = config.subsystem.get() ?? 'UCRT64'
  // MSYSTEM login shells prepend their subsystem bin; MSYS itself only adds /usr/bin.
  const subsystemBin = msystem === 'MSYS' ? [] : [join(msysRoot, msystem.toLowerCase(), 'bin')]
  const prefix = [...subsystemBin, join(msysRoot, 'usr', 'local', 'bin'), join(msysRoot, 'usr', 'bin'), join(msysRoot, 'bin')]
  return {
    id: 'msys2',
    executable: [config.bashPath.get() ?? join(msysRoot, 'usr', 'bin', 'bash.exe')],
    // Login-interactive argv for the PTY terminal (D3; the VS Code `bash
    // (MSYS2)` profile). /etc/profile builds the MSYS environment.
    argv: { oneShot: ['-c', COMMAND_TOKEN], interactive: ['--login', '-i'] },
    env: { MSYSTEM: msystem, CHERE_INVOKING: '1' },
    pathPrefix: prefix,
    pathMapping: {
      // cygpath lives next to the bash we spawn; both directions per ADR-0001 §6.
      toShell: async (winPath) => cygpath(msysRoot, '-u', winPath),
      fromShell: async (shellPath) => cygpath(msysRoot, '-w', shellPath),
    },
  }
}

/**
 * pwsh backend (issue #3, D7 phase 1.5): Windows-native PowerShell, a peer
 * of `msys2` — no MSYS-style injection, native Windows PATH surface,
 * identity path mapping both directions. Argv conventions surveyed from the
 * upstream `pwsh-local` executor (harness checkout dsh-v0.2.0-rc.2, recorded
 * in the ADR-0001 #3 amendment): one-shot `-NoLogo -NoProfile
 * -NonInteractive -Command` with the UTF-8 output preamble riding line 1 of
 * the command text; interactive `-l -noexit` (login + keep-open, the PTY
 * projection's `--login -i` analog — `-Login` requires pwsh ≥7.4, so an
 * interactive terminal over the Windows PowerShell 5.1 fallback fails at
 * spawn rather than silently dropping the flag). Detection follows the VS
 * Code probe pattern: PowerShell 7 (install root, then PATH) ahead of
 * Windows PowerShell 5.1; absence fails loudly naming every probed location
 * — the upstream bare-`pwsh` PATH fallback is deliberately absent (no silent
 * fallback). This executor NEVER confines: a pwsh backend here is unconfined
 * pwsh, unlike the upstream confining `pwsh-sandbox` executor it displaced
 * (#10 posture, recorded in ADR-0001).
 */
function pwshBackend(): BackendDescriptor {
  const detected = detectPwsh()
  if (detected === undefined) {
    throw new Error(
      `bash-local: backend 'pwsh' found no PowerShell; install PowerShell 7 or set backend: 'plain'/'msys2'. `
      + `Probed: ${pwshProbedLocations().join(', ')}`,
    )
  }
  return {
    id: 'pwsh',
    executable: [detected],
    argv: {
      oneShot: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ENCODING_PREAMBLE + COMMAND_TOKEN],
      interactive: ['-l', '-noexit'],
    },
    env: {},
    pathPrefix: [],
    pathMapping: identityMapping,
  }
}

/**
 * UTF-8 output pinning prepended to every one-shot command (surveyed from
 * the upstream `pwsh-local`): the subprocess collector decodes output bytes
 * as UTF-8, but Windows PowerShell 5.1 (the last-resort executable
 * fallback) writes the console/OEM code page by default, which garbles
 * non-ASCII output; pwsh 7 defaults to UTF-8 and is unaffected. The
 * statements ride on line 1 after `; ` separators so PowerShell error line
 * numbers stay accurate.
 */
const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

async function cygpath(msysRoot: string, flag: string, path: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)(join(msysRoot, 'usr', 'bin', 'cygpath.exe'), [flag, path])
  return stdout.trim()
}

/**
 * Resolve the configured backend descriptor. Unknown or reserved ids
 * (`wsl` — issue #2) fail loudly naming the id and the config knob, so a
 * misconfiguration can never silently spawn the wrong shell.
 * @throws Error naming the backend and the config field to change.
 */
export function resolveBackend(config: Config): BackendDescriptor {
  const id = config.backend.get() ?? 'plain'
  switch (id) {
    case 'plain': return plainBackend(config)
    case 'msys2':
      // subsystem 'none' = plain bash, no MSYS env injection (issue #6): Git
      // Bash and Cygwin ride the same descriptor surface with env {} and no
      // PATH prefix.
      if (config.subsystem.get() === 'none') return plainBackend(config)
      return msys2Backend(config)
    case 'pwsh': return pwshBackend()
    case 'wsl':
      throw new Error(`bash-local: backend '${id}' is reserved and not implemented yet (see the project issues); set backend: 'plain', 'msys2', or 'pwsh'`)
    default:
      throw new Error(`bash-local: unknown backend '${id}'; expected one of: plain, msys2, pwsh (wsl is reserved)`)
  }
}

/**
 * Validate a descriptor this executor can run with (ADR-0001 landing seam:
 * `assertServiceableBashConfig` extends to the descriptor).
 * @throws Error naming the unserviceable descriptor part.
 */
export function assertServiceableBackend(backend: BackendDescriptor): void {
  if (backend.executable.length === 0) {
    throw new Error(`bash-local: backend '${backend.id}' declares no executable candidates`)
  }
  if (!backend.argv.oneShot.some(arg => arg.includes(COMMAND_TOKEN))) {
    throw new Error(`bash-local: backend '${backend.id}' oneShot argv template lacks a ${COMMAND_TOKEN} placeholder`)
  }
}

/**
 * Expand a descriptor into the concrete spawn argv: the first existing
 * absolute candidate (VS Code `validateProfilePaths` ordered fallback), or a
 * bare name verbatim so the platform resolves it through PATH — the upstream
 * `plain` contract.
 * @throws Error listing all candidates when none exists.
 */
export function resolveExecutable(backend: BackendDescriptor): string {
  for (const candidate of backend.executable) {
    if (!candidate.includes('\\') && !candidate.includes('/')) return candidate
    // spawnableExists (lstat-based) also sees the Microsoft Store execution
    // alias where existsSync's stat hits the target's ACL (#3).
    if (spawnableExists(candidate)) return candidate
  }
  throw new Error(`bash-local: backend '${backend.id}' executable not found (tried: ${backend.executable.join(', ')})`)
}

/**
 * Expand the one-shot argv template, substituting the command payload into
 * the {@link COMMAND_TOKEN} entry.
 */
export function expandOneShotArgv(backend: BackendDescriptor, command: string): readonly string[] {
  return backend.argv.oneShot.map(arg => arg.replaceAll(COMMAND_TOKEN, command))
}

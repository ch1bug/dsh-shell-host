/**
 * Backend descriptor layer (ADR-0001): a declarative description of the shell
 * backend the executor spawns — ordered executable candidates, per-mode argv
 * templates, env injection (plain keys, caller-wins), and a PATH prefix
 * merged ahead of the caller PATH. Modeled on VS Code's terminal-profile
 * declaration (`ITerminalExecutable` ordered candidates, `IShellLaunchConfig`
 * argv templates, profile `env`). Phase 1 implements `msys2` (explicit
 * configuration only — no auto-detection, that is T3); `pwsh`/`wsl` are
 * reserved registry entries that fail loudly when selected.
 * @module dsh-bash-msys/backends
 */

import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
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
  /** Registry id: `'plain' | 'msys2'` implemented; `'pwsh' | 'wsl'` reserved. */
  id: string
  /** Ordered executable candidates. A bare name spawns through PATH lookup (upstream `plain` behavior); absolute paths must exist. */
  executable: readonly string[]
  /** One-shot argv template; the entry containing {@link COMMAND_TOKEN} receives the command. */
  argv: {
    oneShot: readonly string[]
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

/** The upstream-equivalent backend: bare `bash` + `['-c', '{command}']`, no injection. A configured `bashPath` replaces the PATH-resolved bare name. */
function plainBackend(config: Config): BackendDescriptor {
  return {
    id: 'plain',
    executable: [config.bashPath.get() ?? 'bash'],
    argv: { oneShot: ['-c', COMMAND_TOKEN] },
    env: {},
    pathPrefix: [],
    pathMapping: identityMapping,
  }
}

/**
 * MSYS2 backend from explicit configuration. `msysRoot` points at the
 * install root (`C:\\msys64`); alternatively `bashPath` points at the bash
 * executable directly and the root is derived from it. `MSYSTEM` selects the
 * subsystem (default UCRT64, D1). `CHERE_INVOKING=1` keeps the working
 * directory across login shells (VS Code's own MSYS2 profile env).
 */
function msys2Backend(config: Config): BackendDescriptor {
  const msysRoot = config.msysRoot.get() ?? (config.bashPath.get() !== undefined
    // `<root>\usr\bin\bash.exe` → strip usr\bin\bash.exe: exactly three levels.
    ? dirname(dirname(dirname(config.bashPath.get()!)))
    : undefined)
  if (msysRoot === undefined) {
    throw new Error("bash-local: backend 'msys2' requires an explicit msysRoot (or bashPath); no auto-detection before T3")
  }
  const msystem = config.msystem.get() ?? 'UCRT64'
  // MSYSTEM login shells prepend their subsystem bin; MSYS itself only adds /usr/bin.
  const subsystemBin = msystem === 'MSYS' ? [] : [join(msysRoot, msystem.toLowerCase(), 'bin')]
  const prefix = [...subsystemBin, join(msysRoot, 'usr', 'local', 'bin'), join(msysRoot, 'usr', 'bin'), join(msysRoot, 'bin')]
  return {
    id: 'msys2',
    executable: [config.bashPath.get() ?? join(msysRoot, 'usr', 'bin', 'bash.exe')],
    argv: { oneShot: ['-c', COMMAND_TOKEN] },
    env: { MSYSTEM: msystem, CHERE_INVOKING: '1' },
    pathPrefix: prefix,
    pathMapping: {
      // cygpath lives next to the bash we spawn; both directions per ADR-0001 §6.
      toShell: async (winPath) => cygpath(msysRoot, '-u', winPath),
      fromShell: async (shellPath) => cygpath(msysRoot, '-w', shellPath),
    },
  }
}

async function cygpath(msysRoot: string, flag: string, path: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)(join(msysRoot, 'usr', 'bin', 'cygpath.exe'), [flag, path])
  return stdout.trim()
}

/**
 * Resolve the configured backend descriptor. Unknown or reserved ids
 * (`pwsh`/`wsl` — issues #2/#3) fail loudly naming the id and the config
 * knob, so a misconfiguration can never silently spawn the wrong shell.
 * @throws Error naming the backend and the config field to change.
 */
export function resolveBackend(config: Config): BackendDescriptor {
  const id = config.backend.get() ?? 'plain'
  switch (id) {
    case 'plain': return plainBackend(config)
    case 'msys2': return msys2Backend(config)
    case 'pwsh':
    case 'wsl':
      throw new Error(`bash-local: backend '${id}' is reserved and not implemented yet (see the project issues); set backend: 'plain' or 'msys2'`)
    default:
      throw new Error(`bash-local: unknown backend '${id}'; expected one of: plain, msys2 (pwsh/wsl are reserved)`)
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
    if (existsSync(candidate)) return candidate
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

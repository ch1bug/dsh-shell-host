/**
 * VS Code-style install detection (ADR-0001 §1 `detectAvailableWindowsProfiles`
 * pattern): ordered absolute-path probes resolved with a plain existence
 * check, PATH search with exclusions, and loud failure that names the probed
 * locations. Exists for T3 — T2 was explicit-config only.
 * @module dsh-bash-msys/detect
 */

import { existsSync, lstatSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * MSYS2 install-root probes, VS Code `bash (MSYS2)` order: the installer's
 * default drive root first, then the `${HOMEDRIVE}\msys64` profile candidate
 * (verbatim from VS Code's terminalProfiles.ts). A root qualifies only when
 * its `usr\bin\bash.exe` exists.
 */
export const MSYS2_ROOT_CANDIDATES: readonly string[] = [
  'C:\\msys64',
  join(process.env.HOMEDRIVE ?? 'C:', 'msys64'),
]

/**
 * Plain-bash fallback candidates (ordered, win32): Git Bash (VS Code
 * `source`-based paths), then Cygwin (VS Code's two candidate roots), then a
 * full MSYS2 install — usable through the `subsystem: 'none'` plain surface.
 */
export const PLAIN_BASH_CANDIDATES: readonly string[] = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\cygwin64\\bin\\bash.exe',
  'C:\\cygwin\\bin\\bash.exe',
  'C:\\msys64\\usr\\bin\\bash.exe',
  join(process.env.HOMEDRIVE ?? 'C:', 'msys64', 'usr', 'bin', 'bash.exe'),
]

/**
 * Resolve the first MSYS2 root whose `usr\bin\bash.exe` exists, or undefined.
 * @param exists - injectable existence predicate (tests use fake paths).
 */
export function detectMsysRoot(exists: (path: string) => boolean = existsSync): string | undefined {
  for (const root of MSYS2_ROOT_CANDIDATES) {
    if (exists(join(root, 'usr', 'bin', 'bash.exe'))) return root
  }
  return undefined
}

/** The Windows system bash is WSL's launcher (CONTEXT.md fact 6) — spawning it as a POSIX bash is always wrong. */
function isWslSystemBash(candidate: string): boolean {
  return /\\windows\\system32\\/i.test(candidate)
}

/**
 * Resolve a bash for the plain surface on win32: `bash.exe` searched along
 * the caller PATH with the WSL System32 stub excluded, then the ordered
 * {@link PLAIN_BASH_CANDIDATES}. On POSIX there is nothing to detect — the
 * caller keeps the upstream bare `bash` (byte-equivalent contract).
 * @returns the resolved absolute path, or undefined (win32: the caller must
 *   then fail loudly naming the probed locations).
 */
export function detectPlainBash(
  exists: (path: string) => boolean = existsSync,
  path: string | undefined = process.env.PATH,
): string | undefined {
  if (process.platform !== 'win32') return undefined
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'bash.exe')
    if (!isWslSystemBash(candidate) && exists(candidate)) return candidate
  }
  for (const candidate of PLAIN_BASH_CANDIDATES) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Whether a candidate path can be spawned. lstat opens the entry itself
 * instead of following reparse points, so it sees the Microsoft Store app
 * execution alias where stat-based `existsSync` hits the target's ACL
 * (EACCES); Node reports that alias as a symlink on current releases and as
 * a plain file on older ones, and CreateProcess resolves either shape
 * (surveyed from the upstream `pwsh-local` resolve.ts, dsh-v0.2.0-rc.2 —
 * the same predicate backs `resolveExecutable`'s ordered-candidate check).
 */
export function spawnableExists(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Every PowerShell location the pwsh backend probes, in order (win32, #3):
 * PowerShell 7's install-root `pwsh.exe` first, then every PATH entry's
 * `pwsh.exe` (e.g. the Microsoft Store install, user-added locations),
 * then Windows PowerShell 5.1's `powershell.exe` — the same shape as the
 * upstream `pwsh-local` candidate list, with the trailing bare-`pwsh` PATH
 * fallback REMOVED: this executor's contract is a loud failure naming every
 * probed location, never a silent bare-name spawn (ADR-0001 #3 amendment).
 */
export function pwshProbedLocations(
  path: string | undefined = process.env.PATH,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  return [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    ...pathEntries(path),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
}

/**
 * Resolve a PowerShell executable on win32 (issue #3): PowerShell 7's
 * `pwsh.exe` (install root, then every PATH entry), then Windows PowerShell
 * 5.1's `powershell.exe`. PowerShell 7 always wins over 5.1 when both exist.
 * @param exists - injectable existence predicate (tests use fake paths).
 * @param path - the PATH to probe for `pwsh.exe`; defaults to the process PATH.
 * @param env - environment for the well-known roots; defaults to the process env.
 * @returns the resolved absolute path, or undefined (the caller must then
 *   fail loudly naming the probed locations).
 */
export function detectPwsh(
  exists: (path: string) => boolean = spawnableExists,
  path: string | undefined = process.env.PATH,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (process.platform !== 'win32') return undefined
  for (const candidate of pwshProbedLocations(path, env)) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** PATH entries carrying a `pwsh.exe`, quotes stripped (`setx`-style definitions). */
function pathEntries(path: string | undefined): string[] {
  return (path ?? '').split(delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(entry => entry.length > 0)
    .map(entry => join(entry, 'pwsh.exe'))
}

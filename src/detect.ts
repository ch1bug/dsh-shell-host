/**
 * VS Code-style install detection (ADR-0001 §1 `detectAvailableWindowsProfiles`
 * pattern): ordered absolute-path probes resolved with a plain existence
 * check, PATH search with exclusions, and loud failure that names the probed
 * locations. The Git Bash / Cygwin candidates are VS Code
 * `getGitBashPaths()` / `detectedProfiles.set('Cygwin', …)` verbatim (#25);
 * the MSYS2 candidates are a superset — VS Code has no MSYS2 profile surface
 * to fold in, and we keep the installer-default `C:\msys64` root first.
 * Exists for T3 — T2 was explicit-config only.
 * @module dsh-shell-host/detect
 */

import { existsSync, lstatSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

/**
 * MSYS2 install-root probes: the installer's default drive root first (a
 * superset of VS Code — VS Code has no MSYS2 profile), then the
 * `${HOMEDRIVE}\msys64` candidate. A root qualifies only when its
 * `usr\bin\bash.exe` exists.
 */
export const MSYS2_ROOT_CANDIDATES: readonly string[] = [
  'C:\\msys64',
  join(process.env.HOMEDRIVE ?? 'C:', 'msys64'),
]

/**
 * Every plain-bash location the plain surface probes, in order (win32, #25):
 * the Git Bash / Cygwin entries are VS Code `getGitBashPaths()` /
 * `detectedProfiles.set('Cygwin', …)` verbatim —
 *
 * 1. the install root reverse-derived from a `git.exe` found on the caller
 *    PATH (`<root>\cmd\git.exe` → `<root>`), probed first (VS Code inserts it
 *    into its candidate set before the well-known roots — the one PATH hit
 *    that always reflects the actual install);
 * 2. `ProgramW6432` / `ProgramFiles` / `ProgramFiles(X86)` /
 *    `%LocalAppData%\Program` install roots (skipped when the env var is
 *    unset, addTruthy semantics), each × `Git\bin\bash.exe`,
 *    `Git\usr\bin\bash.exe`, `usr\bin\bash.exe` (Git for Windows SDK layout);
 * 3. the two scoop shims under `%UserProfile%`;
 * 4. `%HOMEDRIVE%\cygwin64` and `%HOMEDRIVE%\cygwin`.
 *
 * Then a full MSYS2 install — a superset of VS Code, usable through the
 * `subsystem: 'none'` plain surface. The caller (`backends.ts`) joins this
 * list into the loud-failure message, so it always names the real probe
 * points. Folded from VS Code's `source`-type ordered-path profile; the
 * ordering semantics are equivalent.
 */
export function plainBashProbedLocations(
  path: string | undefined = process.env.PATH,
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = spawnableExists,
): readonly string[] {
  const gitDirs: string[] = []
  const seen = new Set<string>()
  const addDir = (dir: string | undefined): void => {
    if (dir === undefined) return
    const key = dir.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    gitDirs.push(dir)
  }

  // git.exe on the PATH lives at `<installdir>\cmd\git.exe`; its install root
  // is the most reliable candidate (VS Code getGitBashPaths, verbatim shape).
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue
    if (exists(join(dir, 'git.exe'))) addDir(resolve(dir, '..', '..'))
  }
  addDir(env.ProgramW6432)
  addDir(env.ProgramFiles)
  addDir(env['ProgramFiles(X86)'])
  if (env.LocalAppData) addDir(join(env.LocalAppData, 'Program'))

  const locations: string[] = []
  for (const gitDir of gitDirs) {
    locations.push(
      join(gitDir, 'Git', 'bin', 'bash.exe'),
      join(gitDir, 'Git', 'usr', 'bin', 'bash.exe'),
      join(gitDir, 'usr', 'bin', 'bash.exe'), // using Git for Windows SDK
    )
  }
  // Special installs that don't follow the standard directory structure.
  if (env.UserProfile) {
    locations.push(
      join(env.UserProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
      join(env.UserProfile, 'scoop', 'apps', 'git-with-openssh', 'current', 'bin', 'bash.exe'),
    )
  }
  const homeDrive = env.HOMEDRIVE ?? 'C:'
  locations.push(
    join(homeDrive, 'cygwin64', 'bin', 'bash.exe'),
    join(homeDrive, 'cygwin', 'bin', 'bash.exe'),
    // MSYS2 superset: installer-default root, then the ${HOMEDRIVE} profile root.
    'C:\\msys64\\usr\\bin\\bash.exe',
    join(homeDrive, 'msys64', 'usr', 'bin', 'bash.exe'),
  )
  return locations
}

/**
 * The plain-bash fallback candidates resolved from the real environment at
 * module load — the list the loud-failure message names. Exact match with
 * what `detectPlainBash()` probes holds for default-args calls (the only
 * production caller); injected args may diverge by design.
 */
export const PLAIN_BASH_CANDIDATES: readonly string[] = plainBashProbedLocations()

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
 * {@link plainBashProbedLocations} list (VS Code getGitBashPaths parity +
 * MSYS2 superset, #25). On POSIX there is nothing to detect — the caller
 * keeps the upstream bare `bash` (byte-equivalent contract).
 * @param exists - injectable existence predicate (tests use fake paths).
 * @param path - the PATH to probe for `bash.exe` and `git.exe`; defaults to the process PATH.
 * @param env - environment for the well-known roots; defaults to the process env.
 * @returns the resolved absolute path, or undefined (win32: the caller must
 *   then fail loudly naming the probed locations).
 */
export function detectPlainBash(
  exists: (path: string) => boolean = existsSync,
  path: string | undefined = process.env.PATH,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (process.platform !== 'win32') return undefined
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'bash.exe')
    if (!isWslSystemBash(candidate) && exists(candidate)) return candidate
  }
  for (const candidate of plainBashProbedLocations(path, env, exists)) {
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

/**
 * Every WSL launcher location the wsl backend probes (win32, #15, ADR-0003
 * decision 3): the explicit System32 `wsl.exe` — the only candidate by
 * decision. A bare `bash` on the Windows PATH is a known unreliable probe
 * (CONTEXT.md verified facts: it hits the System32 WSL stub) and the System32
 * `bash.exe` launcher collides with that hazard, so neither is ever probed.
 */
export function wslProbedLocations(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')]
}

/**
 * Resolve the WSL launcher on win32 (issue #15): the explicit System32
 * `wsl.exe` when it exists.
 * @param exists - injectable existence predicate (tests use fake paths).
 * @param env - environment for the well-known root; defaults to the process env.
 * @returns the resolved absolute path, or undefined (the caller must then
 *   fail loudly naming the probed locations — the pwsh posture).
 */
export function detectWslExe(
  exists: (path: string) => boolean = spawnableExists,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (process.platform !== 'win32') return undefined
  for (const candidate of wslProbedLocations(env)) {
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

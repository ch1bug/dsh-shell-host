/**
 * Custom-preset registration validation (issue #105, ADR-0018): the security
 * core of the custom shell registration surface. A registered custom preset
 * is a DECLARED EXECUTABLE PATH + argv + env + PATH prefix — the moment any
 * agent calls `shell_open({ preset: id })` that program runs on this machine.
 * The registration channel itself is the attack surface, so every entry is
 * validated HERE, at entry-apply time (process start), before it can ever
 * reach the preset table.
 *
 * Postures:
 * - LOUD REJECTION, never silent repair: every rejected entry is listed with
 *   ALL of its reasons; the caller (`./terminal` apply) throws so the row
 *   fails to activate with the reason visible in the plugin manager
 *   (fail-closed: a bad registration must not leave a half-open table).
 * - NO BUILT-IN OVERRIDE: a custom id may not shadow a built-in preset id —
 *   the #54 merge semantics allowed it, #105 forbids it at the registration
 *   gate (the override flag on shell_open output stays for provenance
 *   reporting; it simply can no longer become true through this channel).
 * - EXPLICIT PATHS ONLY: each executable candidate must be an absolute path,
 *   free of shell metacharacters (no "executable string with arguments" —
 *   argv is an array in this repo, never a joined line), with a path
 *   separator (bare names resolve along PATH — a renamed binary is a
 *   hijack), existing and not a directory at registration time.
 * @module dsh-shell-host/terminal/register
 */

import { statSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import type { CustomLauncherConfig } from '../launchers.ts'
import { spawnableExists } from '../detect.ts'

/** Probe seams — tests fake the machine; production uses the real one. */
export interface RegistrationDeps {
  /** The built-in preset ids this registration may NOT shadow. */
  builtInIds: readonly string[]
  /** Existence probe; defaults to `src/detect.ts`'s spawnableExists. */
  exists?: (path: string) => boolean
  /** Directory probe (a directory is not spawnable); defaults to statSync. */
  isDirectory?: (path: string) => boolean
  /**
   * Platform gate for separator shape (#167). The default `process.platform`
   * is the SINGLE-MACHINE gauge: correct for the in-process LauncherDeps
   * path, but WRONG if this pure-validation layer is ever reused to judge
   * configs destined for a DIFFERENT host (e.g. a remote/POSIX target while
   * validating on Windows) — win32-only rules (`\` or `/`, NTFS streams)
   * would silently misfire. When validating for another environment, pass
   * `platform` explicitly; the default is a convenience, not a contract.
   */
  platform?: NodeJS.Platform
}

/** One rejected entry: its config-file position, id, and EVERY reason. */
export interface RegistrationRejection {
  index: number
  id: string
  reasons: string[]
}

/** The registration outcome: accepted entries (clean copies) + loud rejects. */
export interface RegistrationResult {
  accepted: CustomLauncherConfig[]
  rejected: RegistrationRejection[]
}

/**
 * Characters that must never appear in a registered executable path: quotes,
 * the command-line metacharacters a shell would interpret (both POSIX and
 * cmd.exe expansion sets: `?` `!` `^` `%`), and control characters. WHITESPACE
 * IS ALLOWED on purpose — legitimate Windows install paths contain spaces
 * ("C:\Program Files\..."), the spawn spec is an argv ARRAY (never a joined
 * line), and `localLaunchCommand` quotes spaced paths at launch. An
 * "executable string with arguments" (`...exe --flag`) is caught by the
 * EXISTENCE probe instead: a path with an argument suffix is not a file.
 */
const FORBIDDEN_IN_EXECUTABLE = /["'`&;|<>()$*?!^%\u0000-\u001f]/

/** NTFS alternate data streams (`file.exe:stream`) ride a SECOND colon — the
 * first one is the drive. win32 only; on POSIX a colon is an ordinary char. */
function hasNtfsAlternateDataStream(candidate: string): boolean {
  return (candidate.match(/:/g) ?? []).length > 1
}

/** The shared array-of-strings shape check (argv / pathPrefix). */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** A preset id: charset-locked so the config file cannot smuggle control
 * characters or whitespace into tool args and error messages. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function validateExecutableCandidate(candidate: unknown, deps: RegistrationDeps): string | undefined {
  if (typeof candidate !== 'string' || candidate.length === 0) return 'executable candidate must be a non-empty string'
  if (FORBIDDEN_IN_EXECUTABLE.test(candidate)) {
    return `executable candidate contains quotes or shell metacharacters: ${JSON.stringify(candidate)}`
  }
  if (hasNtfsAlternateDataStream(candidate)) {
    return `executable candidate must not name an NTFS alternate data stream: ${JSON.stringify(candidate)}`
  }
  if (!isAbsolute(candidate)) return `executable candidate must be an absolute path, got: ${JSON.stringify(candidate)}`
  // Bare names (no separator) would resolve along PATH at spawn time — a
  // renamed binary earlier on PATH is a hijack. A registered preset pins an
  // explicit location. win32 counts both `\` and `/`; POSIX only `/`.
  // separator shape is a SINGLE-MACHINE gauge — see RegistrationDeps.platform (#167).
  const platform = deps.platform ?? process.platform
  const hasSeparator = candidate.includes(sep) || (platform === 'win32' && candidate.includes('/'))
  if (!hasSeparator) {
    return `executable candidate must include a path separator (bare names resolve along PATH): ${JSON.stringify(candidate)}`
  }
  const exists = deps.exists ?? spawnableExists
  // Directory check FIRST: a directory "exists" but is not spawnable, and it
  // deserves its own reason (a config pointing at a folder is a common slip).
  const isDirectory = deps.isDirectory ?? defaultIsDirectory
  if (isDirectory(candidate)) return `executable candidate is a directory, not a file: ${JSON.stringify(candidate)}`
  if (!exists(candidate)) return `executable candidate does not exist: ${JSON.stringify(candidate)}`
  return undefined
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Validate ONE entry; returns its reasons ([] = accepted). */
function validateEntry(entry: unknown, deps: RegistrationDeps, seenIds: ReadonlySet<string>): string[] {
  const reasons: string[] = []
  if (typeof entry !== 'object' || entry === null) {
    return ['a custom preset entry must be an object']
  }
  const e = entry as Record<string, unknown>
  const id = e['id']
  if (typeof id !== 'string' || id.length === 0) {
    return ['a custom preset requires a non-empty id']
  }
  if (!ID_PATTERN.test(id)) {
    reasons.push(`preset id must match ${ID_PATTERN.source}, got: ${JSON.stringify(id)}`)
  }
  if (seenIds.has(id)) {
    reasons.push(`duplicate custom preset id: ${JSON.stringify(id)}`)
  }
  if (deps.builtInIds.includes(id)) {
    reasons.push(
      `custom preset ${JSON.stringify(id)} would override the built-in preset of the same id — ` +
      'overriding built-in ids is forbidden on the registration surface (pick a new id)',
    )
  }
  const transport = e['transport']
  if (transport !== 'local' && transport !== 'ssh') {
    reasons.push(`transport must be "local" or "ssh", got: ${JSON.stringify(transport)}`)
    return reasons
  }
  if (transport === 'ssh') {
    if (typeof e['host'] !== 'string' || (e['host'] as string).length === 0) {
      reasons.push(`custom ssh preset ${JSON.stringify(id)} requires a host`)
    }
    return reasons
  }
  // local transport:
  const base = e['base']
  if (typeof base === 'string' && base.length > 0) {
    // The inheritance source must already be resolvable: a built-in id or an
    // EARLIER accepted custom id (config order = inheritance order).
    if (!deps.builtInIds.includes(base) && !seenIds.has(base)) {
      reasons.push(`custom preset ${JSON.stringify(id)} references unknown or non-accepted base preset ${JSON.stringify(base)}`)
    }
  }
  const executable = e['executable']
  if (executable !== undefined) {
    if (!Array.isArray(executable)) {
      reasons.push('executable must be an array of path candidates')
    } else {
      if (executable.length === 0) reasons.push('executable must list at least one candidate path')
      for (const candidate of executable) {
        const reason = validateExecutableCandidate(candidate, deps)
        if (reason !== undefined) reasons.push(reason)
      }
    }
  } else if (base === undefined) {
    reasons.push(`custom local preset ${JSON.stringify(id)} requires an executable (or a base preset reference)`)
  }
  const argv = e['argv']
  if (argv !== undefined && !isStringArray(argv)) {
    reasons.push('argv must be an array of strings')
  }
  const env = e['env']
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env) ||
    Object.values(env).some(v => typeof v !== 'string'))) {
    reasons.push('env must be a record of string to string')
  }
  const pathPrefix = e['pathPrefix']
  if (pathPrefix !== undefined && !isStringArray(pathPrefix)) {
    reasons.push('pathPrefix must be an array of strings')
  }
  const cwd = e['cwd']
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    reasons.push(`cwd must be an absolute path, got: ${JSON.stringify(cwd)}`)
  }
  return reasons
}

/**
 * Validate the whole `custom` array. Accepted entries are returned as clean
 * copies (own enumerable shape only — the frozen registration snapshot is
 * built from these); rejected entries carry their index in the original
 * array so the loud error can point at the config-file position.
 */
export function validateCustomEntries(custom: readonly unknown[], deps: RegistrationDeps): RegistrationResult {
  const accepted: CustomLauncherConfig[] = []
  const rejected: RegistrationRejection[] = []
  const seenIds = new Set<string>()
  custom.forEach((entry, index) => {
    const id = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['id'] : undefined
    const reasons = validateEntry(entry, deps, seenIds)
    if (reasons.length > 0) {
      rejected.push({ index, id: typeof id === 'string' ? id : '', reasons })
      return
    }
    // Clean copy: drop everything the shape does not declare (the resolved
    // launcher layer reads only known fields, but the snapshot should not
    // carry unknown payload through restarts).
    const e = entry as Record<string, unknown>
    const clean: Record<string, unknown> = { id, transport: e['transport'] }
    for (const key of ['base', 'executable', 'argv', 'env', 'pathPrefix', 'cwd', 'host', 'jump', 'port', 'shell', 'options'] as const) {
      if (e[key] !== undefined) clean[key] = e[key]
    }
    seenIds.add(id as string)
    accepted.push(clean as unknown as CustomLauncherConfig)
  })
  return { accepted, rejected }
}

/** The loud apply-time error for a registration with rejected entries. */
export function registrationError(rejected: readonly RegistrationRejection[]): Error {
  const lines = rejected.map(r => `  [${r.index}] id=${JSON.stringify(r.id)}: ${r.reasons.join('; ')}`)
  return new Error(
    `terminal: custom preset registration rejected ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} ` +
    '(fix the config and RESTART to apply):\n' + lines.join('\n'),
  )
}

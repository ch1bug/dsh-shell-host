/**
 * 环境侦测上下文（#149 AC10）: the `./pty` entry's ONE `systemPrompt.context`
 * contribution — a statement of which launcher environments this machine
 * resolves to (`preset id → resolved executable`), so an agent can name a real
 * path in `pty_open({ shellCommand })` instead of guessing one.
 *
 * Three deliberate properties (each one is a ticket decision, not a style):
 *
 * - **LAZY, computed once and cached.** The launcher resolution shells out on
 *   win32 (`wsl.exe --list --quiet`, `src/launchers.ts`), so it must never run
 *   inside plugin `apply` — the provider below evaluates on the FIRST
 *   assembly and reuses the rendered line afterwards (#152 tracks making that
 *   detection cheap enough for other call sites).
 * - **AN ENVIRONMENT FACT, not an instruction.** It states what exists; it
 *   starts no turn of its own (the host has no plugin-facing entry point for
 *   that anyway — separate ticket).
 * - **OMITTED when nothing resolves.** An empty contribution contributes
 *   nothing (the prompt registry drops empty context text), so this module
 *   never writes "无" / "none".
 *
 * The launcher table is the presets' single source (ADR-0008) and stays there:
 * this module only picks the RESOLVED executable out of a preset's candidate
 * list and formats it. Note the import direction — `src/launchers.ts` imports
 * `composeSshCommand` from `./index.ts` (ADR-0008 decision 1), so this module
 * closes an import cycle with the pty entry. The cycle is inert by
 * construction: every reference into the launcher module sits inside a
 * function body, so nothing is read while modules are still evaluating.
 *
 * @module dsh-shell-host/pty/environment-context
 */

import { spawnableExists } from '../detect.ts'
import { resolveLaunchers, type LauncherDeps, type ResolvedLauncher } from '../launchers.ts'

/**
 * Context name — the host's namespace form (`working-directory:current`,
 * `sandbox:policy`). The spec pins the LITERAL, so a rename is a decision
 * rather than drift.
 */
export const ENVIRONMENT_CONTEXT_NAME = 'shell-host:environments'

/**
 * Placement: after the agent-identity facts (`CONTEXT_ORDERS` 100–125) and
 * before the harness source (200). External contributions may use any finite
 * order; 130 is this package's own number, not a reserved slot.
 */
export const ENVIRONMENT_CONTEXT_ORDER = 130

/** One resolved environment: preset id → the executable that actually exists. */
export type EnvironmentRow = { id: string; executable: string }

/**
 * The prompt line: `id → executable` pairs, one line, empty when nothing
 * resolves. Kept deliberately terse — it rides every request.
 */
export function formatEnvironmentContext(rows: readonly EnvironmentRow[]): string {
  if (rows.length === 0) return ''
  const pairs = rows.map((row) => `${row.id} → ${row.executable}`).join('; ')
  return (
    'Available shell environments on this machine (resolved launcher presets — an environment fact, not an instruction): ' +
    `${pairs}. ` +
    'Each pair is `preset id → resolved executable`; the executable is a raw command line, so it can be declared ' +
    "verbatim as pty_open's shellCommand to give a session that interpreter."
  )
}

/**
 * Local presets as rows, keeping ONLY environments whose executable exists —
 * a row's promise is "this path can be spawned", so a preset whose candidates
 * are all gone (a probe list is not a hit list) contributes nothing rather than
 * a path that would fail at spawn time. ssh presets carry no shell-env
 * (ADR-0008: ssh is the transport dimension) and are skipped for the same
 * reason.
 */
export function environmentRows(
  presets: readonly ResolvedLauncher[],
  exists: (path: string) => boolean,
): EnvironmentRow[] {
  const rows: EnvironmentRow[] = []
  for (const preset of presets) {
    if (preset.transport !== 'local') continue
    const executable = preset.executable.find((candidate) => exists(candidate))
    if (executable === undefined) continue
    rows.push({ id: preset.id, executable })
  }
  return rows
}

/**
 * The real detection: this machine's launcher table (ADR-0008 single source).
 * NOT cheap — win32 shells out to `wsl.exe` — so callers hold it behind the
 * lazy provider below, never inside `apply`.
 */
export function detectEnvironmentRows(deps: LauncherDeps = {}): EnvironmentRow[] {
  return environmentRows(resolveLaunchers(deps).presets, deps.exists ?? spawnableExists)
}

/**
 * Lazy + cached text provider: the detection runs on FIRST evaluation and the
 * rendered line is reused afterwards, so N assemblies cost one resolution
 * (#149 AC10's counting seam asserts exactly that).
 */
export function createEnvironmentContextText(detect: () => readonly EnvironmentRow[]): () => string {
  let cached: string | undefined
  return () => {
    if (cached === undefined) cached = formatEnvironmentContext(detect())
    return cached
  }
}
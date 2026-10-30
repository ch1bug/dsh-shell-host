/**
 * #169: the config-page WRITE transport — a browser-half page save travels
 * host `settings.mutate` into the terminal entry's volatile `custom` field
 * (the settings user layer), and THIS module materializes that array into the
 * custom.d FILE FAMILY — which stays the ONE authoritative storage
 * (ADR-0018 修订; human decision B on #169: the settings write is transport,
 * never a second authority).
 *
 * Semantics (ticket-internal rulings on #169, recorded in the issue comment
 * and ADR-0018's #169 revision):
 * - UPSERT: every entry with a charset-valid id becomes `<id>.json` — written
 *   only when the serialized body DIFFERS (an idempotent re-save appends no
 *   event and no write). One `changed` audit event per written entry with
 *   `origin: 'config-page'` (spec D5).
 * - DELETE: only ids THIS transport previously materialized (`known`) that the
 *   new state no longer contains — a hand-added file the page never wrote is
 *   NEVER touched. One `removed` event per deletion, same origin.
 * - SKIP: an id failing the #105 charset never touches the disk (a hostile id
 *   must not become a filename); it is reported, not written, and its absence
 *   from the array does not delete an already-materialized file.
 * - VALIDATION is NOT re-run here: the mount-time single-entry disable
 *   (#170) is the identical gate file writes face (spec D4) — an invalid
 *   entry materializes and shows up disabled with its reasons on
 *   terminal_list, exactly like a hand-edited file.
 * @module dsh-shell-host/terminal/materialize
 */

import { join } from 'node:path'
import type { CustomLauncherConfig } from '../launchers.ts'
import { ID_PATTERN } from './register.ts'
import type { AuditLedger, AuditEvent } from './audit-ledger.ts'
import type { MountFs } from './index.ts'

/** The suffix every materialized preset file carries (the D5 shape). */
export const PRESET_FILE_SUFFIX = '.json'

/** What one materialization pass did (ids, not files). */
export interface MaterializeOutcome {
  /** Entries written (content added or changed). */
  written: string[]
  /** Entries whose file was deleted (transport-known, absent from the new state). */
  removed: string[]
  /** Entries skipped — id not charset-safe (never written by this face). */
  skipped: string[]
}

/** The machine slice the transport needs (tests fake the whole thing). */
export interface MaterializeDeps {
  /** The custom.d root (same resolution as the mount's `customDirOf`). */
  customDir: string
  /** The file-family machine; `writeFile`/`unlinkFile` are the #169 additions. */
  fs: Pick<MountFs, 'listDir' | 'readFile' | 'writeFile' | 'unlinkFile' | 'ensureDir'>
  /** The shared audit ledger (#170); the transport appends its own events. */
  ledger: Pick<AuditLedger, 'append'>
  /** The transport's provenance set — ids materialized by PREVIOUS page
   * saves (mutated in place by every call). Seeded by `initKnownIds` at
   * apply time (array ∩ files: the restart shape). */
  known: Set<string>
}

/** The exact bytes one preset file carries — the single serialization, so a
 * re-save is byte-stable and the idempotence check is a plain string compare. */
export function serializePreset(entry: CustomLauncherConfig): string {
  return `${JSON.stringify(entry, undefined, 2)}\n`
}

/**
 * Sync one page-save's array into the file family. Pure over the injected
 * machine; returns what it did (ids).
 */
export function materializeCustom(next: readonly CustomLauncherConfig[], deps: MaterializeDeps): MaterializeOutcome {
  const outcome: MaterializeOutcome = { written: [], removed: [], skipped: [] }
  // The write-path charset guard: a hostile id must not become a filename.
  const writable = next.filter(e => typeof e?.id === 'string' && ID_PATTERN.test(e.id))
  for (const entry of next) {
    if (!writable.includes(entry)) outcome.skipped.push(typeof entry?.id === 'string' ? entry.id : '<no id>')
  }
  const writableIds = new Set(writable.map(e => e.id))
  // Prior provenance, captured before the mutation below.
  const priorKnown = new Set(deps.known)

  // Deletions FIRST (a rewritten id is never both): only transport-known ids
  // that the new state no longer contains in ANY shape — a hostile-skipped id
  // is still the operator's desired state, so its file is kept.
  for (const id of priorKnown) {
    if (writableIds.has(id) || outcome.skipped.includes(id)) continue
    const file = join(deps.customDir, id + PRESET_FILE_SUFFIX)
    if (deps.fs.readFile(file) === undefined) continue
    deps.fs.unlinkFile(file)
    deps.ledger.append({ kind: 'removed', id, origin: 'config-page' } as Omit<AuditEvent, 'ts' | 'source'>)
    outcome.removed.push(id)
  }

  deps.fs.ensureDir(deps.customDir)
  for (const entry of writable) {
    const file = join(deps.customDir, entry.id + PRESET_FILE_SUFFIX)
    const body = serializePreset(entry)
    if (deps.fs.readFile(file) === body) continue
    deps.fs.writeFile(file, body)
    deps.ledger.append({ kind: 'changed', id: entry.id, origin: 'config-page' } as Omit<AuditEvent, 'ts' | 'source'>)
    outcome.written.push(entry.id)
  }

  deps.known.clear()
  for (const id of writableIds) deps.known.add(id)
  return outcome
}

/**
 * Seed the transport's provenance at apply time: an id counts as
 * transport-known only when it is in the patch array AND already exists as a
 * file (the residual patch state after a page save). Array entries with NO
 * file are LEGACY patch rows (#170's migration case) — not known, so a later
 * page save can never delete what the transport never wrote.
 */
export function initKnownIds(
  current: readonly CustomLauncherConfig[],
  deps: Pick<MaterializeDeps, 'customDir' | 'fs'>,
  known: Set<string>,
): void {
  known.clear()
  const names = new Set(deps.fs.listDir(deps.customDir) ?? [])
  for (const entry of current) {
    if (typeof entry?.id === 'string' && names.has(entry.id + PRESET_FILE_SUFFIX)) known.add(entry.id)
  }
}

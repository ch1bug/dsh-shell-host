/**
 * The registration audit ledger (#170, ADR-0018 修订): an APPEND-ONLY JSONL
 * file recording the custom-preset registration surface's events —
 * registered / disabled / enabled / changed / ignored. OBSERVABILITY ONLY:
 * nothing here blocks, gates, or enforces — blocking authority belongs to
 * the #102 permission gate, and a hash mismatch at launch is a warning on
 * the tool result, never an error.
 *
 * The module is a deep leaf over an injected fs: production passes real
 * `readFileSync`/`appendFileSync` shapes, tests pass in-memory fakes
 * (TESTING.md 坑 12 — the machine is always faked at the probe seam).
 * Schema: one JSON object per line, each carrying `ts` (ISO 8601), the
 * GLOBAL `source` field (D1: `'terminal'` today, reserved for future audit
 * surfaces such as launcher presets), `kind`, and kind-specific payload
 * (`id`, `hash`, `executable`, `reasons`, …). Corrupt lines are SKIPPED,
 * never thrown: a hand-edited or truncated ledger must not take the
 * registration surface down with it.
 * @module dsh-shell-host/terminal/audit-ledger
 */

import { appendFileSync, readFileSync } from 'node:fs'

/** The one event every audit line carries. Kind-specific payload rides as
 * extra members (`hash`, `executable`, `reasons`, `count`, …) — the shape is
 * open by design so future surfaces can share it without migration (D1). */
export interface AuditEvent {
  /** ISO 8601 timestamp, stamped by the ledger at append time. */
  ts: string
  /** Global source field (D1): the audit face that produced the event. */
  source: 'terminal'
  kind: 'registered' | 'disabled' | 'enabled' | 'changed' | 'ignored' | 'removed'
  /** Preset id, when the event is about one (the `ignored` event is about a
   * CHANNEL, not a preset — its `what` member names the channel). */
  id?: string
  /** Discriminator for channel-level events (`ignored` carries
   * `what: 'patch-source'`, the D8 废止 event) so future audit faces can
   * share the ledger without colliding on bare `ignored` lines. */
  what?: string
  /** Extra payload (hash / executable / reasons / count / …). */
  [key: string]: unknown
}

/** Minimal synchronous-fs shape the ledger needs (injectable for tests). */
export interface LedgerDeps {
  /** The ledger file path. */
  ledgerPath: string
  /** Whole-file read; defaults to readFileSync (a missing file reads as an
   * empty history, any other read error too — the ledger never blocks). */
  readFile?: (path: string) => string | undefined
  /** One-line append; defaults to appendFileSync. The CALLER ensures the
   * parent directory exists (the production wrapper in `./terminal` runs its
   * fs seam's ensureDir first — the default implementation does NOT create
   * directories). */
  appendFile?: (path: string, line: string) => void
  /** Clock seam for `ts` stamps. */
  now?: () => Date
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function defaultAppendFile(path: string, line: string): void {
  appendFileSync(path, line, 'utf8')
}

/** Parse one JSONL body, skipping blank/corrupt lines (tolerant by design). */
function parseLines(body: string): AuditEvent[] {
  const events: AuditEvent[] = []
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (typeof parsed === 'object' && parsed !== null &&
          typeof (parsed as Record<string, unknown>)['kind'] === 'string' &&
          typeof (parsed as Record<string, unknown>)['ts'] === 'string') {
        events.push(parsed as AuditEvent)
      }
    } catch {
      // Corrupt line: skip, keep the readable history.
    }
  }
  return events
}

/** The ledger facade: append stamps + persists; the queries scan the file. */
export interface AuditLedger {
  /** Stamp `ts` + `source` and append one JSON line. Returns the event. */
  append(event: Omit<AuditEvent, 'ts' | 'source'> & { source?: 'terminal' }): AuditEvent
  /** The whole readable history, in order. */
  readAll(): AuditEvent[]
  /** The newest event about an id, or undefined. */
  latestEventFor(id: string): AuditEvent | undefined
  /** The newest `registered` event about an id — the launch-time hash
   * BASELINE (later `changed` observations never move it, #170 留档口径). */
  latestRegisteredFor(id: string): AuditEvent | undefined
  /** The baseline hash for an id: the hash carried by its newest
   * `registered` event (`changed` events do not count). */
  latestHashFor(id: string): string | undefined
}

export function createAuditLedger(deps: LedgerDeps): AuditLedger {
  const readFile = deps.readFile ?? defaultReadFile
  const appendFile = deps.appendFile ?? defaultAppendFile
  return {
    append(event) {
      const now = (deps.now ?? ((): Date => new Date()))()
      const stamped: AuditEvent = { ...(event as AuditEvent), source: 'terminal', ts: now.toISOString() }
      appendFile(deps.ledgerPath, `${JSON.stringify(stamped)}\n`)
      return stamped
    },
    readAll() {
      const body = readFile(deps.ledgerPath)
      return body === undefined ? [] : parseLines(body)
    },
    latestEventFor(id) {
      const events = this.readAll()
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.id === id) return events[i]
      }
      return undefined
    },
    latestRegisteredFor(id) {
      const events = this.readAll()
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.id === id && events[i]!.kind === 'registered') return events[i]
      }
      return undefined
    },
    latestHashFor(id) {
      const last = this.latestRegisteredFor(id)
      return typeof last?.hash === 'string' ? last.hash : undefined
    },
  }
}

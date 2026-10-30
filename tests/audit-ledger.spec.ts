/**
 * #170 — the registration AUDIT LEDGER module (the spec's only new seam):
 * an append-only JSONL file that records the custom-preset registration
 * surface's events (registered / disabled / enabled / changed / ignored).
 * OBSERVABILITY ONLY — it has no enforcement semantics; blocking belongs to
 * the #102 permission gate. The module is pure logic over an injected fs:
 * tests fake the machine (TESTING.md 坑 12), production passes the real one.
 * @module tests/audit-ledger
 */

import { describe, expect, it } from "vitest";
import { createAuditLedger, type LedgerDeps } from "../src/terminal/audit-ledger.ts";

/** In-memory JSONL file: one string per line, joined with \n. */
function fakeDeps(lines: string[] = [], opts: { now?: string } = {}): LedgerDeps & { file: string[] } {
  const file = [...lines];
  return {
    file,
    ledgerPath: "<mem>/audit.jsonl",
    readFile: (path) => (path === "<mem>/audit.jsonl" ? (file.length === 0 ? undefined : file.join("\n")) : undefined),
    appendFile: (path, line) => {
      if (path !== "<mem>/audit.jsonl") throw new Error(`unexpected append target: ${path}`);
      file.push(line);
    },
    now: () => new Date(opts.now ?? "2026-10-29T00:00:00.000Z"),
  };
}

describe("audit ledger (#170): append-only JSONL over an injected fs", () => {
  it("append stamps ts + the global source field and persists one JSON line", () => {
    const deps = fakeDeps();
    const ledger = createAuditLedger(deps);
    const event = ledger.append({ kind: "registered", id: "my-shell", hash: "abc123", executable: "C:\\x\\sh.exe" });
    expect(event.ts).toBe("2026-10-29T00:00:00.000Z");
    expect(event.source).toBe("terminal");
    expect(deps.file).toHaveLength(1);
    const parsed = JSON.parse(deps.file[0]!) as Record<string, unknown>;
    expect(parsed["kind"]).toBe("registered");
    expect(parsed["id"]).toBe("my-shell");
    expect(parsed["hash"]).toBe("abc123");
    expect(parsed["source"]).toBe("terminal");
  });

  it("readAll parses the persisted sequence back; corrupt lines are skipped, not thrown", () => {
    const deps = fakeDeps([
      JSON.stringify({ ts: "t1", source: "terminal", kind: "registered", id: "a", hash: "h1" }),
      "NOT JSON {{{",
      JSON.stringify({ ts: "t2", source: "terminal", kind: "disabled", id: "a", reasons: ["bad"] }),
      JSON.stringify({ nope: true }),
    ]);
    const ledger = createAuditLedger(deps);
    const events = ledger.readAll();
    expect(events.map((e) => e.kind)).toEqual(["registered", "disabled"]);
    expect(events[0]!.id).toBe("a");
  });

  it("a missing ledger file reads as an empty history", () => {
    const deps = fakeDeps();
    (deps as { readFile?: unknown }).readFile = undefined; // production default: readFileSync that throws on missing
    const ledger = createAuditLedger(deps);
    expect(ledger.readAll()).toEqual([]);
  });

  it("latestHashFor is the BASELINE: the newest hash from registered events only (changed never moves it)", () => {
    const deps = fakeDeps([
      JSON.stringify({ ts: "t1", source: "terminal", kind: "registered", id: "a", hash: "old" }),
      JSON.stringify({ ts: "t2", source: "terminal", kind: "registered", id: "b", hash: "other" }),
      JSON.stringify({ ts: "t3", source: "terminal", kind: "changed", id: "a", hash: "observed" }),
    ]);
    const ledger = createAuditLedger(deps);
    expect(ledger.latestHashFor("a")).toBe("old");
    expect(ledger.latestHashFor("b")).toBe("other");
    expect(ledger.latestHashFor("missing")).toBeUndefined();
    // latestRegisteredFor exposes the ts the baseline was recorded at.
    expect(ledger.latestRegisteredFor("a")?.ts).toBe("t1");
    expect(ledger.latestRegisteredFor("missing")).toBeUndefined();
  });

  it("latestEventFor returns the newest event for an id (transition dedup reads it)", () => {
    const deps = fakeDeps([
      JSON.stringify({ ts: "t1", source: "terminal", kind: "registered", id: "a", hash: "h" }),
      JSON.stringify({ ts: "t2", source: "terminal", kind: "disabled", id: "a", reasons: ["r"] }),
      JSON.stringify({ ts: "t3", source: "terminal", kind: "disabled", id: "b", reasons: ["r"] }),
    ]);
    const ledger = createAuditLedger(deps);
    expect(ledger.latestEventFor("a")?.kind).toBe("disabled");
    expect(ledger.latestEventFor("b")?.kind).toBe("disabled");
    expect(ledger.latestEventFor("missing")).toBeUndefined();
  });
});

/**
 * #169: the config-page transport seam — a page save travels
 * settings.mutate → the terminal entry's volatile `custom` field →
 * `materializeCustom` MATERIALIZES the array into the custom.d FILE FAMILY
 * (the one authority, ADR-0018 修订; human decision B on #169: the settings
 * write is TRANSPORT, the file family stays authoritative). The machine is
 * faked at the fs seam (TESTING.md 坑 12); assertions read the file store and
 * the ledger's JSONL content.
 * @module tests/materialize
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeMountFs } from "./helpers/fake-terminal.ts";
import type { CustomLauncherConfig } from "../src/launchers.ts";
import {
  initKnownIds,
  materializeCustom,
  serializePreset,
  type MaterializeDeps,
} from "../src/terminal/materialize.ts";

const DIR = "<mem>/custom.d";
const pf = (name: string) => join(DIR, name);

const entry = (over: Partial<CustomLauncherConfig> = {}): CustomLauncherConfig => ({
  id: "page-shell",
  transport: "local",
  executable: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"],
  argv: ["-l"],
  ...over,
});

type FakeMachine = ReturnType<typeof fakeMountFs>;

function deps(machine: FakeMachine, known: Set<string> = new Set()): MaterializeDeps {
  return {
    customDir: DIR,
    fs: machine,
    ledger: {
      // The ledger's return value is unused by the transport; the fake
      // machine's append records the line the assertions read back.
      append: (event) => machine.append("", JSON.stringify(event)) as never,
    },
    known,
  };
}

function filesOf(machine: FakeMachine): Array<{ id: string; body: string }> {
  return (machine.listDir(DIR) ?? [])
    .filter((n) => n.endsWith(".json"))
    .map((n) => ({ id: n.replace(/\.json$/, ""), body: machine.readFile(pf(n))! }));
}

function kinds(machine: FakeMachine): Array<{ kind: string; id?: string; origin?: string }> {
  return machine.lines().map((l) => JSON.parse(l));
}

describe("materializeCustom — the page-save transport writes the file family (#169 decision B)", () => {
  it("an added entry becomes <id>.json; the ledger records ONE changed event with origin config-page", () => {
    const machine = fakeMountFs();
    const known = new Set<string>();
    const out = materializeCustom([entry()], deps(machine, known));
    expect(out).toEqual({ written: ["page-shell"], removed: [], skipped: [] });
    expect(filesOf(machine)).toEqual([{ id: "page-shell", body: serializePreset(entry()) }]);
    const events = kinds(machine);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "changed", id: "page-shell", origin: "config-page" });
    expect(known).toEqual(new Set(["page-shell"]));
  });

  it("a changed entry rewrites the file; an UNCHANGED entry neither rewrites nor re-events (idempotent save)", () => {
    const machine = fakeMountFs({ [pf("page-shell.json")]: serializePreset(entry()) });
    const known = new Set(["page-shell"]);
    // Same content: no write, no event.
    expect(materializeCustom([entry()], deps(machine, known))).toEqual({ written: [], removed: [], skipped: [] });
    expect(machine.lines()).toHaveLength(0);
    // Changed argv: one rewrite + one event.
    const next = entry({ argv: ["-NoLogo"] });
    expect(materializeCustom([next], deps(machine, known))).toEqual({ written: ["page-shell"], removed: [], skipped: [] });
    expect(machine.readFile(pf("page-shell.json"))).toBe(serializePreset(next));
    expect(kinds(machine)).toHaveLength(1);
  });

  it("a deleted entry removes its file with a removed event; a HAND-ADDED file the transport never wrote is untouched", () => {
    const machine = fakeMountFs({
      [pf("page-shell.json")]: serializePreset(entry()),
      [pf("hand-made.json")]: serializePreset(entry({ id: "hand-made", argv: [] })),
    });
    const known = new Set(["page-shell"]);
    const out = materializeCustom([], deps(machine, known));
    expect(out).toEqual({ written: [], removed: ["page-shell"], skipped: [] });
    expect(filesOf(machine).map((f) => f.id)).toEqual(["hand-made"]);
    expect(kinds(machine)).toEqual([expect.objectContaining({ kind: "removed", id: "page-shell", origin: "config-page" })]);
  });

  it("a HOSTILE id (failing the #105 id charset) is skipped — never written, never used as a filename", () => {
    const machine = fakeMountFs();
    const hostile = entry({ id: "../evil" });
    const out = materializeCustom([hostile, entry({ id: "ok-shell" })], deps(machine));
    expect(out).toEqual({ written: ["ok-shell"], removed: [], skipped: ["../evil"] });
    expect(filesOf(machine).map((f) => f.id)).toEqual(["ok-shell"]);
  });

  it("a hostile id is skipped from desired-state semantics: the entries the array still names are untouched by ITS presence", () => {
    // page-shell (known) is absent from the next array → removed (desired
    // state). The hostile entry itself never had a file to lose.
    const machine = fakeMountFs({ [pf("page-shell.json")]: serializePreset(entry()) });
    const known = new Set(["page-shell"]);
    const out = materializeCustom([entry({ id: "../../bad" })], deps(machine, known));
    expect(out).toEqual({ written: [], removed: ["page-shell"], skipped: ["../../bad"] });
    expect(machine.readFile(pf("page-shell.json"))).toBeUndefined();
  });

  it("initKnownIds seeds provenance from (transport array ∩ existing files) — the restart shape", () => {
    const machine = fakeMountFs({
      [pf("page-shell.json")]: serializePreset(entry()),
      [pf("hand-made.json")]: serializePreset(entry({ id: "hand-made" })),
    });
    const known = new Set<string>();
    initKnownIds([entry(), entry({ id: "ghost-shell" })], { customDir: DIR, fs: machine }, known);
    // page-shell: in the transport array AND on disk → known. ghost-shell: array
    // but NO file → legacy patch row, NOT known (a later save must not delete it).
    // hand-made: file but NOT in the array → not the transport's.
    expect(known).toEqual(new Set(["page-shell"]));
    // And a follow-up save without it deletes exactly the known one.
    const out = materializeCustom([], deps(machine, known));
    expect(out.removed).toEqual(["page-shell"]);
  });
});

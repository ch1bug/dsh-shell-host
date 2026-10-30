/**
 * #170 — the audit face's EXTERNAL behavior at the tool surface: the
 * shell_open hash-mismatch warning (advisory only — the launch proceeds;
 * a matching hash or a missing ledger record warns NOTHING — the
 * discriminating counter-samples), the once-per-observed-hash `changed`
 * ledger event, and the terminal_list projection of builtin / active /
 * disabled presets. Assertions land on tool RESULTS and LEDGER FILE
 * CONTENT only, never on internal call relationships (spec Testing
 * Decisions).
 * @module tests/terminal-audit
 */

import { describe, expect, it, beforeEach } from "vitest";
import { join } from "node:path";
import { bootTerminal, fakeMountFs, fullDeps, PWSH } from "./helpers/fake-terminal.ts";
import { _resetRegistrationForTests } from "../src/terminal/index.ts";

const DIR = "<mem>/custom.d";
const pf = (name: string) => join(DIR, name);
const PWSH_HASH = `hash:C:/Program Files/PowerShell/7/pwsh.exe`;
const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: "my-shell", transport: "local", executable: [PWSH], ...over });

beforeEach(() => {
  _resetRegistrationForTests();
});

function kindsOf(machine: ReturnType<typeof fakeMountFs>): string[] {
  return machine.lines().map((l) => (JSON.parse(l) as { kind: string }).kind);
}

describe("shell_open hash check (#170): advisory warning at the tool result", () => {
  it("registered hash ≠ current file hash → audit warning on the result + changed event; launch proceeds", async () => {
    const machine = fakeMountFs({ [pf("my-shell.json")]: entry() }, { [PWSH]: "hash-OLD" });
    bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    // The file changed since registration.
    machine.hashFile = (path: string) => (path === PWSH ? "hash-NEW" : `hash:${path}`);
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    const opened = await boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    expect(opened.sessionId).toBeTruthy(); // NOT blocked
    expect(opened.audit).toMatchObject({
      warning: "executable-changed-since-registration",
      expectedHash: "hash-OLD",
      actualHash: "hash-NEW",
    });
    expect(kindsOf(machine)).toEqual(["registered", "changed"]);
    const changed = JSON.parse(machine.lines()[1]!) as { kind: string; hash: string; expectedHash: string };
    expect(changed.hash).toBe("hash-NEW");
    expect(changed.expectedHash).toBe("hash-OLD");
  });

  it("COUNTER-SAMPLE: matching hash → NO audit field, no changed event", async () => {
    const machine = fakeMountFs({ [pf("my-shell.json")]: entry() }, { [PWSH]: PWSH_HASH });
    bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    const opened = await boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    expect(opened.audit).toBeUndefined();
    expect(kindsOf(machine)).toEqual(["registered"]);
  });

  it("COUNTER-SAMPLE: no ledger record at all → no warning (a newly installed file is legitimate)", async () => {
    // The ledger was wiped (or the preset predates the audit face): a launch
    // with NO registered baseline must not warn.
    const machine = fakeMountFs({ [pf("my-shell.json")]: entry() });
    bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    const opened = await boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    expect(opened.source).toBe("custom");
    expect(opened.audit).toBeUndefined();
  });

  it("the same observed hash warns on every launch but is recorded ONCE in the ledger", async () => {
    const machine = fakeMountFs({ [pf("my-shell.json")]: entry() }, { [PWSH]: "hash-OLD" });
    bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    machine.hashFile = (path: string) => (path === PWSH ? "hash-NEW" : `hash:${path}`);
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    await boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    await boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    expect(kindsOf(machine)).toEqual(["registered", "changed"]);
  });

  it("a builtin preset launch never triggers the audit check", async () => {
    const machine = fakeMountFs({}, { [PWSH]: "hash-OLD" });
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    const opened = await boot.tool("shell_open").execute({ preset: "pwsh" }, { agent: { name: "u" } });
    expect(opened.source).toBe("builtin");
    expect(opened.audit).toBeUndefined();
    expect(machine.lines()).toHaveLength(0);
  });
});

describe("terminal_list (#170): the read-only projection", () => {
  it("projects builtin views, active custom rows, and disabled rows with original reasons", async () => {
    const boot = bootTerminal({}, fullDeps, {
      fakeSpawn: true,
      files: {
        [pf("good.json")]: entry({ id: "good" }),
        [pf("broken.json")]: "{ NOT JSON",
      },
    });
    const listed = await boot.tool("terminal_list").execute({}, { agent: { name: "u" } });
    const byId = new Map<string, { id: string; source: string; transport: string; disabled?: boolean; reasons?: string[]; file?: string }>(
      listed.presets.map((p: { id: string }) => [p.id, p]),
    );
    expect(byId.get("pwsh")).toMatchObject({ source: "builtin", transport: "local" });
    expect(byId.get("good")).toMatchObject({ source: "custom", transport: "local", file: "good.json" });
    const broken = byId.get("broken")!;
    expect(broken.disabled).toBe(true);
    expect(broken.reasons!.join(" ")).toContain("JSON");
    expect(broken.file).toBe("broken.json");
    // Every preset appears exactly once.
    const ids = listed.presets.map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

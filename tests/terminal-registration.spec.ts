/**
 * #105/#170 — the custom-preset REGISTRATION surface (host half): the
 * validation matrix at mount time, the no-builtin-override guard, and the
 * agent-face guard (no write path into the registration through the tool
 * surface). Since #170 (ADR-0018 修订) the authoritative storage is the
 * custom.d FILE FAMILY (one <id>.json per preset): a bad file disables ONLY
 * that preset (the whole-batch registrationError gate is retired) and the
 * family re-reads on EVERY mount. The registration contract lives in
 * src/terminal/register.ts + src/terminal/index.ts.
 * @module tests/terminal-registration
 */

import { describe, expect, it, beforeEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bootTerminal, fakeMountFs, fullDeps, PWSH } from "./helpers/fake-terminal.ts";
import { _resetRegistrationForTests } from "../src/terminal/index.ts";
import { validateCustomEntries } from "../src/terminal/register.ts";
import type { LauncherDeps } from "../src/launchers.ts";

// A REAL absolute file (the running node executable) and a REAL directory —
// the registration gate probes the actual filesystem on purpose (a config
// file is validated against the machine it will execute on).
const REAL_FILE = process.execPath;
const REAL_DIR = tmpdir();

const DIR = "<mem>/custom.d";
/** A custom.d file path in the fake machine. */
const pf = (name: string) => join(DIR, name);
/** The boot-time shape: an executable the fullDeps fake probe knows. */
const bootEntry = (over: Record<string, unknown> = {}) => ({
  id: "my-shell",
  transport: "local",
  executable: [PWSH],
  ...over,
});

beforeEach(() => {
  _resetRegistrationForTests();
});

const entry = (over: Record<string, unknown>) => ({
  id: "my-shell",
  transport: "local",
  executable: [REAL_FILE],
  ...over,
});

describe("registration validation matrix (#105) — every illegal shape is loudly rejected", () => {
  const validate = (rows: unknown[]) => validateCustomEntries(rows, { builtInIds: ["pwsh", "bash"] });

  it("relative path → rejected", () => {
    const { rejected } = validate([entry({ executable: ["bin/mysh.exe"] })]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reasons.join(" ")).toContain("absolute path");
  });

  it("nonexistent path → rejected", () => {
    const { rejected } = validate([entry({ executable: [join(REAL_DIR, "definitely-not-here-105.exe")] })]);
    expect(rejected[0]!.reasons.join(" ")).toContain("does not exist");
  });

  it("directory → rejected", () => {
    const { rejected } = validate([entry({ executable: [REAL_DIR] })]);
    expect(rejected[0]!.reasons.join(" ")).toContain("is a directory");
  });

  it("executable string with arguments → rejected (the existence probe catches the suffix)", () => {
    const { rejected } = validate([entry({ executable: [`${REAL_FILE} --am-i-args`] })]);
    expect(rejected[0]!.reasons.join(" ")).toContain("does not exist");
  });

  it("shell metacharacters → rejected", () => {
    for (const bad of [`"${REAL_FILE}"`, `${REAL_FILE}&calc`, "${HOME}/sh", join(REAL_DIR, "a|b"), `${REAL_FILE}?x`, `${REAL_FILE}!i`, `${REAL_FILE}^up`]) {
      const { rejected } = validate([entry({ executable: [bad] })]);
      expect(rejected, bad).toHaveLength(1);
      expect(rejected[0]!.reasons.join(" ")).toContain("metacharacters");
    }
  });

  it("NTFS alternate data stream (second colon) → rejected on win32", () => {
    const { rejected } = validateCustomEntries(
      [entry({ executable: ["C:\\evil\\sh.exe:ads"] })],
      { builtInIds: [], exists: () => true, isDirectory: () => false, platform: "win32" },
    );
    expect(rejected[0]!.reasons.join(" ")).toContain("alternate data stream");
  });

  it("bare name (PATH resolution) → rejected", () => {
    const { rejected } = validate([entry({ executable: ["mysh.exe"] })]);
    expect(rejected[0]!.reasons.join(" ")).toContain("absolute path");
  });

  it("custom id shadowing a built-in id → rejected (the #54 override semantics are closed)", () => {
    const { rejected } = validate([entry({ id: "pwsh" })]);
    expect(rejected[0]!.reasons.join(" ")).toContain("override the built-in");
  });

  it("duplicate custom id → rejected; ssh without host → rejected; bad cwd → rejected", () => {
    const { rejected } = validate([
      entry({}),
      entry({}), // duplicate id
      entry({ id: "second-shell", transport: "ssh", executable: [REAL_FILE] }),
      entry({ id: "third-shell", cwd: "relative/dir" }),
    ]);
    expect(rejected.map(r => r.id)).toEqual(["my-shell", "second-shell", "third-shell"]);
    expect(rejected[0]!.reasons.join(" ")).toContain("duplicate custom preset id");
    expect(rejected[1]!.reasons.join(" ")).toContain("requires a host");
    expect(rejected[2]!.reasons.join(" ")).toContain("cwd must be an absolute path");
  });

  it("rejected entries list EVERY reason (single-entry disable projects them verbatim)", () => {
    const { rejected } = validate([entry({ id: "pwsh", executable: ["nope exe"] })]);
    expect(rejected[0]!.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("custom.d file family mount (#170, ADR-0018 修订)", () => {
  it("a legal file reaches the preset table: source=custom, resolvable, ledger records it", async () => {
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true, files: { [pf("my-shell.json")]: JSON.stringify(bootEntry()) } });
    const opened = await boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    expect(opened.source).toBe("custom");
    expect(opened.executable).toBe(PWSH);
    const events = boot.mountFs.lines().map((l) => JSON.parse(l) as { kind: string; id?: string; hash?: string });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "registered", id: "my-shell", hash: `hash:C:/Program Files/PowerShell/7/pwsh.exe` });
  });

  it("a bad file disables ONLY that entry; the others mount (the whole-batch gate is retired)", async () => {
    const boot = bootTerminal({}, fullDeps, {
      fakeSpawn: true,
      files: {
        [pf("a-good.json")]: JSON.stringify(bootEntry({ id: "a-good" })),
        [pf("bad-shell.json")]: JSON.stringify(bootEntry({ id: "bad-shell", executable: ["C:\\nope\\missing.exe"] })),
      },
    });
    // The counter-sample: the GOOD entry mounts normally.
    const opened = await boot.tool("shell_open").execute({ preset: "a-good" }, { agent: { name: "u" } });
    expect(opened.source).toBe("custom");
    // The BAD entry is not in the table...
    await expect(
      boot.tool("shell_open").execute({ preset: "bad-shell" }, { agent: { name: "u" } }),
    ).rejects.toThrow(/unknown preset/);
    // ...but visible on terminal_list with the original reasons.
    const listed = await boot.tool("terminal_list").execute({}, { agent: { name: "u" } });
    const bad = listed.presets.find((p: { id: string }) => p.id === "bad-shell");
    expect(bad).toMatchObject({ disabled: true, source: "custom", file: "bad-shell.json" });
    expect(bad.reasons.join(" ")).toContain("does not exist");
    const good = listed.presets.find((p: { id: string }) => p.id === "a-good");
    expect(good!.source).toBe("custom");
    expect(good!.disabled).toBeUndefined();
    // The ledger recorded both the registration and the disable.
    const kinds = boot.mountFs.lines().map((l) => (JSON.parse(l) as { kind: string; id?: string }).kind);
    expect(kinds.sort()).toEqual(["disabled", "registered"]);
  });

  it("an unreadable/invalid-JSON file disables that entry with its own reason; others mount", async () => {
    const boot = bootTerminal({}, fullDeps, {
      fakeSpawn: true,
      files: {
        [pf("a-good.json")]: JSON.stringify(bootEntry({ id: "a-good" })),
        [pf("b-broken.json")]: "{ NOT JSON",
      },
    });
    await expect(
      boot.tool("shell_open").execute({ preset: "a-good" }, { agent: { name: "u" } }),
    ).resolves.toMatchObject({ source: "custom" });
    const listed = await boot.tool("terminal_list").execute({}, { agent: { name: "u" } });
    const broken = listed.presets.find((p: { id: string }) => p.id === "b-broken");
    expect(broken.disabled).toBe(true);
    expect(broken.reasons.join(" ")).toContain("JSON");
  });

  it("inheritance from an earlier file works (file order = inheritance order); from an unknown base it is disabled", async () => {
    const boot = bootTerminal({}, fullDeps, {
      fakeSpawn: true,
      files: {
        [pf("a-base.json")]: JSON.stringify(bootEntry({ id: "a-base" })),
        [pf("child-shell.json")]: JSON.stringify(bootEntry({ id: "child-shell", base: "a-base", argv: ["--mine"] })),
      },
    });
    const opened = await boot.tool("shell_open").execute({ preset: "child-shell" }, { agent: { name: "u" } });
    expect(opened.executable).toBe(PWSH);
    const { rejected: orphanRejected } = validateCustomEntries(
      [entry({ id: "orphan", base: "no-such-base" })],
      { builtInIds: [] },
    );
    expect(orphanRejected[0]!.reasons.join(" ")).toContain("base preset");
  });

  it("the patch-row channel is 废止: config.custom entries are ignored with ONE audit event; custom.d still mounts", async () => {
    const boot = bootTerminal(
      { custom: [bootEntry({}), bootEntry({ id: "second-shell" })] as never },
      fullDeps,
      { fakeSpawn: true, files: { [pf("file-shell.json")]: JSON.stringify(bootEntry({ id: "file-shell" })) } },
    );
    // Neither patch row registered...
    await expect(
      boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } }),
    ).rejects.toThrow(/unknown preset/);
    await expect(
      boot.tool("shell_open").execute({ preset: "second-shell" }, { agent: { name: "u" } }),
    ).rejects.toThrow(/unknown preset/);
    // ...the file family still mounts...
    await expect(
      boot.tool("shell_open").execute({ preset: "file-shell" }, { agent: { name: "u" } }),
    ).resolves.toMatchObject({ source: "custom" });
    // ...and ONE ignored:patch-source event covers the whole channel (not one per entry).
    const ignored = boot.mountFs.lines().map((l) => JSON.parse(l) as { kind: string; what?: string; count?: number }).filter((e) => e.kind === "ignored");
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ what: "patch-source", count: 2 });
  });

  it("relative customDir is a loud config error", () => {
    expect(() => bootTerminal({ customDir: "relative/dir" } as never, fullDeps, { fakeSpawn: true })).toThrow(/absolute/);
  });
});

describe("the file family re-reads on every mount (#170 replaces the #105 restart contract)", () => {
  it("fixing a file re-enables the preset on the NEXT MOUNT, with a disabled→enabled ledger trail", async () => {
    const files: Record<string, string> = {
      [pf("my-shell.json")]: JSON.stringify(bootEntry({ executable: ["C:\\nope\\missing.exe"] })),
    };
    const machine = fakeMountFs(files);
    const first = bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    await expect(
      first.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } }),
    ).rejects.toThrow(/unknown preset/);
    expect(machine.lines().map((l) => (JSON.parse(l) as { kind: string }).kind)).toEqual(["disabled"]);

    // Fix the file, then REMOUNT on the SAME machine (the HMR re-apply shape).
    files[pf("my-shell.json")] = JSON.stringify(bootEntry());
    const second = bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    await expect(
      second.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } }),
    ).resolves.toMatchObject({ source: "custom" });
    expect(machine.lines().map((l) => (JSON.parse(l) as { kind: string }).kind)).toEqual(["disabled", "enabled", "registered"]);
  });

  it("remount without a file change appends NO duplicate events (transition dedup)", async () => {
    const files = { [pf("my-shell.json")]: JSON.stringify(bootEntry()) };
    const machine = fakeMountFs(files);
    bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    expect(machine.lines()).toHaveLength(1); // one registered
    bootTerminal({}, fullDeps, { fakeSpawn: true, machine });
    expect(machine.lines()).toHaveLength(1); // the remount appended nothing
  });
});

describe("agent-face guard (#105/#170): the tool surface has no write path into the registration", () => {
  it("the terminal entry registers shell_open + the read-only terminal_list — no registration parameters", () => {
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true, files: { [pf("my-shell.json")]: JSON.stringify(bootEntry()) } });
    const terminalTools = boot.registered.filter((t: { name: string }) => t.name === "shell_open");
    expect(terminalTools).toHaveLength(1);
    const paramKeys = Object.keys(terminalTools[0]!.parameters.properties);
    expect(paramKeys).toEqual(["preset", "cwd", "env", "idleTimeoutMs", "sandbox_permissions", "justification"]);
    const listTools = boot.registered.filter((t: { name: string }) => t.name === "terminal_list");
    expect(listTools).toHaveLength(1);
    expect(Object.keys(listTools[0]!.parameters.properties)).toEqual([]);
    // No tool name on the whole bundle hints at a registration writer.
    for (const tool of boot.registered as { name: string }[]) {
      expect(tool.name).not.toMatch(/register|custom|preset[-_](add|set|write|remove|delete)/i);
    }
  });
});

describe("path shapes (#105): absoluteness is the rule, not 'no home'", () => {
  it("an absolute home path is accepted; a tilde path is not silently expanded", () => {
    const { rejected } = validateCustomEntries(
      [entry({ executable: [join(homedir(), "mysh.exe")] })],
      { builtInIds: [], exists: () => true, isDirectory: () => false },
    );
    expect(rejected).toHaveLength(0);
    const tilde = validateCustomEntries([entry({ executable: ["~/mysh.exe"] })], {
      builtInIds: [],
      exists: () => true,
      isDirectory: () => false,
    });
    expect(tilde.rejected[0]!.reasons.join(" ")).toContain("absolute path");
  });
});

describe("#169 config-page transport (settings write = file-family materialization, decision B)", () => {
  /** The volatile-reference shape the loader hands apply() (read via .get(),
   * updated IN PLACE by the volatile-only commit) — the transport re-reads
   * the CURRENT state at event time, exactly like production. */
  const refConfig = (current: () => unknown) => ({ custom: { get: current } }) as never;

  it("a volatile-update on custom materializes the array into files; the preset is LIVE for the next shell_open without a remount", async () => {
    const next: unknown[] = [bootEntry()];
    const boot = bootTerminal(refConfig(() => next), fullDeps, { fakeSpawn: true });
    // Before the save: patch-only row — legacy, no file, not resolvable.
    await expect(
      boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } }),
    ).rejects.toThrow(/unknown preset/);

    boot.emit("loader/volatile-update", [["custom"]]);

    // The file family now carries the preset (the one authority), ...
    expect(boot.mountFs.readFile(pf("my-shell.json"))).toContain('"my-shell"');
    // ...the preset is live WITHOUT a remount...
    await expect(
      boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } }),
    ).resolves.toMatchObject({ source: "custom" });
    // ...and the ledger carries the transport event + the mount transitions
    // (changed with origin config-page; registered baseline from the refresh).
    const events = boot.mountFs.lines().map((l) => JSON.parse(l) as { kind: string; id?: string; origin?: string });
    expect(events).toContainEqual(expect.objectContaining({ kind: "changed", id: "my-shell", origin: "config-page" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "registered", id: "my-shell" }));
  });

  it("a save that drops a transport-known id removes its file and unlists the preset without a remount", async () => {
    let current: unknown[] = [bootEntry()];
    const body = JSON.stringify(bootEntry());
    const boot = bootTerminal(refConfig(() => current), fullDeps, {
      fakeSpawn: true,
      files: { [pf("my-shell.json")]: body }, // array ∩ file → transport-known
    });
    await expect(
      boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } }),
    ).resolves.toMatchObject({ source: "custom" });

    current = []; // the page saved [] (the volatile commit)
    boot.emit("loader/volatile-update", [["custom"]]);

    expect(boot.mountFs.readFile(pf("my-shell.json"))).toBeUndefined();
    await expect(
      boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } }),
    ).rejects.toThrow(/unknown preset/);
    const events = boot.mountFs.lines().map((l) => JSON.parse(l) as { kind: string; origin?: string });
    expect(events).toContainEqual(expect.objectContaining({ kind: "removed", origin: "config-page" }));
  });

  it("a volatile-update on a NON-custom path is a no-op", () => {
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true });
    boot.emit("loader/volatile-update", [["maxSessions"], ["deep", "path"]]);
    expect(boot.mountFs.lines()).toHaveLength(0);
    expect(boot.mountFs.listDir(pf("")) ?? []).toHaveLength(0);
  });
});

/**
 * #105 — the custom-preset REGISTRATION surface (host half): the loud
 * validation matrix at apply time, the no-builtin-override guard, the
 * restart-effect contract (a process-level snapshot: re-apply or config-file
 * mutation never changes the live preset table mid-session), and the
 * agent-face guard (no write path into the registration through the tool
 * surface). The client config page is a candidate follow-up (ADR-0018);
 * the registration contract lives in src/terminal/register.ts.
 * @module tests/terminal-registration
 */

import { describe, expect, it, beforeEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bootTerminal, fullDeps, PWSH } from "./helpers/fake-terminal.ts";
import {
  _resetRegistrationForTests,
} from "../src/terminal/index.ts";
import { validateCustomEntries, registrationError } from "../src/terminal/register.ts";
import type { LauncherDeps } from "../src/launchers.ts";

// A REAL absolute file (the running node executable) and a REAL directory —
// the registration gate probes the actual filesystem on purpose (a config
// file is validated against the machine it will execute on).
const REAL_FILE = process.execPath;
const REAL_DIR = tmpdir();

beforeEach(() => {
  _resetRegistrationForTests();
});

const entry = (over: Record<string, unknown>) => ({
  id: "my-shell",
  transport: "local",
  executable: [REAL_FILE],
  ...over,
});
// The boot-time shape: an executable the fullDeps fake probe knows (the
// apply-time validation rides the SAME probe seam as resolution).
const bootEntry = (over: Record<string, unknown>) => entry({ executable: [PWSH], ...over });

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

  it("rejected entries list EVERY reason, and the loud error names the position", () => {
    const { rejected } = validate([entry({ id: "pwsh", executable: ["nope exe"] })]);
    expect(rejected[0]!.reasons.length).toBeGreaterThanOrEqual(2);
    const err = registrationError(rejected);
    expect(err.message).toContain("[0]");
    expect(err.message).toContain("RESTART");
    // #171: same structured code family as resolveCustom's parse-time
    // rejections — a consumer branches on `code`, never on prose.
    expect(err.code).toBe("PRESET_CONFIG_INVALID");
  });
});

describe("registration gate at apply time (#105)", () => {
  it("an illegal config file fails the row activation loudly — nothing registers", () => {
    let caught: unknown;
    try {
      bootTerminal({ custom: [bootEntry({ id: "pwsh" })] as never }, fullDeps, { fakeSpawn: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/override the built-in/);
    expect((caught as { code?: string }).code).toBe("PRESET_CONFIG_INVALID");
  });

  it("a legal registration reaches the preset table: source=custom, resolvable", async () => {
    const boot = bootTerminal({ custom: [bootEntry({})] as never }, fullDeps, { fakeSpawn: true });
    const opened = await boot.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    expect(opened.source).toBe("custom");
    expect(opened.executable).toBe(PWSH);
  });

  it("inheritance from an earlier accepted custom id works; from an unknown base it is rejected", async () => {
    const rows = [
      bootEntry({}),
      bootEntry({ id: "child-shell", base: "my-shell", argv: ["--mine"] }),
    ];
    const boot = bootTerminal({ custom: rows as never }, fullDeps, { fakeSpawn: true });
    const opened = await boot.tool("shell_open").execute({ preset: "child-shell" }, { agent: { name: "u" } });
    expect(opened.executable).toBe(PWSH);
    const { rejected: orphanRejected } = validateCustomEntries(
      [entry({ id: "orphan", base: "no-such-base" })],
      { builtInIds: [] },
    );
    expect(orphanRejected[0]!.reasons.join(" ")).toContain("base preset");
  });
});

describe("restart-effect contract (#105): one snapshot per process", () => {
  it("a second apply in the SAME process does NOT adopt new config — restart does", async () => {
    const first = bootTerminal({ custom: [bootEntry({})] as never }, fullDeps, { fakeSpawn: true });
    const ok = await first.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    expect(ok.source).toBe("custom");

    // Same process, "config file edited + row re-applied" (the HMR shape):
    // the new entry is NOT live mid-session.
    const second = bootTerminal({ custom: [bootEntry({ id: "later-shell" })] as never }, fullDeps, { fakeSpawn: true });
    await expect(
      second.tool("shell_open").execute({ preset: "later-shell" }, { agent: { name: "u" } }),
    ).rejects.toThrow(/unknown preset/);
    // ...and the first snapshot still serves.
    const still = await second.tool("shell_open").execute({ preset: "my-shell" }, { agent: { name: "u" } });
    expect(still.source).toBe("custom");
  });

  it("mutating the config array AFTER apply does not leak into the live table", async () => {
    const rows: unknown[] = [bootEntry({})];
    const deps: LauncherDeps = fullDeps;
    const boot = bootTerminal({ custom: rows as never }, deps, { fakeSpawn: true });
    rows.push(bootEntry({ id: "sneaky" })); // the "config file changed underneath" shape
    await expect(
      boot.tool("shell_open").execute({ preset: "sneaky" }, { agent: { name: "u" } }),
    ).rejects.toThrow(/unknown preset/);
  });
});

describe("agent-face guard (#105): the tool surface has no write path into the registration", () => {
  it("the terminal entry registers exactly one tool — shell_open — with no registration parameters", () => {
    const boot = bootTerminal({ custom: [bootEntry({})] as never }, fullDeps, { fakeSpawn: true });
    const terminalTools = boot.registered.filter((t: { name: string }) => t.name === "shell_open");
    expect(terminalTools).toHaveLength(1);
    const paramKeys = Object.keys(terminalTools[0]!.parameters.properties);
    expect(paramKeys).toEqual(["preset", "cwd", "env", "idleTimeoutMs", "sandbox_permissions", "justification"]);
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

/**
 * `./terminal` entry (issue #55, T3): the single `shell_open` tool over the
 * launcher preset layer (#54) and the pty entry's session core (#53 env
 * semantics) — SEAM-FREE since #61/ADR-0010: the pty and terminal entries
 * boot side by side over ONE self-managed core instance, so the returned
 * sessionId is proven to be the core session id (pty_send/tail/close operate
 * it directly — no forwarding tools, ADR-0008 decision 5). Launcher probes
 * are injected, so absent/unknown postures are pinned without any real
 * shell; the pty spawner is an in-process echo fake (no ConPTY in the unit
 * lane).
 * @module tests/terminal
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { bootTerminal, fullDeps, FULL_ENV, PWSH, type TerminalBoot } from "./helpers/fake-terminal.ts";
import { apply as applyTerminal, _resetRegistrationForTests } from "../src/terminal/index.ts";
import { PWSH_INTERACTIVE_ARGV } from "../src/launchers.ts";
import { resolveLaunchers } from "../src/launchers.ts";
import type { CustomLauncherConfig, LauncherDeps } from "../src/launchers.ts";

/** Boot the pty AND terminal entries on one self-managed core through the
 * SHARED harness (#156 — the hand-rolled ctx/spawner is gone); surface the
 * spawn specs the core handed to its spawner and the registered tools of
 * both entries. Unit posture: the injected every-launcher-present deps and
 * the in-process echo fake spawner. `files` are the custom.d entries (#170 —
 * the patch-row channel is 废止; custom presets ride the file family). */
function boot(config: { custom?: CustomLauncherConfig[]; maxSessions?: number } = {}, deps: LauncherDeps = fullDeps, files: Record<string, string> = {}): TerminalBoot {
  // File keys are bare names inside the fake custom.d.
  const prefixed = Object.fromEntries(Object.entries(files).map(([name, body]) => [join("<mem>/custom.d", name), body]));
  return bootTerminal(config, deps, { fakeSpawn: true, files: prefixed });
}

const agent = { name: "unit" };

// #105: the registration snapshot is PROCESS-level (restart-effect contract);
// production never resets it. The unit suite boots one scenario per test, so
// each test starts from a clean snapshot — the contract itself is pinned in
// tests/terminal-registration.spec.ts (same-process double apply).
beforeEach(() => {
  _resetRegistrationForTests();
});

describe("shell_open (#55)", () => {
  it("opens a local preset: composes the executable+argv command, returns the core sessionId", async () => {
    const { tool, spawnSpecs } = boot();
    const opened = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    expect(opened.sessionId).toMatch(/^pty-\d+$/);
    expect(opened.preset).toBe("pwsh");
    expect(opened.transport).toBe("local");
    // The composed launch command: quoted executable (the path has spaces)
    // + interactive argv.
    expect(opened.command).toBe(`"${PWSH}" ${PWSH_INTERACTIVE_ARGV.join(" ")}`);
    const spec = spawnSpecs[0]!;
    expect(spec.command).toBe(opened.command);
    expect(spec.cwd).toBeUndefined();
    expect(spec.env).toEqual({}); // preset declares no env
  });

  it("carries the preset env and merges the preset PATH prefix ahead of the inherited PATH (#53 spec shape)", async () => {
    const { tool, spawnSpecs } = boot();
    await tool("shell_open").execute({ preset: "msys2-ucrt" }, { agent });
    const spec = spawnSpecs[0]!;
    expect(spec.env!.MSYSTEM).toBe("UCRT64");
    expect(spec.env!.CHERE_INVOKING).toBe("1");
    // PATH prefix rides the same-cased inherited key (Windows: 'Path').
    expect(spec.env!.Path).toContain("C:\\msys64\\ucrt64\\bin");
    expect(spec.env!.Path!.endsWith("C:\\Windows\\System32")).toBe(true);
  });

  it("cwd and env tool args override the preset values", async () => {
    const { tool, spawnSpecs } = boot();
    await tool("shell_open").execute(
      { preset: "msys2-ucrt", cwd: "D:\\proj", env: { MSYSTEM: "CLANG64", EXTRA: "1" } },
      { agent },
    );
    const spec = spawnSpecs[0]!;
    expect(spec.cwd).toBe("D:\\proj");
    expect(spec.env!.MSYSTEM).toBe("CLANG64");
    expect(spec.env!.EXTRA).toBe("1");
    expect(spec.env!.CHERE_INVOKING).toBe("1");
  });

  it("the returned sessionId is the core session id: pty_send / pty_tail / pty_close operate it directly", async () => {
    const { tool, core } = boot();
    const opened = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    // Same registry: the id is held by the core itself.
    expect(core.active(agent)).toContain(opened.sessionId);
    const sent = await tool("pty_send").execute({ id: opened.sessionId, data: "echo hi" }, { agent });
    expect(sent.delta).toContain("echo hi");
    const tailed = await tool("pty_tail").execute({ id: opened.sessionId }, { agent });
    expect(tailed.text).toContain("echo hi");
    const closed = await tool("pty_close").execute({ id: opened.sessionId }, { agent });
    expect(closed.closed).toBe(true);
    expect(core.active(agent)).toHaveLength(0);
  });

  it("two concurrent opens stay independent (multi-instance coexistence, unit shape)", async () => {
    const { tool } = boot();
    const a = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    const b = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    expect(a.sessionId).not.toBe(b.sessionId);
    await tool("pty_send").execute({ id: a.sessionId, data: "MARK-A" }, { agent });
    const tb = await tool("pty_tail").execute({ id: b.sessionId }, { agent });
    expect(tb.text).not.toContain("MARK-A");
    expect(tb.lines).toBe(0);
  });

  it("unknown preset fails loudly enumerating the resolved preset ids", async () => {
    const { tool } = boot();
    await expect(tool("shell_open").execute({ preset: "box" }, { agent })).rejects.toThrow(/unknown preset 'box'; resolved presets: .*msys2-ucrt/);
  });

  it("an absent built-in fails loudly naming every probe point (#54 posture)", async () => {
    const { tool } = boot({}, { exists: () => false, env: FULL_ENV, path: "", listDistros: () => [] });
    const err = await tool("shell_open").execute({ preset: "pwsh" }, { agent }).catch((e: Error) => e);
    expect(err.message).toMatch(/preset 'pwsh' is not serviceable/);
    expect(err.message).toContain("pwsh.exe");
  });

  it("a custom preset whose executable vanishes mid-flight fails loudly with NO_EXECUTABLE_CANDIDATE (#165)", async () => {
    // The machine changed between mount (the validation gate saw the
    // executable) and shell_open's runtime re-probe: a literal-executable
    // custom preset resolves verbatim (no probe at resolution), so the loud
    // miss lands on localLaunchCommand — now with a stable code.
    let present = true;
    const deps: LauncherDeps = { ...fullDeps, exists: (candidate: string) => candidate === PWSH ? true : present };
    const { tool } = boot({}, deps, { "dev.json": JSON.stringify({ id: "dev", transport: "local", executable: ["X:\\tools\\dev-shell.exe"], argv: [] }) });
    present = false;
    const err = await tool("shell_open").execute({ preset: "dev" }, { agent }).catch((e: Error) => e);
    expect(err.message).toMatch(/no existing executable candidate/);
    expect(err.code).toBe("NO_EXECUTABLE_CANDIDATE");
  });

  it("a custom preset file is selectable; an override id is single-entry disabled (#105/#170)", async () => {
    const { tool, spawnSpecs } = boot({}, fullDeps, {
      "dev.json": JSON.stringify({ id: "dev", transport: "local", executable: [PWSH], argv: ["-NoExit"], env: { DEV: "1" } }),
    });
    const opened = await tool("shell_open").execute({ preset: "dev" }, { agent });
    expect(opened.command).toContain("-NoExit");
    expect(spawnSpecs[0]!.env!.DEV).toBe("1");
    const second = await tool("shell_open").execute({ preset: "dev", env: { OVR: "y" } }, { agent });
    expect(second.command).toContain("-NoExit");
    // #105/#170: a custom `pwsh` row is single-entry DISABLED (the old
    // whole-batch throw is retired) — the built-in view keeps serving.
    const overrideBoot = bootTerminal({}, fullDeps, { fakeSpawn: true, files: { [join("<mem>/custom.d", "pwsh.json")]: JSON.stringify({ id: "pwsh", transport: "local", executable: [PWSH], env: {} }) } });
    const listed = await overrideBoot.tool("terminal_list").execute({}, { agent });
    const pwshRows = listed.presets.filter((p: { id: string }) => p.id === "pwsh");
    // The builtin view keeps serving (the first row) AND the rejected custom
    // file shows up disabled with the original reason.
    expect(pwshRows[0]).toMatchObject({ source: "builtin" });
    const disabledRow = pwshRows.find((p: { disabled?: boolean }) => p.disabled === true);
    expect(disabledRow!.source).toBe("custom");
    expect(disabledRow!.reasons.join(" ")).toContain("override the built-in");
    await expect(overrideBoot.tool("shell_open").execute({ preset: "pwsh" }, { agent })).resolves.toMatchObject({ source: "builtin" });
  });

  it("an ssh custom preset opens via the ssh composition (keepalive defaults inherit)", async () => {
    const { tool, spawnSpecs } = boot({}, fullDeps, {
      "box.json": JSON.stringify({ id: "box", transport: "ssh", host: "me@example.test", shell: "bash --login" }),
    });
    const opened = await tool("shell_open").execute({ preset: "box" }, { agent });
    expect(opened.transport).toBe("ssh");
    expect(opened.command).toContain("ssh -tt");
    expect(opened.command).toContain("ServerAliveInterval=15");
    expect(opened.command).toContain("bash --login");
    expect(spawnSpecs[0]!.command).toBe(opened.command);
  });
  it("registers exactly one tool: shell_open (send/tail/close reuse pty_*, no Middle Man)", async () => {
    const { tool } = boot();
    expect(tool("shell_open").name).toBe("shell_open");
    expect(() => tool("terminal_send")).toThrow(/not registered/);
    expect(() => tool("terminal_tail")).toThrow(/not registered/);
  });
});


describe("shell_open result fields (#56)", () => {
  it("a built-in local preset reports the minimal self-evidence set: executable/probed/cwd/source/overrode", async () => {
    const { tool } = boot();
    const opened = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    expect(opened.executable).toBe(PWSH); // the hit candidate
    expect(Array.isArray(opened.probed)).toBe(true);
    expect(opened.probed).toContain(PWSH);
    expect("cwd" in opened ? opened.cwd : undefined).toBeUndefined(); // no cwd anywhere → omitted
    expect(opened.source).toBe("builtin");
    expect(opened.overrode).toBe(false);
    // No env dump, no argv repeat (command already carries it).
    expect(opened.env).toBeUndefined();
    expect(opened.argv).toBeUndefined();
  });

  it("cwd reports the EFFECTIVE value: tool arg overrides preset cwd", async () => {
    const { tool, spawnSpecs } = boot({}, fullDeps, {
      "dev.json": JSON.stringify({ id: "dev", transport: "local", executable: [PWSH], argv: ["-NoExit"], cwd: "C:\\dev" }),
    });
    const opened = await tool("shell_open").execute({ preset: "dev" }, { agent });
    expect(opened.cwd).toBe("C:\\dev");
    expect(spawnSpecs[0]!.cwd).toBe("C:\\dev");
    const overridden = await tool("shell_open").execute({ preset: "dev", cwd: "D:\\x" }, { agent });
    expect(overridden.cwd).toBe("D:\\x");
    expect(spawnSpecs[1]!.cwd).toBe("D:\\x");
  });

  it("a custom-only id reports source custom + overrode false; an override id never boots (#105)", async () => {
    const { tool } = boot({}, fullDeps, {
      "dev.json": JSON.stringify({ id: "dev", transport: "local", executable: [PWSH], argv: ["-NoExit"], env: {} }),
    });
    const customOnly = await tool("shell_open").execute({ preset: "dev" }, { agent });
    expect(customOnly.source).toBe("custom");
    expect(customOnly.overrode).toBe(false);
    // The override path is closed at registration (ADR-0018); the layer-level
    // merge semantics stay pinned in tests/launchers.spec.ts.
  });

  it("an ssh preset carries source/overrode but no executable/probed (no local candidates)", async () => {
    const { tool } = boot({}, fullDeps, {
      "box.json": JSON.stringify({ id: "box", transport: "ssh", host: "me@example.test" }),
    });
    const opened = await tool("shell_open").execute({ preset: "box" }, { agent });
    expect(opened.source).toBe("custom");
    expect(opened.overrode).toBe(false);
    expect(opened.executable).toBeUndefined();
    expect(opened.probed).toBeUndefined();
  });
});

describe("shell_open concurrency cap (#56)", () => {
  it("soft cap default 8: the 9th open fails loudly listing the current session count", async () => {
    const { tool } = boot();
    for (let i = 0; i < 8; i += 1) {
      await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    }
    const err = await tool("shell_open").execute({ preset: "pwsh" }, { agent }).catch((e: Error) => e);
    expect(err.message).toMatch(/limit/i);
    expect(err.message).toContain("8");
  });

  it("maxSessions is configurable; pty_close frees a slot", async () => {
    const { tool } = boot({ maxSessions: 2 });
    const a = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    const b = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    const err = await tool("shell_open").execute({ preset: "pwsh" }, { agent }).catch((e: Error) => e);
    expect(err.message).toMatch(/2/);
    await tool("pty_close").execute({ id: a.sessionId }, { agent });
    const c = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    expect(c.sessionId).not.toBe(b.sessionId);
  });

  it("the cap counts the owner's OWN sessions only (another owner is unaffected)", async () => {
    const { tool } = boot({ maxSessions: 1 });
    const other = { name: "other" };
    await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    const theirs = await tool("shell_open").execute({ preset: "pwsh" }, { agent: other });
    expect(theirs.sessionId).toMatch(/^pty-\d+$/);
  });

  it("terminal entry REMOUNT does not reset the cap count — the core registry is the fact source (#62)", async () => {
    const b = boot({ maxSessions: 1 });
    await b.tool("shell_open").execute({ preset: "pwsh" }, { agent });
    // Remount the terminal entry on the SAME context (disable/re-enable /
    // patch replay): the entry's closure state is brand new, the pty core's
    // registry is not — the cap must still count the live session.
    b.registered.length = 0;
    applyTerminal(b.ctx, { maxSessions: 1 }, fullDeps);
    const remounted = (name: string) => {
      const t = b.registered.find((x) => x.name === name);
      if (!t) throw new Error(`tool not registered: ${name}`);
      return t;
    };
    const err = await remounted("shell_open").execute({ preset: "pwsh" }, { agent }).catch((e: Error) => e);
    expect(err.message).toMatch(/limit/);
    expect(err.message).toContain("1");
    // And the still-valid close path frees the slot for the remounted entry.
    await expect(remounted("shell_open").execute({ preset: "pwsh" }, { agent: { name: "fresh" } })).resolves.toBeTruthy();
  });
});

describe("shell_open idleTimeoutMs (#56, #61 core-owned)", () => {
  it("an idle session with idleTimeoutMs auto-closes after the timeout; without it, never", async () => {
    vi.useFakeTimers();
    try {
      const { tool, core } = boot();
      // The core's settle waits for a 150ms quiet window (faked) — advance
      // past it before awaiting the open.
      const p1 = tool("shell_open").execute({ preset: "pwsh", idleTimeoutMs: 1000 }, { agent });
      await vi.advanceTimersByTimeAsync(250);
      const watched = await p1; 
      const p2 = tool("shell_open").execute({ preset: "pwsh" }, { agent });
      await vi.advanceTimersByTimeAsync(250);
      const plain = await p2; 
      await vi.advanceTimersByTimeAsync(600); await vi.advanceTimersByTimeAsync(600); await vi.advanceTimersByTimeAsync(600); 
      
      expect(core.active(agent)).not.toContain(watched.sessionId);
      expect(core.active(agent)).toContain(plain.sessionId);
      const cp = tool("pty_close").execute({ id: plain.sessionId }, { agent });
      await vi.advanceTimersByTimeAsync(50); // kill exit event (5ms) + exit poll tick (25ms)
      await cp;
    } finally {
      vi.useRealTimers();
    }
  });

  it("new output resets the idle clock: a busy session survives past its timeout", async () => {
    vi.useFakeTimers();
    try {
      const { tool, core } = boot();
      const p1 = tool("shell_open").execute({ preset: "pwsh", idleTimeoutMs: 1000 }, { agent });
      await vi.advanceTimersByTimeAsync(250);
      const watched = await p1; 
      await vi.advanceTimersByTimeAsync(700);
      const sendP = tool("pty_send").execute({ id: watched.sessionId, data: "keepalive" }, { agent });
      await vi.advanceTimersByTimeAsync(250); // echo + the core's settle window
      await sendP;
      await vi.advanceTimersByTimeAsync(700);
      expect(core.active(agent)).toContain(watched.sessionId); // <1000ms since output
      await vi.advanceTimersByTimeAsync(500);
      expect(core.active(agent)).not.toContain(watched.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("idleTimeoutMs must be a positive integer (loud)", async () => {
    const { tool } = boot();
    await expect(tool("shell_open").execute({ preset: "pwsh", idleTimeoutMs: 0 }, { agent })).rejects.toThrow(/idleTimeoutMs/);
    await expect(tool("shell_open").execute({ preset: "pwsh", idleTimeoutMs: -5 }, { agent })).rejects.toThrow(/idleTimeoutMs/);
  });
});

// ---------------------------------------------------------------------------
// #119 — a shell_open session is a SHELL TARGET on the pty signal surface
// ---------------------------------------------------------------------------

describe("shell_open sessions are shell targets for pty_signal (#119)", () => {
  it("pty_list shows the shell session; pty_signal refuses SIGKILL and points at pty_close", async () => {
    const { tool } = boot();
    const opened = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    // pty_list 的 id 就是核心 id（同一个注册表，不是第二套枚举）。
    const listed = await tool("pty_list").execute({}, { agent });
    expect(listed.sessions.map((row: any) => row.id)).toContain(opened.sessionId);
    // shell 目标拒 SIGKILL（官方语义：杀 shell 收不回它拥有的子进程）——
    // 拒绝发生在平台分支之前，所以这条判据在 win32 / POSIX 上都成立。
    await expect(tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGKILL" }, { agent }))
      .rejects.toMatchObject({ code: "SIGNAL_FORBIDDEN" });
    // 会话仍活着（拒绝 ≠ 关掉），pty_close 依旧是唯一的回收路径。
    expect((await tool("pty_list").execute({}, { agent })).sessions[0].status).toEqual({ kind: "running" });
    expect(await tool("pty_close").execute({ id: opened.sessionId }, { agent })).toEqual({ closed: true });
  });
});

/**
 * `./terminal` entry (issue #55, T3): the single `shell_open` tool over the
 * launcher preset layer (#54) and the pty entry's session core (#53 env
 * semantics). All behavior through the shared fake-seam harness; the pty and
 * terminal entries boot side by side on ONE registry so the returned
 * sessionId is proven to be the seam session id (pty_send/tail/close operate
 * it directly — no forwarding tools, ADR-0008 decision 5). Launcher probes
 * are injected, so absent/unknown postures are pinned without any real
 * shell.
 * @module tests/terminal
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { FakeTerminals, type SpawnSpec } from "./helpers/fake-terminals.ts";
import { apply as applyPty } from "../src/pty/index.ts";
import { PWSH_INTERACTIVE_ARGV } from "../src/backends.ts";
import { apply as applyTerminal } from "../src/terminal/index.ts";
import type { CustomLauncherConfig, LauncherDeps } from "../src/launchers.ts";

const MSYS_BASH = "C:\\msys64\\usr\\bin\\bash.exe";
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

function existsEverything(candidate: string): boolean {
  const known = [MSYS_BASH, PWSH, join("C:\\Windows", "System32", "cmd.exe")];
  return known.some((k) => k.toLowerCase() === candidate.toLowerCase());
}

const FULL_ENV = { SystemRoot: "C:\\Windows", Path: "C:\\Windows\\System32" } as NodeJS.ProcessEnv;
const fullDeps: LauncherDeps = { exists: existsEverything, env: FULL_ENV, path: FULL_ENV.Path, listDistros: () => [] };

interface Boot {
  terminals: FakeTerminals;
  tool: (name: string) => any;
  spawnSpecs: SpawnSpec[];
}

/** Boot the pty AND terminal entries on one fake registry; surface the
 * spawn specs the terminal entry handed to terminals.spawn and the
 * registered tools of both entries. */
function boot(config: { custom?: CustomLauncherConfig[]; maxSessions?: number } = {}, deps: LauncherDeps = fullDeps): Boot {
  const terminals = new FakeTerminals({
    idPrefix: "term",
    spawnChild: () => echoChild(),
  });
  // Capture what the terminal entry passes to terminals.spawn.
  const spawnSpecs: SpawnSpec[] = [];
  const realSpawn = terminals.spawn.bind(terminals);
  (terminals as any).spawn = async (owner: unknown, spec: SpawnSpec) => {
    spawnSpecs.push(spec);
    return realSpawn(owner, spec);
  };
  const registered: any[] = [];
  const provided = new Map<string, unknown>();
  const makeCtx = () => ({
    provide: (name: string, value: unknown) => provided.set(name, value),
    effect: () => () => Promise.resolve(),
    terminals,
    tools: { register: (t: unknown) => registered.push(t) },
    get: (name: string) => provided.get(name),
  });
  const ctx = makeCtx();
  applyPty(ctx as any, {});
  applyTerminal(ctx as any, config, deps);
  const tool = (name: string) => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  return { terminals, tool, spawnSpecs };
}

const agent = { name: "unit" };

/** A minimal echo "shell": stdin.write lands on stdout, so the fake seam's
 * echo-settle path and the tail cursor behave like the real suites' children
 * without spawning anything. */
function echoChild(): ChildProcess {
  const c = new EventEmitter() as EventEmitter & { pid?: number; exitCode: number | null; signalCode: string | null; stdout: EventEmitter; stdin: { write: (d: string) => void }; kill: () => boolean };
  c.pid = 4242;
  c.exitCode = null;
  c.signalCode = null;
  c.stdout = new EventEmitter();
  c.stdin = { write: (d: string) => c.stdout.emit("data", Buffer.from(d)) };
  c.kill = () => {
    if (c.exitCode === null) {
      c.exitCode = 0;
      c.emit("exit", 0, null);
    }
    return true;
  };
  return c as unknown as ChildProcess;
}

describe("shell_open (#55)", () => {
  it("opens a local preset: composes the executable+argv command, returns the seam sessionId", async () => {
    const { tool, spawnSpecs } = boot();
    const opened = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    expect(opened.sessionId).toMatch(/^term-/);
    expect(opened.preset).toBe("pwsh");
    expect(opened.transport).toBe("local");
    // The composed launch command: quoted executable (the path has spaces)
    // + interactive argv.
    expect(opened.command).toBe(`"${PWSH}" ${PWSH_INTERACTIVE_ARGV.join(" ")}`);
    const spec = spawnSpecs[0]!;
    expect(spec.type).toBe("shell");
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

  it("the returned sessionId is the seam session id: pty_send / pty_tail / pty_close operate it directly", async () => {
    const { tool, terminals } = boot();
    const opened = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    // Same registry: the id is registered on the terminals seam itself.
    expect(terminals.sessions.has(opened.sessionId)).toBe(true);
    const sent = await tool("pty_send").execute({ id: opened.sessionId, data: "echo hi" }, { agent });
    expect(sent.delta).toContain("echo hi");
    const tailed = await tool("pty_tail").execute({ id: opened.sessionId }, { agent });
    expect(tailed.text).toContain("echo hi");
    const closed = await tool("pty_close").execute({ id: opened.sessionId }, { agent });
    expect(closed.closed).toBe(true);
    expect(terminals.sessions.size).toBe(0);
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

  it("a custom preset from config is selectable (data channel; overrides a built-in id)", async () => {
    const custom: CustomLauncherConfig[] = [
      { id: "dev", transport: "local", executable: [PWSH], argv: ["-NoExit"], env: { DEV: "1" } },
      { id: "pwsh", transport: "local", executable: [PWSH], argv: ["-NoLogo", "-NoExit"], env: {} },
    ];
    const { tool, spawnSpecs } = boot({ custom });
    const opened = await tool("shell_open").execute({ preset: "dev" }, { agent });
    expect(opened.command).toContain("-NoExit");
    expect(spawnSpecs[0]!.env!.DEV).toBe("1");
    // Same-id override: the built-in pwsh view is replaced by the custom one.
    await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    expect(spawnSpecs[1]!.env).toEqual({});
    const second = await tool("shell_open").execute({ preset: "dev", env: { OVR: "y" } }, { agent });
    expect(second.command).toContain("-NoExit");
  });

  it("an ssh custom preset opens via the ssh composition (keepalive defaults inherit)", async () => {
    const custom: CustomLauncherConfig[] = [{ id: "box", transport: "ssh", host: "me@example.test", shell: "bash --login" }];
    const { tool, spawnSpecs } = boot({ custom });
    const opened = await tool("shell_open").execute({ preset: "box" }, { agent });
    expect(opened.transport).toBe("ssh");
    expect(opened.command).toContain("ssh -tt");
    expect(opened.command).toContain("ServerAliveInterval=15");
    expect(opened.command).toContain("bash --login");
    expect(spawnSpecs[0]!.type).toBe("shell");
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
    const custom: CustomLauncherConfig[] = [
      { id: "dev", transport: "local", executable: [PWSH], argv: ["-NoExit"], cwd: "C:\\dev" },
    ];
    const { tool, spawnSpecs } = boot({ custom });
    const opened = await tool("shell_open").execute({ preset: "dev" }, { agent });
    expect(opened.cwd).toBe("C:\\dev");
    expect(spawnSpecs[0]!.cwd).toBe("C:\\dev");
    const overridden = await tool("shell_open").execute({ preset: "dev", cwd: "D:\\x" }, { agent });
    expect(overridden.cwd).toBe("D:\\x");
    expect(spawnSpecs[1]!.cwd).toBe("D:\\x");
  });

  it("a custom id that overrides a built-in reports source custom + overrode true; a custom-only id overrode false", async () => {
    const custom: CustomLauncherConfig[] = [
      { id: "pwsh", transport: "local", executable: [PWSH], argv: ["-NoExit"], env: {} },
      { id: "dev", transport: "local", executable: [PWSH], argv: ["-NoExit"], env: {} },
    ];
    const { tool } = boot({ custom });
    const overridden = await tool("shell_open").execute({ preset: "pwsh" }, { agent });
    expect(overridden.source).toBe("custom");
    expect(overridden.overrode).toBe(true);
    const customOnly = await tool("shell_open").execute({ preset: "dev" }, { agent });
    expect(customOnly.source).toBe("custom");
    expect(customOnly.overrode).toBe(false);
  });

  it("an ssh preset carries source/overrode but no executable/probed (no local candidates)", async () => {
    const custom: CustomLauncherConfig[] = [{ id: "box", transport: "ssh", host: "me@example.test" }];
    const { tool } = boot({ custom });
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
    expect(theirs.sessionId).toMatch(/^term-/);
  });
});

describe("shell_open idleTimeoutMs (#56)", () => {
  it("an idle session with idleTimeoutMs auto-closes after the timeout; without it, never", async () => {
    vi.useFakeTimers();
    try {
      const { tool, terminals } = boot();
      // The fake seam settles sends on its own 10ms poll — advance while in flight.
      const p1 = tool("shell_open").execute({ preset: "pwsh", idleTimeoutMs: 1000 }, { agent });
      await vi.advanceTimersByTimeAsync(50);
      const watched = await p1;
      const p2 = tool("shell_open").execute({ preset: "pwsh" }, { agent });
      await vi.advanceTimersByTimeAsync(50);
      const plain = await p2;
      await vi.advanceTimersByTimeAsync(1500);
      expect(terminals.sessions.has(watched.sessionId)).toBe(false);
      expect(terminals.sessions.has(plain.sessionId)).toBe(true);
      await tool("pty_close").execute({ id: plain.sessionId }, { agent });
    } finally {
      vi.useRealTimers();
    }
  });

  it("new output resets the idle clock: a busy session survives past its timeout", async () => {
    vi.useFakeTimers();
    try {
      const { tool, terminals } = boot();
      const p1 = tool("shell_open").execute({ preset: "pwsh", idleTimeoutMs: 1000 }, { agent });
      await vi.advanceTimersByTimeAsync(50);
      const watched = await p1;
      await vi.advanceTimersByTimeAsync(700);
      const sendP = tool("pty_send").execute({ id: watched.sessionId, data: "keepalive" }, { agent });
      await vi.advanceTimersByTimeAsync(100); // fires the fake seam's settle poll
      await sendP;
      await vi.advanceTimersByTimeAsync(700);
      expect(terminals.sessions.has(watched.sessionId)).toBe(true); // <1000ms since output
      await vi.advanceTimersByTimeAsync(500);
      expect(terminals.sessions.has(watched.sessionId)).toBe(false);
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


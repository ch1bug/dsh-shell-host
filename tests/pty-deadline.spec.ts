/**
 * Unit spec for the #159 hard deadline: a one-shot exec (autoClose: true) is
 * bounded by a wall-clock deadline for the WHOLE tool call; on expiry the
 * session's OWN process tree is killed (POSIX graceful→grace→hard, win32
 * ConPTY teardown) and the result carries `timeout: true` + the output so
 * far + the real exit code only if one exists. The unit lane stays hermetic
 * (fake ptys, injected procKill/platform — the #61/#119 lane split); every
 * case is bounded (fakes always surface an exit on kill; vitest's per-test
 * timeout is the outer watchdog).
 * @module tests/pty-deadline
 */

import { describe, it, expect } from "vitest";
import { bootPlugin, fakePty, type FakePtyHandle, type CoreSpawnSpec } from "./helpers/fake-pty.ts";
import type { SessionCore } from "../src/pty/session-core.ts";
import { DEFAULT_DEADLINE_MS, DEFAULT_DEADLINE_GRACE_MS, resolveDeadlineMs } from "../src/pty/session-core.ts";
import { waitUntil } from "./helpers/wait-until.ts";

const agent = { name: "a" };

/** Settle tuning so every await in the spec stays well under a second. */
const FAST = { settleQuietMs: 10, settleTickMs: 5, settleTimeoutMs: 200 };

interface Booted {
  core: SessionCore;
  handles: FakePtyHandle[];
  kills: Array<{ pid: number; signal: string }>;
}

/**
 * Boot the pty entry with a spawner handing out fresh fake ptys, recording
 * every handle and every injected procKill (pid, signal) pair.
 *
 * `sigtermBehavior` models how the fake tree reacts to the group SIGTERM:
 *  - "exit" — a tree that honors the graceful stop (exits with 143);
 *  - "hang" — a waiting-for-stdin tree that ignores it (the default).
 * A group SIGKILL and a pty.kill() ALWAYS surface the exit event (exitCode
 * 137), mirroring real ConPTY teardown where the exit event follows the
 * tree teardown.
 */
function boot(opts?: {
  config?: Record<string, unknown>;
  platform?: NodeJS.Platform;
  sigtermBehavior?: "exit" | "hang";
}): Booted {
  const handles: FakePtyHandle[] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const h = bootPlugin({
    config: { ...FAST, ...opts?.config },
    deps: {
      ...(opts?.platform === undefined ? {} : { platform: opts.platform }),
      procKill: (pid: number, signal: string) => {
        kills.push({ pid, signal });
        // Route the group signal to the tree it addresses (by the session's
        // own pid, negative-pid addressing like the real core) — never by
        // "the last handle", so a future third spawn cannot misdirect it.
        const target = handles.find((f) => f.pty.pid === -pid);
        if (signal === "SIGTERM" && opts?.sigtermBehavior === "exit") {
          setTimeout(() => target?.emitExit({ exitCode: 143 }), 5);
        }
        if (signal === "SIGKILL") {
          setTimeout(() => target?.emitExit({ exitCode: 137 }), 5);
        }
      },
    },
    spawnPty: (_spec: CoreSpawnSpec) => {
      const f = fakePty(4242 + handles.length);
      // The hard teardown lever: kill() ends the tree (the real ConPTY
      // behavior — the exit event always follows a tree teardown) while the
      // handle's `killed` counter keeps counting (wrap, don't replace).
      const rawKill = f.pty.kill.bind(f.pty);
      (f.pty as any).kill = () => {
        rawKill();
        setTimeout(() => f.emitExit({ exitCode: 137 }), 5);
      };
      handles.push(f);
      return f;
    },
  });
  return { core: h.core, handles, kills };
}

/** Open A's one-shot exec (the deadline's only surface). */
function bootOpen(b: Booted, signal?: AbortSignal): Promise<any> {
  return b.core.open(agent, { command: "cat", autoClose: true }, signal) as Promise<any>;
}

/** Wait for the nth fake spawn (an autoClose open does not resolve until the
 * process exits, so the process must be driven while the call is in flight). */
async function waitForSpawn(b: Booted, n: number): Promise<void> {
  await waitUntil(() => b.handles.length >= n, {
    timeoutMs: 2_000,
    describeObserved: () => `handles=${b.handles.length}（期望 ≥ ${n}：open 已 spawn）`,
  });
}

function activeCount(b: Booted): number {
  return b.core.active(agent).length;
}

describe("deadline resolution (#159 priority chain)", () => {
  it("default is 600s; per-call > configured > default; 0 = explicit off", () => {
    expect(DEFAULT_DEADLINE_MS).toBe(600_000);
    expect(DEFAULT_DEADLINE_GRACE_MS).toBe(2_000);
    expect(resolveDeadlineMs(undefined, undefined)).toBe(600_000);
    expect(resolveDeadlineMs(undefined, 5_000)).toBe(5_000);
    expect(resolveDeadlineMs(1_000, 5_000)).toBe(1_000);
    // Explicit off: a selected 0 disables — a per-call off beats a configured
    // value, and a configured off beats the default.
    expect(resolveDeadlineMs(0, 5_000)).toBe(0);
    expect(resolveDeadlineMs(undefined, 0)).toBe(0);
  });
});

describe("deadline expiry kills the session's own tree and marks the result (#159)", () => {
  it("waits-stdin fake: graceful SIGTERM ignored, hard kill, timeout:true + output + real exit code, reclaimed", async () => {
    const b = boot({ config: { deadlineMs: 150, deadlineGraceMs: 60 }, sigtermBehavior: "hang", platform: "linux" });
    const openP = bootOpen(b);
    await waitForSpawn(b, 1);
    b.handles[0]!.emitData("partial output\r\n");
    const opened = await openP;
    expect(opened.timeout).toBe(true);
    expect(opened.initialOutput).toContain("partial output");
    // The real (teardown) exit code — not a fabricated success code.
    expect(opened.status).toEqual({ kind: "exited", exitCode: 137 });
    // The kill sequence addressed THIS session's group: SIGTERM, then SIGKILL.
    expect(b.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(b.kills.every((k) => k.pid === -b.handles[0]!.pty.pid!)).toBe(true);
    // Reclaimed through the single close path — no leaked slot.
    await waitUntil(() => activeCount(b) === 0, {
      timeoutMs: 2_000,
      describeObserved: () => `active=${activeCount(b)}（期望 0：deadline 会话已回收）`,
    });
  });

  it("graceful stop honored: SIGTERM ends the tree, no hard kill, no pty.kill", async () => {
    const b = boot({ config: { deadlineMs: 120, deadlineGraceMs: 2_000 }, sigtermBehavior: "exit", platform: "linux" });
    const openP = bootOpen(b);
    await waitForSpawn(b, 1);
    const opened = await openP;
    expect(opened.timeout).toBe(true);
    expect(opened.status).toEqual({ kind: "exited", exitCode: 143 });
    // Only the graceful signal was needed — no SIGKILL, no pty.kill.
    expect(b.kills).toEqual([{ pid: -b.handles[0]!.pty.pid!, signal: "SIGTERM" }]);
    expect(b.handles[0]!.killed).toBe(0);
    expect(activeCount(b)).toBe(0);
  });

  it("continuous output does not reset or defer the deadline (not the idle timeout)", async () => {
    const b = boot({ config: { deadlineMs: 400, deadlineGraceMs: 60 } });
    const openP = bootOpen(b);
    await waitForSpawn(b, 1);
    // Chatty tree: output every 15ms, never exits on its own. The initial
    // settle caps at settleTimeoutMs (200ms), then the deadline (measured
    // from CALL START) fires — the output never pushed it out.
    const iv = setInterval(() => b.handles[0]!.emitData("tick\r\n"), 15);
    try {
      const opened = await openP;
      expect(opened.timeout).toBe(true);
      expect(opened.status).toEqual({ kind: "exited", exitCode: 137 });
    } finally {
      clearInterval(iv);
    }
    expect(activeCount(b)).toBe(0);
  });

  it("win32 branch: ConPTY teardown is the only lever — no group signals", async () => {
    const b = boot({ config: { deadlineMs: 120 }, platform: "win32" });
    const openP = bootOpen(b);
    await waitForSpawn(b, 1);
    const opened = await openP;
    expect(opened.timeout).toBe(true);
    expect(opened.status).toEqual({ kind: "exited", exitCode: 137 });
    expect(b.kills).toEqual([]); // no POSIX signal path on win32
    expect(b.handles[0]!.killed).toBe(1);
    expect(activeCount(b)).toBe(0);
  });

  it("never touches a foreign owner's session (#159 boundary ③)", async () => {
    const b = boot({ config: { deadlineMs: 120, deadlineGraceMs: 50 }, platform: "linux" });
    // Owner B opens a session FIRST — it will outlive A's deadline window.
    // The owner object is SHARED (the registry keys by identity — a fresh
    // `{ name: "b" }` literal would be a different, empty owner).
    const ownerB = { name: "b" };
    const bOpen = (await b.core.open(ownerB, { command: "b-repl" }, undefined)) as any;
    const openP = bootOpen(b);
    await waitForSpawn(b, 2); // [0] = B's, [1] = A's (B opened first)
    const opened = await openP;
    expect(opened.timeout).toBe(true);
    // B's session: still held, never signaled, never killed.
    expect(b.core.active(ownerB)).toEqual([bOpen.sessionId]);
    // Every signal and every kill belonged to A's tree.
    expect(b.kills.every((k) => k.pid === -b.handles[1]!.pty.pid!)).toBe(true);
    expect(b.handles[1]!.killed).toBeGreaterThanOrEqual(1);
    expect(b.handles[0]!.killed).toBe(0);
  });

  it("an aborted call stops waiting without a timeout marker (naming mutual exclusion)", async () => {
    const b = boot({ config: { deadlineMs: 120 } });
    const ac = new AbortController();
    const openP = bootOpen(b, ac.signal);
    await waitForSpawn(b, 1);
    // The abort beats the 120ms deadline — a different escape entirely.
    setTimeout(() => ac.abort(), 30);
    const opened = await openP;
    expect(opened.timeout).toBeUndefined();
    expect(opened.status).toEqual({ kind: "running" });
    expect(b.kills).toEqual([]);
  });

  it("long task explicitly extended: per-call deadlineMs overrides the configured one, task completes normally", async () => {
    const b = boot({ config: { deadlineMs: 150 } });
    const openP = b.core.open(agent, { command: "long", autoClose: true, deadlineMs: 5_000 }, undefined) as Promise<any>;
    await waitForSpawn(b, 1);
    // The long task finishes on its own well past the configured 150ms.
    setTimeout(() => b.handles[0]!.emitExit({ exitCode: 0 }), 300);
    const opened = await openP;
    expect(opened.timeout).toBeUndefined();
    expect(opened.status).toEqual({ kind: "exited", exitCode: 0 });
    expect(b.kills).toEqual([]);
    expect(activeCount(b)).toBe(0);
  });

  it("normal fast command: real exit code, no timeout marker, no kill", async () => {
    const b = boot({ config: { deadlineMs: 5_000 } });
    const openP = bootOpen(b);
    await waitForSpawn(b, 1);
    b.handles[0]!.emitData("done\r\n");
    b.handles[0]!.emitExit({ exitCode: 0 });
    const opened = await openP;
    expect(opened.timeout).toBeUndefined();
    expect(opened.status).toEqual({ kind: "exited", exitCode: 0 });
    expect(opened.initialOutput).toContain("done");
    expect(b.kills).toEqual([]);
  });
});

describe("deadline validation and surface boundaries (#159)", () => {
  it("invalid per-call values fail loudly", async () => {
    const b = boot({});
    await expect(b.core.open(agent, { command: "x", autoClose: true, deadlineMs: -1 as never }, undefined)).rejects.toThrow(/deadlineMs/);
    await expect(b.core.open(agent, { command: "x", autoClose: true, deadlineMs: 1.5 as never }, undefined)).rejects.toThrow(/deadlineMs/);
  });

  it("deadlineMs on a PERSISTENT open is refused loudly (boundary ①: #56 idle governs persistent sessions)", async () => {
    const b = boot({});
    await expect(b.core.open(agent, { command: "repl", deadlineMs: 1_000 }, undefined)).rejects.toThrow(/ONE-SHOT/);
  });

  it("tool surface: configured deadline applies to an autoClose exec; bad configured value fails loudly", async () => {
    const h = bootPlugin({
      config: { ...FAST, deadlineMs: 120, deadlineGraceMs: 50 },
      spawnPty: (_spec: CoreSpawnSpec) => fakePty(4242),
    });
    const openP = h.tool("pty_open").execute({ command: "cat", autoClose: true }, { agent }) as Promise<any>;
    await waitUntil(() => h.handles.length === 1, { timeoutMs: 2_000, describeObserved: () => `handles=${h.handles.length}` });
    (h.handles[0]!.pty as any).kill = () => setTimeout(() => h.handles[0]!.emitExit({ exitCode: 137 }), 5);
    const opened = await openP;
    expect(opened.timeout).toBe(true);
    // A bad configured value never reaches the core silently.
    expect(() => bootPlugin({ config: { deadlineMs: -5 } })).toThrow(/deadlineMs/);
  });
});

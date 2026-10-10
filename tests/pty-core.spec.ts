/**
 * Unit spec for the self-managed PTY session core (#61, ADR-0010): the
 * seam-free rewrite — node-pty sessions owned by this package's own
 * registry (owner-scoped, cursor reads, cap, idle timeout, dispose).
 * The spawner is injected so the unit lane stays hermetic (no ConPTY);
 * the real node-pty spawn is the machine lane's business (#51 precedent).
 * @module tests/pty-core
 */

import { describe, it, expect } from "vitest";
import { bootPlugin, fakePty, type FakePtyHandle, type CoreSpawnSpec } from "./helpers/fake-pty.ts";
import { DEFAULT_MAX_SESSIONS } from "../src/pty/session-core.ts";

/** Fast settle tuning: the core polls for output quiescence; these values
 * keep every await in the spec under ~100ms without weakening the
 * quiet-window semantics. */
const FAST = { settleQuietMs: 20, settleTickMs: 5, settleTimeoutMs: 300 };

const agent = { name: "a" };

/** Boot with a spawner handing out fresh fake ptys; returns the harness
 * plus the last spawned handle for driving output. */
function bootFast(opts?: { config?: unknown; spawn?: (spec: CoreSpawnSpec) => FakePtyHandle }) {
  const spawned: FakePtyHandle[] = [];
  const specs: CoreSpawnSpec[] = [];
  const h = bootPlugin({
    config: { ...FAST, ...(opts?.config ?? {}) },
    spawnPty: opts?.spawn ?? ((spec: CoreSpawnSpec) => {
      specs.push(spec);
      const handle = fakePty(10000 + spawned.length + 1);
      spawned.push(handle);
      return handle;
    }),
  });
  return { ...h, spawned, specs };
}

describe("self-managed session core (#61 ADR-0010)", () => {
  it("open spawns the command via the injected spawner and captures the initial output", async () => {
    const h = bootFast();
    const pending = h.tool("pty_open").execute(
      { command: "bash --login -i", cwd: "/tmp", env: { FOO: "bar" } },
      { agent },
    );
    // Let the spawn land, then feed a banner before the quiet window closes.
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("welcome\r\n");
    const opened = await pending;
    expect(h.specs[0]).toMatchObject({ command: "bash --login -i", cwd: "/tmp", env: { FOO: "bar" } });
    expect(opened.sessionId).toBeTypeOf("string");
    expect(opened.pid).toBe(h.spawned[0].pty.pid);
    expect(opened.status).toEqual({ kind: "running" });
    expect(opened.initialOutput).toContain("welcome");
  });

  it("tail is cursor-incremental: only new lines, repeated tails empty, truncation flagged", async () => {
    const h = bootFast();
    const pending = h.tool("pty_open").execute({ command: "repl" }, { agent });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("banner\r\n");
    const opened = await pending;
    // Cursor is at publication: the banner is NOT re-sent.
    expect(await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent })).toEqual(
      { text: "", lines: 0, truncated: false },
    );
    h.spawned[0].emitData("one\r\ntwo\r\n");
    await new Promise((r) => setTimeout(r, 10));
    const page = await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent });
    expect(page.lines).toBe(2);
    expect(page.text).toContain("one");
    expect(page.text).toContain("two");
    // A partial line is held back until complete (complete lines only).
    h.spawned[0].emitData("par");
    await new Promise((r) => setTimeout(r, 10));
    expect((await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent })).lines).toBe(0);
    h.spawned[0].emitData("tial\r\n");
    await new Promise((r) => setTimeout(r, 10));
    const page2 = await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent });
    expect(page2.text).toContain("partial");
    // Budget cap: backlog beyond `lines` is dropped and flagged.
    h.spawned[0].emitData("a\r\nb\r\nc\r\nd\r\n");
    await new Promise((r) => setTimeout(r, 10));
    const page3 = await h.tool("pty_tail").execute({ id: opened.sessionId, lines: 2 }, { agent });
    expect(page3.lines).toBe(2);
    expect(page3.truncated).toBe(true);
  });

  it("send writes payload with submit Enter and returns the settled delta", async () => {
    const h = bootFast();
    const opened = await h.tool("pty_open").execute({ command: "repl" }, { agent });
    const sendP = h.tool("pty_send").execute({ id: opened.sessionId, data: "echo hi" }, { agent });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("echo hi\r\nhi\r\n");
    const sent = await sendP;
    expect(h.spawned[0].writes[0]).toBe("echo hi\r");
    expect(sent.delta).toContain("hi");
    expect(sent.status).toEqual({ kind: "running" });
    // submit:false sends the bare text, no Enter.
    await h.tool("pty_send").execute({ id: opened.sessionId, data: "partial", submit: false }, { agent });
    expect(h.spawned[0].writes[1]).toBe("partial");
  });

  it("close kills, waits for the exit, is idempotent, and rejects foreign owners", async () => {
    const h = bootFast();
    const opened = await h.tool("pty_open").execute({ command: "repl" }, { agent });
    // Foreign owner: loud, never crosses the ownership boundary (while the
    // session is still held by its owner).
    await expect(
      h.tool("pty_close").execute({ id: opened.sessionId }, { agent: { name: "other" } }),
    ).rejects.toThrow();
    const closeP = h.tool("pty_close").execute({ id: opened.sessionId }, { agent });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitExit({ exitCode: 0 });
    expect(await closeP).toEqual({ closed: true });
    expect(h.spawned[0].killed).toBe(1);
    // Second close: documented closed:false, not a throw.
    expect(await h.tool("pty_close").execute({ id: opened.sessionId }, { agent })).toEqual({ closed: false });
    // Unknown id: closed:false.
    expect(await h.tool("pty_close").execute({ id: "nope" }, { agent })).toEqual({ closed: false });
  });

  it("enforces the per-owner soft cap (default 8) and frees the slot on close (#56 migrated)", async () => {
    const h = bootFast();
    const ids: string[] = [];
    for (let i = 0; i < DEFAULT_MAX_SESSIONS; i++) {
      ids.push((await h.tool("pty_open").execute({ command: `s${i}` }, { agent })).sessionId);
    }
    await expect(h.tool("pty_open").execute({ command: "one-too-many" }, { agent })).rejects.toThrow(/limit/);
    // Another owner is unaffected (cap is per-owner).
    await expect(h.tool("pty_open").execute({ command: "other-owner" }, { agent: { name: "b" } })).resolves.toBeTruthy();
    // Closing one frees the slot (kill waits for the exit event).
    const closeP = h.tool("pty_close").execute({ id: ids[0] }, { agent });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitExit({ exitCode: 0 });
    await closeP;
    await expect(h.tool("pty_open").execute({ command: "fits-now" }, { agent })).resolves.toBeTruthy();
    // Configured override.
    const h2 = bootFast({ config: { maxSessions: 1 } });
    await h2.tool("pty_open").execute({ command: "first" }, { agent });
    await expect(h2.tool("pty_open").execute({ command: "second" }, { agent })).rejects.toThrow(/limit/);
  });

  it("idle timeout (core-level) closes a session with no new output; output refreshes the clock", async () => {
    const { createSessionCore } = await import("../src/pty/session-core.ts");
    const handles: FakePtyHandle[] = [];
    const core = createSessionCore(
      { settleQuietMs: 10, settleTickMs: 5, settleTimeoutMs: 100, idleTickMs: 10 },
      { spawnPty: ((spec: CoreSpawnSpec) => { const h2 = fakePty(9000 + handles.length); handles.push(h2); return h2.pty; }) as any },
    );
    const openedPromise = core.open(agent, { command: "watcher", idleTimeoutMs: 150 });
    await new Promise((r) => setTimeout(r, 10));
    handles[0].emitData("hi\r\n");
    const opened = await openedPromise;
    // Output inside the window refreshes the clock — still alive past 80ms.
    await new Promise((r) => setTimeout(r, 80));
    expect(core.active(agent)).toContain(opened.sessionId);
    // Now truly idle: the watcher closes it.
    await new Promise((r) => setTimeout(r, 200));
    expect(core.active(agent)).not.toContain(opened.sessionId);
    core.dispose().catch(() => {});
  });
});

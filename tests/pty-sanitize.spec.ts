/**
 * #180 contract A: every session's buffer ingestion goes through the
 * streaming terminal sanitizer — VT/CSI/OSC control noise never reaches the
 * line buffer, so pty_open's initialOutput, pty_send's delta and pty_tail's
 * pages carry printable text only. Unit lane: hermetic fake ptys; the real
 * ConPTY noise measurements stay in the machine lane (pty-shell-machine).
 * @module tests/pty-sanitize
 */

import { describe, it, expect } from "vitest";
import { fakePty, type CoreSpawnSpec } from "./helpers/fake-pty.ts";
import { createSessionCore, type SessionCore, DEFAULT_SANITIZER_PENDING_BYTES } from "../src/pty/session-core.ts";
import { waitUntil } from "./helpers/wait-until.ts";

const FAST = { settleQuietMs: 20, settleTickMs: 5, settleTimeoutMs: 300 };
const agent = { name: "a" };

/** Boot a core over fresh fake ptys; returns the harness and the spawned
 * handles so tests can feed raw terminal bytes. */
function bootFast() {
  const spawned: ReturnType<typeof fakePty>[] = [];
  const core = createSessionCore(FAST, {
    spawnPty: (spec: CoreSpawnSpec) => {
      const handle = fakePty(10000 + spawned.length + 1);
      spawned.push(handle);
      return handle.pty;
    },
  });
  return { core, spawned };
}

async function openOne(h: ReturnType<typeof bootFast>, spec = { command: "repl" }) {
  const pending = h.core.open(agent, spec);
  await waitUntil(() => h.spawned.length === 1, { timeoutMs: 2_000 });
  await new Promise((r) => setTimeout(r, 10));
  return await pending;
}

/** Drive a send whose output arrives WHILE the settle window runs: start the
 * send, feed the raw chunk mid-flight, then read the delta (the fake pty's
 * write is a no-op — the test feeds the terminal bytes itself). */
async function sendWithOutput(h: ReturnType<typeof bootFast>, id: string, chunk: string) {
  const sending = h.core.send(agent, id, { data: "noop" });
  await new Promise((r) => setTimeout(r, 5));
  h.spawned[0].emitData(chunk);
  return await sending;
}

describe("session-core sanitized ingestion (#180 contract A)", () => {
  it("VT/CSI sequences never reach the buffer: initialOutput, send delta and tail carry printable text only", async () => {
    const h = bootFast();
    const openPromise = h.core.open(agent, { command: "repl" });
    await waitUntil(() => h.spawned.length === 1, { timeoutMs: 2_000 });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("\x1b[2J\x1b[Hbanner\x1b[31m-red\x1b[0m\r\n");
    const opened = await openPromise;
    expect(opened.initialOutput).toBe("banner-red\n");

    const sent = await sendWithOutput(h, opened.sessionId, "plain\r\n");
    expect(sent.delta).toBe("plain\n");

    const page = h.core.tail(agent, opened.sessionId, 50);
    expect(page.text).toBe("plain\n");
    expect(page.limit).toBe(50);
    // totalLines counts the whole retained buffer (banner + plain) — the
    // read-window word, not the returned-line count (#185).
    expect(page.totalLines).toBe(2);
    expect(page.offset).toBe(2);
  });

  it("a control sequence torn across chunks does not leak its pieces into the text", async () => {
    const h = bootFast();
    const opened = await openOne(h);
    const sending = h.core.send(agent, opened.sessionId, { data: "noop" });
    await new Promise((r) => setTimeout(r, 5));
    h.spawned[0].emitData("ok \x1b[3");
    h.spawned[0].emitData("8;5;196mhot\x1b[0m done\r\n");
    const sent = await sending;
    expect(sent.delta).toBe("ok hot done\n");
  });

  it("OSC sequences (including the private 133;D prompt marker) are stripped whole", async () => {
    const h = bootFast();
    const opened = await openOne(h);
    const sent = await sendWithOutput(h, opened.sessionId, "\x1b]133;D;0\x07\x1b]0;title\x1b\\visible\r\n");
    expect(sent.delta).toBe("visible\n");
  });

  it("flush at exit keeps trailing printable text and discards an incomplete escape", async () => {
    const h = bootFast();
    const opened = await openOne(h);
    const sending = h.core.send(agent, opened.sessionId, { data: "noop" });
    await new Promise((r) => setTimeout(r, 5));
    h.spawned[0].emitData("tail-no-newline \x1b[");
    h.spawned[0].emitExit({ exitCode: 0 });
    const sent = await sending;
    expect(sent.delta).toBe("tail-no-newline ");
    expect((await h.core.send(agent, opened.sessionId, { data: "noop" })).status).toEqual({
      kind: "exited",
      exitCode: 0,
    });
  });

  it("every session kind is sanitized — the ingestion point is single, not per-surface", async () => {
    const h = bootFast();
    const oneShot = h.core.open(agent, { command: "run-once", autoClose: true });
    await waitUntil(() => h.spawned.length === 1, { timeoutMs: 2_000 });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("\x1b[1mloud\x1b[0m output\r\n");
    h.spawned[0].emitExit({ exitCode: 7 });
    const opened = await oneShot;
    expect(opened.status).toEqual({ kind: "exited", exitCode: 7 });
    expect(opened.initialOutput).toBe("loud output\n");
  });

  it("the pending-bound constant is finite and generous (a torn sequence cannot grow unbounded)", () => {
    expect(Number.isInteger(DEFAULT_SANITIZER_PENDING_BYTES)).toBe(true);
    expect(DEFAULT_SANITIZER_PENDING_BYTES).toBeGreaterThanOrEqual(4096);
    expect(DEFAULT_SANITIZER_PENDING_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
});

/**
 * #177 现象二: ConPTY viewport-repaint suppression — a redraw frame's
 * re-printed old content (banner, previous command's echo) must not reenter
 * the session buffer as fresh output; `pty_send` deltas and `pty_tail` pages
 * carry only genuinely new lines. Two-signal contract (repaint-suppress.ts):
 * a chunk carrying a full-screen repaint-marker CSI has its own leading
 * duplicate-of-buffer-tail lines dropped, in that same chunk only
 * (stateless — no armed state survives between chunks); without the marker
 * repeated output is never touched (fidelity first). Unit lane: hermetic
 * fake ptys feeding raw terminal bytes.
 * @module tests/pty-repaint
 */

import { describe, it, expect } from "vitest";
import { fakePty, type CoreSpawnSpec } from "./helpers/fake-pty.ts";
import { createSessionCore, type SessionCore } from "../src/pty/session-core.ts";
import {
  hasRepaintMarker,
  stripRepaintPrefix,
  REPAINT_WINDOW_LINES,
} from "../src/pty/repaint-suppress.ts";
import { waitUntil } from "./helpers/wait-until.ts";

const FAST = { settleQuietMs: 20, settleTickMs: 5, settleTimeoutMs: 300 };
const agent = { name: "a" };

function bootFast() {
  const spawned: ReturnType<typeof fakePty>[] = [];
  const core = createSessionCore(FAST, {
    spawnPty: (spec: CoreSpawnSpec) => {
      const handle = fakePty(30000 + spawned.length + 1);
      spawned.push(handle);
      return handle.pty;
    },
  });
  return { core, spawned };
}

async function openOne(h: ReturnType<typeof bootFast>) {
  const pending = h.core.open(agent, { command: "repl" });
  await waitUntil(() => h.spawned.length === 1, { timeoutMs: 2_000 });
  await new Promise((r) => setTimeout(r, 10));
  return await pending;
}

/** Command 1's screen: banner + echo + output, already consumed via
 * initialOutput (the redraw re-prints exactly these lines). */
const OLD_SCREEN =
  "Microsoft Windows [Version 10.0.19045]\r\n" +
  "C:\\>echo hello-12345\r\nhello-12345\r\n";

async function bootWithOldScreen(): Promise<{ h: ReturnType<typeof bootFast>; opened: { sessionId: string } }> {
  const h = bootFast();
  const openPromise = h.core.open(agent, { command: "repl" });
  await waitUntil(() => h.spawned.length === 1, { timeoutMs: 2_000 });
  await new Promise((r) => setTimeout(r, 10));
  h.spawned[0].emitData(OLD_SCREEN);
  const opened = await openPromise;
  expect(opened.initialOutput).toContain("hello-12345");
  return { h, opened };
}

describe("#177 现象二: repaint suppression at ingestion", () => {
  it("a viewport redraw of old content does not reappear in send delta or tail pages", async () => {
    const { h, opened } = await bootWithOldScreen();
    const sending = h.core.send(agent, opened.sessionId, { data: "noop" });
    await new Promise((r) => setTimeout(r, 5));
    h.spawned[0].emitData(
      "\x1b[H\x1b[J" + OLD_SCREEN + "C:\\>type med.txt\r\nmed-output-line\r\n",
    );
    const sent = await sending;
    expect(sent.delta).toBe("C:\\>type med.txt\nmed-output-line\n");

    const page = h.core.tail(agent, opened.sessionId, 50);
    expect(page.text).not.toContain("hello-12345");
    expect(page.text).not.toContain("Microsoft Windows");
    expect(page.text).toBe("C:\\>type med.txt\nmed-output-line\n");
  });

  it("a repaint frame torn across chunks: the marker chunk's re-print is suppressed, new output survives (marker-free continuation is a documented limitation)", async () => {
    const { h, opened } = await bootWithOldScreen();
    const sending = h.core.send(agent, opened.sessionId, { data: "noop" });
    await new Promise((r) => setTimeout(r, 5));
    // Chunk 1: marker + the re-printed screen (suppressed whole).
    h.spawned[0].emitData("\x1b[H\x1b[J" + OLD_SCREEN);
    // Chunk 2: continuation WITHOUT a marker — legitimately indistinguishable
    // from repeated output, so it passes (fidelity first, limitation documented).
    h.spawned[0].emitData("C:\\>type med.txt\r\nmed-output-line\r\n");
    const sent = await sending;
    expect(sent.delta).toBe("C:\\>type med.txt\nmed-output-line\n");
  });

  it("repeated identical commands survive: each run's output is delivered whole", async () => {
    const { h, opened } = await bootWithOldScreen();
    // A marker chunk first (a real repaint happened).
    const first = h.core.send(agent, opened.sessionId, { data: "noop" });
    await new Promise((r) => setTimeout(r, 5));
    h.spawned[0].emitData("\x1b[H\x1b[J" + OLD_SCREEN + "C:\\>echo NOISE-1\r\nNOISE-1\r\n");
    expect((await first).delta).toBe("C:\\>echo NOISE-1\nNOISE-1\n");
    // The SAME command again — marker-free, so its identical echo + output
    // (a full duplicate of the buffer tail) must NOT be dropped (the #149
    // AC2 real-ConPTY lesson: an armed state that survives all-duplicate
    // chunks eats exactly this).
    const again = h.core.send(agent, opened.sessionId, { data: "noop" });
    await new Promise((r) => setTimeout(r, 5));
    h.spawned[0].emitData("C:\\>echo NOISE-1\r\nNOISE-1\r\n");
    expect((await again).delta).toBe("C:\\>echo NOISE-1\nNOISE-1\n");
  });

  it("repeated output WITHOUT a repaint marker is never touched (fidelity first)", async () => {
    const { h, opened } = await bootWithOldScreen();
    const sending = h.core.send(agent, opened.sessionId, { data: "noop" });
    await new Promise((r) => setTimeout(r, 5));
    // No marker anywhere: re-printing lines identical to the buffer tail is
    // the command's own output and passes whole.
    h.spawned[0].emitData(OLD_SCREEN + "C:\\>type med.txt\r\nmed-output-line\r\n");
    const sent = await sending;
    expect(sent.delta).toBe(
      "Microsoft Windows [Version 10.0.19045]\nC:\\>echo hello-12345\nhello-12345\nC:\\>type med.txt\nmed-output-line\n",
    );
  });

  it("a redraw without any duplicate prefix (blank screen) disarms immediately and delivers everything", async () => {
    const h = bootFast();
    const opened = await openOne(h);
    const sending = h.core.send(agent, opened.sessionId, { data: "noop" });
    await new Promise((r) => setTimeout(r, 5));
    h.spawned[0].emitData("\x1b[2J\x1b[Hfresh-screen output\r\n");
    const sent = await sending;
    expect(sent.delta).toBe("fresh-screen output\n");
  });

  it("every session kind passes through the same suppression (one-shot lane)", async () => {
    const h = bootFast();
    const oneShot = h.core.open(agent, { command: "run-once", autoClose: true });
    await waitUntil(() => h.spawned.length === 1, { timeoutMs: 2_000 });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("first\r\n");
    h.spawned[0].emitData("\x1b[H\x1b[Jfirst\r\nsecond\r\n");
    h.spawned[0].emitExit({ exitCode: 0 });
    const opened = await oneShot;
    expect(opened.initialOutput).toBe("first\nsecond\n");
  });
});

describe("repaint-suppress unit contract", () => {
  it("hasRepaintMarker matches full-screen repaint sequences only", () => {
    expect(hasRepaintMarker("\x1b[H")).toBe(true);
    expect(hasRepaintMarker("\x1b[2J")).toBe(true);
    expect(hasRepaintMarker("\x1b[J")).toBe(true);
    expect(hasRepaintMarker("\x1b[H\x1b[J")).toBe(true);
    // Parameterized cursor positioning (measured on EVERY msys2 bash prompt
    // line) and line-erase are ordinary rendering, NOT markers.
    expect(hasRepaintMarker("\x1b[6;1H")).toBe(false);
    expect(hasRepaintMarker("\x1b[10;1H")).toBe(false);
    expect(hasRepaintMarker("\x1b[K")).toBe(false);
    expect(hasRepaintMarker("plain\r\n")).toBe(false);
    expect(hasRepaintMarker("\x1b[31mred\x1b[0m")).toBe(false);
  });

  it("stripRepaintPrefix drops only the longest leading duplicate of the buffer tail", () => {
    expect(stripRepaintPrefix(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
    expect(stripRepaintPrefix(["a", "b"], ["b", "c"])).toEqual(["c"]);
    expect(stripRepaintPrefix(["a", "b"], ["c"])).toEqual(["c"]);
    expect(stripRepaintPrefix([], ["a"])).toEqual(["a"]);
    // A redraw re-prints at most the viewport (the buffer's last window
    // lines) — the dedupe window bound is respected beyond that.
    const big = Array.from({ length: REPAINT_WINDOW_LINES + 100 }, (_, i) => `l${i}`);
    const reprint = big.slice(-REPAINT_WINDOW_LINES);
    const kept = stripRepaintPrefix(big, [...reprint, "new"]);
    expect(kept).toEqual(["new"]);
  });
});

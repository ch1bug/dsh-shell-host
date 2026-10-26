/**
 * #121 — presentationMeta on the PTY/terminal tool face (pure display
 * metadata): `pty_send` projects the structured send read (delta + status),
 * `pty_tail` projects the page facts, `shell_open` projects the preset
 * resolution facts. Feasibility read (ticket step 1):
 * the built-in Web Client keys its toolviews by first-party wire NAME and
 * never consumes host presentResult — so these projectors serve the session
 * event stream / replay / PTC dispatch logs, and `output.render` / the model
 * facing schema must stay byte-for-byte what they were (README 「展示元数据（#121）」
 * carries the feasibility read). Unit posture: the
 * shared echo-fake harness (no ConPTY in the unit lane).
 * @module tests/presentation-meta
 */

import { describe, expect, it } from "vitest";
import { bootPlugin, echoFakePty } from "./helpers/fake-pty.ts";
import { bootTerminal, fullDeps } from "./helpers/fake-terminal.ts";
import { presentSendMeta } from "../src/tool-support.ts";

const agent = { name: "unit" };
const exec = () => ({ agent, signal: new AbortController().signal });

describe("pty_send presentationMeta (#121)", () => {
  it("foreground: projects the structured send read (delta + status)", async () => {
    const boot = bootPlugin({ config: { tailLines: 200, maxSessions: 8 }, spawnPty: echoFakePty });
    const opened = await boot.tool("pty_open").execute({ command: "boot" }, exec());
    const args = { id: opened.sessionId, data: "meta-probe" };
    const sent = await boot.tool("pty_send").execute(args, exec());
    const meta = boot.tool("pty_send").output.presentationMeta(args, sent);
    expect(meta).toEqual({ delta: sent.delta, status: sent.status });
    expect((meta as { delta: string }).delta).toContain("meta-probe");
  });

  it("background ack: projects null (the official terminal_send posture)", () => {
    expect(presentSendMeta(undefined, { kind: "background" })).toBeNull();
  });

  it("the model-facing render is untouched: the foreground result stays one JSON block", async () => {
    const boot = bootPlugin({ config: { tailLines: 200, maxSessions: 8 }, spawnPty: echoFakePty });
    const opened = await boot.tool("pty_open").execute({ command: "boot" }, exec());
    const sent = await boot.tool("pty_send").execute({ id: opened.sessionId, data: "render-probe" }, exec());
    expect(boot.tool("pty_send").output.render({}, sent)).toEqual([{ type: "text", text: JSON.stringify(sent) }]);
  });
});

describe("pty_tail presentationMeta (#121)", () => {
  it("projects the page facts (lines / truncated) without duplicating the text", async () => {
    const boot = bootPlugin({ config: { tailLines: 200, maxSessions: 8 }, spawnPty: echoFakePty });
    const opened = await boot.tool("pty_open").execute({ command: "boot" }, exec());
    await boot.tool("pty_send").execute({ id: opened.sessionId, data: "tail-probe" }, exec());
    const args = { id: opened.sessionId };
    const page = await boot.tool("pty_tail").execute(args, exec());
    const meta = boot.tool("pty_tail").output.presentationMeta(args, page);
    expect(meta).toEqual({ lines: page.lines, truncated: page.truncated });
    expect(JSON.stringify(meta)).not.toContain("tail-probe");
  });
});

describe("shell_open presentationMeta (#121)", () => {
  it("projects the preset resolution facts (preset / source / executable / probed / overrode)", async () => {
    const boot = bootTerminal({}, fullDeps, { fakeSpawn: true });
    const opened = await boot.tool("shell_open").execute({ preset: "pwsh" }, { agent });
    const meta = boot.tool("shell_open").output.presentationMeta({ preset: "pwsh" }, opened);
    expect(meta).toMatchObject({
      preset: opened.preset,
      source: opened.source,
      executable: opened.executable,
      overrode: opened.overrode,
    });
    expect(Array.isArray((meta as { probed: string[] }).probed)).toBe(true);
  });
});

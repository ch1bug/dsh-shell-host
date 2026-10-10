/**
 * Machine-lane live suite for the ssh 四工具 (issue #24 AC): the full
 * start → interactive command → incremental tail → close round-trip against
 * a REAL ssh host, plus the death/reconnect semantics on a real drop where
 * available. Gated on DSH_SSH_LIVE_HOST (optionally DSH_SSH_LIVE_JUMP for a
 * -J path); skips loudly when unset so the default lanes stay network-free.
 * @module tests/ssh-pty-live
 */

import { describe, it, expect, onTestFinished } from "vitest";
import { spawn as spawnPty } from "@lydell/node-pty";
import { apply as applyPty } from "../src/pty/index.ts";

// The host value may carry a user@ prefix — the composition passes it to
// ssh verbatim, and key auth on the live host is provisioned per user
// (#51 evidence: a bare IP resolves to the wrong local user and lands on a
// password prompt, which the non-interactive suite can never answer).
const HOST = process.env.DSH_SSH_LIVE_HOST;
const JUMP = process.env.DSH_SSH_LIVE_JUMP;
const hasLiveSsh = !!HOST;

function boot() {
  // #61 (ADR-0010): the live suite drives the REAL self-managed core — the
  // default spawner IS @lydell/node-pty (ConPTY) running the ssh composition
  // directly as the spawned process. Byte flow follows real PTY semantics
  // (full duplex, echo by the pty line discipline); kill is conpty close,
  // taking down the whole local ssh <- remote chain.
  const registered: any[] = [];
  const provided = new Map<string, unknown>();
  const ctx = {
    provide: (name: string, value: unknown) => provided.set(name, value),
    effect: () => () => Promise.resolve(),
    tools: { register: (t: unknown) => registered.push(t) },
    get: (name: string) => provided.get(name),
  };
  applyPty(ctx as any, {});
  const tool = (name: string) => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  const core = provided.get("pty") as { active(owner: unknown): string[] };
  return { tool, core };
}

describe("ssh 四工具 live round-trip (#24 AC)", () => {
  it.skipIf(!hasLiveSsh)(
    "start → interactive command → incremental tail → close against a real host",
    { timeout: 90_000 },
    async () => {
      const agent = { name: "live" };
      const { tool, core } = boot();
      const opened = await tool("ssh_start").execute({ host: HOST!, ...(JUMP ? { jump: JUMP } : {}), shell: "bash --login" }, { agent });
      onTestFinished(() => tool("ssh_close").execute({ id: opened.sessionId }, { agent }).catch(() => {}));
      expect(opened.sessionId).toBeDefined();

      // The remote banner/prompt is captured by open() itself (everything up
      // to the cursor at publication); the tail starts from there.
      const banner = opened.initialOutput ?? "";
      expect(banner.length).toBeGreaterThan(0);

      // Interactive command → the tail cursor sees ONLY the new output.
      await tool("ssh_send").execute({ id: opened.sessionId, data: "echo live-$((6*7))" }, { agent });
      let saw = false;
      let text = "";
      for (let i = 0; i < 40; i++) {
        const t = await tool("ssh_tail").execute({ id: opened.sessionId }, { agent });
        text += t.text;
        if (text.includes("live-42")) {
          saw = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(saw).toBe(true);

      const closed = await tool("ssh_close").execute({ id: opened.sessionId }, { agent });
      expect(closed.closed).toBe(true);
      expect(core.active(agent)).toHaveLength(0);
    },
  );

  it.skipIf(!hasLiveSsh)("ssh_start rejects malformed hosts before any network", async () => {
    const agent = { name: "live" };
    const { tool } = boot();
    await expect(tool("ssh_start").execute({ host: "bad host" }, { agent })).rejects.toThrow(/host/);
  });

  // #53 AC: env injected at spawn reaches the REAL terminal process — a
  // pty_open with env runs `echo %VAR%` in the hosted cmd.exe and the value
  // must come back without any export-style prelude being typed.
  it.skipIf(!hasLiveSsh)(
    "pty_open injects env into the spawned terminal process (#53)",
    { timeout: 60_000 },
    async () => {
      const agent = { name: "live" };
      const { tool } = boot();
      const opened = await tool("pty_open").execute(
        { command: "cmd.exe /d /c echo %LAUNCHER_ENV_PROBE%", env: { LAUNCHER_ENV_PROBE: "spawn-env-live-42" } },
        { agent },
      );
      onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, { agent }).catch(() => {}));
      expect(opened.initialOutput).toContain("spawn-env-live-42");
      const closed = await tool("pty_close").execute({ id: opened.sessionId }, { agent });
      expect(closed.closed).toBe(true);
    },
  );

  // #21 phase 1 AC: a LONG session — a high-volume output stream keeps the
  // incremental-tail cursor honest (no resend, no skip) on a real host, with
  // the keepalive defaults and a free -o option riding on the composition.
  it.skipIf(!hasLiveSsh)(
    "long session: high-volume stream consumed incrementally without resend or skip",
    { timeout: 90_000 },
    async () => {
      const agent = { name: "live" };
      const { tool } = boot();
      const opened = await tool("ssh_start").execute(
        { host: HOST!, options: ["BatchMode=yes"] },
        { agent },
      );
      onTestFinished(() => tool("ssh_close").execute({ id: opened.sessionId }, { agent }).catch(() => {}));
      expect(opened.sessionId).toBeDefined();
      // (The composition itself — keepalive defaults + free -o — is pinned
      // by the unit lane; here initialOutput is the real remote banner.)

      // 500 numbered lines in one burst. Budget 600 > stream size, so the
      // documented no-skip contract holds (backlog beyond the budget is
      // dropped by design — see tailPage); a follow-up empty page proves no
      // resend.
      await tool("ssh_send").execute(
        { id: opened.sessionId, data: "for i in $(seq 1 500); do echo MARK-$i; done; echo STREAM\"\"-DONE" },
        { agent },
      );
      let text = "";
      let lastMark = 0;
      const seen = new Set<string>();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const page = await tool("ssh_tail").execute({ id: opened.sessionId, lines: 600 }, { agent });
        for (const line of page.text.split("\n")) {
          // End-anchored: the remote prompt can glue onto the first mark.
          const m = line.match(/MARK-(\d+)\s*$/);
          if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n) && n > 0) {
              expect(n).toBeGreaterThan(lastMark); // strictly increasing: no resend
              lastMark = n;
              seen.add(`MARK-${n}`);
            }
          }
        }
        text += page.text;
        if (lastMark >= 500) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(text).toContain("STREAM-DONE");
      // Every line arrived exactly once — 500 marks, none skipped, none redelivered.
      expect(seen.size).toBe(500);
      expect(lastMark).toBe(500);
      // Cursor is at the end: a repeat tail is an empty page (no resend).
      const again = await tool("ssh_tail").execute({ id: opened.sessionId, lines: 600 }, { agent });
      expect(again.lines).toBe(0);

      const closed = await tool("ssh_close").execute({ id: opened.sessionId }, { agent });
      expect(closed.closed).toBe(true);
    },
  );
});

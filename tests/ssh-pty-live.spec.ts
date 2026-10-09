/**
 * Machine-lane live suite for the ssh 四工具 (issue #24 AC): the full
 * start → interactive command → incremental tail → close round-trip against
 * a REAL ssh host, plus the death/reconnect semantics on a real drop where
 * available. Gated on DSH_SSH_LIVE_HOST (optionally DSH_SSH_LIVE_JUMP for a
 * -J path); skips loudly when unset so the default lanes stay network-free.
 * @module tests/ssh-pty-live
 */

import { describe, it, expect, onTestFinished } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { apply } from "../src/pty/index.ts";

const HOST = process.env.DSH_SSH_LIVE_HOST;
const JUMP = process.env.DSH_SSH_LIVE_JUMP;
const hasLiveSsh = !!HOST;

function boot() {
  const terminals: any = {
    // The live suite drives the plugin through the same fake-seam SHAPE as
    // ssh-pty.spec.ts, but the spawned process IS the real ssh client (the
    // "terminal provider" here wraps a real child PTY via node's spawn with
    // shell pipes — sufficient for the full-duplex byte round-trip this AC
    // pins; the real harness terminal provider adds viewport semantics the
    // core does not depend on).
    sessions: new Map<string, any>(),
    nextId: 1,
    async spawn(owner: unknown, _spec: any) {
      const id = `live-${(this as any).nextId++}`;
      const child = spawn("ssh", process.env.DSH_SSH_LIVE_JUMP ? ["-J", JUMP!, HOST!] : [HOST!], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const session: any = { id, owner, child, text: "", active: null, exitPromise: once(child, "exit") };
      session.exitPromise.catch(() => {});
      child.stdout!.on("data", (d: Buffer) => {
        session.text += d.toString();
      });
      (this as any).sessions.set(id, session);
      return { sessionId: id, pid: child.pid };
    },
    read(owner: unknown, id: string, req: any) {
      const s = (this as any).sessions.get(id);
      if (!s) throw Object.assign(new Error(`no session ${id}`), { code: "NO_SESSION" });
      const { offset = 0, count = 200 } = req ?? {};
      const lines = s.text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const total = lines.length;
      const start = Math.max(0, total - Math.min(offset, total));
      const end = Math.min(total, start + count);
      return {
        text: lines.slice(start, end).join("\n") + (end > start ? "\n" : ""),
        totalLines: total,
        lineBegin: total - start,
        lineEnd: total - start + (end - start),
        truncated: end < total,
      };
    },
    startSend(owner: unknown, id: string, request: any) {
      const s = (this as any).sessions.get(id);
      if (!s) throw Object.assign(new Error(`no session ${id}`), { code: "NO_SESSION" });
      if (s.active) throw Object.assign(new Error("concurrent send"), { code: "SEND_ACTIVE" });
      const baseLen = s.text.length;
      if (s.child.exitCode === null && s.child.signalCode === null) {
        s.child.stdin!.write(request.text + (request.submit ? "\n" : ""));
      }
      let delta = "";
      const op = {
        readOutput: () => ({ delta, truncated: false }),
        cancel: () => false,
        done: new Promise((resolve) => {
          const settle = () => {
            s.active = null;
            delta = s.text.slice(baseLen);
            const kind = s.child.exitCode === null && s.child.signalCode === null ? "running" : "exited";
            resolve({ viewport: "", waitReason: "inferred_idle", sessionStatus: { kind }, truncated: false });
          };
          const poll = setInterval(() => {
            if (s.text.slice(baseLen).includes(request.text)) {
              clearInterval(poll);
              settle();
            }
          }, 20);
          setTimeout(() => {
            clearInterval(poll);
            settle();
          }, 2000);
        }),
      };
      s.active = op;
      return op;
    },
    async kill(owner: unknown, id: string, _reason: string) {
      const s = (this as any).sessions.get(id);
      if (!s) throw Object.assign(new Error(`no session ${id}`), { code: "NO_SESSION" });
      if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill();
      (this as any).sessions.delete(id);
      return true;
    },
  };
  const registered: any[] = [];
  apply(
    {
      provide: () => {},
      effect: () => () => Promise.resolve(),
      terminals,
      tools: { register: (t: unknown) => registered.push(t) },
    } as any,
    {},
  );
  const tool = (name: string) => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  return { terminals, tool };
}

describe("ssh 四工具 live round-trip (#24 AC)", () => {
  it.skipIf(!hasLiveSsh)(
    "start → interactive command → incremental tail → close against a real host",
    { timeout: 90_000 },
    async () => {
      const agent = { name: "live" };
      const { terminals, tool } = boot();
      const opened = await tool("ssh_start").execute({ host: HOST!, ...(JUMP ? { jump: JUMP } : {}), shell: "bash --login" }, { agent });
      onTestFinished(() => tool("ssh_close").execute({ id: opened.sessionId }, { agent }).catch(() => {}));
      expect(opened.sessionId).toBeDefined();

      // Wait out the banner/auth (network latency — poll the tail).
      let banner = "";
      for (let i = 0; i < 150; i++) {
        const t = await tool("ssh_tail").execute({ id: opened.sessionId }, { agent });
        banner += t.text;
        if (banner.includes("$") || banner.includes("#")) break;
        await new Promise((r) => setTimeout(r, 500));
      }
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
      expect(terminals.sessions.size).toBe(0);
    },
  );

  it.skipIf(!hasLiveSsh)("ssh_start rejects malformed hosts before any network", async () => {
    const agent = { name: "live" };
    const { tool } = boot();
    await expect(tool("ssh_start").execute({ host: "bad host" }, { agent })).rejects.toThrow(/host/);
  });
});

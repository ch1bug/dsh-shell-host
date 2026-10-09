/**
 * ssh 四工具（issue #24，承接 dsh-pty-session#3）: ssh_start / ssh_tail /
 * ssh_send / ssh_close over the `./pty` core. Tests are the reference
 * implementation again: the same owner-scoped terminals-seam fake shape as
 * pty-session.spec.ts, backed by real child processes — the "ssh" here is a
 * node echo script, so the suite pins the TOOL semantics (command
 * composition, cursor passthrough, death reporting, cleanup) without a
 * network. The live full-duplex round-trip is the machine lane's job
 * (wsl-plugin-live.spec.ts pattern).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { apply } from "../src/pty/index.ts";

// ---------------------------------------------------------------------------
// Fake owner-scoped PTY registry (compact re-statement of the pty-session
// fake; same TerminalSessionService contract subset).
// ---------------------------------------------------------------------------

const terr = (code: string, message: string) => Object.assign(new Error(message), { code });

class FakeSession {
  id: string;
  owner: unknown;
  sentLog: string[] = [];
  text: string;
  child: ChildProcess;
  active: { readOutput: () => { delta: string }; done: Promise<unknown> } | null = null;
  pid?: number;
  constructor(spec: any) {
    this.id = spec.sessionId;
    this.owner = spec.owner;
    this.sentLog = [];
    this.text = "";
    this.child = cpSpawn(
      process.execPath,
      [
        "-e",
        // Echo every stdin line back with a marker (fake remote), no exit.
        "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => process.stdout.write('ECHO:' + d));",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout!.on("data", (d) => {
      this.text += d.toString();
    });
    once(this.child, "exit").catch(() => {});
    this.active = null;
  }
  status() {
    if (this.child.exitCode === null && this.child.signalCode === null) return { kind: "running" };
    return { kind: "exited", exitCode: this.child.exitCode, signal: this.child.signalCode };
  }
  startSend(request: { text: string; submit?: boolean }) {
    if (this.active) throw terr("SEND_ACTIVE", "concurrent send");
    const baseLen = this.text.length;
    this.sentLog.push(request.text + (request.submit ? "\n" : ""));
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin!.write(request.text + (request.submit ? "\n" : ""));
    }
    let delta = "";
    const op = {
      readOutput: () => ({ delta, truncated: false }),
      cancel: () => false,
      done: new Promise((resolve) => {
        const settle = () => {
          this.active = null;
          delta = this.text.slice(baseLen);
          resolve({ viewport: "", waitReason: "inferred_idle", sessionStatus: this.status(), truncated: false });
        };
        // Settle once THIS send's echo is on record (a dead session never
        // echoes — the fallback settles it with the exited status instead).
        const poll = setInterval(() => {
          if (this.text.slice(baseLen).includes(request.text)) {
            clearInterval(poll);
            settle();
          }
        }, 10);
        setTimeout(() => {
          clearInterval(poll);
          settle();
        }, 2000);
      }),
    };
    this.active = op;
    return op;
  }
  async kill() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}

class FakeTerminals {
  sessions = new Map<string, FakeSession>();
  nextId = 1;
  killedWith: Array<{ owner: unknown; id: string; reason: string }> = [];
  async spawn(owner: unknown, _spec: any) {
    const id = `sess-${this.nextId++}`;
    const s = new FakeSession({ sessionId: id, owner });
    s.pid = 10000 + this.nextId;
    this.sessions.set(id, s);
    return { sessionId: id, pid: s.pid };
  }
  read(owner: unknown, id: string, req: any) {
    const s = this.sessions.get(id);
    if (!s) throw terr("NO_SESSION", `no session ${id}`);
    // Same contract as the pty-session fake's read: `offset` counts back
    // from the NEWEST retained line (0 = newest); lineBegin/lineEnd are
    // absolute indices for the plugin's cursor bookkeeping.
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
  }
  startSend(owner: unknown, id: string, request: any) {
    const s = this.sessions.get(id);
    if (!s) throw terr("NO_SESSION", `no session ${id}`);
    return s.startSend(request);
  }
  async kill(owner: unknown, id: string, reason: string) {
    const s = this.sessions.get(id);
    if (!s) throw terr("NO_SESSION", `no session ${id}`);
    this.killedWith.push({ owner, id, reason });
    await s.kill();
    this.sessions.delete(id);
    return true;
  }
}

// Harness: boot the plugin, surface the registered tools' execute fns.
function makeAgent(name: string) {
  return { name };
}

function boot() {
  const terminals = new FakeTerminals();
  const registered: any[] = [];
  const ctx = {
    provide: () => {},
    effect: () => () => Promise.resolve(),
    terminals,
    tools: { register: (t: unknown) => registered.push(t) },
  };
  apply(ctx as any, {});
  const tool = (name: string) => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  return { terminals, registered, tool };
}

describe("ssh_start (#24)", () => {
  let h: ReturnType<typeof boot>;
  beforeEach(() => {
    h = boot();
  });

  it("composes ssh argv (host only) and reports the composed command", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "example.com" }, { agent });
    expect(opened.sessionId).toBeDefined();
    expect(opened.initialOutput).toContain("ssh -tt example.com");
  });

  it("threads jump host (-J) and remote shell", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box", jump: "bastion", shell: "bash --login" }, { agent });
    expect(opened.initialOutput).toContain("-J bastion");
    expect(opened.initialOutput).toContain("bash --login");
  });

  it("rejects whitespace-bearing host/jump loudly (they are argv atoms, not shell text)", async () => {
    const agent = makeAgent("a");
    await expect(h.tool("ssh_start").execute({ host: "a b" }, { agent })).rejects.toThrow(/host/);
    await expect(h.tool("ssh_start").execute({ host: "ok", jump: "x y" }, { agent })).rejects.toThrow(/jump/);
  });

  it("requires an owning agent like every pty tool", async () => {
    await expect(h.tool("ssh_start").execute({ host: "box" }, {})).rejects.toMatchObject({ code: "NO_AGENT" });
  });
});

describe("ssh_tail / ssh_send / ssh_close (#24 passthrough semantics)", () => {
  let h: ReturnType<typeof boot>;
  beforeEach(() => {
    h = boot();
  });

  it("start → interactive send → incremental tail → close, full duplex", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box" }, { agent });
    const id = opened.sessionId;

    // The banner came back in initialOutput; the first tail is empty.
    expect(opened.initialOutput).toContain("ssh -tt box");
    const t0 = await h.tool("ssh_tail").execute({ id }, { agent });
    expect(t0.text).toBe("");

    // Interactive round-trip: send increments, tail does not resend.
    const sent = await h.tool("ssh_send").execute({ id, data: "hello remote" }, { agent });
    expect(sent.delta).toContain("ECHO:hello remote");
    const t1 = await h.tool("ssh_tail").execute({ id }, { agent });
    expect(t1.text).toContain("ECHO:hello remote");
    const t2 = await h.tool("ssh_tail").execute({ id }, { agent });
    expect(t2.text).toBe("");

    const closed = await h.tool("ssh_close").execute({ id }, { agent });
    expect(closed.closed).toBe(true);
  });

  it("death is reported, not auto-reconnected: send surfaces the exited status, close reclaims", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box" }, { agent });
    const id = opened.sessionId;

    // Kill the fake ssh process behind the seam (remote drop / network cut).
    h.terminals.sessions.get(id)!.child.kill();

    // Poll until the seam sees the death (process exit is async).
    let status: any;
    for (let i = 0; i < 100; i++) {
      const r: any = await h.tool("ssh_send").execute({ id, data: "ping" }, { agent }).catch((e) => ({ error: e }));
      status = r.status ?? r.error;
      if (status?.kind === "exited" || status?.code === "NO_SESSION") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status?.kind === "exited" || status?.code === "NO_SESSION").toBe(true);

    // No auto-reconnect happened: the SAME id, explicitly closed, reclaims.
    const closed = await h.tool("ssh_close").execute({ id }, { agent });
    expect(closed.closed).toBe(true);
  });

  it("close is idempotent (second close → closed:false, not a throw)", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box" }, { agent });
    await h.tool("ssh_close").execute({ id: opened.sessionId }, { agent });
    const again = await h.tool("ssh_close").execute({ id: opened.sessionId }, { agent });
    expect(again.closed).toBe(false);
  });
});

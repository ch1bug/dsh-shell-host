/**
 * Tests are the reference implementation: every test drives the real plugin
 * surface (defineTool execute) against a fake `terminals` service whose
 * backend runs REAL interactive child processes (node echo / node REPL
 * style) — no protocol parsing, byte-stream round-trips only, matching the
 * issue's "测试即参考实现" requirement.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { spawn as cpSpawn } from "node:child_process";
import { apply } from "../src/pty/index.ts";
import { FakeSession, lineCursorRead, terr } from "./helpers/fake-terminals.ts";

// ---------------------------------------------------------------------------
// Fake owner-scoped PTY registry: implements the TerminalSessionService
// contract subset the plugin consumes, backed by real child processes.
// The session itself is the shared fake-seam helper (#48); what stays local
// is the registry behavior under test here (backends, owner assertion,
// disposal, listing).
// ---------------------------------------------------------------------------

class LocalFakeSession extends FakeSession {
  // TS 6 typecheck facade: constructor-assigned fields declared explicitly.
  motd: string;
  /** The spawn request this backend received (#53: env must ride the spec).
   * The local registry hands the whole terminals.spawn request through. */
  spawnRequest: Record<string, any>;
  constructor(spec, script, { motd = "" } = {}) {
    super(spec, {
      spawnChild: () => cpSpawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }),
      initialText: motd,
    });
    this.motd = motd;
    this.spawnRequest = spec;
  }
  read({ offset = 0, count = 200 } = {}) {
    return lineCursorRead(this.text, { offset, count });
  }
}

class FakeTerminals {
  // TS 6 typecheck facade: constructor-assigned fields declared explicitly
  // (the source JS relied on inference this facade does not perform).
  backends: Record<string, { type: string; spawn: (spec: any) => Promise<LocalFakeSession> }> = {};
  sessions: Map<string, LocalFakeSession> = new Map();
  nextId: number = 1;
  disposedOwners: Set<unknown> = new Set();
  constructor() {
    this.backends = {};
    this.sessions = new Map();
    this.nextId = 1;
    this.disposedOwners = new Set();
  }
  registerBackend(b) { this.backends[b.type] = b; }
  assertOwner(owner, id) {
    const rec = this.sessions.get(id);
    if (!rec) throw terr("NO_SESSION", `no session ${id}`);
    if (rec.owner !== owner) throw terr("FOREIGN_SESSION", `session ${id} belongs to another owner`);
    if (this.disposedOwners.has(owner)) throw terr("OWNER_NOT_LIVE", "owner disposed");
    return rec;
  }
  async spawn(owner, request) {
    const sessionId = `pty-${this.nextId++}`;
    const session = await this.backends[request.type].spawn({ ...request, sessionId, owner });
    this.sessions.set(sessionId, session);
    return { sessionId, pid: session.pid, status: session.status(), motd: session.motd };
  }
  startSend(owner, id, request) { return this.assertOwner(owner, id).startSend(request); }
  read(owner, id, request) { return this.assertOwner(owner, id).read(request); }
  async kill(owner, id, reason) {
    const rec = this.assertOwner(owner, id);
    this.sessions.delete(id);
    await rec.close();
    return true;
  }
  list(owner) {
    return [...this.sessions.entries()]
      .filter(([, r]) => r.owner === owner)
      .map(([sessionId, r]) => ({ sessionId, status: r.status() }));
  }
  /** Registry behavior under test: owner disposal reclaims all its sessions. */
  async disposeOwner(owner) {
    this.disposedOwners.add(owner);
    for (const [id, rec] of [...this.sessions.entries()]) {
      if (rec.owner === owner) { this.sessions.delete(id); await rec.close(); }
    }
  }
}

/** Backend whose "PTY" is a real interactive echo child process. */
const ECHO_SCRIPT = "process.stdin.on('data', d => process.stdout.write(d));";
function echoBackend() {
  return {
    type: "test-echo",
    async spawn(spec) { return new LocalFakeSession(spec, ECHO_SCRIPT); },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeAgent(name) { return { agentName: name }; }
const exec = (agent) => ({ agent, signal: new AbortController().signal });

let ctx;
function setup() {
  ctx = {
    provided: {},
    provide(name, value) { this.provided[name] = value; },
    tools: { registered: [], register(t) { this.registered.push(t); } },
    effects: [],
    effect(fn, label) { this.effects.push({ fn, label }); },
    terminals: new FakeTerminals(),
  };
  ctx.terminals.registerBackend(echoBackend());
  apply(ctx, { backendType: "test-echo", tailLines: 200 });
}
const tool = (n) => ctx.tools.registered.find((t) => t.name === n);
const pty = () => ctx.provided.pty;

async function settled(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("settled: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(setup);

// ---------------------------------------------------------------------------
// AC 1 — open → send → tail → close lifecycle round-trip
// ---------------------------------------------------------------------------

describe("pty lifecycle round-trip", () => {
  it("opens a session on a real child, sends, tails the echo, closes", async () => {
    const agent = makeAgent("a");
    const opened = await tool("pty_open").execute({ command: "hello-open" }, exec(agent));
    expect(opened.sessionId).toMatch(/^pty-\d+$/);
    expect(opened.status.kind).toBe("running");

    const sent = await tool("pty_send").execute({ id: opened.sessionId, data: "ping-payload" }, exec(agent));
    expect(sent.delta).toContain("ping-payload");

    const tailed = await tool("pty_tail").execute({ id: opened.sessionId }, exec(agent));
    expect(tailed.text).toContain("ping-payload");

    const closed = await tool("pty_close").execute({ id: opened.sessionId }, exec(agent));
    expect(closed.closed).toBe(true);
    await expect(tool("pty_send").execute({ id: opened.sessionId, data: "x" }, exec(agent)))
      .rejects.toMatchObject({ code: "NO_SESSION" });
  });

  it("runs the command at open: its output is visible without a send", async () => {
    const agent = makeAgent("a");
    const opened = await tool("pty_open").execute({ command: "auto-run-line" }, exec(agent));
    expect(opened.initialOutput).toContain("auto-run-line");
  });
});

// ---------------------------------------------------------------------------
// AC 2 — cross-turn survival + plugin dispose reclaims everything
// ---------------------------------------------------------------------------

describe("lifetime and disposal", () => {
  it("sessions survive across turns until disposal (registry keeps them)", async () => {
    const agent = makeAgent("a");
    const s1 = await tool("pty_open").execute({ command: "one" }, exec(agent));
    const s2 = await tool("pty_open").execute({ command: "two" }, exec(agent));
    // "next turn": a fresh exec token for the same agent still sees both.
    expect(ctx.terminals.list(agent).map((s) => s.sessionId).sort())
      .toEqual([s1.sessionId, s2.sessionId].sort());
  });

  it("plugin dispose effect closes every session it opened", async () => {
    const agent = makeAgent("a");
    await tool("pty_open").execute({ command: "one" }, exec(agent));
    await tool("pty_open").execute({ command: "two" }, exec(agent));
    expect(ctx.effects).toHaveLength(1);
    await ctx.effects[0].fn()();
    expect(ctx.terminals.list(agent)).toHaveLength(0);
  });

  it("owner agent disposal closes all of that owner's sessions (registry guarantee)", async () => {
    const agent = makeAgent("a");
    const other = makeAgent("b");
    await tool("pty_open").execute({ command: "mine" }, exec(agent));
    await tool("pty_open").execute({ command: "theirs" }, exec(other));
    await ctx.terminals.disposeOwner(agent);
    expect(ctx.terminals.list(agent)).toHaveLength(0);
    expect(ctx.terminals.list(other)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC 3 — incremental tail cursor semantics
// ---------------------------------------------------------------------------

describe("incremental tail cursor", () => {
  it("repeated tails do not resend; new output only", async () => {
    const agent = makeAgent("a");
    const s = await tool("pty_open").execute({ command: "boot" }, exec(agent));
    await tool("pty_send").execute({ id: s.sessionId, data: "line-a" }, exec(agent));

    const t1 = await tool("pty_tail").execute({ id: s.sessionId }, exec(agent));
    expect(t1.text).toContain("line-a");
    expect(t1.truncated).toBe(false);

    const t2 = await tool("pty_tail").execute({ id: s.sessionId }, exec(agent));
    expect(t2.lines).toBe(0);
    expect(t2.text).toBe("");

    await tool("pty_send").execute({ id: s.sessionId, data: "line-b" }, exec(agent));
    const t3 = await tool("pty_tail").execute({ id: s.sessionId }, exec(agent));
    expect(t3.text).toContain("line-b");
    expect(t3.text).not.toContain("line-a");
  });

  it("backlog beyond the budget returns the newest lines and marks truncated", async () => {
    const agent = makeAgent("a");
    const s = await tool("pty_open").execute({ command: "boot" }, exec(agent));
    for (const n of [1, 2, 3]) {
      await tool("pty_send").execute({ id: s.sessionId, data: `n${n}` }, exec(agent));
    }
    await settled(() => ctx.terminals.read(agent, s.sessionId, { offset: 0, count: 1 }).totalLines >= 4 ? true : null);
    const t = await tool("pty_tail").execute({ id: s.sessionId, lines: 2 }, exec(agent));
    expect(t.lines).toBe(2);
    expect(t.truncated).toBe(true);
    expect(t.text).toContain("n3");
    const t2 = await tool("pty_tail").execute({ id: s.sessionId }, exec(agent));
    expect(t2.lines).toBe(0); // cursor fully advanced past the dropped backlog
  });
});

// ---------------------------------------------------------------------------
// AC 4 — owner scoping
// ---------------------------------------------------------------------------

describe("owner scoping", () => {
  it("another agent cannot send, tail, or close a foreign session", async () => {
    const a = makeAgent("a");
    const b = makeAgent("b");
    const s = await tool("pty_open").execute({ command: "secret" }, exec(a));
    for (const [t, args] of [
      ["pty_send", { id: s.sessionId, data: "x" }],
      ["pty_tail", { id: s.sessionId }],
      ["pty_close", { id: s.sessionId }],
    ]) {
      await expect(tool(t).execute(args, exec(b))).rejects.toMatchObject({ code: "FOREIGN_SESSION" });
    }
    // The real owner still can.
    await expect(tool("pty_tail").execute({ id: s.sessionId }, exec(a))).resolves.toBeTruthy();
  });

  it("requires an owning agent", async () => {
    await expect(tool("pty_open").execute({ command: "x" }, { signal: new AbortController().signal }))
      .rejects.toThrow(/owning agent/);
  });
});

// ---------------------------------------------------------------------------
// open options: env + cwd
// ---------------------------------------------------------------------------

describe("pty_open options", () => {
  it("delivers env via the spawn spec (process-env semantics, not export lines) (#53)", async () => {
    const agent = makeAgent("a");
    const s = await tool("pty_open").execute({
      command: "run-cmd",
      env: { FOO: "bar baz", WEIRD: "it's" },
    }, exec(agent));
    const rec = ctx.terminals.sessions.get(s.sessionId);
    // env rides terminals.spawn's request (additive field), so the backend
    // receives it for process-level injection. The local registry passes
    // the whole request ({type, cwd?, env?, sessionId, owner}) to the
    // backend, so the constructor spec carries env.
    expect(rec.spawnRequest.env).toEqual({ FOO: "bar baz", WEIRD: "it's" });
    // Nothing is typed into the terminal as `export` lines anymore: the
    // first send is the command itself.
    const log = rec.sentLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("run-cmd");
    expect(log[0]).not.toContain("export");
  });

  it("rejects an empty command", async () => {
    await expect(tool("pty_open").execute({ command: "  " }, exec(makeAgent("a"))))
      .rejects.toThrow(/non-empty/);
  });
});

// ---------------------------------------------------------------------------
// programmatic facade (ctx.provide("pty")) — the consumer-plugin surface
// ---------------------------------------------------------------------------

describe("pty facade service (consumer plugins)", () => {
  it("provides the facade and shares cursor state with the tool surface", async () => {
    expect(pty()).toBeTruthy();
    const agent = makeAgent("a");
    const s = await pty().open(agent, { command: "facade-cmd" }, new AbortController().signal);
    expect(s.sessionId).toBeTruthy();
    // open consumed its own output into the cursor; a write from the tool
    // surface is visible to the facade's tail (same core cursors).
    await tool("pty_send").execute({ id: s.sessionId, data: "from-tool" }, exec(agent));
    const page = await pty().tail(agent, s.sessionId, 50);
    expect(page.text).toContain("from-tool");
  });

  it("send/tail/close round-trip with explicit owner", async () => {
    const agent = makeAgent("a");
    const s = await pty().open(agent, { command: "start" }, new AbortController().signal);
    await pty().send(agent, s.sessionId, { data: "hello" });
    const page = await pty().tail(agent, s.sessionId, 50);
    expect(page.text).toContain("hello");
    const closed = await pty().close(agent, s.sessionId);
    expect(closed.closed).toBe(true);
    // Idempotent per close.
    await expect(pty().close(agent, s.sessionId)).resolves.toMatchObject({ closed: false });
  });

  it("rejects an empty command on the facade path too", async () => {
    await expect(pty().open(makeAgent("a"), { command: " " }, new AbortController().signal))
      .rejects.toThrow(/non-empty/);
  });

  it("dispose effect still closes facade-opened sessions", async () => {
    const agent = makeAgent("a");
    const s = await pty().open(agent, { command: "bye" }, new AbortController().signal);
    expect(ctx.effects).toHaveLength(1);
    await ctx.effects[0].fn()();
    expect(ctx.terminals.sessions.has(s.sessionId)).toBe(false);
  });
});

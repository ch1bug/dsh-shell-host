/**
 * Tests are the reference implementation: every test drives the real plugin
 * surface (defineTool execute) over the SELF-MANAGED session core (#61,
 * ADR-0010) with an injected fake spawner — an in-process echo "PTY" (any
 * write is echoed back as a line). No ConPTY needed; the real node-pty
 * spawn is the machine lane's business (#51 precedent).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { apply } from "../src/pty/index.ts";
import { echoFakePty, type FakePtyHandle, type CoreSpawnSpec } from "./helpers/fake-pty.ts";

// ---------------------------------------------------------------------------
// Echo spawner: every write is echoed back as a complete line — the fake
// stands in for the pty line discipline the real ConPTY provides.
// ---------------------------------------------------------------------------

const handles: FakePtyHandle[] = [];
const specs: CoreSpawnSpec[] = [];

function echoSpawner(spec: CoreSpawnSpec) {
  specs.push(spec);
  const h = echoFakePty();
  handles.push(h);
  return h.pty;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeAgent(name: string) { return { agentName: name }; }
const exec = (agent: unknown) => ({ agent, signal: new AbortController().signal });

let ctx: any;
function setup() {
  handles.length = 0;
  specs.length = 0;
  ctx = {
    provided: {},
    provide(name: string, value: unknown) { this.provided[name] = value; },
    tools: { registered: [] as any[], register(t: unknown) { this.registered.push(t); } },
    effects: [] as Array<{ fn: () => () => Promise<void>; label: string }>,
    effect(fn: () => () => Promise<void>, label: string) { this.effects.push({ fn, label }); },
  };
  apply(ctx, { tailLines: 200, maxSessions: 8 }, { spawnPty: echoSpawner });
}
const tool = (n: string) => ctx.tools.registered.find((t: any) => t.name === n);
const pty = () => ctx.provided.pty;

beforeEach(setup);

// ---------------------------------------------------------------------------
// AC 1 — open → send → tail → close lifecycle round-trip
// ---------------------------------------------------------------------------

describe("pty lifecycle round-trip", () => {
  it("opens a session, sends, tails the echo, closes", async () => {
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

  it("runs the command at spawn: the command text reaches the spawner verbatim", async () => {
    const agent = makeAgent("a");
    await tool("pty_open").execute({ command: "auto-run-line" }, exec(agent));
    // #61: the command IS the spawned process (under the platform-shell
    // wrapper in production) — no typed-in command line anymore.
    expect(specs[0].command).toBe("auto-run-line");
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
    expect(pty().active(agent).sort())
      .toEqual([s1.sessionId, s2.sessionId].sort());
  });

  it("plugin dispose effect closes every session it opened (all owners)", async () => {
    const agent = makeAgent("a");
    const other = makeAgent("b");
    await tool("pty_open").execute({ command: "one" }, exec(agent));
    await tool("pty_open").execute({ command: "two" }, exec(other));
    expect(ctx.effects).toHaveLength(1);
    await ctx.effects[0].fn()();
    expect(pty().active(agent)).toHaveLength(0);
    expect(pty().active(other)).toHaveLength(0);
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
    for (const n of ["n1", "n2", "n3"]) {
      await tool("pty_send").execute({ id: s.sessionId, data: n }, exec(agent));
    }
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
    await expect(tool("pty_send").execute({ id: s.sessionId, data: "x" }, exec(b)))
      .rejects.toMatchObject({ code: "NO_SESSION" });
    await expect(tool("pty_tail").execute({ id: s.sessionId }, exec(b)))
      .rejects.toMatchObject({ code: "NO_SESSION" });
    await expect(tool("pty_close").execute({ id: s.sessionId }, exec(b)))
      .rejects.toMatchObject({ code: "SESSION_OWNED" });
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
    await tool("pty_open").execute({
      command: "run-cmd",
      env: { FOO: "bar baz", WEIRD: "it's" },
    }, exec(agent));
    // env rides the spawn spec (#61: the core's spawn request): the process
    // is born with these entries.
    expect(specs[0].env).toEqual({ FOO: "bar baz", WEIRD: "it's" });
    // Nothing is typed into the terminal as `export` lines: nothing is
    // written into the pty at all — the command is the spawned process.
    expect(handles[0].writes).toHaveLength(0);
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
    await pty().open(agent, { command: "bye" }, new AbortController().signal);
    expect(ctx.effects).toHaveLength(1);
    await ctx.effects[0].fn()();
    expect(pty().active(agent)).toHaveLength(0);
  });
});

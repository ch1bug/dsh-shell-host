/**
 * Tests are the reference implementation: every test drives the real plugin
 * surface (defineTool execute) over the SELF-MANAGED session core (#61,
 * ADR-0010) with an injected fake spawner — an in-process echo "PTY" (any
 * write is echoed back as a line). No ConPTY needed; the real node-pty
 * spawn is the machine lane's business (#51 precedent).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { apply } from "../src/pty/index.ts";
import { AUTO_CLOSE_SEMANTICS } from "../src/pty/session-core.ts";
import { echoFakePty, type FakePtyHandle, type CoreSpawnSpec } from "./helpers/fake-pty.ts";
import { waitUntil } from "./helpers/wait-until.ts";

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

  /**
   * #64 —— autoClose 一次性回收。
   *
   * ## 本用例的竞态形状（为什么这里不能用固定 sleep）
   *
   * `emitExit()` 只是投递退出事件；**回收是异步的**：核心在 `pty.onExit` 里
   * `settleFor(..., { ignoreExit: true }).then(() => killSession(s, 'autoClose'))`，
   * 而 `settleFor` 走**静默窗口** —— 默认 `settleQuietMs = 150` + `settleTickMs = 25`
   * 起步，再加 `killSession` 自己的开销 ⇒ 正常回收耗时是**百毫秒级**。
   *
   * 本用例原先 `await setTimeout(250)` 再断言。**实测的真实余量**（n=20，1ms 步进探针，
   * `.scratch/124-bound2.log`）：从 `emitExit` 到回收完成 **min 186 / p50 202 / max 204 ms**
   * ⇒ 按**典型**耗时算余量 ≈ **64ms**，按**最坏**算 ≈ **46ms**（票面按「150+25=175ms 起步」
   * 推算的是 ~75ms，量级相符）。**判据本身没错**（它确实该被回收），错的是"用固定 sleep 等一个
   * **可观测的异步事件**"：全量车道里 20+ 个 spec 共用 worker 池、事件循环被挤压时，这几十毫秒
   * 会蒸发 ⇒ 间歇红
   * （票面实测：单档重复 12 次全绿，全量车道同一冻结树 6 次里红 1 次 ——
   * **单档绿证明不了它修好了**）。
   *
   * ## 修法：轮询到条件成立
   *
   * 等的是用例自己的**前置条件** ——"回收已发生"（`pty().active()` 不再含该 sessionId）
   * ——而不是一个猜出来的时长。上界取 **5 s**：远大于百毫秒级的正常回收（高负载下不假红），
   * 又足以在真缺陷（回收根本没发生）上**响亮失败**并报出实际观测到的状态。
   *
   * ⚠️ 不要退回"加长 sleep"（那只是把窗口挪到更慢的机器上），也不要为此调小
   * `settleQuietMs` / `settleTickMs` —— 那是**产品默认值**，属别的面（本票 Out of scope）。
   */
  it("autoClose: true rides the tool surface — the session self-reclaims on exit (#64)", async () => {
    const a = makeAgent("a");
    const opened = await tool("pty_open").execute({ command: "one-shot", autoClose: true }, exec(a));
    expect(pty().active(a)).toContain(opened.sessionId);
    const handle = handles.find((h) => h.pty.pid === opened.pid)!;
    handle.emitExit({ exitCode: 0 });
    // 等"回收已发生"这个条件成立，不是等一个时长。超时会响亮失败并给出实测状态。
    await waitUntil(() => !pty().active(a).includes(opened.sessionId), {
      timeoutMs: 5_000,
      describeObserved: () => `active(${a.agentName}) = ${JSON.stringify(pty().active(a))}（期望不含 ${opened.sessionId}）；`
        + `killed=${handle.killed}`,
    });
  });
  it("autoClose semantics wording has one source: the tool surface quotes the exported constant (#66)", () => {
    const open = tool("pty_open");
    // The parameter description IS the semantic body — no second wording.
    expect(open.parameters.properties.autoClose.description).toBe(AUTO_CLOSE_SEMANTICS);
    // The tool description quotes it too (self-contained agent-facing text,
    // zero independent rephrasing).
    expect(open.description).toContain(AUTO_CLOSE_SEMANTICS);
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

/**
 * Tests are the reference implementation: every test drives the real plugin
 * surface (defineTool execute) over the SELF-MANAGED session core (#61,
 * ADR-0010) with an injected fake spawner — an in-process echo "PTY" (any
 * write is echoed back as a line). No ConPTY needed; the real node-pty
 * spawn is the machine lane's business (#51 precedent).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AUTO_CLOSE_SEMANTICS, PTY_COMMAND_SEMANTICS, PTY_SIGNALS, PTY_SIGNAL_SEMANTICS } from "../src/pty/session-core.ts";
import { bootPlugin, echoFakePty } from "./helpers/fake-pty.ts";
import { waitUntil, stillPending } from "./helpers/wait-until.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeAgent(name: string) { return { agentName: name }; }
const exec = (agent: unknown) => ({ agent, signal: new AbortController().signal });

let boot: ReturnType<typeof bootPlugin>;
/** Boot the pty entry over the echo fake through the SHARED harness (#156 —
 * the hand-rolled `makeCtx` is gone; bootPlugin mounts the permissive #102
 * permission fakes by default). `deps` reaches the core, so a case can swap
 * in the signal seam (#119: `platform` / `procKill`). */
function setup(deps: { platform?: NodeJS.Platform; procKill?: (pid: number, signal: string) => void } = {}) {
  boot = bootPlugin({ config: { tailLines: 200, maxSessions: 8 }, spawnPty: echoFakePty, deps });
}
const tool = (n: string) => boot.tool(n);
const pty = () => boot.core;

beforeEach(() => setup());

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
    expect(boot.specs[0].command).toBe("auto-run-line");
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
    expect(boot.effects).toHaveLength(1);
    await boot.effects[0].dispose();
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
    expect(boot.specs[0].env).toEqual({ FOO: "bar baz", WEIRD: "it's" });
    // Nothing is typed into the terminal as `export` lines: nothing is
    // written into the pty at all — the command is the spawned process.
    expect(boot.handles[0].writes).toHaveLength(0);
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
  it("autoClose: true rides the tool surface — the call waits for the exit, returns the code, then self-reclaims (#64, #146)", async () => {
    const a = makeAgent("a");
    const pending = tool("pty_open").execute({ command: "one-shot", autoClose: true }, exec(a));
    // #146: the open call WAITS for the real exit, so the exit is driven while
    // the call is in flight (the #64 shape — emit after the open resolved —
    // would now wait forever by design).
    await waitUntil(() => boot.handles.length === 1, {
      timeoutMs: 2_000,
      describeObserved: () => `handles=${boot.handles.length}`,
    });
    const handle = boot.handles[0];
    // #146: the call waits for the real exit — it must NOT resolve while the
    // process is alive (the harness settle window is 150ms; 400ms is well past
    // it, so the pre-#146 shape would have returned `running` here).
    await stillPending(pending, { windowMs: 400, what: "tool-surface one-shot open while the process lives" });
    handle.emitExit({ exitCode: 0 });
    const opened = await pending;
    expect(opened.status).toEqual({ kind: "exited", exitCode: 0 });
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

  // #146 AC1/AC2 — the two agent-facing facts this ticket adds:
  // (a) the one-shot result carries a REAL exit code (declared in the output
  //     schema, not just implemented), and (b) the command-spawn semantics have
  //     ONE source: the tool description and its `command` parameter both quote
  //     PTY_COMMAND_SEMANTICS verbatim (#66's AUTO_CLOSE precedent).
  it("#146: the output schema DECLARES the one-shot exited status shape (kind + exitCode)", () => {
    const status = tool("pty_open").output.schema.properties.status;
    // The shape is DECLARED, not merely described in prose: a caller/codegen can
    // read the two fields, and a shape change fails here instead of drifting
    // silently past a substring check.
    expect(status.properties.kind).toMatchObject({ type: "string" });
    expect(status.properties.exitCode).toMatchObject({ type: "number" });
    expect(status.description).toContain("exited");
    expect(status.description).toContain("exitCode");
  });

  it("#146 × #149: autoClose + shellCommand is refused loudly (a shell is persistent)", async () => {
    const a = makeAgent("a");
    await expect(tool("pty_open").execute({ shellCommand: "bash --login -i", autoClose: true }, exec(a)))
      .rejects.toMatchObject({ code: "INVALID_ARGS" });
    // Refused before any spawn — no process left running behind a rejected call.
    expect(boot.specs).toHaveLength(0);
  });

  it("#146: command semantics have one source — the tool description and its `command` parameter quote the constant", () => {
    const open = tool("pty_open");
    expect(open.description).toContain(PTY_COMMAND_SEMANTICS);
    expect(open.parameters.properties.command.description).toContain(PTY_COMMAND_SEMANTICS);
    // Both explicit-shell spellings ride the SAME constant (AC2's two forms),
    // so the description cannot drift into a different pair.
    expect(PTY_COMMAND_SEMANTICS).toContain("cmd.exe /d /c");
    expect(PTY_COMMAND_SEMANTICS).toContain("bash -lc");
    // The POSIX half is stated too, not only the win32 half.
    expect(PTY_COMMAND_SEMANTICS).toContain("/bin/sh -c");
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
    expect(boot.effects).toHaveLength(1);
    await boot.effects[0].dispose();
    expect(pty().active(agent)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #119 — pty_list / pty_signal on the tool surface (AC1 契约、AC2 owner 边界)
// ---------------------------------------------------------------------------

describe("pty_list / pty_signal tool surface (#119)", () => {
  it("registers both tools WITH the mandatory output contract (schema + render) and the signal whitelist", () => {
    for (const name of ["pty_list", "pty_signal"]) {
      const t = tool(name);
      expect(t.name).toBe(name);
      // defineTool 的硬要求（AC1）：缺 output.schema / render 会在挂载期响亮失败。
      expect(t.output?.schema?.type).toBe("object");
      expect(typeof t.output.render).toBe("function");
    }
    // 参数面的白名单是单源常量，不是第二份手抄列表。
    expect(tool("pty_signal").parameters.properties.signal).toMatchObject({ type: "string", enum: [...PTY_SIGNALS] });
    expect(tool("pty_signal").parameters.required).toEqual(["id", "signal"]);
    expect(tool("pty_signal").description).toContain("Windows/ConPTY");
    // 平台语义的单一来源（#66 的 AUTO_CLOSE 同款判据）：工具描述逐字引用常量，
    // 文档与本档都指向它 ⇒ 三处不会各讲一套。
    expect(tool("pty_signal").description).toContain(PTY_SIGNAL_SEMANTICS);
  });

  it("pty_list lists only the caller's own sessions, in creation order; render is one line per session", async () => {
    const a = makeAgent("a");
    const b = makeAgent("b");
    expect(await tool("pty_list").execute({}, exec(a))).toEqual({ sessions: [] });
    const s1 = await tool("pty_open").execute({ command: "one" }, exec(a));
    await tool("pty_open").execute({ command: "two" }, exec(b));
    const s2 = await tool("pty_open").execute({ command: "three" }, exec(a));
    const listed = await tool("pty_list").execute({}, exec(a));
    expect(listed.sessions.map((row: any) => row.id)).toEqual([s1.sessionId, s2.sessionId]);
    expect(listed.sessions[0].status).toEqual({ kind: "running" });
    const text = tool("pty_list").output.render({}, listed)[0].text as string;
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain(s1.sessionId);
    expect(text).toContain("running");
    // 空列表也有明确读数，不是一个空串。
    expect(tool("pty_list").output.render({}, { sessions: [] })[0].text).toBe("(no sessions)");
  });

  it("pty_signal is owner-scoped: foreign id is SESSION_OWNED, unknown id is NO_SESSION, exited is delivered:false", async () => {
    const a = makeAgent("a");
    const b = makeAgent("b");
    const s = await tool("pty_open").execute({ command: "secret" }, exec(a));
    await expect(tool("pty_signal").execute({ id: s.sessionId, signal: "SIGINT" }, exec(b)))
      .rejects.toMatchObject({ code: "SESSION_OWNED" });
    await expect(tool("pty_signal").execute({ id: "nope", signal: "SIGINT" }, exec(a)))
      .rejects.toMatchObject({ code: "NO_SESSION" });
    // 会话退出后仍被持有（持久默认）—— 报 delivered:false，而不是假装投递过。
    boot.handles[0].emitExit({ exitCode: 0 });
    expect(await tool("pty_signal").execute({ id: s.sessionId, signal: "SIGTERM" }, exec(a)))
      .toMatchObject({ delivered: false, status: { kind: "exited", exitCode: 0 } });
    // 归属边界不因退出而失效：别人的 id 依旧响亮。
    await expect(tool("pty_signal").execute({ id: s.sessionId, signal: "SIGTERM" }, exec(b)))
      .rejects.toMatchObject({ code: "SESSION_OWNED" });
  });

  it("pty_signal reaches the core's delivery seam through the facade (POSIX: process group)", async () => {
    // 平台分支与投递缝在 deps 上（核心档已逐条覆盖）；这里证的是工具 → facade →
    // core 这条线真的接上了，且语义标签如实写进结果。
    const calls: Array<[number, string]> = [];
    setup({ platform: "linux", procKill: (pid, signal) => { calls.push([pid, signal]); } });
    const a = makeAgent("a");
    const opened = await tool("pty_open").execute({ command: "run" }, exec(a));
    expect(await tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGINT" }, exec(a)))
      .toMatchObject({ id: opened.sessionId, signal: "SIGINT", delivered: true, semantics: "signal" });
    expect(calls).toEqual([[-opened.pid!, "SIGINT"]]);
  });
});

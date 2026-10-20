/**
 * Unit spec for the self-managed PTY session core (#61, ADR-0010): the
 * seam-free rewrite — node-pty sessions owned by this package's own
 * registry (owner-scoped, cursor reads, cap, idle timeout, dispose).
 * The spawner is injected so the unit lane stays hermetic (no ConPTY);
 * the real node-pty spawn is the machine lane's business (#51 precedent).
 * @module tests/pty-core
 */

import { describe, it, expect } from "vitest";
import { bootPlugin, fakePty, type FakePtyHandle, type CoreSpawnSpec } from "./helpers/fake-pty.ts";
import { DEFAULT_MAX_SESSIONS, PTY_SIGNALS, SPAWN_FAILURE_HINT, createSessionCore, defaultSpawnPty, type SessionCoreConfig } from "../src/pty/session-core.ts";
import { waitUntil, stillPending } from "./helpers/wait-until.ts";

/**
 * 每处固定 sleep 的判据分类（#129）—— 逐处判断，不一律改轮询。
 *
 * 本文件此前有 20 处 `await new Promise((r) => setTimeout(r, N))`。按**等什么**分三类
 * （下面的行号是**本改动之后**的现状，改动前对应 `:46/59/…/225`）：
 *
 * 1. **正当的短 sleep（保持原样，11 处）**：`:91/104/112/119/122/127/137/157/178/196/217`
 *    的 `setTimeout(10)` 等的是"**假 PTY 的 echo 落进缓冲**"—— `helpers/fake-pty.ts:83`
 *    的实现本身就是 `setTimeout(..., 5)` 后才 `emitData`。这是"给一个**已知的、自己制造的**
 *    小延迟留时间"，不是"等一个可观测的最终状态"；改成轮询反而要探一个没有判据的中间态。
 *    （另有 `stillHeldFor` 内部的一处 `setTimeout(ms)` —— 那是下界证明的sleep，见第 3 类。）
 *
 * 2. **等"某个事件已发生"（改轮询，5 处：`:203/221/238/250/289`）**：形状是
 *    `emitExit()` → 固定 sleep → 断言**已**回收 / **已**关闭。固定时长是**猜测**：
 *    实测（`.scratch/t129-measure.log`，真 core、1ms 步进探针、n=20）本文件 `:62` 的
 *    `FAST` 档回收 min46/p50 62/max64ms，而 `:275` 的回归档（`settleQuietMs:60`）
 *    是 min78/p50 93/**max97**ms —— 对 100ms 的固定预算，最坏余量只剩 **3ms**。
 *    ⇒ 改为 `waitUntil(条件, { timeoutMs: 秒级 })`，超时**响亮失败**并附实测状态。
 *
 * 3. **证明"尚未发生"（**不能**改轮询，4 处：`:201/265/281/286`）**：形状是"到此刻**仍然** active /
 *    仍然可读"。这是**下界**证明 —— 轮询到"条件成立"在这里是**真空通过**（回收真出问题、
 *    或干脆立刻回收，探针都会绿），判据会失效。故改用 {@link stillHeldFor} 保住它的语义：
 *    睡满下界 + 断言此刻**确实**仍持有。
 *
 * ⚠️ 第 3 类是本票**最容易误判**的地方：票面 `:155`（改前行号）的说明已点出"等的是**不发生的**
 * 事件，可能需要改的是**下界证明方式**，不是轮询"—— 此处照此办理，并把该判断留档在
 * `.scratch/129-landing.md`。
 */

/**
 * **下界**证明：至少等满 `ms`，然后把此刻的实测值交给 `expected` 去断言。
 *
 * 为什么不能写成 `waitUntil(() => !held)` 的反面：那种"等一个**不发生**的事件"没有可轮询的
 * 成立条件 —— 轮询到它成立就绿，说明该发生的事**还没**发生，恰恰是失败；轮询不到则要睡满
 * 上界才能判，与固定 sleep 同样脆。下界证明的正确形态就是"睡满 + 断言仍持有"。
 *
 * `observed` 在**通过**时也会被算一次（与 `waitUntil` 的惰性 `describeObserved` 不同）：
 * 这里的读数本身是断言对象，必须在断言时取。
 */
async function stillHeldFor<T>(ms: number, observed: () => T): Promise<T> {
  await new Promise((r) => setTimeout(r, ms));
  return observed();
}

/** Wait until `bootFast` has actually spawned (the #146 one-shot tests drive the
 * process WHILE the open call is in flight, so they need the handle first). */
async function waitForOneSpawn(h: { spawned: unknown[] }): Promise<void> {
  await waitUntil(() => h.spawned.length === 1, {
    timeoutMs: 2_000,
    describeObserved: () => `spawned=${h.spawned.length}（期望 1：pty_open 已 spawn）`,
  });
}

/** Fast settle tuning: the core polls for output quiescence; these values
 * keep every await in the spec under ~100ms without weakening the
 * quiet-window semantics. */
const FAST = { settleQuietMs: 20, settleTickMs: 5, settleTimeoutMs: 300 };

const agent = { name: "a" };

/** Boot with a spawner handing out fresh fake ptys; returns the harness
 * plus the last spawned handle for driving output. */
function bootFast(opts?: { config?: unknown; spawn?: (spec: CoreSpawnSpec) => FakePtyHandle }) {
  const spawned: FakePtyHandle[] = [];
  const specs: CoreSpawnSpec[] = [];
  const h = bootPlugin({
    config: { ...FAST, ...(opts?.config ?? {}) },
    spawnPty: opts?.spawn ?? ((spec: CoreSpawnSpec) => {
      specs.push(spec);
      const handle = fakePty(10000 + spawned.length + 1);
      spawned.push(handle);
      return handle;
    }),
  });
  return { ...h, spawned, specs };
}

describe("self-managed session core (#61 ADR-0010)", () => {
  it("open spawns the command via the injected spawner and captures the initial output", async () => {
    const h = bootFast();
    const pending = h.tool("pty_open").execute(
      { command: "bash --login -i", cwd: "/tmp", env: { FOO: "bar" } },
      { agent },
    );
    // Let the spawn land, then feed a banner before the quiet window closes.
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("welcome\r\n");
    const opened = await pending;
    expect(h.specs[0]).toMatchObject({ command: "bash --login -i", cwd: "/tmp", env: { FOO: "bar" } });
    expect(opened.sessionId).toBeTypeOf("string");
    expect(opened.pid).toBe(h.spawned[0].pty.pid);
    expect(opened.status).toEqual({ kind: "running" });
    expect(opened.initialOutput).toContain("welcome");
  });

  it("tail is cursor-incremental: only new lines, repeated tails empty, truncation flagged", async () => {
    const h = bootFast();
    const pending = h.tool("pty_open").execute({ command: "repl" }, { agent });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("banner\r\n");
    const opened = await pending;
    // Cursor is at publication: the banner is NOT re-sent.
    expect(await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent })).toEqual(
      { text: "", lines: 0, truncated: false },
    );
    h.spawned[0].emitData("one\r\ntwo\r\n");
    await new Promise((r) => setTimeout(r, 10));
    const page = await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent });
    expect(page.lines).toBe(2);
    expect(page.text).toContain("one");
    expect(page.text).toContain("two");
    // A partial line is held back until complete (complete lines only).
    h.spawned[0].emitData("par");
    await new Promise((r) => setTimeout(r, 10));
    expect((await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent })).lines).toBe(0);
    h.spawned[0].emitData("tial\r\n");
    await new Promise((r) => setTimeout(r, 10));
    const page2 = await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent });
    expect(page2.text).toContain("partial");
    // Budget cap: backlog beyond `lines` is dropped and flagged.
    h.spawned[0].emitData("a\r\nb\r\nc\r\nd\r\n");
    await new Promise((r) => setTimeout(r, 10));
    const page3 = await h.tool("pty_tail").execute({ id: opened.sessionId, lines: 2 }, { agent });
    expect(page3.lines).toBe(2);
    expect(page3.truncated).toBe(true);
  });

  it("send writes payload with submit Enter and returns the settled delta", async () => {
    const h = bootFast();
    const opened = await h.tool("pty_open").execute({ command: "repl" }, { agent });
    const sendP = h.tool("pty_send").execute({ id: opened.sessionId, data: "echo hi" }, { agent });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitData("echo hi\r\nhi\r\n");
    const sent = await sendP;
    expect(h.spawned[0].writes[0]).toBe("echo hi\r");
    expect(sent.delta).toContain("hi");
    expect(sent.status).toEqual({ kind: "running" });
    // submit:false sends the bare text, no Enter.
    await h.tool("pty_send").execute({ id: opened.sessionId, data: "partial", submit: false }, { agent });
    expect(h.spawned[0].writes[1]).toBe("partial");
  });

  it("close kills, waits for the exit, is idempotent, and rejects foreign owners", async () => {
    const h = bootFast();
    const opened = await h.tool("pty_open").execute({ command: "repl" }, { agent });
    // Foreign owner: loud, never crosses the ownership boundary (while the
    // session is still held by its owner).
    await expect(
      h.tool("pty_close").execute({ id: opened.sessionId }, { agent: { name: "other" } }),
    ).rejects.toThrow();
    const closeP = h.tool("pty_close").execute({ id: opened.sessionId }, { agent });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitExit({ exitCode: 0 });
    expect(await closeP).toEqual({ closed: true });
    expect(h.spawned[0].killed).toBe(1);
    // Second close: documented closed:false, not a throw.
    expect(await h.tool("pty_close").execute({ id: opened.sessionId }, { agent })).toEqual({ closed: false });
    // Unknown id: closed:false.
    expect(await h.tool("pty_close").execute({ id: "nope" }, { agent })).toEqual({ closed: false });
  });

  it("enforces the per-owner soft cap (default 8) and frees the slot on close (#56 migrated)", async () => {
    const h = bootFast();
    const ids: string[] = [];
    for (let i = 0; i < DEFAULT_MAX_SESSIONS; i++) {
      ids.push((await h.tool("pty_open").execute({ command: `s${i}` }, { agent })).sessionId);
    }
    await expect(h.tool("pty_open").execute({ command: "one-too-many" }, { agent })).rejects.toThrow(/limit/);
    // Another owner is unaffected (cap is per-owner).
    await expect(h.tool("pty_open").execute({ command: "other-owner" }, { agent: { name: "b" } })).resolves.toBeTruthy();
    // Closing one frees the slot (kill waits for the exit event).
    const closeP = h.tool("pty_close").execute({ id: ids[0] }, { agent });
    await new Promise((r) => setTimeout(r, 10));
    h.spawned[0].emitExit({ exitCode: 0 });
    await closeP;
    await expect(h.tool("pty_open").execute({ command: "fits-now" }, { agent })).resolves.toBeTruthy();
    // Configured override.
    const h2 = bootFast({ config: { maxSessions: 1 } });
    await h2.tool("pty_open").execute({ command: "first" }, { agent });
    await expect(h2.tool("pty_open").execute({ command: "second" }, { agent })).rejects.toThrow(/limit/);
  });

  it("idle timeout (core-level) closes a session with no new output; output refreshes the clock", async () => {
    const { createSessionCore } = await import("../src/pty/session-core.ts");
    const handles: FakePtyHandle[] = [];
    const core = createSessionCore(
      { settleQuietMs: 10, settleTickMs: 5, settleTimeoutMs: 100, idleTickMs: 10 },
      { spawnPty: ((spec: CoreSpawnSpec) => { const h2 = fakePty(9000 + handles.length); handles.push(h2); return h2.pty; }) as any },
    );
    const openedPromise = core.open(agent, { command: "watcher", idleTimeoutMs: 150 });
    await new Promise((r) => setTimeout(r, 10));
    handles[0].emitData("hi\r\n");
    const opened = await openedPromise;
    // Output inside the window refreshes the clock — still alive past 80ms.
    // 下界证明（见头注第 3 类）：睡满 80ms 再断言**此刻仍然**持有，不是轮询。
    expect(await stillHeldFor(80, () => core.active(agent))).toContain(opened.sessionId);
    // Now truly idle: the watcher closes it. 等"关闭已发生"这个事件成立 —— 不是等一个时长。
    await waitUntil(() => !core.active(agent).includes(opened.sessionId), {
      timeoutMs: 5_000,
      describeObserved: () => `active(agent) = ${JSON.stringify(core.active(agent))}（期望不含 ${opened.sessionId}）`,
    });
    core.dispose().catch(() => {});
  });
});

describe("autoClose one-shot mode (#64, #146)", () => {
  it("reclaims an autoClose session automatically after the process exits, and returns its exit code (#146 AC1)", async () => {
    const h = bootFast();
    const pending = h.tool("pty_open").execute({ command: "one-shot", autoClose: true }, { agent });
    // #146: the call WAITS for the real exit before it returns, so the process
    // must be driven while the call is in flight. The #64-era shape (emit the
    // exit only AFTER the open resolved) no longer exists — an autoClose open
    // on a process nobody ends would wait forever by design.
    await waitForOneSpawn(h);
    h.spawned[0].emitData("work output\r\n");
    // #146: the call must NOT resolve while the process is still alive (120ms is
    // well past FAST's 20ms settle window, so the OLD code resolved here with the
    // old `{ kind: "running" }` shape — output but no exit code, and the
    // auto-reclaim then makes the code unreachable).
    await stillPending(pending, { windowMs: 120, what: "one-shot open while the process lives" });
    h.spawned[0].emitExit({ exitCode: 0 });
    const opened = await pending;
    // The result carries the REAL code (the ticket's AC1) and the final output.
    expect(opened.status).toEqual({ kind: "exited", exitCode: 0 });
    expect(opened.initialOutput).toContain("work output");
    // Settle window first (output lands), then the single close path reclaims.
    // 等"回收已发生"这个条件成立，不是等一个时长（头注第 2 类）。
    await waitUntil(() => !h.core.active(agent).includes(opened.sessionId), {
      timeoutMs: 5_000,
      describeObserved: () => `active(agent) = ${JSON.stringify(h.core.active(agent))}`
        + `（期望不含 ${opened.sessionId}）；killed=${h.spawned[0].killed}`,
    });
    expect(h.spawned[0].killed).toBe(0); // already exited — no kill needed
  });

  it("a non-zero one-shot carries the real code through the status, not a bare `running` (#146 AC1)", async () => {
    const h = bootFast();
    const pending = h.tool("pty_open").execute({ command: "failing-one-shot", autoClose: true }, { agent });
    await waitForOneSpawn(h);
    h.spawned[0].emitData("boom\r\n");
    // Same "must not resolve before the exit" pin as the case above.
    await stillPending(pending, { windowMs: 120, what: "non-zero one-shot open while the process lives" });
    h.spawned[0].emitExit({ exitCode: 3 });
    const opened = await pending;
    expect(opened.status).toEqual({ kind: "exited", exitCode: 3 });
    expect(opened.initialOutput).toContain("boom");
  });

  it("an aborted one-shot returns early (no exit code) instead of pinning the call (#146)", async () => {
    const h = bootFast();
    const controller = new AbortController();
    const pending = h.tool("pty_open").execute(
      { command: "never-ends", autoClose: true },
      { agent, signal: controller.signal },
    );
    await waitForOneSpawn(h);
    controller.abort();
    const opened = await pending;
    // An abort stops the WAIT, not the process: the status is still running and
    // no code is invented. (The exit later still runs the auto-reclaim path.)
    expect(opened.status).toEqual({ kind: "running" });
    h.spawned[0].emitExit({ exitCode: 0 });
  });

  it("refuses autoClose on a declared shell target loudly, before any spawn (#146 × #149)", async () => {
    const h = bootFast();
    // #146 × #149: "wait for the real exit" and "a persistent shell session" are
    // contradictory declarations — refuse loudly instead of pinning the call to
    // a process that by design never ends.
    await expect(h.core.open(agent, { command: "bash --login -i", autoClose: true, shell: true }))
      .rejects.toMatchObject({ code: "INVALID_ARGS" });
    // Refused BEFORE a spawn: no process to leak, no cap slot consumed.
    expect(h.spawned).toHaveLength(0);
    expect(h.core.active(agent)).toHaveLength(0);
  });

  it("frees the soft-cap slot: a new open succeeds immediately after auto-reclaim", async () => {
    const h = bootFast({ config: { maxSessions: 1 } });
    const pending = h.tool("pty_open").execute({ command: "one-shot", autoClose: true }, { agent });
    await waitUntil(() => h.core.active(agent).length === 1, {
      timeoutMs: 2_000,
      describeObserved: () => `active(agent) = ${JSON.stringify(h.core.active(agent))}（期望恰好 1 个：open 已登记）`,
    });
    // Cap is full while the session lives.
    await expect(h.tool("pty_open").execute({ command: "second" }, { agent })).rejects.toThrow(/limit/);
    h.spawned[0].emitExit({ exitCode: 0 });
    const opened = await pending;
    expect(opened.status).toEqual({ kind: "exited", exitCode: 0 });
    // 等"槽位已释放"的**前置条件**（回收已发生）成立，而不是猜一个时长。
    // 判据取"该 owner 已无任何持有"（本档 maxSessions=1 ⇒ 注册表应清空），
    // 不写死 `pty-1`：id 由 core 的计数器生成，写死会把判据绑在编号上。
    await waitUntil(() => h.core.active(agent).length === 0, {
      timeoutMs: 5_000,
      describeObserved: () => `active(agent) = ${JSON.stringify(h.core.active(agent))}（期望为空：单会话档，回收后应清空）`,
    });
    await expect(h.tool("pty_open").execute({ command: "fits-now" }, { agent })).resolves.toBeTruthy();
  });

  it("tail after auto-reclaim reports NO_SESSION (same dead-session semantics as pty_close)", async () => {
    const h = bootFast();
    const pending = h.tool("pty_open").execute({ command: "one-shot", autoClose: true }, { agent });
    await waitForOneSpawn(h);
    h.spawned[0].emitExit({ exitCode: 0 });
    const opened = await pending;
    // 等"回收已发生"成立后再断言 tail 的死会话语义 —— 不是等一个时长。
    await waitUntil(() => !h.core.active(agent).includes(opened.sessionId), {
      timeoutMs: 5_000,
      describeObserved: () => `active(agent) = ${JSON.stringify(h.core.active(agent))}（期望不含 ${opened.sessionId}）`,
    });
    await expect(h.tool("pty_tail").execute({ id: opened.sessionId }, { agent })).rejects.toMatchObject({ code: "NO_SESSION" });
  });

  it("default semantics are byte-identical: no autoClose = session survives exit until pty_close", async () => {
    const h = bootFast();
    const opened = await h.tool("pty_open").execute({ command: "persist" }, { agent });
    h.spawned[0].emitData("before\r\n");
    h.spawned[0].emitExit({ exitCode: 3 });
    // Still registered, tail still readable, no kill, status carries the code.
    // 下界证明（头注第 3 类）：持久档**在退出后仍应被持有** —— 这里要证的是"没被回收"，
    // 轮询到某个条件成立在此会真空通过，故睡满下界后断言此刻仍然持有。
    expect(await stillHeldFor(100, () => h.core.active(agent))).toContain(opened.sessionId);
    const page = await h.tool("pty_tail").execute({ id: opened.sessionId }, { agent });
    expect(page.text).toContain("before");
    expect(h.spawned[0].killed).toBe(0);
  });

  it("settle-before-reclaim: autoClose waits out the quiet window AFTER exit, and post-exit output resets the clock (#64)", async () => {
    // settleQuietMs=60: the regression this pins is reclaiming on the first
    // tick after exit (settleFor short-circuits on s.exited); the fixed
    // core holds the session until output has been quiet for the window.
    const h = bootFast({ config: { settleQuietMs: 60, settleTickMs: 5, settleTimeoutMs: 2000 } });
    const pending = h.tool("pty_open").execute({ command: "one-shot", autoClose: true }, { agent });
    await waitUntil(() => h.core.active(agent).length === 1, {
      timeoutMs: 2_000,
      describeObserved: () => `active(agent) = ${JSON.stringify(h.core.active(agent))}（期望恰好 1 个：open 已登记）`,
    });
    // The id is known while the open call is still in flight (#146 waits for
    // the exit), so the lower-bound assertions can address the session.
    const id = h.core.active(agent)[0]!;
    h.spawned[0].emitExit({ exitCode: 0 });
    // Still inside the quiet window: not yet reclaimed.
    // ⚠️ 下界证明（头注第 3 类）：本行要证"**尚未**回收"，不是"回收已发生" ——
    // 轮询在此会**真空通过**（回收真出问题也绿），故睡满下界 + 断言此刻仍然持有。
    expect(await stillHeldFor(20, () => h.core.active(agent))).toContain(id);
    // Post-exit flush (buffered output racing the exit event) lands and
    // resets the settle clock.
    h.spawned[0].emitData("final flush\r\n");
    // 65ms since exit but only ~45ms of quiet: still held (同一条下界判据)。
    expect(await stillHeldFor(45, () => h.core.active(agent))).toContain(id);
    // The open call returns after the same quiet window, with the flush landed.
    const opened = await pending;
    expect(opened.status).toEqual({ kind: "exited", exitCode: 0 });
    expect(opened.initialOutput).toContain("final flush");
    // 等"回收已发生"—— 这一次是**正面**事件，改轮询 + 秒级上界（这正是本票的主诉形状：
    // 该档实测回收 min78/p50 93/max97ms，对旧的 80ms 固定预算最坏余量只剩 3ms）。
    await waitUntil(() => !h.core.active(agent).includes(id), {
      timeoutMs: 5_000,
      describeObserved: () => `active(agent) = ${JSON.stringify(h.core.active(agent))}`
        + `（期望不含 ${id}；本档 settleQuietMs=60，实测回收 min78/p50 93/max97ms）`,
    });
  });

  it("rejects a non-boolean autoClose loudly", async () => {
    const h = bootFast();
    await expect(
      h.tool("pty_open").execute({ command: "x", autoClose: "yes" } as never, { agent }),
    ).rejects.toThrow(/autoClose/);
  });
});

// #67 regression pin: on win32 the spawn is DIRECT (parseCommandLine argv[0],
// #61 semantic), so a composed command starting with a bare `ssh` (no .exe)
// dies in ConPTY CreateProcess with `File not found`. defaultSpawnPty must
// route argv[0] through the executable resolver before the spawn.
describe("defaultSpawnPty argv[0] resolution (#67)", () => {
  it("resolves the argv[0] through resolveExecutable before spawning (win32)", async () => {
    const spawned: string[] = [];
    defaultSpawnPty(
      { command: "ssh -tt -o ServerAliveInterval=15 example.com", cwd: undefined, env: undefined },
      {
        platform: "win32",
        resolveExecutable: (name: string) => `${name}.exe`,
        spawn: ((argv0: string) => {
          spawned.push(argv0);
          return fakePty(1).pty;
        }) as never,
      },
    );
    // ConPTY needs the extension: argv[0] must end in .exe.
    expect(spawned[0]).toMatch(/\.exe$/);
    expect(spawned[0]).toBe("ssh.exe");
  });

  it("keeps the POSIX /bin/sh -c wrapper untouched", async () => {
    const calls: string[][] = [];
    defaultSpawnPty(
      { command: "ssh -tt example.com", cwd: undefined, env: undefined },
      {
        platform: "linux",
        spawn: ((argv0: string, args: string[]) => {
          calls.push([argv0, ...args]);
          return fakePty(1).pty;
        }) as never,
      },
    );
    expect(calls[0]![0]).toBe("/bin/sh");
    expect(calls[0]![1]).toBe("-c");
  });
});

// #146 AC3: the raw ConPTY failure is `File not found: ` — the program it tried
// is NOT in the message, so an agent writing a shell built-in (`echo`) or `&&`
// learns nothing. The wrapper must name argv[0] and teach the fix. Its own
// describe: these cases are about the FAILURE face, not argv[0] resolution.
describe("defaultSpawnPty spawn diagnostics (#146 AC3)", () => {
  it("names argv[0] and the explicit-shell hint when the win32 spawn fails (#146 AC3)", () => {
    let thrown: unknown;
    try {
      defaultSpawnPty(
        { command: "echo hi && echo bye" },
        {
          platform: "win32",
          resolveExecutable: (name: string) => name,
          spawn: (() => {
            // The exact ConPTY failure shape from the ticket.
            throw new Error("File not found: ");
          }) as never,
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('could not start "echo"');
    // The original reading survives (it is the machine's own words)…
    expect(message).toContain("File not found");
    // …and the hint is the SAME authored text the tool description draws its
    // spellings from (no second copy in the test: it asserts the constant).
    expect(message).toContain(SPAWN_FAILURE_HINT);
    expect(SPAWN_FAILURE_HINT).toContain("cmd.exe /d /c");
    expect(SPAWN_FAILURE_HINT).toContain("bash -lc");
    expect((thrown as { code?: string }).code).toBe("SPAWN_FAILED");
  });

  it("shows the resolved path when argv[0] was rewritten by resolveExecutable (#146 AC3)", () => {
    let thrown: unknown;
    try {
      defaultSpawnPty(
        { command: "ssh example.com" },
        {
          platform: "win32",
          resolveExecutable: () => "C:\\tools\\ssh.exe",
          spawn: (() => {
            throw new Error("File not found: ");
          }) as never,
        },
      );
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('could not start "ssh"');
    // The rewritten path is named too — otherwise a PATH problem is invisible.
    expect(message).toContain('resolved to "C:\\\\tools\\\\ssh.exe"');
  });
});

// ---------------------------------------------------------------------------
// #119 — the structured listing and the signal surface
// ---------------------------------------------------------------------------

/**
 * 为什么这一档直接 `createSessionCore` 而不是走 `bootPlugin`：`pty_list` /
 * `pty_signal` 的**平台分支**（POSIX 真投递 vs Windows 只有终止）与**投递缝**
 * （`procKill` / `platform`）都挂在 `SessionCoreDeps` 上；`bootPlugin` 只转发
 * spawner，测不到另一半。工具面的接线由 `pty-session.spec.ts` 那档覆盖。
 */
function signalCore(opts: { platform?: NodeJS.Platform; procKill?: (pid: number, signal: string) => void; config?: Partial<SessionCoreConfig> } = {}) {
  const handles: FakePtyHandle[] = [];
  /** 投递读数：`[pid, signal]`，pid 为**负数**时就是进程组投递。 */
  const kills: Array<[number, string]> = [];
  const core = createSessionCore(
    { ...FAST, ...(opts.config ?? {}) },
    {
      spawnPty: (spec: CoreSpawnSpec) => {
        const handle = fakePty(7000 + handles.length);
        handles.push(handle);
        return handle.pty;
      },
      platform: opts.platform ?? "linux",
      procKill: opts.procKill ?? ((pid, signal) => { kills.push([pid, signal]) }),
    },
  );
  return { core, handles, kills };
}

/** 取一个抛错的 `code`（本仓的 loud-error 判据形态）；没抛就是 undefined。 */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("pty_list (#119)", () => {
  it("lists only the caller's own sessions; empty for an owner holding none; rows carry id/status/pid", async () => {
    const { core } = signalCore();
    const other = { name: "b" };
    expect(core.list(agent)).toEqual([]);
    expect(core.list(other)).toEqual([]);
    const one = await core.open(agent, { command: "one" });
    const foreign = await core.open(other, { command: "two" });
    expect(core.list(agent).map((row) => row.id)).toEqual([one.sessionId]);
    expect(core.list(other).map((row) => row.id)).toEqual([foreign.sessionId]);
    expect(core.list(agent)[0]).toEqual({
      id: one.sessionId,
      status: { kind: "running" },
      pid: 7000,
    });
  });

  it("order is creation order by the NUMERIC id suffix (lexicographic would flip at the 10th open)", async () => {
    const { core } = signalCore({ config: { maxSessions: 12 } });
    const opened: string[] = [];
    for (let i = 1; i <= 11; i += 1) opened.push((await core.open(agent, { command: `s${i}` })).sessionId);
    const listed = core.list(agent).map((row) => row.id);
    expect(listed).toEqual(opened);
    // 反证：字典序会把 pty-10 / pty-11 排到 pty-2 前面 —— 那正是要钉住的失效形态。
    expect([...opened].sort()).not.toEqual(opened);
  });

  it("an exited-but-unclosed session stays listed with its exit code (persistent default)", async () => {
    const { core, handles } = signalCore();
    const opened = await core.open(agent, { command: "persist" });
    handles[0].emitExit({ exitCode: 3 });
    expect(core.list(agent)).toEqual([{ id: opened.sessionId, status: { kind: "exited", exitCode: 3 }, pid: 7000 }]);
  });
});

describe("pty_signal (#119)", () => {
  it("accepts exactly the whitelist and refuses anything else loudly", async () => {
    const { core, kills } = signalCore();
    const opened = await core.open(agent, { command: "run" });
    expect(codeOf(() => core.signal(agent, opened.sessionId, "SIGUSR1"))).toBe("SIGNAL_INVALID");
    expect(codeOf(() => core.signal(agent, opened.sessionId, "sigint"))).toBe("SIGNAL_INVALID");
    expect(codeOf(() => core.signal(agent, opened.sessionId, ""))).toBe("SIGNAL_INVALID");
    expect(kills).toEqual([]);
    // 白名单本身是单源常量：逐个都能进到投递面。
    for (const signal of PTY_SIGNALS) {
      expect(core.signal(agent, opened.sessionId, signal)).toMatchObject({ signal, delivered: true });
    }
    expect(kills.map(([, signal]) => signal)).toEqual([...PTY_SIGNALS]);
  });

  it("(POSIX) delivers to the session's process GROUP with a real signal — not node-pty's one-shot kill", async () => {
    const { core, handles, kills } = signalCore({ platform: "linux" });
    const opened = await core.open(agent, { command: "run" });
    const result = core.signal(agent, opened.sessionId, "SIGINT");
    expect(kills).toEqual([[-7000, "SIGINT"]]);
    expect(result).toEqual({
      id: opened.sessionId,
      signal: "SIGINT",
      delivered: true,
      semantics: "signal",
      status: { kind: "running" },
    });
    // #119 的取舍依据（核到 node-pty 源码，摘录见 `.scratch/t119-pty-kill-fact.log`）：
    // `UnixTerminal.kill(signal)` 只是 `process.kill(this.pid, signal || 'SIGHUP')`，
    // 外面套 `catch (e) { /* swallow */ }` —— 单 pid、且把投递失败整个吞掉 ⇒ 既够不着
    // 会话的进程组，也报不出 SIGNAL_FAILED。故 POSIX 走我们自己的 process.kill，
    // pty 的内部状态一概不碰（`killed` 只在 win32 分支与 pty_close 上出现）。
    expect(handles[0].killed).toBe(0);
  });

  it("(POSIX) reports a delivery failure loudly instead of pretending success", async () => {
    const { core } = signalCore({
      platform: "linux",
      procKill: () => { throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); },
    });
    const opened = await core.open(agent, { command: "run" });
    expect(codeOf(() => core.signal(agent, opened.sessionId, "SIGTERM"))).toBe("SIGNAL_FAILED");
  });

  it("(Windows/ConPTY) only SIGTERM/SIGKILL are accepted, and both mean TERMINATE", async () => {
    const { core, handles, kills } = signalCore({ platform: "win32" });
    const opened = await core.open(agent, { command: "run" });
    // 不可投递的三项：响亮报缺，绝不静默映射成 kill。
    for (const signal of ["SIGINT", "SIGTSTP", "SIGHUP"]) {
      expect(codeOf(() => core.signal(agent, opened.sessionId, signal))).toBe("SIGNAL_UNSUPPORTED");
    }
    expect(handles[0].killed).toBe(0);
    expect(kills).toEqual([]);
    // 可投递的两项 = 终止语义（ConPTY 唯一能做到的）。
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      expect(core.signal(agent, opened.sessionId, signal)).toMatchObject({ signal, delivered: true, semantics: "terminate" });
    }
    expect(handles[0].killed).toBe(2);
  });

  it("refuses SIGKILL for shell targets on both platforms (killing a shell cannot reclaim its children)", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const { core, handles, kills } = signalCore({ platform });
      const shell = await core.open(agent, { command: "bash -l", shell: true });
      expect(codeOf(() => core.signal(agent, shell.sessionId, "SIGKILL"))).toBe("SIGNAL_FORBIDDEN");
      expect(handles[0].killed).toBe(0);
      expect(kills).toEqual([]);
      // 同一个会话的其他信号照旧（拒绝的是 SIGKILL，不是 shell 本身）。
      expect(core.signal(agent, shell.sessionId, "SIGTERM")).toMatchObject({ delivered: true });
      // 非 shell 目标的 SIGKILL 正常放行（pty_open 的会话不自称 shell）。
      const plain = await core.open(agent, { command: "node server.js" });
      expect(core.signal(agent, plain.sessionId, "SIGKILL")).toMatchObject({ delivered: true });
    }
  });

  it("an exited session reports delivered:false (nothing left to signal) and delivers nothing", async () => {
    const { core, handles, kills } = signalCore();
    const opened = await core.open(agent, { command: "run" });
    handles[0].emitExit({ exitCode: 0 });
    const result = core.signal(agent, opened.sessionId, "SIGINT");
    expect(result).toEqual({
      id: opened.sessionId,
      signal: "SIGINT",
      delivered: false,
      status: { kind: "exited", exitCode: 0 },
    });
    expect("semantics" in result).toBe(false);
    expect(kills).toEqual([]);
  });

  it("owner boundary + invalid id: foreign is SESSION_OWNED, unknown is NO_SESSION", async () => {
    const { core } = signalCore();
    const opened = await core.open(agent, { command: "secret" });
    expect(codeOf(() => core.signal({ name: "b" }, opened.sessionId, "SIGINT"))).toBe("SESSION_OWNED");
    // 归属判据**先于**白名单：别人的 id 配一个非法信号名，仍然只报 SESSION_OWNED
    // （AC2 的姿态不得随调用方的其它参数变化 —— 复核发现 #1）。
    expect(codeOf(() => core.signal({ name: "b" }, opened.sessionId, "SIGUSR1"))).toBe("SESSION_OWNED");
    expect(codeOf(() => core.signal(agent, "nope", "SIGINT"))).toBe("NO_SESSION");
    // 自己的会话上，信号名才被校验（且先于已退出判据，见上一条用例）。
    expect(codeOf(() => core.signal(agent, opened.sessionId, "SIGUSR1"))).toBe("SIGNAL_INVALID");
  });
});

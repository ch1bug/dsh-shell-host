/**
 * #148 — dogfooding 档：真实例的 tool loop 真驱动一次 `pty_list` / `pty_signal`。
 *
 * 为什么这张票存在：#119 之后这两个工具只有「存在」证据，没有「能用」证据 ——
 * 单元档直接调 `defineTool.execute`（绕开 registry 派发），machine 档走 core
 * 不走被服务的工具面，e2e-tarball 只数「42 tools declared」。本套件把两个工具
 * 塞进真实例的 mock-LLM tool loop（链挂具与 `e2e-tool-call-machine` 完全同源：
 * 官方安装 → 真实 boot → 真实 session → 真实工具执行），断言全部取自**实例回灌
 * mock 的请求字节**（`tool_result` 块），不是本地函数返回值。
 *
 * 场景（一条最小链，不引入新依赖）：
 *   1. `pty_open { command: <长驻无名进程> }`（autoClose 省略 → persistent）→ sessionId
 *   2. `pty_list {}` → 该 id 在列且 `status.kind === "running"`
 *   3. `pty_signal { id, signal: "SIGINT" }` —— 平台分支按实况：
 *      win32：响亮拒绝，tool_result 是错误原文（会话仍 running，第 4 步 pty_list 复核）；
 *      POSIX：真投递（`delivered: true` / `semantics: "signal"`），第 4 步 `pty_tail`
 *      看到 trap 输出。另一分支 **loud skip**（`!! SKIP (loud)` 口径），不假装等价。
 *   4. `pty_close { id }` → `{ closed: true }`，随后 `pty_list` 不再有它（close 即回收）。
 *
 * 平台命令语义（src/pty/session-core.ts `PTY_COMMAND_SEMANTICS`）：win32 上命令行
 * 按 OS argv 规则直接 spawn（`ping` 解析到 ping.exe，无 shell）；POSIX 上命令在
 * `/bin/sh -c` 下跑（真 shell 语义，trap 才有意义）。
 *
 * AC3（失败可定位）：每一步的实例侧返回原文都进了断言消息 —— 一步红，红的就是
 * 实例自己的错误原文，不是「断言失败」四个字。
 *
 * 会话边界事实（#119 实测，TESTING.md 有口径）：**已经跑着的 DSH 会话不会获得
 * 新工具** —— dogfooding 新工具必须重装 bundle + 起新会话。本套件每次都是全新
 * 安装 + 全新实例，天然满足；手工 dogfooding 时别拿老会话重试。
 *
 * POSIX 投递语义的容器级判据（真进程组、`/proc` 读数）住在
 * `scripts/posix-signal-lane.mjs`（#144），本套件只按本平台实况断言工具面。
 *
 * @module tests/e2e-pty-loop-machine
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MY_ROWS,
  exchangeToken,
  rpc,
  startInstance,
  startMockLlm,
  stopChild,
  toolResultsOf,
  type MockToolStep,
} from "./helpers/e2e-chain.ts";
import { PLUGIN_DIR, installPlugin, missingEnvironment } from "./helpers/e2e-install.ts";

const PROFILE = "dsh-host-pty-loop";
const IS_WIN = process.platform === "win32";

const absent = missingEnvironment();
/** Named in every skip so the report says WHY nothing ran. */
const skipReason =
  `e2e dogfooding tier needs: ${absent.join(" / ")} — ` +
  `override with DSH_E2E_PLUGIN_DIR / DSH_E2E_HOST_DIR / DSH_E2E_NODE / DSH_E2E_PNPM_DIR`;

// Collection-time loud skip, same spelling as the sibling tiers: when the gate
// trips, vitest 4 never runs a file-scope `afterAll`, so this print is the only
// place the reason can reach the report.
if (absent.length > 0) {
  console.warn(`  !! SKIP (loud) — ${skipReason}`);
}

/** 长驻无名进程（不是 shellCommand，不出 shell 声明面）：
 *  win32 —— `ping -n 30 127.0.0.1`（约 29s，argv 直接 spawn）；
 *  POSIX —— trap SIGINT 后回显标记再继续空转（`/bin/sh -c` 下的真 shell 语义）。 */
const LONG_RUN_COMMAND = IS_WIN
  ? "ping -n 30 127.0.0.1"
  : "trap 'echo TRAPPED-INT' INT; while :; do sleep 1; done";

const TRAP_MARKER = "TRAPPED-INT";

/** 从实例回灌的 tool_result 文本里取 pty_open 给出的会话 id。 */
const sessionIdFrom = (texts: readonly string[]): string => {
  for (const text of texts) {
    const match = /"sessionId"\s*:\s*"(pty-\d+)"/u.exec(text);
    if (match?.[1] !== undefined) return match[1];
  }
  return "";
};

/** 六步 tool loop：每一步的参数都从上一步的实例字节里读（id 不硬编码）。 */
const script: MockToolStep[] = [
  { name: "pty_open", input: () => ({ command: LONG_RUN_COMMAND }) },
  { name: "pty_list", input: () => ({}) },
  { name: "pty_signal", input: (results) => ({ id: sessionIdFrom(results), signal: "SIGINT" }) },
  IS_WIN
    ? { name: "pty_list", input: () => ({}) }
    : { name: "pty_tail", input: (results) => ({ id: sessionIdFrom(results) }) },
  { name: "pty_close", input: (results) => ({ id: sessionIdFrom(results) }) },
  { name: "pty_list", input: () => ({}) },
];

describe.skipIf(absent.length > 0)("e2e: 真实例 tool loop 驱动 pty_list / pty_signal（#148 dogfooding）", () => {
  const timeout = 240_000;

  it("drives pty_list and pty_signal through the real instance's tool loop", { timeout }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-shellhost-e2e-"));
    const dshHome = join(root, ".dsh");

    // 与兄弟档同一条官方安装链（docs/agents/profile-install.md）。
    const installed = await installPlugin(dshHome, PROFILE);
    expect(
      installed.code,
      `dsh plugin add succeeded (output: ${installed.out.slice(-500)})`,
    ).toBe(0);

    const mock = await startMockLlm(script);
    const inst = startInstance(PROFILE, dshHome, {
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.port}`,
      DEEPSEEK_API_KEY: "mock-key-nonempty",
    });
    let launchUrl: string;
    try {
      launchUrl = await inst.ready;
    } catch (error) {
      await mock.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }

    try {
      // 失败归因先于洁净度断言（#100 的顺序，兄弟档同款）。
      const stderr = inst.stderr();
      const blamed = MY_ROWS.filter((row) => new RegExp(`\\b${row}\\b`, "u").test(stderr));
      expect(blamed, "stderr never blames this bundle's loader rows").toEqual([]);
      expect(stderr, "instance stderr is clean").toBe("");

      const exchanged = await exchangeToken(launchUrl);
      const port = exchanged.port;
      expect(Number.isInteger(port) && port > 0, "instance bound a real port").toBe(true);
      expect(exchanged.status, "launch URL exchanges the token").toBe(303);
      const cookie = exchanged.cookie;
      expect(cookie, "exchange issues an auth cookie").toBeTruthy();

      const created = await rpc(port, cookie, "session/create", { cwd: PLUGIN_DIR });
      const createdValue = (JSON.parse(created.text) as any)?.result?.value;
      expect(createdValue?.sessionId, "session/create returns a sessionId").toBeTruthy();

      await rpc(port, cookie, "session/prompt", {
        requestId: `e2e-pty-loop-${Date.now()}`,
        sessionId: createdValue.sessionId,
        mode: "queue",
        content: [{ type: "text", text: "Drive the pty tools step by step." }],
      });

      // 六步脚本 + 收尾的 done 文本轮。
      const totalTurns = script.length + 1;
      const deadline = Date.now() + 120_000;
      while (mock.agentTurns() < totalTurns && Date.now() < deadline) {
        await new Promise((r) => { setTimeout(r, 500); });
      }

      // ── AC1：两个工具真的被实例的 tool loop 调用并执行 ─────────────────────
      const agentReqs = mock.agentRequests();
      expect(agentReqs.length, "the instance issued the scripted agent turns").toBeGreaterThanOrEqual(totalTurns);
      const declared = Array.isArray(agentReqs[0]?.body.tools) ? agentReqs[0]!.body.tools : [];
      const names = declared.map((t: any) => t?.name ?? t?.function?.name).filter(Boolean) as string[];
      // 工具面断言的正确写法（TESTING.md）：读实例真实请求体里的 tools 数组。
      expect(names, "pty_list is in the instance's tool surface").toContain("pty_list");
      expect(names, "pty_signal is in the instance's tool surface").toContain("pty_signal");

      // 按脚本发的 tool_use id 收回每一步的 tool_result（实例自己的字节）。
      const byId = new Map<string, { isError?: boolean; text: string }>();
      for (const req of agentReqs) {
        for (const result of toolResultsOf(req.body)) {
          if (!byId.has(result.toolUseId)) byId.set(result.toolUseId, result);
        }
      }
      const stepResult = (n: number, label: string): { isError?: boolean; text: string } => {
        const id = `toolu_e2e_s${String(n)}`;
        const found = byId.get(id);
        expect(
          found,
          `${label}（第 ${String(n)} 步）的 tool_result 不在实例回灌的字节里 —— ` +
            `实例只回了：${[...byId.keys()].join(", ") || "（无）"}`,
        ).toBeTruthy();
        return found!;
      };
      /** AC3：一步的返回不是工具输出 JSON 时，红的就是实例侧错误原文。
       *  线型事实（#148 实测）：只有 `jsonRender` 的工具（pty_open / pty_signal /
       *  pty_close）回 JSON 文本；pty_list / pty_tail 回各自 `output.render` 的
       *  行文本 —— 所以 pty_list / pty_tail 的断言走行文本，不走 JSON.parse。 */
      const parseStep = (n: number, label: string): any => {
        const result = stepResult(n, label);
        try {
          return JSON.parse(result.text) as any;
        } catch {
          throw new Error(`${label} 的实例侧返回不是工具输出 JSON —— 实例原文：\n${result.text}`);
        }
      };

      // ── 第 1 步 pty_open：拿到实例开出的会话 id ────────────────────────────
      const openResult = stepResult(1, "pty_open");
      const sessionId = sessionIdFrom([openResult.text]);
      expect(
        sessionId,
        `pty_open 的实例返回必须给出 pty-<n> 形态的 sessionId —— 实例原文：\n${openResult.text}`,
      ).toMatch(/^pty-\d+$/u);

      // ── 第 2 步 pty_list：该 id 在列且 status.kind === "running" ────────────
      // pty_list 的 tool_result 文本是它的渲染行：`<id>  <status.kind>[  pid=…]`。
      const listText = stepResult(2, "pty_list(开列)").text;
      expect(
        listText,
        `pty_list 输出里找不到刚开的会话 ${sessionId} 的 running 行 —— 实例原文：\n${listText}`,
      ).toMatch(new RegExp(`(?:^|\\n)${sessionId}  running(?:  |\\n|$)`, "u"));

      // ── 第 3 步 pty_signal(SIGINT)：平台分支按实况，另一分支 loud skip ─────
      const signalResult = stepResult(3, "pty_signal(SIGINT)");
      if (IS_WIN) {
        console.warn(
          "  !! SKIP (loud) — pty_signal 的 POSIX 投递分支（真投递 + pty_tail 见 trap 输出）在 win32 " +
            "不成立，本平台按实况断言拒绝分支；POSIX 语义的容器级判据见 scripts/posix-signal-lane.mjs（#144）",
        );
        // node-pty/ConPTY 只暴露终止（src/pty/session-core.ts 的 SIGNAL_UNSUPPORTED 分支）。
        expect(
          signalResult.isError,
          `win32 上 SIGINT 必须被响亮拒绝（is_error）—— 实例原文：\n${signalResult.text}`,
        ).toBe(true);
        expect(
          signalResult.text,
          `拒绝必须带 ConPTY 语义的错误原文 —— 实例原文：\n${signalResult.text}`,
        ).toContain("cannot be delivered on Windows/ConPTY");
        // 第 4 步 pty_list 复核：拒绝 ≠ 送达，会话仍 running（渲染行同上）。
        const refusalListText = stepResult(4, "pty_list(拒绝后)").text;
        expect(
          refusalListText,
          `SIGINT 被拒后会话必须仍在列且 running —— 实例原文：\n${refusalListText}`,
        ).toMatch(new RegExp(`(?:^|\\n)${sessionId}  running(?:  |\\n|$)`, "u"));
      } else {
        console.warn(
          "  !! SKIP (loud) — pty_signal 的 win32 拒绝分支（SIGNAL_UNSUPPORTED）只在 win32 成立，" +
            "本平台按实况断言 POSIX 投递分支",
        );
        expect(
          signalResult.isError,
          `POSIX 上 SIGINT 必须真投递（不得是错误）—— 实例原文：\n${signalResult.text}`,
        ).toBe(undefined);
        const delivered = parseStep(3, "pty_signal(SIGINT)");
        expect(
          delivered.delivered,
          `pty_signal 必须报告 delivered —— 实例原文：\n${stepResult(3, "pty_signal(SIGINT)").text}`,
        ).toBe(true);
        expect(
          delivered.semantics,
          `POSIX 投递的 semantics 必须是 signal（真信号，不是 terminate）—— 实例原文：\n${stepResult(3, "pty_signal(SIGINT)").text}`,
        ).toBe("signal");
        // 第 4 步 pty_tail：trap 的输出必须到达（pty_tail 回渲染文本，
        // 无新输出时是 `(no new output)` —— 那也算原文可读的红）。
        const tailText = stepResult(4, "pty_tail(投递后)").text;
        expect(
          tailText,
          `pty_tail 必须看到 trap 输出（${TRAP_MARKER}）—— 实例原文：\n${tailText}`,
        ).toContain(TRAP_MARKER);
      }

      // ── 第 5 步 pty_close：clean 关闭 ──────────────────────────────────────
      const closed = parseStep(5, "pty_close");
      expect(
        closed.closed,
        `pty_close 必须真关闭（closed: true）—— 实例原文：\n${stepResult(5, "pty_close").text}`,
      ).toBe(true);

      // ── 第 6 步 pty_list：persistent-session 契约，close 即回收 ─────────────
      // 会话被回收后渲染行是 `(no sessions)`，至少不再有该 id 的行。
      const finalListText = stepResult(6, "pty_list(关闭后)").text;
      expect(
        finalListText,
        `关闭后 pty_list 不得再有 ${sessionId}（close 即回收）—— 实例原文：\n${finalListText}`,
      ).not.toMatch(new RegExp(`(?:^|\\n)${sessionId}(?:  |\\n|$)`, "u"));
    } finally {
      // 与兄弟档同一套收尾：先停实例再关 mock（杀进 agent loop 会留 libuv 噪声）。
      await stopChild(inst.child);
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

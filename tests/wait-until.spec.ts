/**
 * `tests/helpers/wait-until.ts` 的离线单测（#124）。
 *
 * 这个 helper 是 `#64` 用例**时序判据**的载体，故它自己必须被钉住 —— 否则
 * "改成轮询到条件成立"只是说法。三条判据对应 brief 的 AC：
 *
 *   - **轮询到条件成立**：条件在一次探针后为真 ⇒ 成功返回；且**先探一次**
 *     （已经为真时不为一个真判据白等一轮）。
 *   - **秒级上界 + 超时响亮失败**：条件恒假 ⇒ **抛错**（绝不静默 return/skip），
 *     消息含**上界**、**实际等待时长**与调用方报告的**实测状态**。
 *   - **条件成立即返回，不耗满上界**：早成立时实际耗时 ≈ 成立时点，远小于上界。
 *
 * 全离线：不 spawn、不跑真 PTY、不碰权威树；探针都是本地的纯计数/Bool。
 *
 * ⚠️ 为什么这些必须**在仓内**（而不只是在 `.scratch/` 的临时探针里）：`.scratch/`
 * 已 gitignore、不在收集面，复跑不可得；Testings 纪律要求判据的验证手段自身可复现
 * （对照 `tests/lib-snapshot.spec.ts` 对同类 helper 的待遇）。
 *
 * @module tests/wait-until.spec.ts
 */

import { describe, expect, it } from "vitest";
import { waitUntil } from "./helpers/wait-until.ts";

describe("waitUntil：轮询到条件成立（#124）", () => {
  it("条件在若干轮后为真 ⇒ 成功返回", async () => {
    let calls = 0;
    await waitUntil(() => {
      calls++;
      return calls >= 3;
    }, { timeoutMs: 2_000, pollMs: 5 });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("THE POINT：已经为真时**先探一次**，不白等一轮", async () => {
    const started = Date.now();
    let calls = 0;
    await waitUntil(() => (calls++, true), { timeoutMs: 5_000, pollMs: 1_000 });
    const elapsed = Date.now() - started;
    // 若没有"先探一次"，这里会先 sleep pollMs(1000ms) 才判 —— 故必须远小于它。
    expect(elapsed).toBeLessThan(200);
    expect(calls).toBe(1);
  });

  it("异步探针同样成立", async () => {
    let calls = 0;
    await waitUntil(async () => (calls++, calls >= 2), { timeoutMs: 2_000, pollMs: 5 });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("THE POINT（brief AC：超时响亮失败）：条件恒假 ⇒ 抛错，且带实测状态", async () => {
    const started = Date.now();
    let thrown: unknown = null;
    try {
      await waitUntil(() => false, {
        timeoutMs: 80,
        pollMs: 10,
        describeObserved: () => "MARKER: active = ['pty-1']; killed=0",
      });
    } catch (e) {
      thrown = e;
    }
    const elapsed = Date.now() - started;
    // 绝不静默：必须是**抛错**，不是 return / skip。
    expect(thrown).toBeInstanceOf(Error);
    const msg = String((thrown as Error).message);
    // 三条信息都要在：上界、实际等待时长、调用方的实测状态。
    expect(msg).toContain("80ms");
    expect(msg).toContain("实际等了");
    expect(msg).toContain("MARKER: active = ['pty-1']; killed=0");
    // 确实等满了上界（不是提前放弃）。
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it("没有 describeObserved 时仍抛错（诊断是可选增强，不是放行条件）", async () => {
    await expect(waitUntil(() => false, { timeoutMs: 40, pollMs: 10 }))
      .rejects.toThrow(/未成立/);
  });

  it("早成立时**不耗满上界**：实际耗时 ≈ 成立时点", async () => {
    const started = Date.now();
    const deadline = started + 60;
    await waitUntil(() => Date.now() >= deadline, { timeoutMs: 5_000, pollMs: 5 });
    const elapsed = Date.now() - started;
    // 上界 5000ms，但条件 60ms 就成立 ⇒ 必须远小于上界（证明不是"等满再看"）。
    expect(elapsed).toBeLessThan(1_000);
    expect(elapsed).toBeGreaterThanOrEqual(55);
  });
});
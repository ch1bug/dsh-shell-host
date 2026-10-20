/**
 * `waitUntil`：**轮询到一个条件成立**，带上界与**响亮失败**（#124）。
 *
 * ## 为什么单独成模块
 *
 * 本仓此前有两处"等到条件成立"的手写轮询：
 * {@link ./lib-snapshot.ts} 的 `waitForTreeReady*`（等**文件指针**就位，**已导出**、可复用）
 * 与 `tests/terminal-machine.spec.ts:58` 的 `waitFor`（等 **pty_tail 文本**出现；
 * **未 `export`、是那个 spec 文件内部的私有函数**，仓内别处 import 不到）。
 * 两者都把"探什么"写死在函数体里，换一个被测面就得再抄一遍循环。
 *
 * `#124` 的现场是这种抄写的最新一次：`pty-session` 的 `#64` 用例要等的是
 * **`pty().active()` 不再含某个 sessionId** —— 既不是文件指针，也不是 pty 文本。
 * 与其在 spec 里再写一遍 `while (Date.now() < deadline)`，这里提供一份
 * **只把"探什么"交给调用方**的极小挂具：探针是一个返回 `boolean` 的同步函数
 * （或任意 `Promise<boolean>`），其余（上界、轮询间隔、失败文案）统一。
 *
 * ⚠️ **本挂具没有、也不打算一次消灭仓内全部轮询**（诚实边界）：`#124` 只改 `#64` 一处
 * （brief 的 Out of scope 明写"不顺手给别的用例做同类改造"）。仓内**仍有**几处手写
 * `while (Date.now() < deadline)`：`tests/terminal-machine.spec.ts:61`、
 * `tests/ssh-pty-live.spec.ts:139`、`tests/e2e-real-llm-machine.spec.ts:473`、
 * `tests/e2e-tarball-machine.spec.ts:268`、`tests/e2e-tool-call-machine.spec.ts:162`
 * （后四处是真实层 e2e，判据各不相同），以及 `./lib-snapshot.ts` 的两处
 * （判据是文件指针，已导出、可复用）。**把这些改造成本挂具是另一个面** ——
 * 若要做，另立票（本仓纪律：队列外一律 TICKET EXIT）。
 *
 * ## 失败行为：响亮，绝不静默（本仓证据纪律）
 *
 * 超时**必须**抛错，且错误里带上**调用方报告的实测状态**（`observed`）——
 * 只报"期望/实际"会让读的人分不清"条件没成立"与"探针写错了"。
 * **不要**把超时降级成 skip 或 `return false` 让调用方自己判：那正是把
 * "没等到"静默吞成绿的那条路（`#124` 的 brief 明写禁止）。
 *
 * 上界取值的依据（`#124`）：被测的 autoClose 回收走**静默窗口**，
 * 默认 `settleQuietMs=150` + `settleTickMs=25` 起步再加 `killSession` 开销，
 * 正常落在**百毫秒级**。上界取**秒级**（见调用方传的 `timeoutMs`）——
 * 远大于正常耗时，使高负载下的调度延迟不产生假红；而真缺陷（回收根本没发生）
 * 仍会被这个上界抓住并响亮失败。
 *
 * @module tests/helpers/wait-until
 */

/** 轮询选项。 */
export interface WaitUntilOptions {
  /** 等待上界（毫秒）。超时**抛错**，绝不静默。 */
  timeoutMs: number;
  /** 轮询间隔（毫秒）。默认 10 ms：回收量级在百毫秒，细一点让早成立时收得快。 */
  pollMs?: number;
  /**
   * 超时失败时附在错误里的**实测状态**。**惰性构造**（一个返回 `string` 的**函数**，
   * 不是已算好的字符串）——因为在正常路径上它一次都不会被调用，无需每次轮询都算一遍
   * 诊断快照。调用方可在这里读当时的现场（例如"那个 id 还在不在 `active()` 里"）。
   */
  describeObserved?: () => string;
}

/**
 * 轮询 `probe` 直到它返回 `true`（或超过 `timeoutMs` ⇒ **抛错**）。
 *
 * 探针**先探一次再等**：条件已成立时立即返回，不为一个已经为真的判据白等一轮 ——
 * 这同时让"在非常快的机器上"与"在很慢的机器上"走同一条正确性路径。
 *
 * @param probe 判据：返回 `true` 即条件成立。可以是异步的。
 * @param options 见 {@link WaitUntilOptions}
 * @throws 超时时抛 `Error`，消息含**上界**、**实际等待时长**与 `describeObserved()` 的实测状态。
 */
export async function waitUntil(
  probe: () => boolean | Promise<boolean>,
  { timeoutMs, pollMs = 10, describeObserved }: WaitUntilOptions,
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  // 先探一次：条件已成立就不等（也避免把"已经为真"报成需要等待）。
  if (await probe()) return;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await probe()) return;
  }
  const elapsedMs = Date.now() - startedAt;
  const detail = describeObserved ? `；实测状态：${describeObserved()}` : '';
  throw new Error(
    `waitUntil: 条件在 ${timeoutMs}ms 内未成立（实际等了 ${elapsedMs}ms）${detail}`,
  );
}

/**
 * 证明 `pending` 在 `windowMs` 内**没有**完成（#146）：{@link waitUntil} 的镜像。
 *
 * 什么时候用它：判据是「**还在跑**」而不是「跑完了」。`waitUntil` 在这里会**真空通过** ——
 * "尚未发生"没有可轮询的成立条件，一个"立刻返回"的坏实现也能让"条件成立"的探针绿。
 *
 * ⚠️ 窗口必须**大于被测实现自己的静默窗/上界**，否则旧形状（提前返回）也能通过。
 * 调用方在注释里写明所对的窗口：#146 用 120ms 对 FAST 的 20ms、400ms 对 harness 的 150ms。
 *
 * @throws `pending` 在窗口内完成（判据为假）或 reject（拒绝永远不算"仍在等待"）。
 */
export async function stillPending<T>(
  pending: Promise<T>,
  { windowMs, what }: { windowMs: number; what: string },
): Promise<void> {
  const STILL_PENDING = Symbol('still-pending');
  const raced = await Promise.race([
    pending as Promise<unknown>,
    new Promise((resolve) => { setTimeout(() => resolve(STILL_PENDING), windowMs); }),
  ]);
  if (raced !== STILL_PENDING) {
    throw new Error(`stillPending: ${what} 在 ${windowMs}ms 内就完成了（期望它此刻仍在等待）`);
  }
}
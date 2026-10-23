/**
 * `lib/` **读者**的并发前置门槛（#123）。
 *
 * ## 为什么需要它（本票实测的根因）
 *
 * `tests/clean-lib.spec.ts` 会**真跑 `node --run build` 两次**，每次先 `clean-lib.mjs` 删掉
 * `lib/` 的四个入口目录与顶层 chunk，再由 tsc/tsdown 重建 —— 即**写 `lib/`**。而本仓另有若干
 * **读者**（`tests/verify-pack.spec.ts` 的副本 fixture `cpSync` 整棵 `lib/`、
 * `tests/built-artifact.spec.ts` 直接 import `lib/pty/index.js`）。写者与读者同池并发时，
 * 读者会读到**窗口内的半棵树**，表现为间歇红。
 *
 * ## 为什么"轮询等指针就位"不够（本票钉死的关键点）
 *
 * #90/#118 的旧门禁是**轮询 `existsSync`，等到齐就跑**。那是 **check-then-use 竞态**，
 * 不是"等窗口关闭"：
 *
 * 1. 门禁探到 `lib/pty/index.js` **在**（窗口尚未打开）⇒ 返回；
 * 2. 写者随后删掉它（窗口打开）；
 * 3. `main()` 的判据 1/1b 读到缺失 ⇒ 早退 `return 1` ⇒ 断言"必须走到 loud-skip"红。
 *
 * 门禁只是把窗口**变窄**，没有消除它。实测证据（本票）：单档重复 5 次，1 次落在窗口里，
 * 报缺失的恰是三个入口目录（`./lib/pty/index.js` / `./lib/wsl-plugin/index.js`），
 * 而**门禁本身没有报未就位** —— 正是"看见了又被删"的现场。
 *
 * ## 修法：读者只消费**冻结快照**，不消费活动树
 *
 * 与"等窗口"相反：读者把 `lib/` 快照进自己的临时目录（**只读复制，绝不改权威树**），
 * 之后一切断言针对快照。快照前用 {@link waitForTreeReady} 等一次稳定读数，
 * 且快照与**完整性校验**成对（复制完再核一遍件数/关键件），复制到半棵树就**响亮失败**，
 * 不静默继续。
 *
 * 这是**真免疫**而不是"窗口更窄"：窗口在快照完成那一刻就对读者永久关闭 ——
 * 写者之后再删活动树，快照已经与它无关。
 *
 * ⚠️ **它不负责**让写者停下来、也不负责改车道调度（那是 `vitest.config.ts` 的活，
 * 见本仓 `writers` 车道）。两道防线各挡一半：车道挡**内部**写者，快照挡**外部** build
 * （例如人手在另一个会话里跑 `node --run test:release`）。
 *
 * @module tests/helpers/lib-snapshot
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 门槛选项（两个 `waitForTreeReady*` 共用一份形状 —— 复核指出它们是同一组 Data Clumps）。
 *
 * - `timeoutMs`：等待上界（**等不到就返回缺失清单**，绝不降级 skip）
 * - `pollMs`：轮询间隔
 * - `absentRounds`：连续这么多轮"**一件都没出现**"就提前收手（见 `waitForTreeReadyBriefly`）
 */
export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  absentRounds?: number;
}

/** 探针 + 稳定读数：**单一来源**（复核指出两版曾各自写一遍同一段）。 */
function makeProbe(targets: readonly string[], resolve: (relative: string) => string) {
  const missing = (): string[] => targets.filter((target) => !existsSync(resolve(target)));
  return { missing, present: () => targets.length - missing().length };
}

/** 一次门槛等待的结果：仍缺失的指针 + **实际**等待时长。 */
export interface WaitOutcome {
  /** 仍缺失的指针（`[]` = 全部就位）。 */
  missing: string[];
  /** 实际等待了多少毫秒（早退时**小于** `timeoutMs` —— 这正是要如实报的那个数）。 */
  elapsedMs: number;
}

/**
 * 等一棵树的若干指针**同时**就位（一次稳定读数），最多等 `timeoutMs`。
 *
 * 判据是"**再过一轮仍然齐**"（连续两次探测都齐），而不是"第一次探到齐" —— 后者在写者
 * 恰好重建到一半时可能瞬时为真。这仍**不是**免疫（免疫靠调用方随后的快照），
 * 它只让"开始复制"这个动作大概率落在窗口之外，减少无谓的复制失败。
 *
 * @param targets 仓根相对的指针路径（`/` 分隔）
 * @param resolve 把仓根相对路径解成绝对路径（调用方自带 `repoRoot`）
 * @returns {@link WaitOutcome}：就位时 `missing` 为空；超时后带着仍缺失的指针
 *   （**调用方据此响亮失败**，绝不降级 skip）
 */
export async function waitForTreeReady(
  targets: readonly string[],
  resolve: (relative: string) => string,
  { timeoutMs = 60_000, pollMs = 250 }: WaitOptions = {},
): Promise<WaitOutcome> {
  const { missing } = makeProbe(targets, resolve);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let still = missing();
  while (still.length > 0 && Date.now() < deadline) {
    await delay(pollMs);
    still = missing();
  }
  if (still.length > 0) return { missing: still, elapsedMs: Date.now() - startedAt };
  // 稳定读数：再探一轮，要求仍然齐（挡住"恰好重建到一半"的瞬时为真）。
  await delay(pollMs);
  return { missing: missing(), elapsedMs: Date.now() - startedAt };
}

/**
 * {@link waitForTreeReady} 的**快路径**变体：先探一次，齐就直接返回；
 * 不齐时**最多**等 `timeoutMs`，但**连续 `absentRounds` 轮都没有任何一件出现**就提前收手。
 *
 * **为什么需要它**（#123 的一处成本回退）：`built-artifact.spec.ts` 在新检出上（从没构建过）
 * 本该立刻响亮跳过，用满上界会让它白等 60 s —— 而"等不到"与"等够了"给出的**结论一样**，
 * 只是给慢机器留余量。判据是"有没有出现**任何**动静"：全齐 → 立刻跑；
 * 一件都没出现且连续多轮如此 → 判定"根本没在建"，提前收手（仍返回缺失清单，
 * 调用方照旧**响亮**跳过，不静默）。
 *
 * ⚠️ 提前收手时 **`elapsedMs` 会明显小于 `timeoutMs`** —— 调用方报读数必须用它而不是上界
 * （见 {@link pointerMissReport} 的说明）。
 *
 * @param absentRounds 连续这么多轮"一件都没出现"就提前收手（默认 8 轮 ≈ 2 s @250ms）
 */
export async function waitForTreeReadyBriefly(
  targets: readonly string[],
  resolve: (relative: string) => string,
  { timeoutMs = 60_000, pollMs = 250, absentRounds = 8 }: WaitOptions = {},
): Promise<WaitOutcome> {
  const { missing, present } = makeProbe(targets, resolve);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  let still = missing();
  if (still.length === 0) {
    // 快路径：已经齐了。稳定读数仍要求再探一轮（挡住"恰好重建到一半"）。
    await delay(pollMs);
    return { missing: missing(), elapsedMs: Date.now() - startedAt };
  }
  // 不齐：看有没有"动静"。一件都没出现 ⇒ 大概率是"根本没在建"，别把上界耗满。
  let quietRounds = 0;
  while (Date.now() < deadline) {
    await delay(pollMs);
    still = missing();
    if (still.length === 0) {
      await delay(pollMs);
      return { missing: missing(), elapsedMs: Date.now() - startedAt };
    }
    quietRounds = present() === 0 ? quietRounds + 1 : 0;
    if (quietRounds >= absentRounds) break;
  }
  return { missing: still, elapsedMs: Date.now() - startedAt };
}

/** 一次冻结快照：临时副本的绝对路径 + 清理函数。 */
export interface LibSnapshot {
  /** 副本里的 `lib/` 绝对路径（读者一切断言针对它）。 */
  libDir: string;
  /** 副本根（`lib/` 的父目录，也是"副本仓库根"的家）。 */
  root: string;
  /** 删掉整棵副本根。调用方**必须**在 `finally` 里调它。 */
  dispose: () => void;
}

/**
 * 把权威树的 `lib/` **冻结**进一个临时目录，返回副本位置。
 *
 * **只读复制权威树，绝不改它** —— 写 `lib/` 是 `clean-lib` 的写域，读者抢它只会制造更坏的窗口。
 *
 * **完整性校验**（本票踩过的坑）：`cpSync` 落在写者窗口里时会复制到**半棵树**。故复制完立刻
 * 核一遍"入口目录与顶层 chunk 是否都在"，缺件时**响亮抛错**（不是静默返回半个快照 ——
 * 那会把"读者没验到"伪装成"读者验过了"）。
 *
 * @param repoRoot 权威仓根
 * @param required 快照**必须**含有的仓根相对路径（缺任一即抛错）
 * @param tag 临时目录标签（便于残留归因）
 */
export function snapshotLib(repoRoot: string, required: readonly string[], tag: string): LibSnapshot {
  const root = join(
    process.env.TEMP ?? process.env.TMPDIR ?? "/tmp",
    `dsh-lib-snapshot-${tag}-${String(process.pid)}`,
  );
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const libDir = join(root, "lib");
  cpSync(join(repoRoot, "lib"), libDir, { recursive: true });

  const absent = required.filter((relative) => !existsSync(join(root, relative.replace(/^\.\//u, ""))));
  if (absent.length > 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `lib/ 快照不完整（复制落进了写者的重建窗口）：缺 ${absent.join(", ")} —— ` +
        `读者必须消费完整快照，半棵树会把"没验到"伪装成"验过了"`,
    );
  }
  return { libDir, root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 真前提缺失时的**自报**文案：点名"判据 1/1b 指针缺失"，而不是让下游断言
 * 报成"没走到 loud-skip"（本票 AC2）。
 *
 * 为什么是一个函数而不是一句内联字符串：**三条** CLI 用例共用它（`verify-pack.spec.ts`
 * 的 #90 / #118 响亮面 / #117 面），写成三份迟早漂移成三种说法 —— 而"红时能一眼看出是哪条
 * 判据早退"正是本票要的读数。
 *
 * ⚠️ **`elapsedMs` 是"实际等了多久"，不是配置的上界**（#123 自查抓到的一处读数失真）：
 * 用 `waitForTreeReadyBriefly` 时，`absentRounds` 会让"一件都没出现"**提前收手**，
 * 此时真实等待可能只有 2 s 而配置上界是 60 s。旧文案写死上界，于是打印
 * "等构件 60000 ms 仍未就位" —— 而它其实 2.1 s 就收手了（实测：AC3 副本取证）。
 * 那正是本票要消灭的那类**读数与事实不符**，故上界与实测值**都**写进文案。
 *
 * @param missing 仍缺失的指针（仓根相对）
 * @param timeoutMs 配置的等待上界
 * @param elapsedMs 实际等待时长（省略时只写上界，保持旧调用点可用）
 */
export function pointerMissReport(
  missing: readonly string[],
  timeoutMs: number,
  elapsedMs?: number,
): string {
  const waited =
    elapsedMs === undefined
      ? `${String(timeoutMs)} ms（配置上界）`
      : `${String(elapsedMs)} ms（实际等待；配置上界 ${String(timeoutMs)} ms）`;
  return (
    `判据 1/1b（指针存在性）早退：${missing.join(", ")} 在 ${waited} 后仍未就位。` +
    `这不是"注入没接上"、也不是"没走到 loud skip"—— main() 在判据 1/1b 就 return 1 了，` +
    `根本没走到后面的分支。真缺件或并发重建窗口都可能，先看这两条指针是谁删的。`
  );
}

/**
 * 权威树里判据 1/1b 需要的入口文件，**仓根相对**（`clean-lib` 会删它们，故快照完整性必须核它们）。
 *
 * ⚠️ **它是仓根相对**（`lib/pty/index.js`），不是 `lib/` 相对（`pty/index.js`）——
 * 复核指出这与 `libLooksRebuilt(libDir)` 的入参语义**不同**，同一份常量两种用法是踩坑面。
 * 故这里把两者**分开命名**，让前缀差在调用点就看得见：
 *   - `snapshotLib(root, LIB_ENTRY_FILES, …)` —— 仓根相对（直接 `join(root, …)`）
 *   - `libLooksRebuilt(libDir)` —— 内部按 {@link LIB_ENTRY_FILES_WITHIN_LIB} 取值（`lib/` 相对）
 */
export const LIB_ENTRY_FILES = [
  "lib/pty/index.js",
  "lib/ssh/index.js",
  "lib/terminal/index.js",
  "lib/remote/index.js",
  "lib/remote-fs/index.js",
  "lib/wsl-plugin/index.js",
] as const;

/**
 * 同一组文件的 **`lib/` 相对**写法（`pty/index.js`）—— `libLooksRebuilt` 用这一份。
 *
 * 由 {@link LIB_ENTRY_FILES} **机械派生**（不是手写第二份清单）：两者不可能漂移，
 * 而"剥前缀"这个动作只发生在这里一次。
 */
export const LIB_ENTRY_FILES_WITHIN_LIB = LIB_ENTRY_FILES.map((relative) =>
  relative.replace(/^lib\//u, ""),
);

/**
 * `lib/` 目录是否像"重建完成"：六个入口文件都在。
 *
 * @param libDir **`lib/` 自己**的绝对路径（不是仓根）—— 入参语义与 {@link LIB_ENTRY_FILES}
 *   的仓根相对写法不同，见那里的说明。
 */
export function libLooksRebuilt(libDir: string): boolean {
  return LIB_ENTRY_FILES_WITHIN_LIB.every((withinLib) => {
    try {
      return statSync(join(libDir, withinLib)).isFile();
    } catch {
      return false;
    }
  });
}

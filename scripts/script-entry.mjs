/**
 * script-entry.mjs —— 本仓 CLI 脚本**共用的一份**「直接执行」守卫（`#85`）。
 *
 * 为什么存在：每个脚本末尾都要一句"只有**直接执行**才跑 CLI，被 spec import 时不跑"。
 * 字面路径比对（`resolve(argv1) === fileURLToPath(moduleUrl)`）在**符号链接**调用下必失配 ——
 * ESM 在加载主模块时会按 `realpath` 解析，`import.meta.url` 是**真实路径**，而 `process.argv[1]`
 * 是**链接路径**（Node 默认不开 `--preserve-symlinks-main`）。失配的后果是脚本
 * **静默什么都不做并 `exit 0`**：排批消费者把「没跑」读成「没有阻塞」，`privacy-scan.mjs`
 * （pre-commit 第 5 步）则把「守卫没跑」读成「干净」—— 本仓最忌的**静默假绿**。
 *
 * 本模块是**单一来源**：`frontier.mjs` / `privacy-scan.mjs` / `verify-all.mjs` /
 * `verify-pack.mjs` 全部从这里导入（此前四份里两份是错形状；守卫一旦分叉就会再次漂移）。
 * 判据本身是**纯函数**且有离线单测，见 `tests/script-entry.spec.ts`（含真符号链接与
 * 真子进程调用两条面）。
 *
 * @module scripts/script-entry
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 是否**直接执行**（而非被 import）——被 import 时不跑 CLI。
 *
 * 路径按 `realpath` 归一：符号链接 / junction / 正反斜杠等等价写法都算直接执行。
 *
 * 判不准时**一律判「非直接执行」**（fail closed）：
 *   - 路径不存在 / `moduleUrl` 不是 `file:` URL → `false`；
 *   - 反过来的默认值会让"import 本模块"的调用方误跑 CLI，比显式静默更糟。
 *
 * @param argv1     `process.argv[1]`（可以是绝对路径、也可以用调用方 cwd 解释的相对路径）。
 * @param moduleUrl 调用方自己的 `import.meta.url`。
 * @returns 直接执行 → `true`；否则 `false`（绝不抛错：守卫崩掉 = 入口崩）。
 */
export function isDirectInvocation(argv1, moduleUrl) {
  if (argv1 === undefined) return false
  let script
  try {
    script = fileURLToPath(moduleUrl)
  } catch {
    // 非 file: URL（如 http:）—— 没有可比的脚本路径。
    return false
  }
  try {
    return realpathSync(argv1) === realpathSync(script)
  } catch {
    // 任一侧解析不了（不存在 / 不可访问）：判不准就不跑 —— fail closed。
    return false
  }
}

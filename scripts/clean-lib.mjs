/**
 * clean-lib.mjs —— `build` 自带的第一步：清掉 **tsdown 上一代产物**（`#111` 路线 A）。
 *
 * 为什么存在：`package.json` 的 `files` 用 glob（`lib/pty-*.js` / `lib/posix-quote-*.js` …），
 * 而 tsdown 的 chunk 名带**内容哈希**（如 `lib/pty-C0_H63de.js`）——内容一变名字就变，
 * 上一代文件**不会被覆盖**而是**留在原地**。`lib/` 又在 `.gitignore` 第 2 行，
 * 所以残留既不出现在 `git status`、也不影响构建绿灯，只会在 `npm pack` 时
 * **historically** 一起进 tarball（票面取证：未清 = 16 文件 / 59771 B，含当次
 * `lib/pty-C0_H63de.js` 46520 B + 遗留 `lib/pty-g32VoH8_.js` 46509 B；清后 = 15 文件 / 45527 B）。
 * 旧口径是「发布构建前记得手工 `Remove-Item -Recurse -Force lib`」——靠记性，故做进 `build`。
 *
 * 为什么**不**打开 tsdown 的 `clean`：tsc 的声明产出 `lib/types/` 与 tsdown **共享
 * outDir 根**（见 `tsdown.config.ts:10-11`），打开 `clean` 会把 `lib/types/` 一并清掉，
 * 而那是 `exports` 里 `types` 指针的落点 —— 唯一必须保留的面。
 *
 * 清什么（`tsdown.config.ts` 的 `outDir: 'lib'` + `entry: src/{pty,wsl-plugin,terminal}/index.ts`）：
 *   - `lib/*.js`  —— 按源码模块切出的 chunk（`lib/pty-*.js` / `lib/src-*.js` …），**仅顶层**；
 *   - `lib/{pty,terminal,wsl-plugin}/` —— 三个入口目录，整棵删。
 * 留什么：
 *   - `lib/types/**` —— tsc 声明面，**整棵保留**（含其中的 `.js`：那是声明面目录，不是 tsdown 产物）；
 *   - `lib/` 下其余一切（如 `lib/README.md`）—— 本模块**只删它确知是 tsdown 产物的东西**，
 *     判不准就不删（宁可留残留、也不误删别人的文件）。
 *
 * 结构：**「该删 vs 该留」的判定是纯函数** `planLibCleanup()`（导出，离线单测见
 * `tests/clean-lib.spec.ts`，覆盖「`lib/types/` 下的 `.js` 不得被误删」这条边界）；
 * 碰 I/O 的只有 `listLibEntries()` / `applyLibCleanup()` / `main()` 薄层。
 * 入口守卫 `isDirectInvocation` **原样转出**自 `scripts/script-entry.mjs`（`#85` 的单一来源，
 * 本文件不再自带一份 realpath 比对）。顶层只在**直接执行**时跑 —— import 本模块零副作用。
 *
 * @module dsh-shell-host/scripts/clean-lib
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectInvocation } from './script-entry.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** tsdown 的 outDir（`tsdown.config.ts` 的 `outDir: 'lib'`）—— 本模块的清理根。 */
export const LIB_DIR = 'lib'

/**
 * tsc 声明面的落点，**整棵保留**（`package.json` 的 `lib/types/**\/*.d.ts` 指针面）。
 * 单列成常量是因为它同时是**兜底判据**（`isUnderTypes` 里 `startsWith` 而非精确相等），
 * 免得有人在别处写死成"只保 `lib/types` 这一层"。
 *
 * **保留判据是"整个子树"，不是扩展名白名单**：`.d.ts.map` 等非 `.d.ts` 文件同样在 `lib/types/` 下，
 * 它们不在 `package.json` 的 `files` 面（只声明了 `lib/types/**\/*.d.ts`）上、也不是 `exports` 指针 ——
 * 按扩展名删它们**没有任何判据会报红**（本票唯一的静默缺口）。故 `isUnderTypes` 只看路径前缀。
 */
export const TYPES_DIR = 'lib/types'

/** tsdown 的三个入口目录（`entry: src/{pty,wsl-plugin,terminal}/index.ts`）—— 整棵删。 */
export const TSDOWN_ENTRY_DIRS = ['lib/pty', 'lib/wsl-plugin', 'lib/terminal']

/**
 * 归一成仓根相对路径的**正斜杠**形态：`lib\pty\index.js` → `lib/pty/index.js`，
 * 前导 `./` 与重复分隔符一并去掉（列表可能来自 `readdirSync` 或手工构造）。
 *
 * **末尾分隔符也去掉**：`readdirSync` 的目录条目与手工构造的 `lib/pty/` 是同一件事的
 * 等价写法，归一后必须等于 `lib/pty` —— 否则 `TSDOWN_ENTRY_DIRS.includes()` 会漏判，
 * 三个入口目录整棵留下（本模块最初就是这么错的，单测逮住了）。
 *
 * 只做纯字符串归一（**不碰 I/O**，也不解 `..`）：输入是"lib 下的条目列表"，
 * 由调用方保证是仓根相对形态；纯函数越少猜测越好测。
 */
export function normalizeLibPath(entry) {
  return String(entry)
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replace(/\/{2,}/gu, '/')
    .replace(/\/+$/u, '')
}

/**
 * 该条目**是否在 `lib/types/` 之下**（守卫的兜底判据，保留面的唯一来源）。
 *
 * 用 `startsWith` 而非相等：`lib/types` 自身、`lib/types/pty/index.d.ts`、
 * `lib/types/pty/orphan.js` **全部**算保留面 —— 深层路径漏判 = 误删声明。
 * 分隔符**必须**跟着比：`lib/types-old/x.d.ts` 不是保留面（前缀相同但不同目录）。
 */
export function isUnderTypes(entry) {
  const path = normalizeLibPath(entry)
  return path === TYPES_DIR || path.startsWith(`${TYPES_DIR}/`)
}

/**
 * **纯函数**：给定 `lib/` 下的条目列表，算出哪些**该删**。
 *
 * 判据（顺序无关，但每条都只针对**确知是 tsdown 产物**的形态）：
 *   1. `lib/types/**` → **保留**（整棵；这是 tsc 的面，含其中的 `.js`）—— **先判**，
 *      否则 `lib/types/pty/orphan.js` 会被第 2 条误伤；
 *   2. 三个入口目录 `lib/{pty,terminal,wsl-plugin}` 及其子树 → **删**；
 *   3. `lib/` **顶层**的 `*.js`（chunk）→ **删**；深层其它 `*.js`（如
 *      `lib/zz-fake/index.js` 这种非入口目录）→ **保留**：判不准就不删。
 *
 * 其余一切（目录名不匹配、非 `.js` 后缀、`lib/` 之外）→ 保留。
 *
 * @param entries `lib/` 下的仓根相对路径列表（文件与目录**都可**传；目录名以
 *                `lib/pty` 形态出现即代表整棵子树，故 `readdirSync` 的顶层结果直接可用）。
 * @returns **该删**的路径（归一形态，按输入顺序去重后去重前的稳定顺序保留）。
 */
export function planLibCleanup(entries) {
  const doomed = []
  const seen = new Set()
  for (const raw of entries ?? []) {
    const path = normalizeLibPath(raw)
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    // 1. 声明面整棵保留 —— 必须在"顶层 .js"判据**之前**（`lib/types/x.js` 也得留）。
    if (isUnderTypes(path)) continue
    // 2. 三个入口目录及其子树（`lib/pty` 命中即代表 `lib/pty/**` 整棵）。
    if (TSDOWN_ENTRY_DIRS.includes(path)) {
      doomed.push(path)
      continue
    }
    // 3. `lib/` 顶层的 `.js` chunk（`lib/pty-abc.js`、`lib/src-abc.js` …）。
    //    「顶层」= 去掉 `lib/` 前缀后**不再含分隔符**：`lib/a/b.js` 不算，判不准就不删。
    const rest = path.startsWith(`${LIB_DIR}/`) ? path.slice(LIB_DIR.length + 1) : null
    if (rest !== null && !rest.includes('/') && rest.endsWith('.js')) doomed.push(path)
  }
  return doomed
}

/**
 * 列出 `dir` 下的**顶层**条目 —— 碰 I/O 的薄层。
 *
 * 返回路径的**前缀取自 `dir` 的 basename**（不是写死 `lib/`）：列表形态与
 * `applyLibCleanup` 的删除根必须由**同一个来源**推出，否则两者会错位（见下方契约）。
 * 默认调用下 `basename` 就是 `lib`，与 `planLibCleanup` 的判据形态一致。
 *
 * `dir` 不存在时返回 `[]`（**首次构建 / `git clean -fxd` 之后**是正常态，不是错误）。
 * 递归由 `planLibCleanup` 的"目录名命中即整棵删"承担，故这里只取一层：
 * `lib/pty` 出现在列表里就足以判掉 `lib/pty/**`。
 *
 * @param dir 目标清理根目录（约定它是某个 `lib/` 形态的目录）。
 */
export function listLibEntries(dir = join(repoRoot, LIB_DIR)) {
  const prefix = basename(dir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).map((item) => `${prefix}/${item.name}`)
}

/**
 * 执行清理：`planLibCleanup(listLibEntries(dir))` → 逐个 `rmSync` —— 碰 I/O 的薄层。
 *
 * **契约：`dir` 的 basename 必须是 `lib`**（默认即 `<repo>/lib`，fixture 一律用 `<tmp>/lib`）。
 * 判据与返回值是**配置文件同形**的相对路径（`lib/...`），故删除根 = `dirname(dir)`，
 * 拼回 `dirname(dir)/lib/<name>` —— 这与 `listLibEntries` 的前缀**同源**。
 *
 * 为什么把这条写死并**大声拒绝**：删除根写错不会崩，只会**静默什么都不删**，
 * 而返回值照旧报"清掉 N 项" —— 单测假绿、真实清理行为从未被验证（本模块最初写死
 * `repoRoot` 就是这么错的，被幂等用例逮住；basename 不叫 `lib` 是同一失败模式的另一种入口）。
 * 故这里**响亮抛错**而不是继续跑：错位的删除根比崩掉更糟。
 *
 * 目录用 `rmSync(..., { recursive: true, force: true })`（整棵删）；`force: true` 让
 * "列出后被别人删掉"这类竞态**不抛错** —— 清理是幂等的，重复跑必须同样绿。
 *
 * @returns 实际删掉的路径列表（`lib/` 前缀形态，供 CLI 打印与 caller 断言）。
 */
export function applyLibCleanup(dir = join(repoRoot, LIB_DIR)) {
  const prefix = basename(dir)
  if (prefix !== LIB_DIR) {
    throw new Error(
      `clean-lib: applyLibCleanup 的 dir 必须以 ${LIB_DIR} 结尾（收到 basename=${JSON.stringify(prefix)}，dir=${dir}）——` +
        '删除根与列表前缀必须同源，否则会静默一个文件都不删却报告清掉 N 项',
    )
  }
  const doomed = planLibCleanup(listLibEntries(dir))
  const root = dirname(dir)
  for (const path of doomed) {
    rmSync(join(root, ...path.split('/')), { recursive: true, force: true })
  }
  return doomed
}

/** CLI 主体（碰真实文件系统，故不导出、不由离线单测覆盖）：清 → 打印一条读数。 */
function main() {
  const doomed = applyLibCleanup()
  if (doomed.length === 0) {
    console.log(`clean-lib: lib/ 里没有 tsdown 上一代产物可清（保留 ${TYPES_DIR}/）`)
  } else {
    console.log(`clean-lib: 清掉 ${doomed.length} 项 tsdown 产物（保留 ${TYPES_DIR}/）：${doomed.join(' ')}`)
  }
}

/**
 * 是否**直接执行**（而非被 import）——被 import 时不跑 CLI。
 *
 * 真正实现在 `scripts/script-entry.mjs`（`#85` 收敛成的单一来源：realpath 归一 + 纯函数 + spec）。
 * 这里**原样转出**，让既有调用面与其它脚本共用同一份守卫。
 */
export { isDirectInvocation }

// 只有**直接执行**才跑 CLI：被单测 import 时不得删任何东西。
if (isDirectInvocation(process.argv[1], import.meta.url)) main()

/**
 * verify-all.mjs —— 本仓**唯一检查入口**（retro 落地，对齐相邻工作区）。
 *
 * 为什么存在：本仓无 CI（维护者决定 2026-09-30），本地套件即唯一验收通道，
 * 但此前 `test` 脚本只跑 vitest 两个项目，**汇总层看不出"哪些是通过、哪些是
 * 带 loud skip 的通过"**——而这两者的证据强度完全不同（见 docs/agents/TESTING.md）。
 *
 * 本脚本把两个车道串起来并按 TESTING.md 的口径如实汇总：
 *   PASS   —— 真通过
 *   PASS*  —— 通过，但输出含 `!! SKIP (loud)`：其**环境侧断言未验证**，绿 != 全验过
 *   FAIL   —— 失败（附末尾输出）
 *   SKIP   —— 用例按门禁整体跳过（如 ssh-pty-live 无 DSH_SSH_LIVE_HOST）
 *
 * 用法：node scripts/verify-all.mjs              （`node --run test` = 先 typecheck 再跑本脚本）
 *       node scripts/verify-all.mjs --lane unit  （**迭代口径**：只跑一个车道，非验收口径）
 *
 * 注意：**summary 里的 PASS* 数量是要看的数字**。它比"全绿"更有信息量。
 *
 * #122：读数与颜色**解耦**。子进程环境由 `pinnedRunnerEnv()` 钉成 `NO_COLOR=1`（裸徽标），
 * 解析层另认带色的色块徽标形态（`parsePerFileLine` 的输入契约）—— 两条路各自成立，
 * 于是"逐文件表随调用者会话环境时有时无"这个失效模式被关掉（详见票面与 TESTING.md）。
 *
 * 结构：解析与判定是**纯函数**（导出，见 tests/verify-all.spec.ts 的离线单测），
 * 只有 `runLane()` 与 `main()` 碰真实环境。判定逻辑曾随车道顺序漂移（#83）。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectInvocation } from './script-entry.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs')

/**
 * 车道 → 说明。**顺序即调度**（`main` 里逐个 `&&` 式串跑，不并发）。
 *
 * `writers` 必须**最后**：它是 `lib/` 的**写者**（`clean-lib.spec.ts` 真跑 `node --run build`，
 * 而 build 的第一步就是删 `lib/` 的三个入口目录与顶层 chunk）。读者车道（unit 里的
 * `verify-pack.spec.ts` / `built-artifact.spec.ts`）跑在**它之前**，窗口才不会与它们重叠；
 * 反过来排就是本票 #123 要修的那种间歇红。见 `vitest.config.ts` 的 `writersLane` 说明。
 */
const LANES = [
  { name: 'unit', why: '纯逻辑与类型面' },
  { name: 'machine', why: '串行；碰真实终端 / 真实实例 / 可选真实 LLM' },
  { name: 'writers', why: '串行；写 lib/（真跑 build），排在所有读者之后' },
]

/** 汇总表的状态标签（5 列宽，便于对齐）。 */
const STATUS_LABEL = { PASS: 'PASS ', 'PASS*': 'PASS*', FAIL: 'FAIL ', SKIP: 'SKIP ' }

/** ANSI SGR 序列（真彩色：`\x1b[<n>m`，本包实测就是这种无参数形态）。 */
const ANSI_SGR = /\u001b\[[0-9;]*m/gu

/**
 * "这一行有没有 SGR" 的**无状态**探针 —— 刻意**不带 `/g`**。
 *
 * `/g` 正则的 `test()` 会推进 `lastIndex`：同一个正则对象连用会**交替命中**（复核轴实测
 * 第 7 次返回 false），一条带色行会被误判成裸形态；靠手工 `lastIndex = 0` 复位能修，但那是
 * **隐式契约** —— 将来谁删掉那行，没有用例会红。用无状态探针根治（`replace` 用 `/g` 无此问题，
 * 它自己会重置 `lastIndex`）。
 */
const HAS_SGR = /\u001b\[[0-9;]*m/u

/** 去掉一行里的全部 ANSI SGR —— 解析前归一，**只在行内做**（跨行状态本脚本不消费）。 */
function stripAnsi(line) {
  return String(line).replace(ANSI_SGR, '')
}

/**
 * 逐文件行解析。**输入契约（#122 定界）—— 恰好两种形态，没有第三种"看运气"状态**：
 *
 * ```
 * （A）裸徽标：  ✓ |unit| tests/detect.spec.ts (7 tests | 1 skipped) 17852ms
 * （B）色块徽标：ESC[32m✓ESC[39m ESC[30mESC[42m unit ESC[49mESC[39m tests/….spec.ts (52 tests) 20ms
 * ```
 *
 * 精确的判据是"**这一行有没有 SGR**"：**无 SGR 全行** ⇒ 只能走形态 A；**有 SGR** ⇒ 只能走
 * 形态 B（形态 A 的正则不再兜底）。因此"混合行"（徽标是裸的、但别处带色）**不收** ——
 * 真实 vitest 打不出这种行：`formatProjectName` 只在 `!isColorSupported` 时返回 `|name|`，
 * 而**所有** token 共用同一个 `isColorSupported` 标志，逐进程要么全色要么全无色（复核轴核过）。
 * 这条写清楚，免得把契约读成"两种形态可以混着来"。
 *
 * **判别依据是"SGR 在不在"（即这一行有没有着色），不是空格数**：
 *
 * - 形态 **A** 没有 SGR，徽标是 `|lane|` 包裹的文本 ⇒ 用 A 正则（`\s+` 容忍对齐空格，
 *   与 #122 之前的宽容度一致）；
 * - 形态 **B** **有** SGR，且着色序列把 `|` 连徽标一起替换掉了 ⇒ 用 B 正则匹配**原始行**
 *   （SGR 显式写在正则里，`\s+` 仍然容忍对齐空格）—— 这样对齐填充不会被误判成一种新形态；
 * - 两者都不匹配 ⇒ `null`（交给汇总层的响亮失败兜底，不猜）。
 *
 * 为什么不按"剥完后的空格数"判别：那是**空格计数**而非形状，对齐填充一变就静默改判
 * （3 空格填充的合法裸行会被丢，2 空格的非徽标文本会被收）—— 正是本票要消灭的那种漂移。
 * 也不按"剥完后有没有 `|`"判别：实测带色行剥完残留 `|` 数为 **0**（本机实测 char code：
 * **原始**行 `✓` 之后是 `10003,27,91,51,57,109,32,27,91,51,48,109,…`，即 `✓` 与徽标词之间
 * 夹着 `ESC[39m ESC[30mESC[42m`；**剥完后**才是 `10003,32,32,117,…` = `✓␣␣unit`），
 * 看似可分，但"剥完无 `|`"这一点**只在"确知带色"时才成立** —— 单看剥完的文本无法与
 * "用户自己写的无管道文本"区分，所以判据落在 SGR 上。
 *
 * SGR 一律**不泄进返回值**（`lane` / `file` / `detail` 都是干净文本）。
 * 汇总行（`Tests  387 passed (388)` / `Test Files  no test files found`）整行以 `Tests` /
 * `Test Files` 起头，**不是徽记**，因此不会被误收；`Duration` 同理。
 *
 * @param line 车道输出的一行（**可带色也可不带**）
 * @returns `{ mark, lane, file, detail }`；不是逐文件行则 `null`
 */
export function parsePerFileLine(line) {
  const raw = String(line)
  const hasSgr = HAS_SGR.test(raw)
  const stripped = stripAnsi(raw).trim()
  // 形态 B：**带色**行 —— 徽标被色块替换掉，SGR 落在徽记与徽标词之间。
  if (hasSgr) {
    const blocked = /^(?:.*?)(✓|×|↓)\u001b\[[0-9;]*m\s+\u001b\[[0-9;]*m\u001b\[[0-9;]*m\s*(\w+)\s*\u001b\[[0-9;]*m/u.exec(raw)
    if (blocked !== null) {
      // 文件名与 detail 从**剥干净的文本**里取（避免把残留 SGR 带进字段）。
      const rest = /^\s*(✓|×|↓)\s+(\w+)\s+(\S+\.spec\.ts)\b(.*)$/u.exec(stripped)
      if (rest !== null) {
        return { mark: rest[1], lane: rest[2], file: rest[3], detail: rest[4].trim() }
      }
    }
    // 带色但不是本契约的徽标形状 ⇒ 不收（交给兜底），不再退回裸形态猜。
    return null
  }
  // 形态 A：无色的裸徽标行 —— `✓ |unit| tests/detect.spec.ts …`（`\s+` 容忍对齐填充）。
  const bare = /^\s*(✓|×|↓)\s*\|(\w+)\|\s*(\S+\.spec\.ts)\b(.*)$/u.exec(stripped)
  if (bare === null) return null
  return { mark: bare[1], lane: bare[2], file: bare[3], detail: bare[4].trim() }
}

/** 从整个车道的输出里收集逐文件行。 */
export function perFileEntries(output) {
  const perFile = []
  for (const line of output.split('\n')) {
    const entry = parsePerFileLine(line)
    if (entry !== null) perFile.push(entry)
  }
  return perFile
}

/** 车道输出里是否出现 loud skip（`!! SKIP (loud)` = 门禁未满足的响亮跳过）。 */
export function hasLoudSkip(output) {
  return /!! SKIP \(loud\)/u.test(output)
}

/**
 * 单个逐文件条目的四态判定。
 * 顺序敏感：**标记优先于 loud** —— `×` / `↓` 不因本车道别处有 loud skip 而变形。
 */
export function entryStatus({ mark, detail, loud = false }) {
  if (mark === '↓') return 'SKIP'
  if (mark === '×') return 'FAIL'
  return /skipped/u.test(detail) || loud ? 'PASS*' : 'PASS'
}

/**
 * 车道级失败：车道退出码非零、但逐文件行都好看时补一条 FAIL，别让退出码被吞。
 *
 * 判定范围必须是**本车道**的条目（`results.filter(r => r.lane === lane.name)`）：
 * 用全局 `results` 会让先行车道的 FAIL 掩盖后行车道的车道级失败（反之亦然），
 * 结果随车道执行顺序漂移（8e8fa9f 修的正是这处）。
 */
export function laneLevelFailure({ lane, exitCode, output, results }) {
  const laneResults = results.filter((r) => r.lane === lane.name)
  if (exitCode === 0 || laneResults.some((r) => r.status === 'FAIL')) return null
  return {
    label: `project ${lane.name} (lane exit)`,
    lane: lane.name,
    status: 'FAIL',
    detail: `exit ${String(exitCode)}`,
    output,
  }
}

/**
 * 车道输出里有没有 vitest 的**用例数**汇总行（`Tests  387 passed | 1 skipped (388)`）。
 *
 * 用途（#122 的机械兜底）：逐文件行**解析不到**、而本轮**确实跑过**用例 ⇒ 那是解析失败
 * （输出格式漂移），**不是**"没收集到用例"。反例是 `Test Files  no test files found` ——
 * 真没跑，读成 SKIP 才诚实。
 *
 * **必须先剥 SGR（#122）**：带色时这行是
 * `ESC[2m      Tests ESC[22m ESC[1mESC[32m52 passedESC[39m…` —— `Tests` 与数字之间夹着
 * 着色序列，未剥色的正则在带色输出上**恒不命中**，于是兜底在最需要它的场合（带色）
 * 恰好失效，把"解析失败"静默读成 SKIP。与逐文件行是同一处根因：**读数必须与颜色解耦**。
 */
export function reportsTestCounts(output) {
  return /^\s*Tests\s+\d+/mu.test(stripAnsi(output ?? ''))
}

/**
 * 把一个车道的运行结果收集成汇总条目：逐文件条目 + 兜底条目
 * （「无收集到用例」/「逐文件行解析失败」/「车道级失败」）。
 *
 * @param run `{ exitCode, out }` —— 逐文件行**只从 `out` 现场解析**：单测构造输出
 *            文本、生产跑真实输出，两边走的是同一条解析路径（不留测试没走过的分支）。
 * @param results 已累积的汇总条目（判断车道级失败时只取本车道的）。
 */
export function collectLane({ lane, run, results = [] }) {
  const out = run.out ?? ''
  const perFile = perFileEntries(out)
  const loud = hasLoudSkip(out)
  const entries = []
  if (perFile.length === 0) {
    // 解析不到逐文件行的**两种**情形必须分开：跑过但格式漂移（响亮失败）vs 真没收集到用例。
    if (run.exitCode === 0 && reportsTestCounts(out)) {
      entries.push({
        label: `project ${lane.name}`,
        lane: lane.name,
        status: 'FAIL',
        detail: '逐文件行 0 行但 vitest 报过用例数（输出格式漂移，见 #122）',
        output: out,
      })
      return entries
    }
    // 没有逐文件行：整个车道没收集到用例（全用例 skipIf / 无测试文件），或提前崩了。
    entries.push({
      label: `project ${lane.name}`,
      lane: lane.name,
      status: run.exitCode === 0 ? 'SKIP' : 'FAIL',
      detail: run.exitCode === 0 ? '无收集到的用例' : `exit ${String(run.exitCode)}`,
      output: run.exitCode === 0 ? undefined : out,
    })
    return entries
  }
  for (const file of perFile) {
    const status = entryStatus({ ...file, loud })
    entries.push({
      label: file.file,
      lane: file.lane,
      status,
      detail: file.detail || lane.why,
      output: status === 'FAIL' ? out : undefined,
    })
  }
  const laneExit = laneLevelFailure({
    lane,
    exitCode: run.exitCode,
    output: out,
    // 判据 = 此前累积的 + 刚收集的条目，再按 lane 过滤；逐文件条目的 lane 取自该行
    // 自己的 `|lane|` 标记（与 project 名不一致时不算同车道）——与历史行为一致。
    results: [...results, ...entries],
  })
  if (laneExit !== null) entries.push(laneExit)
  return entries
}

/** 汇总计数：`passed` 含 PASS 与 PASS*；`partial` 是其中带 loud skip / 部分跳过的。 */
export function summarize(results) {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'PASS' || r.status === 'PASS*').length,
    partial: results.filter((r) => r.status === 'PASS*').length,
    skipped: results.filter((r) => r.status === 'SKIP').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
  }
}

/** 汇总文案；口径见 docs/agents/TESTING.md（PASS* 的环境侧断言未验证）。 */
export function summaryLine(results) {
  const { total, passed, partial, skipped, failed } = summarize(results)
  return (
    `${failed === 0 ? 'OK' : 'FAILED'} — ${passed}/${total} 通过` +
    (partial > 0 ? `（其中 ${partial} 项为 PASS*：含 loud skip / 部分跳过，**其环境侧断言未验证**）` : '') +
    (skipped > 0 ? `，${skipped} 项整体跳过（门禁未开，见上）` : '')
  )
}

/** 汇总表的一行：`  <status> <label，40 宽> <detail>`。 */
export function formatEntry(entry) {
  return `  ${STATUS_LABEL[entry.status]} ${entry.label.padEnd(40)} ${entry.detail}`
}

/**
 * 解析本脚本的 CLI 参数（纯函数，便于离线单测）。
 *
 * `--lane <name>` = **迭代口径**：只跑该车道，省掉另一个车道的墙钟时间。
 * 非验收口径 —— 输出里必须两道提示（`partialBanner` / `partialSummaryNote`）。
 *
 * @returns `{}`（默认跑全部）或 `{ lane }` 或 `{ error }`（交给 main 打 stderr + exit 1）
 */
export function parseVerifyArgs(argv) {
  let lane
  const errors = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--lane') {
      lane = argv[i + 1]
      i += 1
      if (lane === undefined) errors.push('--lane 缺参数')
    } else {
      errors.push(`未知参数：${arg}`)
    }
  }
  if (lane !== undefined && !LANES.some((l) => l.name === lane)) {
    errors.push(`未知车道：${lane}（可选 ${LANES.map((l) => l.name).join(' / ')}）`)
  }
  if (errors.length > 0) return { error: errors.join('；') }
  return lane === undefined ? {} : { lane }
}

/** 迭代口径的顶部横幅：**别让"只跑了一个车道"被当验收**。 */
export function partialBanner(laneName) {
  return `  >> 仅 ${laneName} 车道 —— **迭代口径，非验收口径**；完整验收跑 node --run test`
}

/** 迭代口径的结尾提示（有人只看汇总末尾时同样看得出来）。 */
export function partialSummaryNote(laneName) {
  return `  >> 上面只是 ${laneName} 车道的结论（**迭代口径，非验收口径**）—— 完整验收：node --run test`
}

/**
 * Pull the lines that actually explain a failure.
 *
 * Blindly tailing the output loses the diagnosis: vitest prints its failure
 * detail mid-stream and ends with the summary and timings, so a tail shows the
 * counts but not WHICH assertion failed. Extract the failure block instead, and
 * fall back to the tail only when nothing matches (e.g. a crash before vitest
 * could format anything).
 */
export function failureExcerpt(output) {
  const lines = output.split('\n')
  const markers = [
    /^\s*FAIL\b/u,                        // vitest per-file failure banner
    /AssertionError/u,
    /^\s*Error:/u,
    /^\s*[×✗]\s/u,                        // failed case line
    /Cannot find (module|package)/u,
    /is not a function|is not defined/u,
  ]
  const hits = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!markers.some((m) => m.test(lines[i]))) continue
    hits.push(i)
  }
  if (hits.length === 0) return lines.slice(-25).join('\n')
  // Keep a window around each hit, deduplicated and in order.
  const keep = new Set()
  for (const hit of hits.slice(0, 6)) {
    for (let i = Math.max(0, hit - 2); i <= Math.min(lines.length - 1, hit + 14); i += 1) keep.add(i)
  }
  return [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n')
}

/**
 * 把子进程（vitest）的**输出形态**钉死 —— 读数稳定性由这里保证，不靠调用者记得先设变量。
 *
 * `NO_COLOR=1` 让 vitest 打**裸徽标**（形态 A）：徽标两侧有 `|`、每个 token 一条色带，
 * 读数与颜色解耦。**这是本票 #122 的一半修法**：调用者会话带不带色，逐文件表都在。
 *
 * 解析层（`parsePerFileLine`）另认形态 B（色块徽标），所以忘设也不会塌 —— 两处各自独立，
 * 不是一处对另一处的备份依赖。
 *
 * 变量名对齐 no-color.org（本包实测 `NO_COLOR=1` 即得裸徽标，见 `docs/agents/TESTING.md`）。
 */
export function pinnedRunnerEnv(baseEnv) {
  return { ...baseEnv, NO_COLOR: '1' }
}

/** 跑一个车道（**碰真实环境**，故不导出、单测不覆盖）→ `{ exitCode, out }`。 */
function runLane(lane) {
  const run = spawnSync(process.execPath, [VITEST, 'run', '--project', lane.name], {
    cwd: REPO,
    encoding: 'utf8',
    env: pinnedRunnerEnv(process.env),
  })
  return { exitCode: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/**
 * 环表宣告行：`=== <档名> rings (…) ===`。
 *
 * 它是**约定**（不是巧合）：谁在报告里打环表，就用这一行开头，汇总层才收得到。
 * 目前两档 e2e（`e2e-tarball-machine` / `e2e-real-llm-machine`）都是这个形状。
 */
const RINGS_HEADING = /^=== .*\brings\b.* ===$/u

/**
 * 环表读数行：`  ✓ <环>` / `  ✗ <环>` / `  – <说明>`。
 *
 * 末尾的 `(?!\|)` 是必需的：vitest 自己的逐文件行同样以两空格 + `✓` 开头
 * （`  ✓ |machine| tests/detect.spec.ts`），不排除就会把汇总行当成读数。
 */
const RING_ROW = /^ {2}(?:✓|✗|–) (?!\|)/u

/**
 * 从车道原始输出里收集**环表读数**：每块 = 宣告行 + 紧随其后的读数行。
 *
 * 为什么汇总层要收：`collectLane` 只为 FAIL 留输出（`output` 字段），而「清理读数
 * 在成功与失败两条路径都出现」这类 AC 的**成功路径**证据恰恰只在绿路径的输出里 ——
 * #89 与 #97 都因此被迫补跑一次单档，其中 #97 那次是一次真实端点调用。读数只有在
 * **唯一验收入口**里看得见，才谈得上"读数"。
 *
 * @param output 车道输出（vitest stdout+stderr 拼接）
 * @returns `[{ heading, rows }]`，按出现顺序；无宣告行 / 无读数行时为 `[]`
 */
export function readingBlocks(output) {
  const lines = String(output ?? '').split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i]
    if (!RINGS_HEADING.test(heading)) continue
    const rows = []
    for (let j = i + 1; j < lines.length && RING_ROW.test(lines[j]); j += 1) rows.push(lines[j])
    if (rows.length > 0) blocks.push({ heading, rows })
    i += rows.length // 已收的行不再当宣告行看
  }
  return blocks
}

/** CLI 主体：跑车道（默认全部；`--lane` 只跑一个）→ 纯函数汇总 → 打印 + exit code。 */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseVerifyArgs(argv)
  if (parsed.error !== undefined) {
    console.error(`verify-all: ${parsed.error}`)
    process.exit(1)
  }
  const selected = parsed.lane === undefined ? LANES : LANES.filter((l) => l.name === parsed.lane)
  const iterationOnly = parsed.lane !== undefined
  const results = []
  const readings = []
  for (const lane of selected) {
    const run = runLane(lane)
    readings.push(...readingBlocks(run.out))
    results.push(...collectLane({ lane, run, results }))
  }

  console.log('\n=== verify-all ===')
  if (iterationOnly) console.log(partialBanner(parsed.lane))

  // 提交前门禁是**每 clone 一次**的本地 git 配置（core.hooksPath 不随 clone 分发）：
  // 没配就是静默没有，而套件照样全绿 —— 与 loud-skip 的"如实告知"口径相反。
  // 故响亮提一句（advisory：不阻断、不改 exit code）。
  {
    const probe = spawnSync('git', ['config', 'core.hooksPath'], { cwd: REPO, encoding: 'utf8' })
    const hooksPath = (probe.stdout ?? '').trim()
    // git 不可用时不猜（probe.error 存在即静默跳过），只在能确证时提示。
    if (probe.error === undefined && probe.status !== null && hooksPath !== '.githooks') {
      console.log(
        `  !! pre-commit 钩子未启用（core.hooksPath = ${hooksPath === '' ? '未设置' : hooksPath}）` +
          ' —— 首次 clone 跑一次: git config core.hooksPath .githooks',
      )
    }
  }

  for (const r of results) {
    console.log(formatEntry(r))
  }

  // 环表读数：**绿路径也打**（`collectLane` 只为 FAIL 留输出，见 `readingBlocks`）。
  // 放在失败摘录之前 —— 读数是"哪个环节"，摘录是失败细节：先定位，再细节。
  if (readings.length > 0) {
    console.log('\n--- 环表读数（每块 = 宣告行 + 该档读数；绿 / 红路径都收）---')
    for (const block of readings) {
      console.log(block.heading)
      for (const row of block.rows) console.log(row)
    }
  }

  for (const failed of results.filter((r) => r.status === 'FAIL')) {
    console.log(`\n--- ${failed.label} (${failed.detail}) ---`)
    console.log(failureExcerpt(failed.output ?? ''))
  }

  console.log(`\n${summaryLine(results)}`)
  if (iterationOnly) console.log(partialSummaryNote(parsed.lane))

  process.exit(summarize(results).failed > 0 ? 1 : 0)
}

/**
 * 是否**直接执行**（而非被 import）——被 import 时不跑 CLI。
 *
 * 真正实现在 `scripts/script-entry.mjs`（#85 的单一来源：realpath 归一 + 纯函数 + spec）。
 * 这里**原样转出**，让既有调用面与其它脚本共用同一份守卫，不再各写一套。
 */
export { isDirectInvocation }

// 只有**直接执行**才跑 CLI：被单测 import 时不得递归跑整套套件。
if (isDirectInvocation(process.argv[1], import.meta.url)) main()
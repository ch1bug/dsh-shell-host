/**
 * verify-all.mjs —— 本仓**唯一检查入口**（retro 落地，对齐相邻工作区）。
 *
 * 为什么存在：本仓无 CI（维护者决定 2026-09-30），本地套件即唯一验收通道，
 * 但此前 `pnpm test` 只跑 vitest 两个项目，**汇总层看不出"哪些是通过、哪些是
 * 带 loud skip 的通过"**——而这两者的证据强度完全不同（见 docs/agents/TESTING.md）。
 *
 * 本脚本把两个车道串起来并按 TESTING.md 的口径如实汇总：
 *   PASS   —— 真通过
 *   PASS*  —— 通过，但输出含 `!! SKIP (loud)`：其**环境侧断言未验证**，绿 != 全验过
 *   FAIL   —— 失败（附末尾输出）
 *   SKIP   —— 用例按门禁整体跳过（如 ssh-pty-live 无 DSH_SSH_LIVE_HOST）
 *
 * 用法：node scripts/verify-all.mjs   （等价：pnpm test / node --run test）
 *
 * 注意：**summary 里的 PASS* 数量是要看的数字**。它比"全绿"更有信息量。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs')

/** 车道 → 说明。unit 先跑（快、纯逻辑），machine 后跑（串行、碰真实环境）。 */
const LANES = [
  { name: 'unit', why: '纯逻辑与类型面' },
  { name: 'machine', why: '串行；碰真实终端 / 真实实例 / 可选真实 LLM' },
]

/** 跑一个车道，返回 { exitCode, out, perFile }。 */
function runLane(lane) {
  const run = spawnSync(process.execPath, [VITEST, 'run', '--project', lane.name], {
    cwd: REPO,
    encoding: 'utf8',
    env: process.env,
  })
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
  // vitest 逐文件行形如：  ✓ |machine| tests/x.spec.ts (7 tests | 1 skipped) 17852ms
  //                      ↓ |machine| tests/y.spec.ts (4 tests | 4 skipped)
  const perFile = []
  for (const line of out.split('\n')) {
    const match = /^\s*(✓|×|↓)\s*\|(\w+)\|\s*(\S+\.spec\.ts)(.*)$/u.exec(line)
    if (match === null) continue
    perFile.push({
      mark: match[1],
      lane: match[2],
      file: match[3],
      detail: match[4].trim(),
    })
  }
  // 整个车道被 vitest 判为 skipped（如全用例 skipIf 掉）时逐文件行可能缺失。
  return { exitCode: run.status, out, perFile, allSkipped: /Test Files\s+.*1 skipped \(1\)/u.test(out) }
}

const results = []
for (const lane of LANES) {
  const run = runLane(lane)
  const loud = /!! SKIP \(loud\)/u.test(run.out)
  if (run.perFile.length === 0) {
    // 没有逐文件行：整个车道没收集到用例，或提前崩了。
    results.push({
      label: `project ${lane.name}`,
      status: run.exitCode === 0 ? 'SKIP' : 'FAIL',
      detail: run.exitCode === 0 ? '无收集到的用例' : `exit ${String(run.exitCode)}`,
      output: run.exitCode === 0 ? undefined : run.out,
    })
    continue
  }
  for (const file of run.perFile) {
    const skippedEntirely = file.mark === '↓'
    const hasSkips = /skipped/u.test(file.detail)
    let status
    if (skippedEntirely) status = 'SKIP'
    else if (file.mark === '×') status = 'FAIL'
    else status = hasSkips || loud ? 'PASS*' : 'PASS'
    results.push({
      label: file.file,
      lane: file.lane,
      status,
      detail: file.detail || lane.why,
      output: status === 'FAIL' ? run.out : undefined,
      laneFailed: run.exitCode !== 0,
    })
  }
  // 车道整体非零但逐文件行都好看：记一条车道级失败，别让退出码被吞。
  if (run.exitCode !== 0 && !results.some((r) => r.status === 'FAIL')) {
    results.push({
      label: `project ${lane.name} (lane exit)`,
      status: 'FAIL',
      detail: `exit ${String(run.exitCode)}`,
      output: run.out,
    })
  }
}

const label = { PASS: 'PASS ', 'PASS*': 'PASS*', FAIL: 'FAIL ', SKIP: 'SKIP ' }
console.log('\n=== verify-all ===')
for (const r of results) {
  console.log(`  ${label[r.status]} ${r.label.padEnd(40)} ${r.detail}`)
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
function failureExcerpt(output) {
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

for (const failed of results.filter((r) => r.status === 'FAIL')) {
  console.log(`\n--- ${failed.label} (${failed.detail}) ---`)
  console.log(failureExcerpt(failed.output ?? ''))
}

const failed = results.filter((r) => r.status === 'FAIL').length
const passed = results.filter((r) => r.status === 'PASS' || r.status === 'PASS*').length
const partial = results.filter((r) => r.status === 'PASS*').length
const skipped = results.filter((r) => r.status === 'SKIP').length

console.log(
  `\n${failed === 0 ? 'OK' : 'FAILED'} — ${passed}/${results.length} 通过` +
    (partial > 0 ? `（其中 ${partial} 项为 PASS*：含 loud skip / 部分跳过，**其环境侧断言未验证**）` : '') +
    (skipped > 0 ? `，${skipped} 项整体跳过（门禁未开，见上）` : ''),
)

process.exit(failed > 0 ? 1 : 0)
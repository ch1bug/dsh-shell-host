#!/usr/bin/env node
/**
 * frontier.mjs — ready frontier（当前可开工票集合）现算，**不读票面文字**。
 *
 * 为什么：排批/预检要知道"现在能开哪几张票"。人工读法有两个坑，本会话两种都踩过：
 *
 *   1. **正文会过期**。有人在回复里写下"#81 → #80 连着做"这类阻塞判断，而 tracker 里
 *      根本没有那条边 —— 阻塞只活在对话里，换个会话就没了。权威表示是**原生依赖边**，
 *      正文/回复只是叙述。改阻塞关系 = **改边**。
 *   2. **`issue_dependencies_summary` 写入后滞后**。刚 `--add-blocked-by` 后立即查 REST，
 *      `blocked_by` 读到 0（实测：等几秒才变 1）。据此判断"边没建上"再重试，会得到
 *      `Target issue has already been taken` 的困惑错误。本脚本改用**逐票依赖端点**取数，
 *      并在 `--json` 里带上原始读数，避免把滞后当成"无阻塞"。
 *
 * 规则（与 docs/agents/issue-tracker.md 一致）：
 *   frontier = open + label(默认 ready-for-agent) + **无 open 阻塞** + **无 assignee**
 *
 * 用法：
 *   node scripts/frontier.mjs                    # 默认 ready-for-agent
 *   node scripts/frontier.mjs --label ready-for-human
 *   node scripts/frontier.mjs --json             # 机器可读（排批输入）
 *   node scripts/frontier.mjs --repo owner/name
 * 前置：PATH 上有已登录的 `gh`。任何 gh 调用失败都**响亮退出** ——
 * 绝不让"接口挂了"伪装成"没有阻塞"。
 *
 * 纯逻辑 `readyFrontier()` 与 gh I/O 分离，便于离线单测。
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 默认 frontier 的 label。 */
export const DEFAULT_LABEL = 'ready-for-agent'

/**
 * 纯函数：算出 frontier 与被 gate 的票。
 *
 * @param issues        [{ number, title, labels: string[], assignees: string[], state? }]
 *                      —— 只读 labels/assignees/state/number；`body` 一律忽略（本脚本的要点）。
 * @param openBlockers  Map<number, number[]>：每票的 **open** 阻塞票号（已关闭的边不算 gate）。
 * @returns { frontier, gated }（均按票号升序；gated 附带 blockers/assignees 作为理由）
 */
export function readyFrontier(issues, openBlockers, { label = DEFAULT_LABEL } = {}) {
  const frontier = []
  const gated = []
  for (const issue of issues) {
    // state 大小写不敏感：`gh issue list --json state` 给 "OPEN"/"CLOSED"（大写），
    // 而 REST `gh api` 给 "open"/"closed"（小写）——归一在纯函数里做，边界不吃亏。
    if (issue.state !== undefined && String(issue.state).toLowerCase() !== 'open') continue
    const labels = issue.labels ?? []
    if (!labels.includes(label)) continue
    const blockers = openBlockers.get(issue.number) ?? []
    const assignees = issue.assignees ?? []
    if (blockers.length > 0 || assignees.length > 0) gated.push({ ...issue, blockers, assignees })
    else frontier.push(issue)
  }
  const byNumber = (a, b) => a.number - b.number
  return { frontier: frontier.sort(byNumber), gated: gated.sort(byNumber) }
}

/** 解析 CLI 参数。 */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo') args.repo = argv[++i]
    else if (a === '--label') args.label = argv[++i]
    else if (a === '--json') args.json = true
    else if (a === '--help' || a === '-h') args.help = true
    else fail(`unknown argument: ${a}（--help 看用法）`)
  }
  return args
}

/** 跑一条 gh 命令并要求成功：失败即响亮退出。 */
function gh(args) {
  const run = spawnSync('gh', args, { encoding: 'utf8' })
  if (run.error !== undefined) fail(`gh 不可用（PATH 上要有已登录的 gh）：${run.error.message}`)
  if (run.status !== 0) fail(`gh ${args.join(' ')} exited ${run.status}: ${(run.stderr ?? '').trim()}`)
  return run.stdout
}

function fail(message) {
  console.error(`frontier: ${message}`)
  process.exit(1)
}

const USAGE = [
  'usage: node scripts/frontier.mjs [--label <label>] [--repo <owner/name>] [--json]',
  `  --label   frontier 的 label（默认 ${DEFAULT_LABEL}）`,
  '  --repo    目标仓库（默认经 gh 取当前仓库）',
  '  --json    输出机器可读 JSON（frontier + gated）',
].join('\n')

/** CLI 主体：取数 → 纯函数 → 打印。 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { console.log(USAGE); return }
  const repo = args.repo ?? gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()
  const label = args.label ?? DEFAULT_LABEL

  const raw = JSON.parse(gh([
    'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200',
    '--json', 'number,title,labels,assignees,state',
  ]))
  const issues = raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: (issue.labels ?? []).map((l) => l.name),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    state: String(issue.state ?? 'open'),
    // body 故意不取：正文的 "Blocked by" 文字不是权威（见文件头注）。
  }))

  // 逐票取**原生依赖边**，自行按 state 过滤。用这个端点而非
  // `issue_dependencies_summary.blocked_by`：后者写入后滞后，读不出"边存在但已满足"。
  const openBlockers = new Map()
  for (const issue of issues) {
    const blockers = JSON.parse(gh([
      'api', `repos/${repo}/issues/${issue.number}/dependencies/blocked_by`,
      '--jq', '[.[] | select((.state | ascii_downcase) == "open") | .number]',
    ]))
    if (blockers.length > 0) openBlockers.set(issue.number, blockers)
  }

  const { frontier, gated } = readyFrontier(issues, openBlockers, { label })

  if (args.json === true) {
    console.log(JSON.stringify({ repo, label, frontier, gated }, null, 2))
    return
  }

  console.log(`\n=== ready frontier（${label} · open · 无 open 阻塞 · 无 assignee）: ${frontier.length} ===`)
  for (const issue of frontier) console.log(`  #${issue.number}  ${issue.title}`)
  console.log(`\n=== 被 gate（${label} 但有 open 阻塞 / assignee）: ${gated.length} ===`)
  for (const issue of gated) {
    const reasons = [
      issue.blockers.length > 0 ? `← ${issue.blockers.map((b) => '#' + b).join(', ')}` : '',
      issue.assignees.length > 0 ? `assigned: ${issue.assignees.map((a) => '@' + a).join(', ')}` : '',
    ].filter(Boolean).join('   ')
    console.log(`  #${issue.number}  ${reasons}`)
  }
}

// 只有**直接执行**才跑 CLI：被 import（离线单测）时只暴露纯函数。
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
/**
 * posix-signal-lane.mjs —— POSIX **真信号投递**的实机车道（`#144`）。
 *
 * ## 为什么存在
 *
 * `pty_signal` 的 POSIX 分支（`src/pty/session-core.ts` 的 `signal()`）用
 * `process.kill(-pid, signal)` 投递到会话的**进程组**，但本仓两条常驻车道都跑在 Windows 上：
 * unit 档用注入的 `procKill` 缝钉的是**调用形状**（投递目标是 `-pid`、返回
 * `semantics: "signal"`），machine 档（`tests/pty-signal-machine.spec.ts`）走的是 ConPTY 的
 * **只有终止**语义。⇒ 代码里声明的「真信号投递」在任何车道里都**没有执行证据**。
 *
 * 本车道补的就是那一半：在 Linux 容器里开**真实**会话核心（默认 spawner =
 * `defaultSpawnPty` 的 `/bin/sh -c` 分支；`procKill` / `platform` 都用真实值），判据是
 * **信号真的到达了执行中的进程**（trap 被触发），不是「投递调用没抛错」。
 *
 * ## 一条命令
 *
 * ```sh
 * node scripts/posix-signal-lane.mjs
 * ```
 *
 * 它只做三件事：确认 podman 在、把本仓的 `src/` 与 `scripts/` **只读**挂进
 * `node:24-bookworm-slim`、在容器内装 Linux 版 `@lydell/node-pty` 再跑 `--in-container`
 * 那半边。依赖装在**容器的可写层**（不写本仓 `node_modules`），镜像钉死、node-pty 版本
 * **从 `package.json` 的依赖锚派生**（单一来源：依赖 bump 之后车道跟着走，不会静默测旧版）
 * ⇒ 同一台机器上一次装配、之后可复跑。
 *
 * ## 判据（读数，不是断言）
 *
 * 1. **AC2 前半 + AC3** —— 会话自己装 INT trap（记一笔继续跑）；投递 `SIGINT` 后 `tail`
 *    必须读到 trap 的输出，且**信前不得已有该标记**（needle 要求 `pid=<数字>`，而命令文本里
 *    是**未展开**的 `$$` ⇒ 输入回声单独满足不了它）。投递后会话仍 running，再 `close` ——
 *    必须 **`/proc` 里整组消失**（不是「返回 `closed:true` 但进程还在」）。
 * 2. **AC2 后半** —— 票面 What to build 3 的形态：trap 里 `exit 0`。trap 命中之后会话必须按
 *    **命令自身语义退出**（`status = { kind: "exited", exitCode: 0 }`），不是只命中就完事。
 * 3. **AC4 正向** —— 一个**前台**子进程（与领导者同进程组）自己装 trap：组投递必须让
 *    **子进程的 trap 也触发** ⇒「投到组而不是单 pid」有实测读数。
 * 4. **AC4 反向（措辞的负控制）** —— `set -m` 让后台作业进**自己的进程组**：同一条组投递
 *    **够不着**它（它活着、trap 没响），而领导者自己的 trap 照响。量到的是
 *    `PTY_SIGNAL_SEMANTICS` 里「交互式 shell 把前台作业放进独立进程组时收不到」那一句的形态；
 *    「Node 没有 `tcgetpgrp`」是 API 事实，不由本读数覆盖。
 * 5. **AC4 的形态说明** —— 票面建议的 `child & wait` 原形态：同组的**异步**子进程**活着、
 *    trap 不响**（POSIX：异步命令 exec 前把 `SIGINT` 置为 ignored，子 shell 因此装不上 trap），
 *    而领导者 trap 照响。⇒ 那个形态会读出「子进程没收到」的**假结论**；要量子进程得让它做
 *    **前台**命令（场景 3）。这条不是引经据典，是本车道自己的读数。
 *
 * ## 退出码（三态，**2 = 没跑**，不是第四种判定）
 *
 * - `0` 车道跑完、`RESULT: PASS` 且全部读数成立；
 * - `1` 车道跑完、有读数不成立（真红；probe 打出 `RESULT: FAIL`）；
 * - `2` 车道**没跑完**：没有 podman / 镜像拉不下来 / 容器内装依赖失败 / 参数不对 /
 *   墙钟超时 / 输出里没有 `RESULT` 行。「没跑」与「判过」必须分开。
 *
 * ## 与 Windows 默认车道的关系（AC5）
 *
 * 本脚本住在 `scripts/`，而 unit 车道按**位置约定**只收集 `tests/` 下的 `*.spec.ts`
 * （machine 车道是显式清单）⇒ 它结构上进不了任何 Windows 车道。`--in-container` 那半边在
 * win32 上被 `parseArgs` **响亮拒绝**（Windows 没有 `/proc`，也没有 POSIX 信号）。
 * `docs/agents/TESTING.md` 只记一行入口。
 *
 * ## 容器里的两个装配细节（都不是可选的）
 *
 * - `/work/package.json` 必须带 `"type": "module"`：`src/` 下 `.ts` 文件的模块格式取自最近的
 *   `package.json`；缺了它 Node 把 `.ts` 当 CJS，`import` 语法直接炸（与「类型剥离」无关）。
 * - 挂载点是 `src/` 与 `scripts/`，**不是**仓库根：本仓的 `node_modules/` 是 win32 二进制，
 *   挂进去会让 `@lydell/node-pty` 在容器里找到错误的平台包。
 *
 * ## 为什么要墙钟看门狗 + 显式收场
 *
 * `killSession` 不真杀时，会话的 pty handle 会一直活着 ⇒ probe 进程的事件循环不会自己退出
 * （本票在加看门狗之前的一次变异跑正是这样挂住的；那次读数与他日志同名，已被后来的
 * **有界**红跑覆盖 ⇒ 代码里只按机制陈述，不再声称「实测」）。两道防线：host 侧的
 * {@link LANE_TIMEOUT_MS} 墙钟，与 probe 末尾 flush 两个流之后的显式 `process.exit`。
 *
 * 结构（`#144`）：`parseArgs` / `containerPlan` / `scenarioCommand` / `trapPid` /
 * `groupMembersIn` / `judgeChecks` / `formatCheck` 是**纯函数**（离线单测见
 * `tests/posix-signal-lane.spec.ts`）；
 * `main` 亦导出但**非纯**（CLI 入口：调度 host 半边或容器内 probe）。
 *
 * @module scripts/posix-signal-lane
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectInvocation } from './script-entry.mjs'

/** 车道镜像：`#68` 的 POSIX 先例同源（bookworm + 官方 node 24）。 */
const LANE_IMAGE = 'node:24-bookworm-slim'

/**
 * 容器内 `/work` 的最小 `package.json`。`"type": "module"` 是**必需**的
 * （缺了 `.ts` 会被当成 CJS，头注「两个装配细节」讲了为什么）。
 */
const MINIMAL_PACKAGE_JSON = '{"name":"posix-signal-lane","private":true,"type":"module"}'

/** 容器内 probe 半边的开关（也是 win32 上的拒绝开关，见 `parseArgs`）。 */
const PROBE_FLAG = '--in-container'

const EXIT_OK = 0
const EXIT_RED = 1
/** **没跑**（环境不可用 / 参数不对 / 超时 / 没打出 RESULT）—— 不是第四种判定。 */
const EXIT_UNAVAILABLE = 2

/** 容器内轮询间隔（ms）；上界在每个调用点写。 */
const POLL_MS = 20

/** 场景 4/5 的**观测窗**：给「其实收到了」一个出现的机会，再判「没收到」。 */
const OBSERVE_MS = 500

/**
 * host 半边的**墙钟看门狗**：容器里装依赖 + 五个场景正常在 1 分钟内；超过这个上界说明
 * 有东西挂住了（见头注「为什么要墙钟看门狗」）。挂住必须**响亮**、并在有界时间内收场 ——
 * 否则「没跑完」会伪装成「还在跑」。
 */
const LANE_TIMEOUT_MS = 180_000

/** 每条会话的 owner（core 的 owner 作用域，与工具面同构）。 */
const OWNER = { name: 'posix-signal-lane' }

/**
 * trap 标记的 **needle**（`#99` 的展开值纪律）：要求 `pid=<数字>`。
 * 命令文本里的形态是未展开的 `$$` ⇒ **输入回声单独满足不了**这条判据。
 */
const NEEDLES = {
  leaderReady: /P-READY pid=\d+/u,
  leaderFired: /P-FIRED pid=\d+/u,
  childReady: /C-READY pid=\d+/u,
  childFired: /C-FIRED pid=\d+/u,
}

const USAGE = `posix-signal-lane (#144) —— POSIX 真信号投递实机 lane

  node scripts/posix-signal-lane.mjs              host 半边：起容器（需要 podman）
  node scripts/posix-signal-lane.mjs --in-container   容器内 probe 半边（仅 Linux）

退出码：0 全绿 / 1 读数不成立（判定为红）/ 2 没跑完（环境、参数、超时或没有 RESULT 行）`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 解析 CLI 参数（纯函数）。
 *
 * `--in-container` 在**非 Linux** 上**响亮拒绝**：那半边读 `/proc`、投 POSIX 信号，
 * Windows 上两者都没有 —— 让它跑起来只会得到误导性的失败（AC5 的机械面）。
 *
 * @param {readonly string[]} argv 命令行参数（不含 node 与脚本路径）
 * @param {NodeJS.Platform} [platform] 平台守卫（注入以便离线单测）
 * @returns {{mode: 'host' | 'probe'}} 或 `{help: true}` 或 `{error: string}`
 */
export function parseArgs(argv, platform = process.platform) {
  let mode = 'host'
  for (const arg of argv) {
    if (arg === PROBE_FLAG) {
      mode = 'probe'
      continue
    }
    if (arg === '--help' || arg === '-h') return { help: true }
    return { error: `未知参数：${JSON.stringify(arg)}（只认 ${PROBE_FLAG} 与 --help）` }
  }
  if (mode === 'probe' && platform !== 'linux') {
    return {
      error:
        `${PROBE_FLAG} 只能在 Linux 容器里跑（当前 platform=${platform}）：` +
        '那半边读 /proc 并投 POSIX 信号，Windows 上两者都没有 —— 本车道不进 Windows 默认车道',
    }
  }
  return { mode }
}

/**
 * 容器计划（纯函数）：podman argv + 容器内的 sh 脚本 + 两条只读挂载。
 *
 * `nodePtySpec` **必须由调用方给**（host 半边从 `package.json` 的依赖锚读出）：版本串只许有
 * 一个真相源，否则依赖 bump 之后车道会静默测旧版（本仓把「依赖锚」列为高危面）。
 * 挂载面**只有** `src/` 与 `scripts/`（不是仓库根）：本仓 `node_modules/` 是 win32 二进制，
 * 挂进容器会让 `@lydell/node-pty` 解析到错误的平台包（头注「两个装配细节」）。
 *
 * @param {{repoRoot: string, nodePtySpec: string}} options 仓库根 + node-pty 的安装规格
 * @returns {{image: string, spec: string, mounts: string[], command: string, argv: string[]}}
 */
export function containerPlan({ repoRoot, nodePtySpec }) {
  if (typeof nodePtySpec !== 'string' || nodePtySpec === '') {
    throw new Error('containerPlan: 需要 nodePtySpec（来自 package.json 的依赖锚，不许在这里再写一份版本串）')
  }
  const mounts = [
    `${join(repoRoot, 'src')}:/work/src:ro`,
    `${join(repoRoot, 'scripts')}:/work/scripts:ro`,
  ]
  const command = [
    'mkdir -p /work',
    'cd /work',
    `printf '%s' '${MINIMAL_PACKAGE_JSON}' > package.json`,
    `if ! npm install --no-save --no-audit --no-fund --loglevel=error ${nodePtySpec}; then`,
    `  echo 'LANE-UNAVAILABLE: 容器内装 ${nodePtySpec} 失败（需要 npm registry 访问）' >&2`,
    `  exit ${EXIT_UNAVAILABLE}`,
    'fi',
    // 版本串随 env 进 probe，供读数行自报（probe 读不到本仓 package.json：容器里只有最小那份）。
    `export LANE_PTY_SPEC='${nodePtySpec}'`,
    // 刻意**不** `exec` node：`exec` 会把 probe 变成容器 PID 1，而 Node 不回收「不是自己
    // 起的」子进程 ⇒ 被信号打死的 `sleep` 会留在 `/proc` 里当僵尸，让「组已清空」的读数
    // 永远不成立（本票实测：8s 上界到了组里还有人）。留着 sh 当 PID 1，它会回收孤儿。
    `node /work/scripts/posix-signal-lane.mjs ${PROBE_FLAG}`,
    'code=$?',
    'echo "posix-signal-lane: container probe exit=$code"',
    'exit $code',
  ].join('\n')
  const argv = ['podman', 'run', '--rm', ...mounts.flatMap((mount) => ['-v', mount]), LANE_IMAGE, 'sh', '-c', command]
  return { image: LANE_IMAGE, spec: nodePtySpec, mounts, command, argv }
}

/**
 * 五个场景的被 spawn 命令（纯函数，`/bin/sh -c` 语义下的**一整行**）。
 *
 * 只导出命令、不导出 needle：判据面在 {@link trapPid}，命令与 needle 的配对由它保证
 * （`$$` 与 `pid=\d+` 必须成对出现，否则输入回声就能满足判据）。
 *
 * @param {'leader' | 'exit-trap' | 'group-child' | 'job-control' | 'async-child'} kind 场景
 * @returns {string} 交给 `pty_open` 的 command 文本
 */
export function scenarioCommand(kind) {
  const child = `/bin/sh -c 'trap "echo C-FIRED pid=$$" INT; echo "C-READY pid=$$"; while :; do sleep 0.2; done'`
  const leader = `trap 'echo "P-FIRED pid=$$"' INT; echo "P-READY pid=$$"`
  if (kind === 'leader') return `${leader}; while :; do sleep 0.2; done`
  if (kind === 'exit-trap') return `trap 'echo "P-FIRED pid=$$"; exit 0' INT; echo "P-READY pid=$$"; while :; do sleep 0.2; done`
  // 前台子命令：与领导者同进程组、且**不是**异步命令 ⇒ SIGINT 没被 exec 前置成 ignored，
  // 它的 trap 装得上（AC4 正向的读数前提）。
  if (kind === 'group-child') return `${leader}; ${child}`
  // 作业控制：后台作业进自己的进程组 ⇒ 组投递够不着（AC4 反向）。
  if (kind === 'job-control') return `set -m; ${leader}; ${child} & wait`
  // 票面建议的 `child & wait` 原形态：子进程是**异步命令** ⇒ SIGINT 进入时即 ignored，
  // trap 装不上；领导者 trap 照响。用来证明那个形态会读出假结论（场景说明见头注）。
  if (kind === 'async-child') return `${leader}; ${child} & wait; while :; do sleep 0.2; done`
  throw new Error(
    `scenarioCommand: 未知场景 ${JSON.stringify(kind)}（可选 leader / exit-trap / group-child / job-control / async-child）`,
  )
}

/**
 * 从 tail 累积文本里取某个 trap 标记的**展开后 pid**（纯函数）。
 *
 * @param {string} text 会话输出（tail 累积）
 * @param {'leaderReady' | 'leaderFired' | 'childReady' | 'childFired'} kind needle 名
 * @returns {number | undefined} 命中的 pid；未命中（含**回声帧** `pid=$$`）返回 undefined
 */
export function trapPid(text, kind) {
  const needle = NEEDLES[kind]
  if (needle === undefined) throw new Error(`trapPid: 未知 needle ${JSON.stringify(kind)}`)
  const match = needle.exec(String(text))
  if (match === null) return undefined
  const digits = /\d+/u.exec(match[0])
  return digits === null ? undefined : Number(digits[0])
}

/**
 * `/proc/<pid>/stat` 的组归属筛选（纯函数）。
 *
 * `comm` 可以含空格与右括号（例如 `(my (weird) comm)`），所以字段从**最后一个** `)` 之后切；
 * `state ppid pgrp …` 里下标 2 是 pgrp。
 *
 * @param {readonly {pid: number, stat: string}[]} entries `/proc` 快照
 * @param {number} pgid 目标进程组
 * @returns {number[]} 属于该组的 pid（保持输入顺序）
 */
export function groupMembersIn(entries, pgid) {
  const members = []
  for (const { pid, stat } of entries) {
    const close = stat.lastIndexOf(')')
    if (close < 0) continue
    const fields = stat.slice(close + 2).split(' ')
    if (Number(fields[2]) === pgid) members.push(pid)
  }
  return members
}

/**
 * 判定一组读数（纯函数）。
 *
 * **空读数不算 PASS**：没有读数 = 没有证据（本仓「空日志与没跑不可区分」那条纪律的机械面）。
 *
 * @param {readonly {id: string, ok: boolean, detail: string}[]} checks 读数
 * @returns {{ok: boolean, failures: string[], exitCode: number}}
 */
export function judgeChecks(checks) {
  const failures = checks.filter((check) => check.ok !== true).map((check) => check.id)
  const ok = checks.length > 0 && failures.length === 0
  return { ok, failures, exitCode: ok ? EXIT_OK : EXIT_RED }
}

/** 一行读数（纯函数）：`[OK  ] <id> — <detail>` / `[FAIL] <id> — <detail>`。 */
export function formatCheck(check) {
  return `[${check.ok === true ? 'OK  ' : 'FAIL'}] ${check.id} — ${check.detail}`
}

/** 轮询到条件成立；返回**实测**等待毫秒（上界与实测值分开报）。 */
async function pollUntil(probe, { timeoutMs, what }) {
  const startedAt = Date.now()
  for (;;) {
    if (await probe()) return Date.now() - startedAt
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= timeoutMs) {
      throw new Error(`${what}：在 ${timeoutMs}ms（上界）内未成立，实际等了 ${elapsedMs}ms`)
    }
    await sleep(POLL_MS)
  }
}

/** 全量 `/proc` 快照（容器内 Linux；win32 由 `parseArgs` 挡在门外）。 */
function readProcEntries() {
  const entries = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue
    const pid = Number(name)
    try {
      entries.push({ pid, stat: readFileSync(`/proc/${pid}/stat`, 'utf8') })
    } catch {
      // 进程在这一瞬间退出：调用方关心的是「还剩下谁」，丢一条无妨。
    }
  }
  return entries
}

/** `process.kill(pid, 0)` 的存活判据（ESRCH ⇒ false）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 一条会话的 tail 累积读数：`drain()` 把新行吸进 transcript 再返回全文。 */
function tailer(core, sessionId, initialOutput) {
  let transcript = initialOutput
  return {
    drain() {
      transcript += core.tail(OWNER, sessionId, 500).text
      return transcript
    },
    text() {
      return transcript
    },
  }
}

/**
 * 五个场景共用的前奏（`open` → pid 断言 → tail 累积）。
 *
 * 三个字段（sessionId / leaderPid / tail）总是一起旅行 ⇒ 打成一个对象，别在五个场景里各抄
 * 一遍同形前奏（`#144` 复核点名的 Duplicated Code + Data Clumps）。
 */
async function openScenario(core, kind) {
  const opened = await core.open(OWNER, { command: scenarioCommand(kind) })
  if (opened.pid === undefined) throw new Error('会话没有 pid —— POSIX node-pty 应当给出 pid')
  return {
    command: scenarioCommand(kind),
    sessionId: opened.sessionId,
    leaderPid: opened.pid,
    tail: tailer(core, opened.sessionId, opened.initialOutput),
  }
}

/** 投递 `SIGINT` 并记一条「投递形状」读数（五个场景同形，点名各自的前缀）。 */
function deliverSigint(core, checks, scenario, id) {
  const result = core.signal(OWNER, scenario.sessionId, 'SIGINT')
  checks.push({
    id,
    ok: result.delivered === true && result.semantics === 'signal',
    detail: JSON.stringify(result),
  })
  return result
}

/** 轮询到某个 needle 命中，返回命中的 pid 与实测等待毫秒。 */
async function waitForNeedle(tail, kind, { timeoutMs, what }) {
  let pid
  const waitedMs = await pollUntil(
    () => {
      pid = trapPid(tail.drain(), kind)
      return pid !== undefined
    },
    { timeoutMs, what },
  )
  return { pid, waitedMs }
}

/**
 * `close` 之后按 `/proc` 判「整组消失」，并记两条读数（AC3 的判据本体）。
 *
 * @returns {{closedMs: number, members: number[]}}
 */
async function closeAndJudgeGroupGone(core, checks, scenario, ids) {
  const closed = await core.close(OWNER, scenario.sessionId)
  checks.push({ id: ids.closed, ok: closed.closed === true, detail: JSON.stringify(closed) })
  let members = groupMembersIn(readProcEntries(), scenario.leaderPid)
  const closedMs =
    members.length === 0
      ? 0
      : await pollUntil(
          () => {
            members = groupMembersIn(readProcEntries(), scenario.leaderPid)
            return members.length === 0
          },
          { timeoutMs: 8000, what: `pty_close 之后进程组 ${scenario.leaderPid} 仍然有成员` },
        )
  checks.push({
    id: ids.groupGone,
    ok: members.length === 0,
    detail: `组 ${scenario.leaderPid} 成员=${JSON.stringify(members)}（${closedMs}ms 内清空；判据是 /proc 快照，不是 close 的返回值）`,
  })
  return { closedMs, members }
}

/** 场景标题 + 被 spawn 的命令 + 会话输出（证据：回声形态与展开形态在同一份日志里可辨）。 */
function printTranscript(title, scenario) {
  console.log(`\n--- ${title} ---`)
  console.log(`spawned command（原样；**不是**会话输出 —— 其中的 pid=$$ 未展开，输入回声长这样）：`)
  console.log(`  $ ${scenario.command}`)
  console.log('会话输出（tail 累积，每行以 `| ` 起）：')
  const lines = scenario.tail.text().split('\n').filter((line) => line !== '')
  for (const line of lines) console.log(`  | ${line}`)
  if (lines.length === 0) console.log('  | （空）')
}

/** 场景 1：trap 命中（AC2 前半）+ 投递后 close 仍真终止（AC3）。 */
async function scenarioTrapAndClose(core, checks) {
  const scenario = await openScenario(core, 'leader')
  const { leaderPid, tail } = scenario

  const ready = await waitForNeedle(tail, 'leaderReady', {
    timeoutMs: 8000,
    what: 'P-READY 未出现在 tail 里（会话没起来，或 trap 没装上）',
  })
  checks.push({
    id: 'ac2-leader-ready',
    ok: ready.pid === leaderPid,
    detail: `P-READY pid=${String(ready.pid)}；opened.pid=${leaderPid}（${ready.waitedMs}ms）`,
  })
  checks.push({
    id: 'ac2-marker-absent-before-signal',
    ok: trapPid(tail.drain(), 'leaderFired') === undefined,
    detail:
      '信前输出里没有 P-FIRED pid=<数字>：命令文本里的形态是未展开的 P-FIRED pid=$$，' +
      '而 needle 要求 pid=<数字> ⇒ 输入回声单独满足不了判据',
  })

  deliverSigint(core, checks, scenario, 'ac2-signal-result')

  const fired = await waitForNeedle(tail, 'leaderFired', {
    timeoutMs: 8000,
    what: 'SIGINT 之后 tail 里没有 P-FIRED pid=<数字>（信号没到达执行中的进程）',
  })
  checks.push({
    id: 'ac2-trap-fires',
    ok: fired.pid === leaderPid,
    detail: `P-FIRED pid=${String(fired.pid)}；会话 pid=${leaderPid}（投递后 ${fired.waitedMs}ms 读到）`,
  })

  const row = core.list(OWNER).find((entry) => entry.id === scenario.sessionId)
  checks.push({
    id: 'ac3-signal-does-not-close',
    ok: row !== undefined && row.status.kind === 'running',
    detail: `list ⇒ ${JSON.stringify(row)}（trap 是「记一笔继续跑」，故投递后仍应 running）`,
  })

  await closeAndJudgeGroupGone(core, checks, scenario, {
    closed: 'ac3-close-returns',
    groupGone: 'ac3-group-gone',
  })
  const alive = pidAlive(leaderPid)
  checks.push({
    id: 'ac3-pid-gone',
    ok: alive === false,
    detail: `process.kill(${leaderPid}, 0) ⇒ ${alive ? '仍存活' : 'ESRCH（进程已不在）'}`,
  })

  printTranscript('场景 1（AC2 前半 trap 命中 / AC3 close 仍真终止）', scenario)
}

/** 场景 2：票面 What to build 3 的形态 —— trap 命中后会话按**命令自身语义**退出（`exit 0`）。 */
async function scenarioTrapExit(core, checks) {
  const scenario = await openScenario(core, 'exit-trap')
  const { leaderPid, tail } = scenario

  await waitForNeedle(tail, 'leaderReady', {
    timeoutMs: 8000,
    what: 'P-READY 未出现在 tail 里（会话没起来，或 trap 没装上）',
  })
  deliverSigint(core, checks, scenario, 'ac2b-signal-result')

  const fired = await waitForNeedle(tail, 'leaderFired', {
    timeoutMs: 8000,
    what: 'SIGINT 之后 tail 里没有 P-FIRED pid=<数字>（信号没到达执行中的进程）',
  })
  checks.push({
    id: 'ac2b-trap-fires',
    ok: fired.pid === leaderPid,
    detail: `P-FIRED pid=${String(fired.pid)}；会话 pid=${leaderPid}（投递后 ${fired.waitedMs}ms 读到）`,
  })

  // 「随后会话按命令自身语义退出」：判据是**真实退出事件**给出的 status/exitCode，不是猜。
  let status
  const exitMs = await pollUntil(
    () => {
      status = core.list(OWNER).find((entry) => entry.id === scenario.sessionId)?.status
      return status?.kind === 'exited'
    },
    { timeoutMs: 8000, what: 'trap 里 exit 0 之后会话没有退出（status 仍 running）' },
  )
  checks.push({
    id: 'ac2b-exits-with-own-code',
    ok: status?.kind === 'exited' && status.exitCode === 0,
    detail: `status=${JSON.stringify(status)}（trap 的 exit 0 在 ${exitMs}ms 后落成真实退出码）`,
  })

  await closeAndJudgeGroupGone(core, checks, scenario, {
    closed: 'ac2b-close-returns',
    groupGone: 'ac2b-group-gone',
  })
  printTranscript('场景 2（AC2 后半 trap 命中后按命令自身语义退出）', scenario)
}

/** 场景 3：组投递的正向——**前台**子进程（同组）自己的 trap 也被触发（AC4）。 */
async function scenarioGroupChild(core, checks) {
  const scenario = await openScenario(core, 'group-child')
  const { leaderPid, tail } = scenario

  const ready = await waitForNeedle(tail, 'childReady', {
    timeoutMs: 8000,
    what: 'C-READY 未出现在 tail 里（前台子进程没起来）',
  })
  const childPid = ready.pid
  checks.push({
    id: 'ac4-child-is-not-leader',
    ok: childPid !== leaderPid,
    detail: `child=${String(childPid)}；leader=${leaderPid}`,
  })

  const members = groupMembersIn(readProcEntries(), leaderPid)
  checks.push({
    id: 'ac4-child-in-leader-group',
    ok: members.includes(childPid),
    detail: `组 ${leaderPid} 成员=${JSON.stringify(members)}（含 child=${members.includes(childPid)}）`,
  })
  checks.push({
    id: 'ac4-child-trap-not-fired-before-signal',
    ok: trapPid(tail.drain(), 'childFired') === undefined,
    detail: '信前输出里没有 C-FIRED pid=<数字>（命令文本里是未展开的 C-FIRED pid=$$）',
  })

  deliverSigint(core, checks, scenario, 'ac4-group-signal-result')

  const fired = await waitForNeedle(tail, 'childFired', {
    timeoutMs: 8000,
    what: 'SIGINT 之后子进程的 C-FIRED 未出现（信号只到 leader？）',
  })
  checks.push({
    id: 'ac4-child-trap-fires',
    ok: fired.pid === childPid,
    detail: `C-FIRED pid=${String(fired.pid)}；child=${String(childPid)}（投递后 ${fired.waitedMs}ms 读到）`,
  })

  await closeAndJudgeGroupGone(core, checks, scenario, {
    closed: 'ac4-group-close-returns',
    groupGone: 'ac4-group-gone',
  })
  printTranscript('场景 3（AC4 正向：前台子进程同组，组投递也触发它的 trap）', scenario)
}

/** 场景 4：措辞的负控制——`set -m` 的独立进程组**够不着**。 */
async function scenarioJobControl(core, checks) {
  const scenario = await openScenario(core, 'job-control')
  const { leaderPid, tail } = scenario

  const ready = await waitForNeedle(tail, 'childReady', {
    timeoutMs: 8000,
    what: 'C-READY 未出现在 tail 里（set -m 的后台作业没起来）',
  })
  const childPid = ready.pid
  const members = groupMembersIn(readProcEntries(), leaderPid)
  checks.push({
    id: 'ac4b-child-own-group',
    ok: childPid !== leaderPid && members.includes(childPid) === false,
    detail: `组 ${leaderPid} 成员=${JSON.stringify(members)}；child=${childPid}（不在该组 ⇒ 作业控制给了它自己的组）`,
  })

  deliverSigint(core, checks, scenario, 'ac4b-signal-result')

  const fired = await waitForNeedle(tail, 'leaderFired', {
    timeoutMs: 8000,
    what: 'SIGINT 之后领导者自己的 P-FIRED 未出现（投递本身失效，本节无判别力）',
  })
  checks.push({
    id: 'ac4b-leader-trap-fires',
    ok: fired.pid === leaderPid,
    detail: `P-FIRED pid=${String(fired.pid)}；leader=${leaderPid}（投递后 ${fired.waitedMs}ms 读到）`,
  })

  // 观测窗：投递是同步的，trap 的 echo 是毫秒级；给「其实收到了」一个出现的机会再判「没收到」。
  await sleep(OBSERVE_MS)
  tail.drain()
  const childFired = trapPid(tail.text(), 'childFired')
  const childAlive = pidAlive(childPid)
  checks.push({
    id: 'ac4b-child-not-reached',
    ok: childFired === undefined && childAlive,
    detail:
      `观察窗 ${OBSERVE_MS}ms：C-FIRED=${childFired === undefined ? '未出现' : String(childFired)}；` +
      `child(${childPid}) 存活=${childAlive}（活着 + trap 没响 ⇒ 信号没到它那个组，不是「它先死了」）`,
  })

  // 收尾：它自己的组收不到组投递，也不会随领导者退出而消失 —— 显式清掉。
  try {
    process.kill(childPid, 'SIGKILL')
  } catch {
    // 已经在窗口里自己退了：没有可清的。
  }
  const cleanedMs = await pollUntil(() => pidAlive(childPid) === false, {
    timeoutMs: 8000,
    what: `场景 4 收尾：child ${childPid} 在 SIGKILL 之后仍然活着`,
  })
  const closed = await core.close(OWNER, scenario.sessionId)
  checks.push({
    id: 'ac4b-cleanup',
    ok: true,
    detail: `child ${childPid} 在 SIGKILL 后 ${cleanedMs}ms 消失；close=${JSON.stringify(closed)}`,
  })
  printTranscript('场景 4（AC4 反向：set -m 的独立组够不着）', scenario)
}

/** 场景 5：票面建议的 `child & wait` 原形态会假读（异步子进程 SIGINT=ignored ⇒ trap 装不上）。 */
async function scenarioAsyncChild(core, checks) {
  const scenario = await openScenario(core, 'async-child')
  const { leaderPid, tail } = scenario

  const ready = await waitForNeedle(tail, 'childReady', {
    timeoutMs: 8000,
    what: 'C-READY 未出现在 tail 里（异步子进程没起来）',
  })
  const childPid = ready.pid
  const members = groupMembersIn(readProcEntries(), leaderPid)
  checks.push({
    id: 'ac4c-child-in-leader-group',
    ok: members.includes(childPid),
    detail: `组 ${leaderPid} 成员=${JSON.stringify(members)}（异步子进程与领导者**同组**，无 set -m）`,
  })

  deliverSigint(core, checks, scenario, 'ac4c-signal-result')

  const fired = await waitForNeedle(tail, 'leaderFired', {
    timeoutMs: 8000,
    what: 'SIGINT 之后领导者自己的 P-FIRED 未出现（投递本身失效，本节无判别力）',
  })
  checks.push({
    id: 'ac4c-leader-trap-fires',
    ok: fired.pid === leaderPid,
    detail: `P-FIRED pid=${String(fired.pid)}；leader=${leaderPid}（投递后 ${fired.waitedMs}ms 读到）`,
  })

  await sleep(OBSERVE_MS)
  tail.drain()
  const childFired = trapPid(tail.text(), 'childFired')
  const childAlive = pidAlive(childPid)
  checks.push({
    id: 'ac4c-async-child-trap-inert',
    ok: childFired === undefined && childAlive,
    detail:
      `观察窗 ${OBSERVE_MS}ms：C-FIRED=${childFired === undefined ? '未出现' : String(childFired)}；` +
      `child(${childPid}) 存活=${childAlive}（同组 + 组投递已生效（领导者 trap 响）+ 子进程活着而 trap 不响` +
      ' ⇒ 异步命令 exec 前 SIGINT 被置 ignored，trap 装不上）',
  })

  // 收尾：SIGKILL 不可被忽略；它的 `sleep` 子进程是短命循环，组会在 0.2s 内自然清空。
  try {
    process.kill(childPid, 'SIGKILL')
  } catch {
    // 已在观测窗里自己退了。
  }
  const cleanedMs = await pollUntil(() => pidAlive(childPid) === false, {
    timeoutMs: 8000,
    what: `场景 5 收尾：child ${childPid} 在 SIGKILL 之后仍然活着`,
  })
  const closed = await core.close(OWNER, scenario.sessionId)
  checks.push({
    id: 'ac4c-cleanup',
    ok: true,
    detail: `child ${childPid} 在 SIGKILL 后 ${cleanedMs}ms 消失；close=${JSON.stringify(closed)}`,
  })
  printTranscript('场景 5（AC4 形态说明：`child & wait` 的异步子进程 trap 装不上，会假读）', scenario)
}

/** 容器内 probe 半边：真核心 + 五个场景 + 读数汇总。 */
async function runProbe() {
  const { createSessionCore } = await import(new URL('../src/pty/session-core.ts', import.meta.url).href)
  console.log('=== posix-signal-lane (#144) — POSIX 真信号投递实机 lane ===')
  console.log(
    `platform=${process.platform} node=${process.version} pty=${process.env.LANE_PTY_SPEC ?? '(host 未注入)'} image=${LANE_IMAGE}`,
  )
  console.log(
    'needle 纪律：P-FIRED / C-FIRED 都要求 `pid=<数字>`；命令文本里是未展开的 `pid=$$` ⇒ 输入回声单独满足不了判据。',
  )

  const checks = []
  const core = createSessionCore()
  const runScenario = async (label, fn) => {
    try {
      await fn(core, checks)
    } catch (error) {
      checks.push({
        id: `${label}-aborted`,
        ok: false,
        detail: `场景中途抛错：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  try {
    await runScenario('scenario-1', scenarioTrapAndClose)
    await runScenario('scenario-2', scenarioTrapExit)
    await runScenario('scenario-3', scenarioGroupChild)
    await runScenario('scenario-4', scenarioJobControl)
    await runScenario('scenario-5', scenarioAsyncChild)
  } finally {
    await core.dispose()
  }

  const verdict = judgeChecks(checks)
  console.log('\n--- 读数 ---')
  for (const check of checks) console.log(formatCheck(check))
  console.log(
    verdict.ok
      ? `\nRESULT: PASS（${checks.length}/${checks.length} 项读数成立）`
      : `\nRESULT: FAIL（${verdict.failures.length}/${checks.length} 项不成立：${verdict.failures.join(', ')}）`,
  )
  return verdict.exitCode
}

/**
 * 从 `package.json` 的依赖面读 node-pty 的版本锚（**单一来源**）。
 *
 * 车道不许自带一份版本字面量：依赖 bump 之后车道会静默测旧版，而本仓把「依赖锚」列为高危面。
 */
function readNodePtySpec(repoRoot) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const version = manifest?.dependencies?.['@lydell/node-pty']
  if (typeof version !== 'string' || version === '') {
    throw new Error('posix-signal-lane: package.json 的 dependencies["@lydell/node-pty"] 缺失 —— 车道不知道该装哪一版')
  }
  return `@lydell/node-pty@${version}`
}

/** host 半边：起容器、把输出转发出来、把退出码翻译成三态。 */
function runHost() {
  const version = spawnSync('podman', ['--version'], { encoding: 'utf8' })
  if (version.error !== undefined || version.status !== 0) {
    console.error('posix-signal-lane: 这台机器上没有可用的 podman —— POSIX 容器车道跑不了（**不静默跳过**）。')
    console.error(`  need: podman（machine 在跑）+ 可拉取的 ${LANE_IMAGE}`)
    return EXIT_UNAVAILABLE
  }
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const plan = containerPlan({ repoRoot, nodePtySpec: readNodePtySpec(repoRoot) })
  console.log(`posix-signal-lane: ${version.stdout.trim()} · image=${plan.image} · pty=${plan.spec}`)
  console.log('posix-signal-lane: one command = node scripts/posix-signal-lane.mjs')
  const run = spawnSync(plan.argv[0], plan.argv.slice(1), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: LANE_TIMEOUT_MS,
  })
  if (run.error !== undefined) {
    const timedOut = run.error.code === 'ETIMEDOUT' || run.signal !== null
    console.error(
      timedOut
        ? `posix-signal-lane: 车道超过 ${LANE_TIMEOUT_MS}ms 墙钟上界仍未收场 —— 有东西挂住了（不是「判定为红」）。` +
            ' 收尾：podman ps -a 看有没有遗留容器，podman rm -f <name>。'
        : `posix-signal-lane: 启动 podman 失败：${run.error.message}`,
    )
    return EXIT_UNAVAILABLE
  }
  const out = run.stdout ?? ''
  const err = run.stderr ?? ''
  if (out !== '') process.stdout.write(out)
  if (err !== '') process.stderr.write(err)
  const code = run.status ?? EXIT_UNAVAILABLE
  const sawPass = /^RESULT: PASS/mu.test(out)
  const sawFail = /^RESULT: FAIL/mu.test(out)
  // 三态是**对称**的：0 只认 RESULT: PASS，1 只认 RESULT: FAIL；其余一律「没跑完」。
  if (code === EXIT_OK && sawPass) return EXIT_OK
  if (code === EXIT_RED && sawFail) return EXIT_RED
  if (code === EXIT_UNAVAILABLE) return EXIT_UNAVAILABLE
  console.error(
    `posix-signal-lane: 车道没跑完（容器退出码 ${code}；RESULT 行=${sawPass ? 'PASS' : sawFail ? 'FAIL' : '缺失'}）` +
      ' —— 这不是「判定为红」',
  )
  return EXIT_UNAVAILABLE
}

/**
 * CLI 入口（非纯）：`parseArgs` 决定走 host 半边还是容器内 probe 半边。
 * @param {readonly string[]} argv 命令行参数（不含 node 与脚本路径）
 * @returns {Promise<number>} 退出码（0 绿 / 1 红 / 2 没跑完）
 */
async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.error !== undefined) {
    console.error(`posix-signal-lane: ${parsed.error}`)
    return EXIT_UNAVAILABLE
  }
  if (parsed.help === true) {
    console.log(USAGE)
    return EXIT_OK
  }
  if (parsed.mode === 'probe') return runProbe()
  return runHost()
}

export { main }

// 只有**直接执行**才跑 CLI（被 `tests/posix-signal-lane.spec.ts` import 时不得起容器）。
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  const code = await main(process.argv.slice(2))
  // 收尾：probe 的 `dispose()` 之后若还有 pty handle 活着（关闭路径没真杀就会这样），事件循环
  // 不会自己退出 —— 于是「没跑完」会伪装成「还在跑」。先 flush 两个流，再显式收场。
  await Promise.all([
    new Promise((resolve) => process.stdout.write('', resolve)),
    new Promise((resolve) => process.stderr.write('', resolve)),
  ])
  process.exit(code)
}

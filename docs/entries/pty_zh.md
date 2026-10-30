> 摘自 README（issue #28，ADR-0007）。返回 [README](../../README.md)。英文版：[pty.md](pty.md)。

## The `./pty` entry (issue #28, ADR-0007; seam-free since #61, ADR-0010)

`src/pty/` is the absorbed dsh-pty-session module (pure move from the
dsh-pty-session repo, anchored at `dsh-v0.2.1-alpha.1-r1` per ADR-0005): a
Layer 0, protocol-agnostic PTY session core — SEAM-FREE since #61
(ADR-0010): sessions are SELF-MANAGED on node-pty (Windows ConPTY) via
`src/pty/session-core.ts` — an owner-scoped registry (sessionId → live
session, owner binding, awaited dispose cleanup), per-session line buffers
with incremental read cursors, the #56 soft cap (`maxSessions`, default 8,
counted from the registry so an entry remount cannot reset it — the #62
root cause is structurally gone) and the opt-in per-session
`idleTimeoutMs` (auto-close on no new output). Six tools — `pty_open` /
`pty_send` / `pty_tail` / `pty_close` / `pty_list` / `pty_signal` — plus a
programmatic facade (`ctx.provide("pty")`) for consumer plugins. Persistent/
interactive session ownership (ADR-0004 decision 5) is unchanged, and the
entry keeps its own settings namespace (`dsh-pty-session` plugin name,
`maxSessions` + `tailLines` + `defaultShellCommand` config) — ADR-0007: sharing
the package does not merge config surfaces.

```js
import * as pty from 'dsh-shell-host/pty'   // { name, inject, Config, apply }
```

Mount it via the bundle layer with `name: 'dsh-shell-host/pty'` — no
dependency on any platform seam (the bundle patch mounts the pty + ssh +
terminal rows unconditionally).

### 会话默认 shell（#149）：打开时声明一次，之后裸命令直通

`pty_open` 新增 `shellCommand`：一串**裸命令**（可执行 + 它自己的交互 argv，如
`<msys2>/usr/bin/bash.exe --login -i`）。声明之后 `pty_send` 的文本**直接由它解释** ——
`cd` 跨调用生效、管道与 `&&` 可用，**不必**每条命令自己套 `bash -lc "…"`。

- **与 `command` 互斥**：两个都填 = 响亮报错（`INVALID_ARGS`）。一个都不给时才轮到 settings 的
  `defaultShellCommand`；Config 也没配 ⇒ 响亮报错，文案点名三个选项。
  **优先级链 = 显式 `shellCommand` > 显式 `command` > `defaultShellCommand` > 报错** ——
  显式 `command` 是普通进程，**永不吃**全局默认（否则全局默认会改写所有既有调用）。
- **零词汇**：不新增预设 id、不加 `shell: true` 布尔、`shellCommand` **不经** launcher 预设解析
  —— 取值即使长得像预设 id（`msys2-ucrt`）也按**裸命令** spawn。预设面仍是 `shell_open`
  （分工见 `./terminal` 一节）。
- **shell 目标**：这样的会话是 **shell 目标** ⇒ `pty_signal` 拒绝 `SIGKILL`（`SIGNAL_FORBIDDEN`，
  与 `shell_open` 同源文案），结束时走 `pty_close`。反例不受影响：`pty_open({ command: "bash" })`
  **不是** shell 目标 —— 核心不从命令行文本猜。
- **平台差异（如实声明）**：win32 = `parseCommandLine` 分词后**直接** spawn（无 shell 解释）；
  POSIX = 仍 `/bin/sh -c <shellCommand>`，即**多一层 `sh` 父进程**（`pid` 报的是 `sh`）。
  不新增 POSIX 分词 / 引号面（那正是本票拒绝的复杂度）。
- **代价（选显式命令的代价，不掩饰）**：预设环境（`MSYSTEM` / `CHERE_INVOKING` / PATH 前缀）
  **不由本票代注入**，由 caller 自担；要预设环境就用 `shell_open`。env/PATH 只在 **spawn 时**
  注入 ⇒ 运行中的会话换不了环境。
- **临时切换（零工具面）**：在会话里发一行另一解释器的启动命令即进入，`exit` 回默认 ——
  状态天然在 PTY 进程树里，无状态机、无新参数。**一条命令**形式的一次性调用由 caller 自写方言
  （`bash -lc` / `pwsh -Command` / `cmd /d /c`），工具**不代拼引号**（每方言引号规则不同）。
- **环境侦测上下文**：本 entry 注册**一条** `systemPrompt.context`（`shell-host:environments`，
  order 130，`interpolate: false`），内容 = 「预设 id → 解析出的可执行」，让 agent 知道该把哪个
  路径写进 `shellCommand`，不必猜。它是**环境事实**、不是指令，**不主动起轮**；
  **首次装配才懒算**并缓存（win32 的侦测要起 `wsl.exe --list --quiet`，绝不在 `apply` 里同步跑）；
  没有可用环境时该行**整条不注入**（不写「无」）。注册走**子 fiber**
  （`ctx.inject(['systemPrompt'], …)`，cordis 的 child-fiber 入口）：`./pty` 的**工具面从不等待**
  提示词面 —— 没有 prompt registry 的 tools-only 组合照旧拿到六个工具；而**后挂**的 registry
  仍然会拿到这条上下文（机会式 `ctx.get` 读取会漏掉这种挂载顺序）。

```js
// 声明一次，之后裸命令直通
const s = await pty_open({ shellCommand: '<msys2>/usr/bin/bash.exe --login -i' })
await pty_send({ id: s.sessionId, data: 'cd /c/work && ls | head -3' })   // 无包装、无包装回显
```

**噪音读数（#149 AC2，真实 ConPTY / win32，N=3；载体 `pty-shell-machine.spec.ts`）**：
同一 payload ——「每条命令一次 `pty_open`」= 3 个会话 / 9 个初始化转义序列 / **126 字节**；
「一个常驻 shell 会话」= 1 个会话 / 20 个序列 / **566 字节**；调用方每命令要写的字节
**55（包装串）→ 22（裸命令）**。**如实说**：常驻**交互** shell 的字节读数**更大** ——
提示符与命令回显是终端语义，不是本票要消的噪音；本票消掉的是「每命令一次会话 + 一次 PTY 初始化
+ 一次 shell 启动」以及**回显里再没有包装串**。

### `initialOutput` 可能为空（#154）：ConPTY 首静默窗与正确的取数姿势

**事实：真实 ConPTY 下 `pty_open` 返回的 `initialOutput` 经常是空串，这不是缺陷。**
成因在 core 的初始 settle（`src/pty/session-core.ts`）：打开会话后先等一个**输出静默窗**
（默认 `DEFAULT_SETTLE_QUIET_MS = 150`，一旦连续 150ms 无新字节即返回；另有 2s 硬上界防挂），
而 ConPTY 的初始化转义序列与 shell 横幅往往在**首个静默窗之后**才到达 ⇒ 它们不落进
`initialOutput`，而是落进**下一次** `pty_tail` 的页里（tail 游标从打开时已存在的行起算，
之后到的字节都能读到）。`autoClose: true` 的一次性形态不受此影响 —— 它等真退出后再走一次
静默窗，缓冲输出会落进 `initialOutput`（见上一节 #146）。

实测读数（采集环境：文件沙箱 = `danger-full-access`、无审批提示，真实 ConPTY / win32）：

- `#149`：`shell initialOutput bytes = 0`，同一份日志里紧接的 delta 才带着 `ESC[?9001h…`
  与 bash 横幅（`.scratch/149-probe.log`）。
- `#147` 读数 A：`pty_open { command: 'node -e "setInterval(() => {}, 1000)"' }` 返回
  `{"initialOutput":""}`（转录 `.scratch/t147-pty-crosscall.md`）。

**正确取数姿势：要量「启动输出」（横幅 / 初始化转义 / 提示符），不要读 `initialOutput`，
用后续 tool call 里的 `pty_tail` 轮询**。可复跑步骤（最少两次 tool call；采集环境一并记）：

1. `pty_open { command: 'node -e "setInterval(() => {}, 1000)"' }`（或任一会产出横幅的会话）
   → 记下返回的 session id；**此时 `initialOutput` 为 `""` 属预期**，别拿它断言「没输出」。
2. **另一次** tool call 里 `pty_tail { id }` → 横幅与初始化转义（`ESC[?9001h…`）在这一页里；
   若还没有，隔一拍再 `pty_tail`，直到读到你要的 needle 为止。
   （不产出任何输出的子进程读到空增量也算正常返回 —— 与
   [docs/dev-environment.md §4.6](../../docs/dev-environment.md) 的跨轮存活读数是同一套措辞。）
3. 用完 `pty_close { id }` 收尾。

**本票不改语义**：不加「首个输出到达再算 settle」的开关、不改 settle 默认值 ——
要那样请另立票（会牵动默认行为 / 超时上界 / `shellCommand` 交互与变异验证）。

### pty_list / pty_signal（#119）

补齐官方 `terminal_list` / `terminal_signal` 的工具面覆盖。两者都**只作用于调用方
agent 自己持有的会话**（数据源就是核心的 owner 注册表，与 `pty_close` 的
`SESSION_OWNED` 同一姿态）：`pty_list` 只列自己的（别人的会话根本不出现在结果里）；
`pty_signal` 拿别人的 id 一律 `SESSION_OWNED`、未知 id `NO_SESSION`，**归属判据先于信号名
校验**（别人的 id 配一个非法信号名也只会得到 `SESSION_OWNED`）。

- **`pty_list`**：每行 `{ id, status, pid? }`，**顺序稳定 = 创建顺序**（按 id 的数字
  后缀排；字典序会在第 10 个会话起错位，`pty-10` 会跑到 `pty-2` 前面）。已退出但仍被
  持有的会话照旧列出 —— 持久会话的契约是 `pty_close` 才回收。
- **`pty_signal`**：白名单与官方一致（`SIGINT` / `SIGTERM` / `SIGKILL` / `SIGTSTP` /
  `SIGHUP`）。**平台语义与代码共用同一份常量**（`PTY_SIGNAL_SEMANTICS`，
  `src/pty/session-core.ts` 导出；工具描述逐字引用它，本节的取舍与它同源）：
  - **POSIX**：`process.kill(-pid, signal)` 投递到会话的**进程组**（forkpty 的子进程是
    session leader，pid 即 pgid）—— 真信号投递、尽力而为。**前台进程组够不着**（Node
    没有 `tcgetpgrp`）：交互式 shell 把前台作业放进独立进程组时收不到，那种场景用
    `pty_send` 发 `"\u0003"`（Ctrl-C，由终端驱动投递给前台组）。
  - **Windows / ConPTY**：node-pty 的 `kill(signal)` 在 Windows 上直接抛
    「Signals not supported on windows.」（摘录见落地文档的证据载体），**只有终止一种语义**
    ⇒ 只接受 `SIGTERM` / `SIGKILL`，两者都等于**终止会话**（ConPTY 进程树被拆掉）；
    `SIGINT` / `SIGTSTP` / `SIGHUP` **响亮拒绝**，不做静默映射。这是平台事实，不假装与
    POSIX 等价。
  - **`SIGKILL` 对 shell 目标一律拒绝**（官方同款语义：POSIX 上硬杀 shell 收不回它拥有的
    子进程），改用 `pty_close` 走完整关闭路径。Windows 上任何可投递信号本来就是整棵进程树
    的拆除，所以那里**结束 shell 会话的正规做法就是 `SIGTERM`**（`SIGKILL` 仍按官方的名字
    拒掉）。**「shell 目标」由打开方声明**，两条路：`shell_open`（启动器预设，`./terminal`）传
    `shell: true`，`pty_open({ shellCommand })`（#149）同样标记为 shell 目标（两条路的结果面
    都能看出来：`shell_open` 返回 `preset`，`pty_open` 返回 `shellCommand`）。
    核心**不从命令行文本猜**，所以 `pty_open({ command: "bash" })` 不算 shell 目标 ——
    猜不准就不猜（边界见 `src/pty/session-core.ts` 的 `OpenSpec.shell`）。
    ssh 会话同理**不是** shell 目标：它的本地顶层进程是 ssh 客户端而不是 shell，
    `SIGKILL` 在那里是一次正当的硬断开。
  - 投递**不自己关闭**会话：信号之后用 `pty_tail` 读后事，再用 `pty_close` 回收（幂等）。
    注意带 `idleTimeoutMs` 的会话若因信号停止产出，**空闲 watcher 之后仍可能把它回收** ——
    那是空闲策略，不是 `pty_signal` 关的。

### 后台发送（#120）：`run_in_background` 接宿主 jobs 栈

`pty_send` / `ssh_send` 多一个 `run_in_background?: boolean`（只认 `true`）。**前台路径零变化** ——
不给这个参数就是原来的「写入 + 等 settle（150 ms 静默窗，2000 ms 硬上限）并回 `{ delta, status }`」。

给 `true` 时**不等 settle**：立刻返回 `{ kind: 'background', jobId }`，工作交给**宿主已有的后台任务栈**，
`job_output` 收输出、`job_kill` 取消（作业记录带 `kind: 'pty-send'`、`label = '<sessionId>: <text>'`、
`toolCall`、`owner = 拥有者会话 id`、256 KiB 的 `outputLimitBytes`、一个输出拉取源）。

**两个包是一对，缺一个就是死路**（源码核对，`0.2.1-rc.2`）：`@deepseek-ai/dsh-jobs` 只是抽象 seam，
它的 `start` 在**没有 attached controller 服务该 owner 时直接拒绝**；`@deepseek-ai/dsh-tool-jobs`
才是那个 controller（`attachController`）+ `job_output` / `job_list` / `job_kill` + 完成投递。
所以 `ctx.get('jobs')` 取不到时的报错**同时点名这两个包**，且**不静默降级为前台**；
`./pty` 配置的 `enableRunInBackground: false` 同样响亮拒绝（连参数都不在工具面上列出）。

- 取消 = 提前结束 settle：`job_kill` 走 core `send` 已收的 abort signal，作业落
  `{ status: 'killed', detail: 'cancelled after N bytes read' }`；正常结束落 `completed`。
- 输出 = 这次 send **在 settle 期间产生的 delta**（core `send` 的回包），由作业的输出源交给
  `job_output`（每次读消费掉已交出的字节，游标单调）。
- 结果面：后台形态只报 `started background job <jobId>`（卡片换 `generic`）；前台形态逐字不变。
- **不自己造 controller、不复制 `job_*` 工具**：那是宿主的能力，本包只接线
  （依赖面的例外记账见 [docs/dev-environment.md §4.4](../../docs/dev-environment.md) 与 ADR-0005 决策 7）。

### 展示元数据（#121）：`presentationMeta` 进 `result.meta`，`presentResult` 不接

**可行性读数（票面第 1 步）**：内置 Web Client 的工具卡片**按第一方 wire 工具名**在
`tool.call.toolview` slot 做 key 匹配（无 key 落 generic 卡），且 client-ui-tool 明言
「Host `presentCall` / `presentResult` 值不会进入 Client」⇒ 第三方插件**复用不了**
`card: 'terminal'`，接 `presentResult` 对 Web UI **零收益**（官方 `terminal_send` 的那
份也只喂宿主本地消费方）。⇒ 本票只接 `presentationMeta`：宿主侧把它投影进
`tool/result.meta`（持久、replay 原样保留），消费面 = 会话事件流 / replay / PTC
dispatch 日志；Web 卡片对本仓工具名仍是 generic（已知边界，不改）。

- **`pty_send`**：前台投影 `{ delta, status }`（官方 `terminal_send` 同款「前台给结构化
  读数、后台给 `null`」姿态）；`pty_tail` 投影页事实 `{ lines, truncated }`（不复制正文）；
  `shell_open` 投影预设解析事实 `{ preset, source, executable, probed, cwd, overrode }`。
- **模型面零变化**：`output.schema` / `output.render` 逐字不动 —— 元数据是纯展示，
  不进模型上下文（PTC 路径只写 `tool/ptc-dispatch` 事件的 meta，见
  [docs/research/research-ptc-third-party-tools.md §1.4](../../docs/research/research-ptc-third-party-tools.md)）。
- **`finalizeContent` 不对齐**（票面顺带评估）：官方的 `maxResultBytes` 是对渲染文本的
  字节上限；本仓的输出**已被结构面各自封顶**（settle 窗有界、`pty_tail` 有 lines 预算 +
  scrollback 上限、#162 截止水位截断 one-shot 结果），再叠一层上限只会改变模型可见内容
  的语义（与 #162 的「按构造区分真实输出与截断残留」口径相抵），收益不成比例 —— 不做。

### 一次性命令（#146）：`autoClose` 等真退出、给真退出码；Windows 无 shell 解释

`./pty` 当 **exec 面**用时缺的两块，本票补齐：

- **退出码**：`pty_open({ command, autoClose: true })` 现在**等进程真正退出**才返回 —— 退出后再走
  一次静默窗（缓冲输出落进 `initialOutput`），然后结果的 `status` 是
  `{ kind: 'exited', exitCode }`（就是 `pty_list` / `pty_send` 用的同一形状，输出 schema 里两个字段
  都声明了）。会话随后照旧经单条关闭路径回收（不用 `pty_close`，软上限槽位自动释放）。**中止**（abort）只停止
  **等待**，不杀进程，此时结果没有退出码。
- **`shellCommand` 不是 one-shot**：会话级 shell 按设计是长命的（关闭路径 = `pty_close`），所以
  `autoClose: true` 与 shell 声明（`shellCommand` / 配置的 `defaultShellCommand`）同时给会**响亮拒绝**
  （`INVALID_ARGS`）—— 否则这条调用会等一个永不退出的进程。要"一次性 + shell 语义"就把整条行写进
  `command`（`cmd.exe /d /c "…"` 或 `bash -lc "…"`）。
- **命令语义（agent 面单源）**：`pty_open` 工具描述与 `command` 参数描述**逐字引用**同一条常量
  `PTY_COMMAND_SEMANTICS` —— win32 是**按 argv 分词后直接 spawn**（argv[0] 就是可执行文件），
  `&&` / 管道 / 重定向 / 内建命令**都不解释**，要 shell 就显式写 `cmd.exe /d /c "…"` 或
  `bash -lc "…"`；POSIX 仍走 `/bin/sh -c`。
- **可读诊断**：win32 启动失败（`File not found: ` 这条**不点名的** ConPTY 原文）现在会重抛成
  点名 argv[0]（以及 `resolveExecutable` 改写后的路径）+ 直达修法的提示（`code: 'SPAWN_FAILED'`，
  原文留在 `cause`）。落点在 `defaultSpawnPty` 的包装层，不在工具层（`#67` 的路径）。

真实 ConPTY 读数载体：`tests/pty-oneshot-machine.spec.ts`（0 / 非零退出码各一条 + 内建命令诊断）。

### 硬截止时间（#159）：one-shot exec 默认 600s，防等待输入无限挂起

`pty_open({ command, autoClose: true })` 的调用本身现在有**默认生效、可调的硬截止时间**（wall-clock，
覆盖**整个工具调用**——初始 settle + 等退出全部算在内）：

- **优先级**：单次参数 `deadlineMs` > `./pty` 配置的 `deadlineMs` > 默认 **600000ms**（10 分钟，
  单源：`session-core.ts` 的 `DEFAULT_DEADLINE_MS`，工具描述内文由该常量插值）。
  `deadlineMs: 0` = **显式关闭**（默认是有限的；关闭必须显式传，不存在静默无限）。非法值（非整数 / 负数）
  在工具面与配置面**响亮拒绝**。
- **总时长口径**：持续输出、读日志、settle 窗口的提前返回都**不会重置或顺延**它——这与
  #56 的 opt-in `idleTimeoutMs`（按输出定义的空闲）是**两个独立机制**，命名互不覆盖。
- **到期动作**：杀**自有**进程树——POSIX 先向进程组发 SIGTERM，宽限（默认 2s）后组 SIGKILL 强杀；
  Windows/ConPTY 只有树终止一条杠杆，直接终止。**绝不触碰其他 owner 的会话**；清理走单条关闭路径，幂等。
- **结果语义**：返回 `timeout: true` + 已捕获输出（`initialOutput`）+ `status` 里的**真实退出码**
  （进程确实报了才给；到期杀不伪造成功码）。abort 是另一条逃生通道，**永不**带 `timeout` 标记。
- **输出截断水位（#162）**：`timeout: true` 的 `initialOutput` **截至 kill 序列发起时刻**——
  终止竞态残留（树终止先杀直接子进程、被杀 shell 在自己死前又跑出的输出，如 `T1_LEAK` 一类）
  因果上发生在 kill 之后，**不进结果**；调用方因此可靠区分「命令真实输出」与「终止残留」，
  两侧平台同一口径。settle 窗口仍会照常排干退出事件（`status` 里的真实退出码依赖它），
  只是残留不再出现在返回文本里。
- **边界（成文）**：deadline 管的是**工具调用**，不管持久 session / REPL / watcher——那是 #56 opt-in
  idle 的管辖（`shell_open` 描述里也明说）；PTY 是字节流、没有命令边界协议，持久会话内**单条 shell
  命令不假设可精确计时**。对持久 open 传 `deadlineMs` 会响亮拒绝。

单元读数载体：`tests/pty-deadline.spec.ts`（等待 stdin 的 / 持续输出不退出的 / 长任务显式延长的 /
正常快速命令的假件，全部有界）。

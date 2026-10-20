# dsh-shell-host

DSH bundle: **a tools-only plugin (ADR-0012/0013)** — persistent PTY sessions
(`./pty`), interactive ssh sessions (`./ssh`), launcher-preset terminals
(`shell_open`, `./terminal`), and WSL bridge tools (`./wsl`). No shell executor,
no `ctx.shell` provider, no upstream loader-row takeover: every row in
`cordis.patch.yml` is an own-id insert, and the shell seam belongs to the
platform shell executors alone.

> History: this package was formerly a shell executor (MSYS2-first, VS Code
> terminal-profile modeled, routed backends incl. `ssh`) with host-only forks
> of the permission-presets and pwsh-tool rows. That world was removed in two
> steps — ADR-0012 (no upstream-row takeover) and ADR-0013 (executor world
> deleted) — after the executor registration/composition path kept failing in
> practice. Remote ONE-SHOT execution now lives in the standalone
> `dsh-shell-remote` plugin (route C).

## The bundle patch

`cordis.patch.yml` mounts exactly three own-id rows and touches nothing else:

1. `pty` (`dsh-shell-host/pty`) — the persistent session core.
2. `ssh` (`dsh-shell-host/ssh`) — the interactive ssh instance (`ssh_start` /
   `ssh_tail` / `ssh_send` / `ssh_close`), over the `pty` core (#136).
3. `terminal` (`dsh-shell-host/terminal`) — the `shell_open` launcher surface.

The platform executors (`pwsh-sandbox` / `bash-sandbox`) keep their DSH-native
posture untouched; the one-shot `bash`/`pwsh` tool faces are the platform's own
(including upstream's pwsh-fallback behavior when PowerShell 7 is absent).

### Host MSYS2 prerequisites（宿主环境最低工具集，2026-10-02 实测补齐）

launcher 预设与 ssh 会话都假定宿主 MSYS2 工具链可用——**本 bundle 不负责装齐
MSYS2 工具链**。裸 MSYS2 缺常用工具会让 agent 的验证手段悄悄降级（实测：
diff/cmp 缺失时所有 diff 类验证被迫绕 `git diff --no-index`）。安装后请补齐：

```bash
pacman -S --needed diffutils patch jq unzip rsync
```

判定方法：agent 会话里 `command -v diff` 落空即缺。新增工具需求时在此处追加清单。

## 权限模型（#102）：每次执行 resolve 宿主策略，升级走官方审批

本包的三条**执行面**（`pty_open` / `shell_open` / `ssh_start`）都起**进程**，`win_*` 走宿主
shell seam 执行命令。**#102 之前**它们既不读 `ctx.sandboxPolicy` 也不走 `ctx.approval` ——
`read-only` 会话或 `approval/policy = ask` 下照样能起进程、写字节（一条绕过官方审批界面的任意执行面）。
现在这三条面接入宿主权限模型，实现集中在 `src/permission-gate.ts`（单一来源）：

| 面 | 行为 |
|---|---|
| `pty_open` / `shell_open` / `ssh_start` | **每次执行前** `sandboxPolicy.resolve({ session })`：`read-only` **拒绝**起进程；`workspace-write` **只允许在 workspaceRoot 内**起动（**省略 cwd 时默认落在 workspaceRoot**，相对 cwd 相对它解析）；`danger-full-access` 不限制 |
| `pty_send` / `ssh_send` | **每次写入都重解析**：写入基线 = 会话**被授权时**的模式（升级打开时就是那个**一次性授予**的模式）。当前模式比它**窄**就拒绝（如策略降到 `read-only`，或该会话是 read-only 下经升级打开的 ⇒ 授权不外溢）。**升宽**不算降级。读（`pty_tail`）与收尾（`pty_close` / `ssh_close`）**不设门** —— 它们不放大权限 |
| `win_*` | 解析后的策略**随每次 shell 请求**交给执行器（执行器才是真正的强制面）；策略拒绝时结果带官方 `[sandbox: file access denied under <mode> mode]` 标记 + 同轮升级提示 |

**升级（one-shot retry）**：拒绝后可用 `sandbox_permissions`（`workspace-write` /
`danger-full-access`）+ `justification`（一句话理由，与前者**成对**）重试**同一次调用**。请求经
`ctx.approval.request` 交给**官方审批界面**（本包**不自造弹窗**），**只有 `allowed-once` 放行**；
`rejected` / `cancelled` / `unavailable` 一律拒绝并把 outcome 回显给模型（fail closed，不静默重试）。
`approval/policy = never` 时官方服务直接判 `rejected`（不弹窗）—— 本包按同一条拒绝路径处置。

**文案来源（如实标注，不夸大「逐字」）**：升级请求的 `reason` / `displayReason` 文本、`allowed-once`
的授予语义与非 grant 的处置**直接来自** `@deepseek-ai/dsh-sandbox` 的 `approveEscalation`；拒绝标记 /
同轮提示 / `sandbox_permissions` 的参数说明来自同包的 `sandboxDenialMarker` / `escalationHintMarker` /
`sandboxPermissionsDescription`（与上游 `bash` / `pwsh` / `fs` 家族同一套词表）。**模式阶梯的前置比较
是本包自己做的**（用官方 `WIDER_MODES` 表，把「参数错误」与「策略拒绝」分开，因此错误文案比上游多一句
允许目标清单）—— 这一处是**有意的分叉**，写在这里而不是声称逐字。

**缺服务 = fail closed**：`ctx.get('sandboxPolicy')` / `ctx.get('approval')` 任一为空时**拒绝执行**，
错误点名缺的服务并给出挂载指引（**不静默放行**）；四个 entry 也把这两个服务写进 `inject`，所以缺服务的
部署里这些行**不会激活**。⇒ 没挂 `dsh-sandbox-policy` + `dsh-user-approval` 的部署里
`pty_*` / `shell_open` / `ssh_start` / `win_*` **直接不可用** —— 这是**有意**的取舍（宁响亮失败，
不绕过）。官方 **base** bundle（`web` / `headless` 档）默认挂这两行（模式 `DSH_PERMISSION_MODE ??
'workspace-write'`）；**`sdk-minimal` 不是**（它是 `danger-full-access` 且不挂 approval）⇒ 该档下本包
的工具面按上述口径不可用，要改用 base 系 profile 或自行补 approval 行。

**诚实的边界（不假装做到了没做的）**：`ctx.subprocess` 的 spawn spec **没有** `sandboxPolicy`
字段，本包**拿不到进程级隔离**。这里能承诺的只有**策略判定（模式）+ 起动工作区边界 + 审批门** ——
进程一旦起来，OS 层的读写仍由平台执行器/沙箱方言负责，本包不冒充它。

**没有自定义命令白名单**（与上游一致）：`pty_open` 收**自由命令行**，`shell_open` 是**更窄的通道**
（可执行只能来自 launcher 预设表 + 探测点）。真正的命令白名单要改公开面（`allowedCommands` 配置 +
`resolveExecutable` 同一执行世界判定），属**另一张票**，本包不预先造一套与上游分叉的语义。

`pty_open` / `shell_open` / `ssh_start` 的结果带 `sandboxMode`（本次跑在哪个模式；带升级时是**授予**模式）。

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
  （依赖面的例外记账见 `docs/dev-environment.md` §4.4 与 ADR-0005 决策 7）。

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

## The `./ssh` entry (issue #136, ADR-0016 Q1)

`src/ssh/` is the INTERACTIVE full-duplex ssh instance as its own component
(#136 split it out of `./pty`): `ssh_start` / `ssh_tail` / `ssh_send` /
`ssh_close`, opened on the `./pty` entry's session core — the returned
sessionId IS a core session id, so `pty_send` / `pty_tail` / `pty_close` /
`pty_signal` still operate it (one registry, unchanged).

```js
import * as ssh from 'dsh-shell-host/ssh'   // { name, inject, Config, apply }
```

Independent settings namespace (`ssh`) with the ssh family's own
`enableRunInBackground` (the background-send section below describes the shared
path).

**迁移（只挂 `pty` 的老 profile 会失去 ssh 工具）**：`#136` 之前四个 `ssh_*` 工具是
`./pty` 行的一部分；现在只有挂 `ssh` 行才有它们。只挂 `pty` 的老 profile 升级后
**`ssh_*` 全部消失**（`pty_*` 不变）—— 在自己的 profile patch 里补一行
（迁移总说明统一在 T7 —— 见父票 `#135` 的 tickets 拆分；本票只写必须知道的这一句）：

```yaml
- insert:
    - id: ssh
      name: dsh-shell-host/ssh
```

同一条迁移还包含两处**面收窄**（都写在这里，免得踩到）：

1. `./pty` 模块**不再导出** ssh 合成符号（`composeSshCommand` / `SSH_KEEPALIVE_*` /
   `SshOption*`）—— 它们随组件搬到 `src/ssh/compose.ts`；从 `dsh-shell-host/pty` 具名 import
   这些符号的代码会变成 `undefined`，改指新模块。
2. `pty` 命名空间的 `enableRunInBackground` **只再管 `pty_send`**；要关 ssh 的后台发送
   得在 `ssh` 行配置（默认 true，未配置的部署零变化）。

```yaml
- insert:
    - id: ssh
      name: dsh-shell-host/ssh
```

`ssh_start({ host, jump?, shell? })` composes the ssh command line
(`host`/`jump` are argv atoms — no whitespace/shell metacharacters) and opens it
on the core PTY; the three passthroughs reuse the core's cursors and reads
verbatim. **合成逻辑单一来源**：`src/ssh/compose.ts`（keepalive 默认值 / `port` /
`-o` 透传 / argv 合成）——`./terminal` 的 ssh transport 维度也吃同一份，行为与 #136 之前逐字一致。

Division of labor (README-documented): ONE-SHOT remote commands belong to the
standalone `dsh-shell-remote` plugin (ADR-0013, route C — formerly this
package's `./remote` entry); `ssh_start` is for sessions a human/agent
converses with (long-lived remote shell, intermediate output via the tail
cursor).

Long-session hardening (#21 phase 1):

- `ssh_start({ ..., port })` — non-standard remote port, passed as `-p`
  (integer 1..65535; `user@host:port` is NOT valid ssh syntax).
- Keepalive defaults ride on every start: `-o ServerAliveInterval=15 -o
  ServerAliveCountMax=4` — without them, NAT/firewall idle drops kill
  sessions silently. (Single source #49: exported as
  `SSH_KEEPALIVE_INTERVAL_DEFAULT` / `SSH_KEEPALIVE_COUNT_DEFAULT` from
  `src/ssh/compose.ts` — code, tool description, and tests derive from there.)
- `ssh_start({ ..., options })` — free `-o` passthrough for remote-workspace
  capabilities building on this surface (#50, additive dual shape per entry:
  an atomic string — `"Key=value"` or a valueless `"Key"`, no whitespace —
  or a structured `{ key, value? }` whose value may carry spaces and is
  POSIX-quoted into one shell word, e.g. `ProxyCommand`). An option whose
  key is `ServerAliveInterval` / `ServerAliveCountMax` suppresses its
  default (exact key match).

**传输形态（ADR-0017，接口在 `src/ssh/transport.ts`）**：v1 在**所有**客户端都是
「每会话一条独立连接」——`ssh_start` 结果带 `transport` 结构化事实
（`shape: "per-session-connection"` + `controlMasterUsable`），远程工作区用它回答
「这条会话走的是哪种形态」。**Windows 客户端不能用 ControlMaster**（实测 socket 与 fd 两处都失败）
⇒ 那里**永不**去"先试 master 再回退"（那会在每次会话多打一条失败日志）。POSIX 客户端按
ADR-0017 **决策 2** 才是 master+channel 形态 —— 那条路径随远程工作区（#137）落地；本票是
**重构票**、不改开会话路径，所以结果里如实报的永远是**实际形态**（今天 = 每会话一条连接），
不虚报"可能形态"。
**远端登录 shell 必须是 POSIX 系**（会话打开时探测 `uname` / `$SHELL`，非 POSIX 响亮拒绝、
点名原因）；**Windows 远端 v1 明确不支持**。这两件的探测/拒绝随远程会话的打开路径（#137+）
落地，本票只承载接口与契约。

Reconnect semantics: **RECONNECT-NO, explicit** — a dropped session (network
cut, remote drop) surfaces `status.kind = "exited"` on the next send/tail;
nothing auto-reconnects. Recovery = `ssh_start` again (new session id); the
dead id is reclaimed by `ssh_close` (idempotent).

Live verification (machine lane): `tests/ssh-pty-live.spec.ts` runs the full
start → interactive → incremental tail → close round-trip against a real
host; it is gated on `DSH_SSH_LIVE_HOST` (optionally `DSH_SSH_LIVE_JUMP`)
and skips loudly when unset — no network in the default test lanes.

## The `./terminal` entry (issue #55, ADR-0008)

`src/terminal/` is the launcher layer's plugin entry: ONE tool,
`shell_open(preset, cwd?, env?, idleTimeoutMs?)`. It resolves a launcher preset through the
#54 layer (`src/launchers.ts` — declarative argv/prefix tables + detect scans +
custom presets from its settings namespace) and opens it on the `./pty`
entry's session core. The returned sessionId IS a core session id:
everything afterwards goes through the existing `pty_send` / `pty_tail` /
`pty_close` — no second tool family (ADR-0008 decision 5, no Middle Man).
Unknown ids fail loudly listing every serviceable preset; uninstalled
environments fail loudly naming every probe point. The entry's settings
namespace (`terminal`) carries the custom-preset data channel (the #54
shape; the CRUD UI is a later ticket reading the same data); the built-in
preset table is read-only, surfaced live by the unknown-id error.

**分工（#149）**：`shell_open` 是**预设面** —— launcher 预设 + 预设环境（`MSYSTEM` /
`CHERE_INVOKING` / PATH 前缀）；`pty_open({ shellCommand })` 是**裸声明面** —— 一条命令、
零词汇、**不注入**预设环境。本包**不复制**预设表、**不新增**预设 id（ADR-0008 单源不变）；
要预设环境用前者，要一条任意解释器用后者。

### 覆盖规则 / 并发上限 / 空闲超时（#56 裁决）

- **预设覆盖**：custom 同 id 覆盖 built-in 视图（用户显式配置优先），**不报错** ——
  但 `shell_open` 结果带响亮字段 `source: 'builtin'|'custom'` 和
  `overrode: true|false`（仅当 custom 真正替换了一个存在的 built-in 视图时为
  true；shadow 一个未安装的 built-in 不算覆盖）。结果同时含
  `executable`（命中候选）/ `probed`（全部候选点）/ `cwd`（实际生效值）；
  不返回完整 env（合并后即整条 PATH，无增量），argv 不重复返回（`command`
  已含）。判定单源在 `resolveLauncherDetailed`（`src/launchers.ts`）。
- **并发软上限（#61/#62 起 core 推导）**：计数来自 pty 核心**注册表**（owner 归属、
  `pty_close` 即释放；plugin dispose 全杀回收）——entry 重挂不再可能把计数归零
  （#62 的缝时代根因已随缝消失）。默认上限 8，settings namespace
  `terminal.maxSessions`（与 pty 核心的同名默认一致）可配；超限时 `shell_open`
  响亮报错，列出当前会话数与各 session id。无默认空闲超时 —— 持久终端
  （长驻 watcher/REPL）是本层卖点；`idleTimeoutMs`（可选，per-session）由 pty
  核心的 watcher 执行：无**新输出**满该时长即自动关闭（#56 裁决：无可靠空闲
  判据，故 opt-in 且以输出定义）。
- **逐会话空闲超时**：`shell_open(preset, idleTimeoutMs)` 可选参数 ——
  调用者显式 opt-in 时，该会话**无新输出**持续 `idleTimeoutMs` 毫秒后自动
  `pty_close`（空闲判据 = 输出行数不再增长；新输出会重置计时）。不带该
  参数的会话永不被空闲回收。

```js
import * as terminal from 'dsh-shell-host/terminal' // { name, inject, apply }
```

Mount it via the bundle patch (`cordis.patch.yml`, row id `terminal`, name
`dsh-shell-host/terminal`). It needs the `pty` service — mount `./pty`
alongside (the patch order does not matter; both rows are plugin-layer).

## The `./wsl` entry (issue #30, ADR-0007)

`src/wsl-plugin/` is the absorbed dsh-wsl-bridge module (pure move, source
anchored at `dsh-v0.2.1-alpha.1-r1` per ADR-0005): Windows access tools for
agents running inside WSL — `win_ls` / `win_read` / `win_write` / `win_run`
(cmd / powershell / direct interop) / `win_open` / `win_path` / `win_drives`.
Path normalization accepts both `C:\Users\me` and `/mnt/c/Users/me` forms
(the entry's own simplified converters; relative paths pass through);
`win_run` writes temp `.bat`/`.ps1` files to `C:\Windows\Temp` and cleans up
after itself. [ADR-0013: the `wsl` BACKEND and its strict cross-VM mapping
layer (`src/wsl-bridge.ts`) are gone — this entry is self-contained now.]

```js
import * as wsl from 'dsh-shell-host/wsl'   // { name, inject, apply }
```

`./wsl` is **exported but deliberately NOT bundle-mounted** (ADR-0013): the
bundle patch mounts only three rows (`pty`, `ssh`, `terminal` — see *The bundle
patch* above), so installing the bundle does NOT give you the `win_*` tools.
That is
by design — the row was never in the patch, so its absence is not a regression.
The tools exist for an agent hosted **inside WSL** reaching the Windows side;
with DSH running natively on Windows the semantics do not hold (path
normalization is redundant, and `win_run`'s temp `.bat`/`.ps1` staging under
`C:\Windows\Temp` has no point).

To use it, add the row to your own profile patch —
`$DSH_HOME/profiles/<name>/cordis.patch.yml` — then restart the profile (the
host composes the tree once at startup; see `docs/agents/profile-install.md`):

```yaml
- insert:
    - id: wsl
      name: dsh-shell-host/wsl
```

The row's `name` is the module specifier that decides which entry loads (`id`
is just the row identity); the source repo's old plugin name `dsh-wsl-bridge`
no longer resolves post-absorption. Plugin-LAYER entry (ADR-0007 "Entry form
differences"): built on `defineTool` + `ctx.tools`, registers model tools —
never an execution backend.

## Division of labor with the official optional bundles

DSH's optional-bundle list (`OPTIONAL_BUNDLES`) holds several bundles a person
switches on from the Plugins page; two of them bear on this package. Both are
offered switched **OFF** and are selected by no shipped template:

- `@deepseek-ai/dsh-experimental-terminal-bundle` — the official persistent
  terminal: `@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash` (the
  Windows row reuses the same backend package with `shellDialect: pwsh`) +
  `@deepseek-ai/dsh-tool-terminal`, i.e. six tools (`terminal_open` /
  `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` /
  `terminal_list`). While it is on it is a **global tool layer**: every agent
  in every preset sees those tools.
- `@deepseek-ai/dsh-experimental-ralph-bundle` — the `ralph` tool (a fixed
  script plus one fresh structured-output child per round). It injects
  `tools` / `workflowEngine` / `subagents` / `systemPrompt`, but registers no
  tool this package also registers: enabling it only adds the one global
  `ralph` tool.

Tool names and loader row ids do not collide, so the official bundles and this
one can coexist in a single profile. The recommended posture is nonetheless
**do not enable the official terminal bundle together with this package's
`./pty` / `./terminal`**: two session registries (`terminal_*` over the
official `terminals` service, `pty_*` over this package's own node-pty core)
plus the official bundle's own `tool:pty` system-prompt section — this package
registers no prompt section at all, so the model gets one mental model
described twice, and reading both it has no way to tell which registry a given
session id belongs to. Keep one of them: this package's `pty_*` / `shell_open`
(seam-free, ADR-0010) or the official six tools.

Two claims that must stay separate (merging them is the drift this section
exists to prevent):

- **Default inside the `minimal` preset** — the shipped `minimal` **agent
  preset** carries a `persistent-shell` group (`@deepseek-ai/dsh-terminal` +
  `@deepseek-ai/dsh-terminal-bash` + `dsh-tool-bash-persistent` /
  `dsh-tool-pwsh-persistent`), which surfaces a `bash` / `pwsh` tool whenever
  that preset is selected. It is part of the `minimal` preset; it is **not**
  the terminal bundle.
- **Optional and off by default** — the
  `dsh-experimental-terminal-bundle` described above. The default `standard`
  preset has no persistent-terminal row at all, so the `terminal_*` tools do
  not exist until a person turns the bundle on in the Plugins page.

"Officially provided" therefore does not mean "on by default". Upstream source
paths, patch excerpts and reproducible commands:
`docs/research/research-official-terminal-ralph-bundles.md`.

## Build & verify

`node --run install` / `node --run build` need no `deepseek-harness` checkout:
`peerDependencies` (cordis, schemastery, and the `@deepseek-ai/dsh-*` packages
that `dsh-tools` declares) resolve from npm.

```bash
node --run typecheck      # tsc --noEmit -p tsconfig.json
node --run build          # tsc -p tsconfig.build.json → tsdown (lib/*.js)
node --run test           # typecheck + scripts/verify-all.mjs (the single check entry)
node --run test:release   # build + verify:pack (exports pointers resolve from the tarball)
```

Scripts use `node --run` rather than a package-manager shim, so they work in an
environment that has only Node (no `pnpm`/`npm` on PATH) — issue #79.

**First clone, once:** enable the local pre-commit guard. Git does not ship hook
configuration with a clone, so the file is present but inert until this is run:

```bash
git config core.hooksPath .githooks
```

It checks detached HEAD + lockfile agreement + typecheck, and skips LOUDLY
(never blocking) when a tool is missing. Bypass deliberately with
`SKIP_HOOKS=1 git commit …`.

No CI (maintainer decision 2026-09-30; boundaries in ADR-0014) — local
verification is the only channel. In the `verify-all` summary, `PASS*` means the
case contained a loud skip and its environment-side assertions were NOT
verified; `SKIP` means a gate was off. See `docs/agents/TESTING.md` for the
tiering and evidence rules, and `docs/dev-environment.md` for isolation,
source deployment and build gotchas.

## Provenance

- History: started as a fork of `@deepseek-ai/dsh-bash-local` **0.2.0-rc.2**
  (© DeepSeek AI, MIT; see `LICENSE`), became an independent shell executor
  (issue #23), and ended as a tools-only plugin (ADR-0012/0013, 2026-10-16).
  The PTY/wsl modules are pure moves absorbed from their source repos
  (ADR-0005 anchors).
- Dependencies: `peerDependencies` = `@deepseek-ai/cordis` +
  `@deepseek-ai/schemastery` + the current `@deepseek-ai/dsh-tools` **direct peer
  set** (10 `dsh-*` pins that track the certified anchor — ADR-0005, dev-environment
  §4.4); admission is gated separately by the `engines.dsh` range (ADR-0005
  decision 6, dev-environment §2.1); deps are `@deepseek-ai/dsh-tools` +
  `@lydell/node-pty`; tooling
  (typescript/vitest/tsdown) comes from npm.

Status: v0.2.1-rc.2-r1, tools-only (ADR-0012/0013): `./pty` + `./ssh` +
`./terminal` + `./wsl`; remote one-shot via the standalone `dsh-shell-remote`
plugin.

# dsh-shell-host

DSH bundle: **a tools-only plugin (ADR-0012/0013)** — persistent PTY sessions
(`./pty`), interactive ssh sessions (`./ssh`), launcher-preset terminals
(`shell_open`, `./terminal`), 远程工作区与文件服务（`./remote` / `./remote-fs`），以及 WSL bridge tools (`./wsl`, 默认关闭). No shell executor,
no `ctx.shell` provider, no upstream loader-row takeover: every row in
`cordis.patch.yml` is an own-id insert, and the shell seam belongs to the
platform shell executors alone.

> History: this package was formerly a shell executor (MSYS2-first, VS Code
> terminal-profile modeled, routed backends incl. `ssh`) with host-only forks
> of the permission-presets and pwsh-tool rows. That world was removed in two
> steps — ADR-0012 (no upstream-row takeover) and ADR-0013 (executor world
> deleted) — after the executor registration/composition path kept failing in
> practice. 原远程 one-shot 的 route C 分工后来由 ADR-0016 修订；
> 现行工作区能力由本包承接，单次执行与 `dsh-ssh/ssh_exec` 正交分工。

## The bundle patch

`cordis.patch.yml` 挂载六条自有 id 行，不接管上游行（#143 起 `wsl` 随 bundle 挂载但默认关闭）：

1. `pty` (`dsh-shell-host/pty`) — the persistent session core.
2. `ssh` (`dsh-shell-host/ssh`) — the interactive ssh instance (`ssh_start` /
   `ssh_tail` / `ssh_send` / `ssh_close`), over the `pty` core (#136).
3. `terminal` (`dsh-shell-host/terminal`) — the `shell_open` launcher surface.
4. `remote` (`dsh-shell-host/remote`) — 远程工作区登记、预热与长驻连接（#137）。
5. `remote-fs` (`dsh-shell-host/remote-fs`) — 加性 `ctx.remoteFs` 与消费它的 `remote_*`
   文件工具（`remote_ls` / `remote_read` / `remote_write` / `remote_edit`，#137–#139），
   依赖前一行（行序即依赖）。
6. `wsl` (`dsh-shell-host/wsl`, `disabled: true`) — Windows 互操作工具（`win_*` 七个，
   #143）。行在挂载面上、默认关闭 —— 开启方式见 *The `./wsl` entry*。

### 怎么装、怎么加行（#142）

装 bundle = 把上面六条 `- insert` 行并进你 profile 的 patch
（`$DSH_HOME/profiles/<name>/cordis.patch.yml`；宿主在启动时组合一次树，
机制见 `docs/agents/profile-install.md`）。只想加某一项能力，就抄对应的行
—— `cordis.patch.yml` 本身就是六行的完整可抄来源（`wsl` 行记得连同
`disabled: true` 一起抄，除非你就是要开启它，见 *The `./wsl` entry*）；
下文 `./ssh`（迁移节）/ `./remote` / `./wsl` 各节另有可粘贴的 insert 片段，
`pty` / `terminal` / `remote-fs` 三行照本节清单或 `cordis.patch.yml` 抄即可。

**老 profile 迁移（一句话）**：只挂过 `pty` + `terminal` 的，补一行 `ssh`
（`#136` 起 `ssh_*` 四工具搬进了 `./ssh`，不补就消失 —— 面收窄细节见
*The `./ssh` entry* 的迁移节）；要**远端文件面**再补 `remote` + `remote-fs`
两行。

**两套文件词汇，别混用（Q14 纠正，放显眼处）**：本包**不替换上游 `ctx.fs`**，
上游 `read` / `write` / `edit` / `glob` / `grep` 行为**完全不变**
（ADR-0016 决策 1/2/9：本包做的是**加性** `ctx.remoteFs`，上游一字不动）。
进入远程工作区后，文件操作一律用 **`remote_*`**：工作区目录只是一个
**本地锚点** —— 只含 `.dsh-remote-workspace.json` 标记文件、不镜像任何远端文件，
**对本地上游文件工具就是空目录**；本地 `read` / `write` / `edit`
看到的是锚点，不是远端文件。

**`./ssh` 与 `./wsl` 的区别（一句话：方向）**：`./ssh` 是**远端通道** ——
从本机连到远端 POSIX 主机（交互会话 `ssh_start`，远程工作区的文件通道也走它）；
`./wsl` 是 **Windows 互操作** —— 给**跑在 WSL 里**的 agent 访问 Windows 侧
（`win_*` 七个工具），**不是**远程访问，且随 bundle 挂载但**默认关闭**
（`disabled: true`，opt-in 开启，见 *The `./wsl` entry*）。

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
   [docs/dev-environment.md §4.6](docs/dev-environment.md) 的跨轮存活读数是同一套措辞。）
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
  （依赖面的例外记账见 `docs/dev-environment.md` §4.4 与 ADR-0005 决策 7）。

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
  `docs/research/research-ptc-third-party-tools.md` §1.4）。
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
（迁移总说明统一在 *The bundle patch* 的「怎么装、怎么加行」（#142）；本节写必须知道的细节）：

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

远程 one-shot 分工按 ADR-0016 修订：单次执行使用 `dsh-ssh` 的 `ssh_exec`，本包不新增 one-shot 工具。
原独立 `dsh-shell-remote`（route C）仅为历史分工；
`ssh_start` remains for sessions a human/agent
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

## 远程工作区：`./remote` 与 `./remote-fs`（#137）

这两个是兄弟入口：前者提供 `ctx.remote`，负责工作区登记与连接生命周期；后者提供
`ctx.remoteFs`，文件工具只经这个服务访问远端。它们不替换上游 `ctx.fs`，也不新增
`ctx.shell` 执行器。老 profile 的迁移路径（补 `ssh` / `remote` / `remote-fs`）
统一写在 *The bundle patch* 的「怎么装、怎么加行」（#142），此处不重复。

### 预热配置与工具

`remote` 行的配置示例（元数据，不保存凭据）：

```yaml
- insert:
    - id: remote
      name: dsh-shell-host/remote
      config:
        workspaces:
          - host: devbox
            root: /srv/app
            title: 远程应用
```

组合装载即开始连接，失败记录为 `unavailable` 与稳定错误码，不阻塞宿主启动。
`remote_open({ host, root, anchor?, title?, port?, jump?, options? })` 可动态登记或显式重试，
`remote_list` 查看登记项，`remote_status({ workspaceId? })` 查看实际启动形态、远端 shell
探测值、引用计数、重连次数、在飞请求及最后错误。同一 host 的工作区共享文件通道；若
port/jump/options 不同，明确拒绝复用，须使用不同 OpenSSH host alias，避免静默访问错误主机。
动态登记保留到 `remote_close_workspace` 或组件卸载；需在重启后预热的工作区写入上面的 `workspaces` 配置。

`remote_open` 创建本地锚点目录，内含 `.dsh-remote-workspace.json`（host + 远端 root
与连接指纹，不含凭据）。默认位于 `anchorRoot` 下；未配置时使用本次会话工作区根下的
`.dsh-remote`，配置预热则使用部署默认工作区根。锚点是身份而非文件副本；完整宿主有
`workspaceRegistry` 时自动把锚点登记为普通工作区，纯工具组合仍可通过本服务查询它。
已有 marker 不匹配、marker 是符号链接、或无 marker 的目录非空时均拒绝接管。
`remote_open` 经过 #102 权限门；`workspace-write` 同时约束 ssh 启动 cwd 与锚点真实路径，
`read-only` 拒绝开连接。配置预热是部署者声明，不冒充某个 agent 的一次性授权。

`remote_ls({ path?, limit? })` 列远端目录；显式 `path` 必须为绝对 POSIX 路径，省略则列
工作区根。工作区由会话 cwd 对应的本地锚点选定；无锚点时仅在唯一工作区下兜底，多主机
歧义必须明确报错。`limit` 只限制展示行数，返回 `truncated` 与 `total`，不是远端扫描或
内存预算；超出帧上限会响亮失败而不是返回半棵目录。**本地 read/write/edit 看到的是锚点，
远端文件必须用 `remote_*` 工具**。

`remote_read({ file_path, offset?, limit? })` 对齐上游 `read`：路径按会话锚点与远程文件系统解析，
行号从 1 开始；默认及最大 2000 行，每行最多 2000 字符，选中文本最多 50 KiB，footer 提示续读。
目录拒绝为 `FS_NOT_REGULAR_FILE`；严格 UTF-8 文本面拒绝非法编码及前 8 KiB 内的 NUL（`FS_NOT_TEXT`），
不猜编码或用替换字符掩盖坏字节。底层 `readBytes` / `readByteRange` 可逐字节读回非 UTF-8 文件。
读取按 256 KiB 字节块走既有 base64 通道；跨块保留 UTF-8 解码状态，大于单帧的文件不塞进一帧。
途中断连、超时、短块或文件版本变化均响亮失败，不返回前缀冒充完整结果。

`remote_write({ file_path, content })` 原子创建或替换文本；`remote_edit({ file_path, old_string,
new_string, replace_all? })` 做字面量替换，默认只允许唯一匹配。覆盖/编辑前先用 `remote_read` 读取；
观察按会话与远程 canonical 身份隔离，外部改动返回 `FS_STALE_VERSION`，需重读再试。成功创建/修改后
可以继续编辑，不必额外读取。编辑按上游规则恢复 LF/CRLF，`$&` 等不当作正则替换语法。
写入以有界 base64 块进入同目录私有 staging，发布前校验版本，替换保留已有权限位；失败清理 staging。
create 使用原子 no-clobber，替换使用 `mv`；provider 内同目标串行，不宣称对任意外部进程的 OS 级 CAS。
通道已死时无法保证远端清理，失败会明确报告。此后端不宣称本机文件沙箱能监禁远端路径；
写工具每次重新解析调用方会话策略，只有 `danger-full-access` 可写；降级、缺少策略服务均在远端请求前拒绝。
直接调用服务并传入受限本机 `sandboxPolicy` 同样返回 `FS_SANDBOX_DENIED`，工具不提供虚假的提权参数。

### 多会话编排（#140）

`remote_open_session({ workspaceId, kind, cwd?, env? })` 在已登记工作区打开独立远端 shell，
返回的 `sessionId` 就是同一 PTY 核心的 id，后续直接用同一 agent 的 `pty_send` / `pty_tail` /
`pty_close`。`kind` 只标注 `shell` / `build` / `test` 用途，不会自动运行构建或测试命令；
三种用途都拥有自己的交互 `sh`，一条中的 `cd` 不改变另一条。

`cwd` 是远端绝对 POSIX 路径，默认工作区 `root`；`env` 仅注入远端 shell，本地 SSH 进程的
cwd 仍取本次宿主权限门的授权值。每次打开均重新解析权限，将真实 grant 写入 PTY，后续
`pty_send` 保留降级拒写；已连接不等于永久授权，也不宣称本机沙箱能监禁远端。
每条会话在自己的连接内实测 POSIX 登录 shell，并确认 cwd/env 初始化成功后才发布 id；
探测还要求宿主具备文件帧协议的 coreutils（`base64` / `mktemp`，ADR-0016 decision 3）——
同一宿主同时承载文件通道，缺一件在探测期就 fail closed，而不是让会话起来后文件面逐请求失败。
失败、超时、中止均尝试回收，清理失败保留 id 供工作区关闭重试。

`remote_list` / `remote_status` 增加当前 agent 的 `sessions`（id、kind、cwd、运行/退出状态、
实测 shell、传输形态、connectionId）。工作区 `state` 指文件通道，不冒充交互会话状态。
POSIX 交互会话以 slave 加入已有 master（同一 `connectionId`）；master 丢失不能偷偷直连。
Windows 或明确禁共享时每条会话有独立连接和 id；文件连接的重连只影响文件连接。
交互 shell **不自动重连**，断线由 PTY 报 `exited`，需新开会话；POSIX master 丢失会影响
其下所有 channel。未实现 WSL/tmux 路径，状态不伪造这些形态。

软上限完全沿用 PTY owner 注册表，与本地 PTY、SSH、launcher 会话共用计数；退出未关闭仍占位，
超限使用核心的响亮错误与当前会话清单。没有第二套工作区配额。
`remote_close_workspace({ workspaceId })` 是**整个工作区**的收尾，会关闭其全部 owner 的
关联 id，并解除工作区登记；不触碰其他工作区、本地 PTY或本地锚点。它等待排队的打开操作，
重复关闭幂等；失败保留重试责任。列表不公开其他 agent 的会话明细，这不缩小整批关闭范围。

### 传输与本期边界

- POSIX 客户端明确启用 ControlMaster；Windows 明确禁用它，绝不先试 master 再回退。
  可显式 `ControlMaster=no` 选择独立连接，状态同步报告该形态；`auto`/`ask` 等不能保证
  可观测形态的模式响亮拒绝。WSL 承载和 tmux 仍为 ADR-0017 的 deferred 选项。
- 远端必须有 POSIX 登录 shell，以及 GNU `base64` / `mktemp` / `stat` / `find` / `realpath` / `dd`
  等工具；打开时实测 `uname` 与 `$SHELL`，Windows 或非 POSIX 登录 shell 响亮拒绝。
  不安装远端 server，不用 SFTP，不做本地文件镜像。
- 文件通道使用 `ssh -T` 的原始 pipe，不是交互 PTY；内部请求是带 id 的 base64 行帧。
  先协商协议版本与 `clientId`，异版或身份不匹配响亮拒绝；子命令与协议 stdin 隔离，
  响应帧有 8 MiB 上限。这是文件传输通道，不是第二份 PTY 核心。
- 本期真正实现 `resolve` / `stat` / `listDir` 与 #138 的 `lstat` / `readText` / `streamText` /
  `readBytes` / `readByteRange`，以及 #139 的 `writeText` / `editText`；#140 提供工作区多会话编排（见上节）。
- 无活体 ssh 主机的环境中，真实 bash 循环与注入通道覆盖不等于 ssh 活体验收；验证报告须
  明说 `not run locally: remote live`，不能用假通道绿灯代替真实网络证据。

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

- **预设出处**：`shell_open` 结果带响亮字段 `source: 'builtin'|'custom'` 和
  `overrode: true|false`（custom 真正替换一个存在的 built-in 视图时为 true；
  shadow 一个未安装的 built-in 不算覆盖）。结果同时含
  `executable`（命中候选）/ `probed`（全部候选点）/ `cwd`（实际生效值）；
  不返回完整 env（合并后即整条 PATH，无增量），argv 不重复返回（`command`
  已含）。判定单源在 `resolveLauncherDetailed`（`src/launchers.ts`）。
  ⚠️ #105 起**同 id 覆盖在注册门处被封死**（见下节）——`overrode` 经合法注册
  通道不再可能为 true，字段保留为出处事实。
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

### 自定义 shell 注册面（#105/#170，ADR-0018）

`custom` 通道把一条**可执行路径 + argv + env + PATH 前缀**交给 `shell_open`——
注册面本身即攻击面，故有注册门（`src/terminal/register.ts`）：

- **权威存储（#170 起）：custom.d 文件族**。custom 预设每条一个 JSON 文件
  （`<customDir>/<id>.json`，文件名必须等于条目 id），目录由 terminal 行设置
  `customDir`（绝对路径）给出，缺省 `<DSH_HOME 或用户家目录>/.dsh/custom.d`。
  **patch 行里的 `config.custom` 数组写法已不再是权威**：#170 起挂载忽略手写的
  旧条目（legacy = 数组条目没有对应文件时记一条审计事件）；#169 起 `custom`
  字段被定为**配置页写通道**（volatile + 传输语义）——页面保存的数组由宿主
  半幅物化成文件族，patch 里留下的只是已物化的传输残影（一次性迁移见下）。
- **写入方**：只由**人**写入——经 custom.d 文件直接改，或经**配置页**（#169，
  human 的 GUI，不是 agent 写口）；工具面没有任何写注册口（`terminal_list`
  是纯只读面，守卫测试锁定）。
- **注册门（挂载期，单条禁用）**：逐条过校验矩阵——id 非空且字符集锁定、
  文件族内不重复、**禁止覆盖内置 id**；local 可执行候选必须绝对路径 + 含路径
  分隔符（拒裸名——沿 PATH 解析可被改名劫持）+ 无引号与 shell 元字符 + 存在
  且不是目录；空格允许（Windows 合法安装路径，spawn 走 argv 数组）；ssh 行
  必须有 host；cwd 若声明必须绝对；`base` 继承源必须是内置 id 或更早被接受的
  自定义 id。校验**不通过只禁用该条**（`terminal_list` 呈现 `disabled` + 原因
  原文），其余条目照常挂载；改好文件后**下次挂载自动放行**（无需任何命令）。
- **注册审计账本（#170）**：`<customDir>/audit.jsonl`，append-only JSONL——
  registered / disabled / enabled / changed / ignored / removed 事件随
  profile 持久；配置页发起的物化记 `changed` / `removed`（带
  `origin: 'config-page'`）。每次 `shell_open` 启动 custom 预设时，对命中
  执行的 executable 做内容哈希与账本基线比对，不符则在该次结果附**告警字段**
  （不阻断——阻断权归 #102 权限门；哈希一致或无账本记录则不告警）。基线只记
  首次注册，事后变化以 `changed` 事件观察、不动基线。
- **配置页（#169，ADR-0013 修订）**：本包自带浏览器半幅（`dsh.client`
  `{platform:'web'}` + `./client` 导出 → `lib/client.js`，React 走宿主基线
  模块表、`dsh.client.external` 留空），在插件管理器的 terminal 行注册
  `plugins.row.config` 配置页（key `dsh-shell-host#terminal`）：增删改自定义
  预设、实时预览完整启动命令；**保存** = 经宿主 `settings.mutate` 写 terminal
  行 user 层的 volatile `custom` 字段（乐观锁，冲突提示刷新重试），宿主半幅
  监听 volatile 更新后把数组物化成 custom.d 文件——文件族仍是唯一权威，
  保存即生效（下次 `shell_open` 无需重启/重挂）。浏览器半幅挂在本包唯一行上，
  bundle 未来拆多行时页面随根行关闭。**内置预设不在页面列表**（浏览器面无
  launcher 表通道，`terminal_list` 是 agent 面）——页面只管理自定义面。

**一次性迁移（patch 行 → custom.d）**：把 terminal 行 `config.custom` 数组里的
每条对象取出，逐条写成 `<customDir>/<id>.json`（UTF-8，内容 = 该条对象原样），
然后删掉 patch 行里的 `custom` 数组（或改用 #169 的配置页重新保存一次——页面
保存会把这些条目物化成文件）。重启 profile 前旧写法只是被忽略（有审计
事件提醒），配置不会丢。

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

As of #143 (human's 2026-10-19 ruling, revising #134's "deliberately not
mounted" call), `./wsl` **is bundle-mounted but dormant by default**: the bundle
patch carries the row with `disabled: true` — the row stays on the loader tree
(visible as a component in the plugin face; a disabled entry is not activated,
so nothing resolves its `inject` and the tools cost nothing until enabled), and
the `win_*` tools do NOT appear on an agent's tool face until you turn it on.
Before #143 the bundle patch mounted five rows (`pty`, `ssh`, `terminal`,
`remote`, `remote-fs` — see *The bundle patch* above) and `./wsl` was not among
them at all; that absence is what this change replaces (single source of truth —
the old "exported but deliberately NOT bundle-mounted" claim is gone).

The tools exist for an agent hosted **inside WSL** reaching the Windows side;
with DSH running natively on Windows the semantics mostly do not hold (path
normalization is redundant, and `win_run`'s temp `.bat`/`.ps1` staging under
`C:\Windows\Temp` has no point) — that is why the row ships disabled rather
than absent, and why you opt in per profile.

To enable it, override the row in your own profile patch —
`$DSH_HOME/profiles/<name>/cordis.patch.yml` — then restart the profile (the
host composes the tree once at startup; see `docs/agents/profile-install.md`):

```yaml
- id: wsl
  disabled: false
```

(the override targets the already-mounted row by its `id`; the source repo's old
plugin name `dsh-wsl-bridge` no longer resolves post-absorption). After the
restart the seven `win_*` tools register on the tool face of agents in that
profile. Plugin-LAYER entry (ADR-0007 "Entry form differences"): built on
`defineTool` + `ctx.tools`, registers model tools — never an execution backend.

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
  `@lydell/node-pty` + `diff`（#139 的上下文 diff 卡片，沿上游版本）；tooling
  (typescript/vitest/tsdown) comes from npm.

Status: v0.2.1-rc.2-r1, tools-only (ADR-0012/0013): the bundle mounts six rows
(`pty` / `ssh` / `terminal` / `remote` / `remote-fs` / `wsl`); `./wsl` ships
mounted but dormant (`disabled: true`, #143 — see *The `./wsl` entry*). Remote one-shot is
`dsh-ssh`'s `ssh_exec` (ADR-0016); the standalone `dsh-shell-remote` plugin was
the historical route-C predecessor.

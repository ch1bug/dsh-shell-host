# dsh-shell-host

DSH bundle：**tools-only 插件（ADR-0012/0013）**——持久 PTY 会话（`./pty`）、交互 ssh
会话（`./ssh`）、launcher 预设终端（`shell_open`，`./terminal`）、远程工作区与文件服务
（`./remote` / `./remote-fs`），以及 WSL bridge 工具（`./wsl`，默认关闭）。无 shell
executor、无 `ctx.shell` provider、不接管上游 loader 行：`cordis.patch.yml` 里每行都是
自有 id 的 insert，shell seam 只属于平台 shell 执行器。

> **语言**：英文版是权威文档（[README.md](README.md)）；本文件是内容完整的中文跟随版。
> 各 entry 文档在 [`docs/entries/`](docs/entries/) 下成对存在：`<name>.md`（英文）与
> `<name>_zh.md`（中文）。内容变更先落英文，再同步 `_zh` 版。

> History：本包前身是 shell executor（MSYS2 优先、仿 VS Code terminal-profile、含
> `ssh` 在内的 routed backends），并对 permission-presets 与 pwsh-tool 行做了 host-only
> fork。那个世界分两步移除——ADR-0012（不接管上游行）与 ADR-0013（executor 世界删除）
> ——因为 executor 注册/组合路径在实践中持续失败。原远程 one-shot 的 route C 分工已由
> ADR-0016 修订；现行工作区能力由本包承接，与 `dsh-ssh/ssh_exec` 单次执行正交分工。

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
   #143）。行在挂载面上、默认关闭 —— 开启方式见 [./wsl entry 文档](docs/entries/wsl_zh.md)。

### 怎么装、怎么加行（#142）

装 bundle = 把上面六条 `- insert` 行并进你 profile 的 patch
（`$DSH_HOME/profiles/<name>/cordis.patch.yml`；宿主在启动时组合一次树，
机制见 `docs/agents/profile-install.md`）。只想加某一项能力，就抄对应的行
—— `cordis.patch.yml` 本身就是六行的完整可抄来源（`wsl` 行记得连同
`disabled: true` 一起抄，除非你就是要开启它，见 [./wsl entry 文档](docs/entries/wsl_zh.md)）；
`./ssh`（迁移节）/ `./remote` / `./wsl` 各 entry 文档另有可粘贴的 insert 片段，
`pty` / `terminal` / `remote-fs` 三行照本节清单或 `cordis.patch.yml` 抄即可。

**老 profile 迁移（一句话）**：只挂过 `pty` + `terminal` 的，补一行 `ssh`
（`#136` 起 `ssh_*` 四工具搬进了 `./ssh`，不补就消失 —— 面收窄细节见
[./ssh entry 文档](docs/entries/ssh_zh.md) 的迁移节）；要**远端文件面**再补
`remote` + `remote-fs` 两行。

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
（`disabled: true`，opt-in 开启，见 [./wsl entry 文档](docs/entries/wsl_zh.md)）。

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

## Entry 文档

各 entry 的完整文档已从本文件迁出——每个 entry 一份完整英文文档 + 一份 `*_zh.md`
中文对偶版：

| Entry | 覆盖内容 | 文档 |
|---|---|---|
| `./pty` | 持久 PTY 会话：六个 `pty_*` 工具 + 编程 facade；会话默认 shell（#149）、`initialOutput`（#154）、`pty_list`/`pty_signal`（#119）、后台发送（#120）、展示元数据（#121）、一次性命令（#146）、硬截止时间（#159） | [pty_zh.md](docs/entries/pty_zh.md) · [English](docs/entries/pty.md) |
| `./ssh` | pty 核心上的交互 ssh 会话；迁移 + 面收窄（#136）、keepalive、`-o` 透传、传输形态（ADR-0017）、RECONNECT-NO | [ssh_zh.md](docs/entries/ssh_zh.md) · [English](docs/entries/ssh.md) |
| `./remote` + `./remote-fs` | 远程工作区：登记/锚点、`remote_*` 文件工具、多会话编排（#140）、传输与边界 | [remote_zh.md](docs/entries/remote_zh.md) · [English](docs/entries/remote.md) |
| `./terminal` | `shell_open` launcher 预设；并发上限、空闲超时（#56）、自定义 shell 注册面 + 审计账本（#105/#170，ADR-0018）、配置页（#169） | [terminal_zh.md](docs/entries/terminal_zh.md) · [English](docs/entries/terminal.md) |
| `./wsl` | WSL 内 agent 的 Windows 互操作（`win_*` 七个）；默认挂载但休眠（#143）、开启方法 | [wsl_zh.md](docs/entries/wsl_zh.md) · [English](docs/entries/wsl.md) |

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

## 与官方可选 bundle 的分工

DSH 的 optional-bundle 清单（`OPTIONAL_BUNDLES`）里有几个 bundle 可供人在插件页开启；
其中两个与本包相关。两者都**默认关闭**，且没有任何出厂模板选它们：

- `@deepseek-ai/dsh-experimental-terminal-bundle` —— 官方持久终端：
  `@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash`（Windows 行复用同一
  backend 包，`shellDialect: pwsh`）+ `@deepseek-ai/dsh-tool-terminal`，即六个工具
  （`terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` /
  `terminal_close` / `terminal_list`）。开启时它是**全局工具层**：每个 preset 里的每个
  agent 都能看到这些工具。
- `@deepseek-ai/dsh-experimental-ralph-bundle` —— `ralph` 工具（固定脚本 + 每轮一个
  fresh 结构化输出子代理）。它注入 `tools` / `workflowEngine` / `subagents` /
  `systemPrompt`，但不注册任何本包也注册的工具：开启它只是多一个全局 `ralph` 工具。

工具名与 loader 行 id 都不冲突，官方 bundle 与本包可以在同一个 profile 共存。但推荐的
姿态仍是**不要把官方 terminal bundle 与本包的 `./pty` / `./terminal` 同时开启**：两套
会话注册表（`terminal_*` 走官方 `terminals` 服务、`pty_*` 走本包自己的 node-pty 核心）
加上官方 bundle 自带的 `tool:pty` system-prompt 节——本包完全不注册 prompt 节，模型会
拿到同一个心智模型的两份描述，读了也分不清某个会话 id 属于哪个注册表。二选一：本包的
`pty_*` / `shell_open`（seam-free，ADR-0010）或官方六工具。

两条必须分开的表述（合并它们正是本节要防的漂移）：

- **`minimal` 预设里的默认**——出厂的 `minimal` **agent 预设**带 `persistent-shell`
  组（`@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash` +
  `dsh-tool-bash-persistent` / `dsh-tool-pwsh-persistent`），选中该 preset 就有
  `bash` / `pwsh` 工具。它属于 `minimal` 预设，**不是** terminal bundle。
- **可选、默认关**——上面说的 `dsh-experimental-terminal-bundle`。默认 `standard`
  预设完全没有持久终端行，`terminal_*` 工具在有人到插件页开启 bundle 之前不存在。

所以「官方提供」不等于「默认开启」。上游源码路径、patch 摘录与可复跑命令：
`docs/research/research-official-terminal-ralph-bundles.md`。

## Build & verify（英文版为权威，见 [README.md](README.md#build--verify)）

`node --run install` / `node --run build` 不需要 `deepseek-harness` 检出：
`peerDependencies`（cordis、schemastery 以及 `dsh-tools` 声明的 `@deepseek-ai/dsh-*`
包）从 npm 解析。

```bash
node --run typecheck      # tsc --noEmit -p tsconfig.json
node --run build          # tsc -p tsconfig.build.json → tsdown (lib/*.js)
node --run test           # typecheck + scripts/verify-all.mjs（唯一检查入口）
node --run test:release   # build + verify:pack（exports 指针从 tarball 解析）
```

脚本用 `node --run` 而非包管理器 shim，所以只有 Node 的环境（PATH 上无
`pnpm`/`npm`）也能跑 —— issue #79。

**首次 clone，一次性**：启用本地 pre-commit 守卫。git clone 不带 hook 配置，文件在但
不生效，直到执行：

```bash
git config core.hooksPath .githooks
```

它查 detached HEAD + lockfile 一致 + typecheck，缺工具时**响亮跳过**（永不阻塞）。
刻意绕过用 `SKIP_HOOKS=1 git commit …`。

无 CI（维护者决定 2026-09-30；边界见 ADR-0014）——本地验证是唯一通道。`verify-all`
汇总里 `PASS*` 表示该用例含 loud skip、其环境侧断言**未验证**；`SKIP` 表示门禁未开。
分层与证据规则见 `docs/agents/TESTING.md`；隔离、源码部署与构建坑见
`docs/dev-environment.md`。

## Provenance

- History：起步是 `@deepseek-ai/dsh-bash-local` **0.2.0-rc.2** 的 fork（© DeepSeek AI，
  MIT；见 `LICENSE`），成为独立 shell executor（issue #23），最终定格为 tools-only
  插件（ADR-0012/0013，2026-10-16）。PTY/wsl 模块是从各自源仓 pure move 吸收
  （ADR-0005 锚点）。
- 依赖：`peerDependencies` = `@deepseek-ai/cordis` + `@deepseek-ai/schemastery` +
  当前 `@deepseek-ai/dsh-tools` **直接 peer 集**（10 个 `dsh-*` pin 跟随认证锚 ——
  ADR-0005、dev-environment §4.4）；准入另由 `engines.dsh` 区间门禁（ADR-0005 决策 6、
  dev-environment §2.1）；deps = `@deepseek-ai/dsh-tools` + `@lydell/node-pty` +
  `diff`（#139 的上下文 diff 卡片，沿上游版本）；工具链（typescript/vitest/tsdown）
  来自 npm。

Status：v0.2.1-rc.2-r1，tools-only（ADR-0012/0013）：bundle 挂六行
（`pty` / `ssh` / `terminal` / `remote` / `remote-fs` / `wsl`）；`./wsl` 随包挂载但
休眠（`disabled: true`，#143 —— 见 [./wsl entry 文档](docs/entries/wsl_zh.md)）。
远程 one-shot 走 `dsh-ssh` 的 `ssh_exec`（ADR-0016）；独立 `dsh-shell-remote` 插件是
历史上的 route C 前身。

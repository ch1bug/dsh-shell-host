# 决策日志（dsh-shell-host）

本文件收 dsh-shell-host 的 grill 决策与票共识沿革（原 GLOSSARY 决策史节，原文逐字搬运）；词汇与已验证事实见 [GLOSSARY.md](../GLOSSARY.md)。

## 已定决策(grill 共识,2026-09-30)

- D1 子系统 = MSYSTEM=UCRT64(/usr/bin 超集)
- D2 fork 官方 dsh-bash-local 泛化:新增 bashPath(显式 MSYS bash)+ env 注入配置;单独建仓(2026-09-30 修订:基线版本 = 0.2.0-rc.2,见事实第 1 条)
- D3 one-shot env 注入 MSYSTEM/CHERE_INVOKING/PATH;PTY 终端 = `--login -i`
- D4 保留沙箱包装代码但不承诺受限进程沙箱(见事实第 3 条)
- D5 preset 行集参考 dsh-bash-native 的示范(executor + dsh-tool-bash + dsh-terminal 组)
- D6 原 brush bundle(dsh-bash-native)待本项目在真实会话验证通过后再从 profile 卸载
- D7(2026-09-30 triage;#3 落地 2026-09-30)backend 描述符层一次到位:executor 第一版即含声明式 backend 层(spawn/argv 模板/env/路径映射),模式参照 VS Code terminal-profile/remote;phase 1 只实现 msys2 后端,pwsh/wsl 描述符占位(#3/#2),落地=填描述符+补测试,不做破坏性重构。**phase 1.5(#3 已落地):pwsh 描述符就位**——pwsh.exe/powershell.exe 有序探测(PS7 安装根→PATH→WinPS 5.1,无声回落已删除,缺失响亮报全部探测点)、one-shot `-NoLogo -NoProfile -NonInteractive -Command`+UTF-8 前导、interactive `-l -noexit`(-Login 需 pwsh≥7.4)、env{}/pathPrefix[]/恒等路径映射;argv 惯例勘源上游 pwsh-local(dsh-v0.2.0-rc.2),**非监禁姿态**(详见 ADR-0001 #3 amendment)。WSL 涉及 ssh/远程语义,明确 phase 2
- D8(2026-09-30 human 拍板,方向修订)**从"并列 preset"改为"宿主级替换"**:完全替代内置 bash 执行器、对外接口保持一致、内部实现参考 VS Code、加前端配置页。落地形态:
  - patch 在宿主平面禁用 `pwsh-sandbox`/`bash-sandbox`(win32 守卫)+ insert 本执行器(行 id `shell-host`)——seam 每 composition 恰一个 provider,preset 树的 tool-bash 解析宿主 ctx.shell,装载即全 preset 生效
  - 已知取舍:web-app standard/minimal preset 的 `pwsh` 工具(win32 启用)在替换后命令文本交给 bash(上游契约:无方言翻译);本部署用 bash-dialect preset
  - 前端设置页 = 包内 client half(lib/client.js closure factory,只外部依赖平台模块表的 primitives + react/jsx-runtime),绑定 configForms namespace **`shell-host`(= Loader 行 id,settings-controller 自动按行派生表单)**;volatile 字段经 settings user-section 运行时改预算,免重启
  - 顺带覆盖 `terminal-controller`(宿主级侧边栏用户终端):默认 shell 显式指 MSYS2 bash `--login -i`,摘掉裸 `bash` 候选(宿主 PATH 无 MSYS2,裸 bash 只会命中 WSL stub);!!js existsSync 探测,未安装则回退上游发现

## D8 follow-up (#10, 2026-09-30)【历史记录 —— 已被 D12/ADR-0012 摒弃,上游 permission-presets 重新组装】

- **permission-presets host-only fork(human 拍板:只 fork 不提上游)**:D8 副作用
  #10 修复 = 包内 `src/permission-presets.ts`(入口 `dsh-shell-host/permission-presets`)
  ——同名服务 `permissionPresets` + 同 Typert 命名空间 + 同命令 definitionId
  `@deepseek-ai/dsh-permission-presets` + 同 `permission/preset` 事件/`permissions`
  投影,原版 client UI 零改动复活(不 fork 任何 client 代码)
- **fork 语义**:sandbox 旋钮回退 = `ctx.sandboxPolicy.defaultMode`(文件沙箱
  政策),不读 `ctx.shell` —— 非 confinement 执行器不是 misconfiguration,
  无任何代码路径声称进程 confinement;切换预设仍写穿双旋钮
  (`sandbox/mode` + `approval/policy`)
- **挂载(human 2026-09-30 方案 A 修订)**:fork insert 行**接管行 id `permission`**(settings
  namespace = 行 id,设置页 PermissionRow 硬编码读 ns `permission`)——loader 同 id 后行
  覆盖前行即替换机制,上游模块在本部署永不组装(双平台);POSIX 等价性 = 上游
  执行器 sandboxMode 本就读 sandboxPolicy.defaultMode,fork 回退逐值等价
- **决策记录**:`docs/adr/0002-permission-presets-fork.md`(含 zod@4.4.3 钉版、
  dsh-settings 走 built 声明两条实现期事实)

新事实(已验证):
- **tsdown(oxc)不降级标准装饰器**:@Remote(...) 会原样进入宿主 lib,Node 24 导入即
  「Invalid or unexpected token」——插件行组装但永远不激活,UI 面全黑且无可见报错
  (#10 live 发现)。修复 = tsdown-plugin.ts(TypeScript transpileModule 预变换,
  与 vitest 装饰器预变换同源);tests/built-artifact.spec.ts 锁住产物可导入性
- vite 的 RegExp alias 不匹配含 `/` 的子路径 specifier(如
  `@deepseek-ai/dsh-commands/brand`)——子路径 alias 必须用 string find
- 装饰器源码(`@Remote(...)`)在本仓 vitest 下必须先过 TypeScript 预变换
  (vitest.shared.ts `standardDecoratorPlugin`,移植自上游同名文件;unit/machine
  两个 project 各自挂载,#34 起 vitest.config.ts 为 projects 结构)
- zod 4.6.x 会让 projection `register` 的泛型推断 TS2589;fork 钉 `zod@4.4.3`
  (与上游一致)
- **依赖策略例外(仅类型)**:fork 的 `dsh-settings` 类型导入走兄弟仓 BUILT
  声明(`../../deepseek-harness/.../lib/types/index.d.ts`)——settings→config-editor→hmr
  源链在本仓单程序松弛 flags 下不可编译;运行时导入被剥离,不违反
  「不走 npm」铁律。此例外记录于 ADR-0002,复制该模式前先读它


## D9 (#2 grill 共识, 2026-10-03, 见 ADR-0003)

- **多后端 = registry + 运行时单选热切**(Q1=A):`backend` 字段保持单选 volatile,对外契约与 bash-local 逐字段一致不变;不做命名实例、不做 per-call 选择(D8 红线)
- **wsl 进 registry,边界写死**(Q2=C):registry 仅限本机后端(含本机 WSL 发行版);ssh/远程语义永不进 registry,独立票锚定
- **wsl 启动协议**(Q3=A):`wsl.exe -d <distro> -e bash -c <cmd>`,显式 distro,缺失响亮报全部探测点(与 pwsh 探测失败姿态同构)
- **backend 专属字段长在 descriptor 上**(Q6=B,VS Code profile 语义):wsl descriptor 自带 distro 等 VM 字段,无旁路 config 节,无模板占位符发明
- **跨 VM 路径映射由 WSL 桥承载**(Q7):toShell(fromShell)双向都归 wsl 后端专属桥模块——`/mnt/<drive>/` 规则、`\\wsl$\<distro>\` 反向映射、drvfs 边角都在桥内实现与测试
- **拆票**(Q5=C):T1 descriptor 表达力扩展 → T2 multi-backend registry/切换层 → T3 wsl descriptor + 桥;远程票独立

## D10 (#16 grill 共识, 2026-10-03, 见 ADR-0004)

- **远程 one-shot 执行独立成仓 `dsh-shell-remote`**(Q3 修订/Q7=A):三仓三界——shell-host=本地 one-shot;shell-remote=远程 one-shot;pty-session=持久会话(本地或 ssh,见其 #3)。互不注册,shell-remote 永不进 shell-host registry(ADR-0003 决策 2 不变)
- **传输 = shell 出系统 OpenSSH**(Q5=C):`ssh <host> -- bash -c <cmd>`,继承 `%USERPROFILE%\.ssh\config`/密钥/跳板机;ssh 库(持久连接/多路复用)属持久会话世界,留 revisit
- **D8 契约照守**(Q6=A):ShellResult 字段与 bash-local 逐字段一致;全部路径语义声明为远端路径,不做映射;无远程对应物的宿主能力(spill)响亮拒绝
- **形态分阶段**(Q2=C):薄传输先行;Remote-SSH 式远端组件挂 revisit(交互/长会话需求出现时,且大概率落 pty-session 世界)
- **拆票**(Q9=A):R1 脚手架+descriptor 骨架 → R2 one-shot 执行+D8 一致性测试+spill 拒绝
- **#16 转移**(Q8=C):shell-remote 开镜像票后 #16 关闭留指针

## #21 remote dev survey(2026-10-09,票面前置已完成)

- **现状勘察**:VS Code Remote-SSH = 专有 remote server(编辑器 UX 层,非 agent 工具面);zcode/DSH 平台无内置 ssh 长会话工具;其他 DSH 插件(dsh-terminal-*)均本地。结论:agent 可用的 long-session remote PTY 无现成工作,#24 的 ssh 四工具即 phase 1 机制层。
- **phase 1 落地(human 拍板 C)**:`ssh_start` 增 `port`(-p)+ keepalive 默认(ServerAliveInterval=15/ServerAliveCountMax=4,可被同名 options 覆盖)+ 自由 `-o` options 透传——options 面为后续远程工作区能力(远程文件系统/runtime,后续票)预留。
- 证据:unit `ssh-pty.spec.ts`(#21 组合块)+ machine live `ssh-pty-live.spec.ts` 长流 500 行无跳读/无重发(真机 <user>)。

## D11 (#63, 2026-10-10, human 拍板路线 A, 见 ADR-0011)

- **pwsh 工具 host-only fork(只 fork 不提上游)**:平台 `dsh-tool-pwsh` 执行器裸查 `pwsh`,缺 PS7 静默回落 bash(#63 现象)。fork = 本包 `./pwsh` entry 注册同名 `pwsh` 工具,cordis.patch.yml 以同 id `tool-pwsh` 接管 loader 行(permission 行先例);唯一语义差 = executable 解析(`pwsh.exe → powershell.exe` 有序探测,双缺响亮报全部探测点)。一次性执行走 `ctx.subprocess`(非 PTY 世界);backends pwsh descriptor 是执行器维度另一层,红线不动。POSIX 门控镜像基座行逐字。

## D13 (ADR-0013, 2026-10-16, human 拍板 B:执行器 world 整体移除)

- **本包 = 纯工具插件**:shell 执行器 world(`shell-host` 行、`src/index.ts`、
  `src/core/`、`src/backends*`、`src/types|timeout|subprocess-context|wsl-bridge`、
  client 设置卡、`./remote` entry)全部删除;`ctx.shell` 只由平台 shell 执行器
  提供。理由:B 路径(执行器注册/缝组装)已被实证会直接报错。
- **挂载面 = 六个自有 id 行**（`#143` 起；`#137`–`#139` 期间为五行使能行）:`pty` + `ssh` + `terminal` + `remote` + `remote-fs` + `wsl`(`disabled: true` 默认关闭,#143);entry 面 = `./pty`(持久
  PTY 会话核心)、`./ssh`(ssh 四工具 + 通道合成，`#136` 从 `./pty` 抽出)、`./terminal`(shell_open launcher 预设)、`./wsl`(WSL 桥
  工具)、`./remote`（工作区登记与文件通道）、`./remote-fs`（加性文件服务；本期 resolve/stat/listDir + remote_ls）。`launchers.ts` 吸收了原 backends 的 argv/prefix 常量
  (`*_INTERACTIVE_ARGV`、`msys2PathPrefix`、`parseWslDistroList`)。
- **远程 one-shot = C 路线**【已被 D14 / ADR-0016 覆盖:远程工作区收回本包,
  `dsh-shell-remote` 只记为前身】:原结论为归独立 `dsh-shell-remote` 插件
  (ADR-0004 原边界恢复)。
- **ADR 状态**:0001/0003/0006 被 ADR-0013 supersede;0002/0011 已被 0012
  supersede;0007/0008 收窄有效(所有 entry 均为插件层)。T5 e2e 执行器清单
  与执行器/registry/backend 测试面随删;machine lane = terminal + ssh-pty live。

## D14 (ADR-0016, 2026-10-19, human 拍板:远程工作区收回本包)

- **三组件 + pty 回归纯核心**:`./ssh` 独立组件(owns ssh 四工具 + 命令合成 / keepalive /
  `port` / `-o` 透传)、`./remote` 远程工作区 = 多会话编排 + 连接池、`./remote-fs` 远端文件面
  (与 remote 兄弟、只依赖 ssh);挂载面 **2 行 → 5 行**(`pty`/`ssh`/`terminal`/`remote`/`remote-fs`),
  `tests/patch-shape.spec.ts` 的棘轮显式更新;全部插件层 —— 执行器 world 仍不复活,
  `ctx.shell` 仍只由平台 shell 执行器提供(ADR-0013 主体不变)。
- **文件面 = 加性后端,不替换 `ctx.fs`**(Q14 纠正 / Q15=A):提供 **`ctx.remoteFs`**(与
  `dsh-fs` 同形契约:resolve / stat / readText / streamText / readBytes / listDir / watch /
  writeText / editText + 稳定错误码)与消费它的 `remote_*` 工具族;`ctx.fs` 与
  `fs-local`/`fs-sandbox` 一字不动,上游 read/write/edit/glob/grep 行为不变。
  确定代价 = **两套文件词汇**(锚点目录对上游工具是空目录);干净长期解 = DSH 上游的
  工作区作用域化 `ctx.fs`(本包不自行实现,但保持同形契约以便平移)。
- **承载面 = 本地锚点目录**(Q11=A):远程工作区在 DSH 的 workspace 注册表里就是一个
  普通项目,path = 本地空锚点目录(内含 marker:host + 远端 root);会话 cwd 绑定锚点,
  会话历史仍按本地目录分区;远端目录**不做本地镜像**。
- **配置 = settings 面 + 零凭据**(Q12=A):非敏感元数据(标题 / ssh 别名 / 远端 root /
  锚点 / 默认 preset / 连接选项)走本包 settings namespace;host/user/port/key/跳板
  一律来自用户 OpenSSH 配置与 agent,**本包不存任何凭据**;v1 **不做前端半区**。
- **连接生命周期归工作区服务**:每主机一条通道(按工作区/会话引用计数)、keepalive、
  有界重连;**组合装载时预热**(在任何 agent 轮次之前建连),工具永不建连,
  通道不在 ⇒ 稳定错误码 + 原因,`remote_status` 暴露状态。
- **同构优先(upstream-swappable)**:`ctx.remoteFs` 与 `dsh-fs` 契约**同名同形**、
  `remote_*` 与上游工具**同参同名(只差前缀)**,帧协议只活在服务背后 ⇒ 上游将来出
  "工作区作用域化 `ctx.fs`"时,迁移 = **换挂载点 + 删前缀**,语义与提示词都不用改。
  这也是否掉"自带粗粒度工具"的理由:那会把将来的迁移变成重写。
- **文件操作远端就地执行**:工作区持有一条长驻 `ssh <host> -- sh` 通道,帧化请求
  （#137采用base64行帧 + 请求id，并先协商协议版本/clientId），只传payload；**不用 SFTP / SSHFS / rsync**，
  零新增依赖。
- **远端零安装**:只要求 `sh` + `base64`/`find`/`stat`/`tar`;不装 server、不做版本目录。
- **升级门槛**:watch/增量、千文件级扫描、断线续期/多客户端 —— 任一成立才升 helper
  (先零安装 `sh` 帧循环,再考虑 node)。
- **远程 one-shot 便捷工具(哨兵法)不在本 ADR**:留独立决定。
- **supersede 范围**:仅覆盖 ADR-0013 的「Remote one-shot goes route C」一节。

## D12 (#ADR-0012, 2026-10-16, human 拍板:只保留独立插件注册)【行清单已被 D13 收窄:现挂载面 = `pty` + `terminal`,无 `shell-host`;又被 D14 扩到 5 行,再扩到 6 行(#143,`wsl` 默认 `disabled: true`)]

- **改上游路径全部摒弃,挂载形态 = 自有 id 插件行**:patch 只允许自有 id 的
  insert 行(`shell-host` / `pty` / `terminal`);同 id 接管上游 loader 行、
  覆盖上游行 config 一律禁止。被清除的三处接管:`permission` 行
  (permission-presets fork,ADR-0002 废弃)、`tool-pwsh` 行(pwsh 工具
  fork,ADR-0011 废弃)、`terminal-controller` 行(上游侧边栏终端 config
  覆盖)。对应源码入口与测试连代码删除(`src/permission-presets.ts`、
  `src/pwsh.ts`)。
- **行为回归已知情接受**:上游 permission 三面(命令/设置页/权限选择器)、
  pwsh 工具缺 PS7 静默回落 bash(#63 现象回归)、侧边栏终端裸 `bash` 候选
  (可能命中 WSL stub)全部回归上游原生行为。
- **不受影响的边界**:D8 执行器替换本体(`shell-host` 行 + client 设置卡 +
  ctx.shell 缝语义)保留;backends pwsh descriptor 是执行器维度,不动;
  依赖策略 npm 通道保留(独立构建决策);tsdown/vitest 装饰器预变换保留
  (执行器自身也用装饰器,built-artifact 冒烟改指 `lib/index.js`)。
- **后续修复上游行为的唯一合法通道**:上游 PR,或新的自有 id 行/entry——
  永不再走同 id 接管。

## #109 与官方可选 bundle 的分工（2026-10-19 落地；评估全文见 `docs/research/research-official-terminal-ralph-bundles.md`）

上游当前（`0.2.1-rc.1` 锚）的 `OPTIONAL_BUNDLES` 里有若干个可选 bundle；其中**两个与本仓有关**。
它们**默认关**、由**插件页**开启，不被任何随附模板选中。

- `dsh-experimental-terminal-bundle`（组行 `optional-persistent-terminals`）= 官方**持久终端**：
  `@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash`（Windows 侧同一后端配
  `shellDialect: pwsh`）+ `@deepseek-ai/dsh-tool-terminal` 六个工具
  （`terminal_open/send/read/signal/close/list`）。开启后是**全局工具层** —— 所有 preset
  的所有智能体都看得见。
- `dsh-experimental-ralph-bundle`（组行 `optional-ralph`）= `ralph` 工具（固定脚本 + 每轮一个
  fresh 结构化输出子智能体）。inject `tools/workflowEngine/subagents/systemPrompt`，
  **不注册本仓已有的任何工具**（只多一个全局 `ralph` 工具）。

**分工建议（本票落地口径，非 D 系列决策）**：工具名与 loader 行 id **都零冲突**，可同
profile 并存；但**不宜同时开**官方持久终端与本仓 `pty_*` / `shell_open` —— 两套会话注册表
（`terminal_*` 走官方 `terminals` 服务，`pty_*` 走本仓自管 node-pty 核心）＋官方 bundle 自带的
`tool:pty` system prompt 段（**本仓一个 system prompt 段都不注册**），同一件事被描述两遍，
模型无法判断某个 session id 属于哪一套。二选一：本仓 seam-free 面（ADR-0010），或官方六工具。
操作层写法见 README 的「Division of labor with the official optional bundles」一节。

**两条必须分开写的事实**（不得混成「官方已默认提供」）：

- **默认就在跑（选中 `minimal` 时）**：随附的 `minimal` **agent preset** 里的
  `persistent-shell` 组（`@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash` +
  `dsh-tool-bash-persistent`/`dsh-tool-pwsh-persistent`），呈现为 `bash` / `pwsh` 工具
  —— 那是 **preset 的一部分**，不是上面那个 bundle。默认 preset 是 `standard`，其中
  没有该组。
- **可选、默认关**：`dsh-experimental-terminal-bundle`。默认 preset（`standard`）
  **没有任何持久终端行** ⇒ 插件页开启之前，`terminal_*` 六工具**不存在**。

## #120 grill 共识（2026-10-19：接入宿主 jobs 栈，照抄官方全套）

- **决策 = 接入**：`pty_send` / `ssh_send` 加 `run_in_background`，`jobs.start({ kind: 'pty-send',
  label: '<sessionId>: <text>', toolCall: { callId, rootCallId }, owner: <agent session id>,
  outputLimitBytes, output: [...], run })`；**前台路径零行为变化**。
- **jobs 是「一对包」**（源码核对，`0.2.1-rc.2`）：`@deepseek-ai/dsh-jobs` 只是**抽象 seam**
  （进程内实现 = `dsh-jobs-local`），`start` 在**没有 attached controller** 服务于该 owner 时
  **直接拒绝**；`@deepseek-ai/dsh-tool-jobs` 才是 controller（`attachController`）+
  `job_output` / `job_list` / `job_kill` + 完成投递。**只声明前者 = 永远响亮报错的死路**。
- **配置门照抄官方**：`enableRunInBackground`（默认 `true`）；缺 `jobs` 时响亮报错，
  文案点明两个包（不静默降级为前台）。
- **依赖面政策成本**：两个包都**不是** `dsh-tools` 的直接 peer ⇒ `dev-environment §4.4` /
  ADR-0005 决策 6 记一条**带理由的例外**：宿主已自带这套栈（桌面 `app.asar` 就有），
  本票是**接线**不是造面。
- **否决过两条**：不接入（与宿主既有能力相悖）、自建 controller（等于重写 `dsh-tool-jobs`）。
- **顺带更正（同一次源码核对）**：`dsh-tool-jobs` 的完成投递 = `ctx.get('agents')` 取 Agent +
  `Agent.followup`（空闲 owner **开一轮**）/ `Agent.inject`（忙碌 owner 注入下一步）——
  此前「宿主没有插件起轮入口」的说法**是错的**，见 `#151`。
- **落地（2026-10-20，批 G 第 2 票）**：新模块 `src/pty/background-send.ts` 一个门面收全部 ——
  两处响亮失败（缺 `ctx.jobs` 点明两个包 / `enableRunInBackground: false`）、job spec（照官方逐字段）、
  输出拉取源（settle 时填的 delta，读一次消费一次）、以及 `cancel` 走 core `send` 的 abort signal；
  `pty_send` / `ssh_send` 只共用这一个分支，**前台路径零改动**（结果面仍旧 `{ delta, status }`，
  `kind` 字段只在后台形态出现）。配置门与参数面走 `./pty` 的 `enableRunInBackground`（默认 `true`；
  关掉时**连参数都不在工具面列出**）。
  **依赖面**：两个包都进了 `peerDependencies` + `devDependencies`（锚 `0.2.1-rc.2`），
  作为「只跟 `dsh-tools` 直接 peer 集」的带理由例外，记账在
  `docs/dev-environment.md` §4.4 与 ADR-0005 **决策 7**；代价 = `pnpm peers check` 多一条
  `dsh-output-retention` missing（peer 的 peer，已知并接受）。

## #149 grill 共识（2026-10-19，6 个决定；全文见 `#149` 票面正文）

- **Q1=C 声明形态 = 显式命令**：`pty_open({ shellCommand })` 说一句裸命令（可执行 + 交互 argv）。
  **零词汇**：不用 launcher 预设 id、不造 shell 名表、不新增预设 id、不新增 `shell: true` 布尔。
  环境标签路线被否 —— 它会让 `pty_open(预设 id)` 与 `shell_open(preset)` 撞成第二套 launcher 面。
- **Q2=A 发现面 = 侦测一次 + 动态上下文**：本机可用的 launcher 环境以 `systemPrompt.context` 一行交给
  agent（是**环境事实**、不是指令，也**不主动起轮**）。侦测必须**懒**（首次装配算一次并缓存）——
  `resolveLaunchers` 在 win32 会 `execFileSync('wsl.exe')`，插件 `apply` 不该背这个延迟。
  这是本仓**第一次**注册提示词面（此前一个段都没有）。
- **Q3=A 全局来源 = 本包 settings**：`./pty` Config 新增 `defaultShellCommand?: string`。
  作用域今天是**本插件全局**，不是工作区；跨工作区隔离留给将来的工作区面（解析处留缝，工具面不动）。
- **Q4=A 临时切换 = 零工具面**：进入另一解释器 = 在会话里发它自己的启动命令，`exit` 回默认
  （状态在 PTY 进程树里，无状态机、无新参数）；「一条命令」形式由 caller 自写方言一-shot，工具不代拼引号。
  **硬事实**：env/PATH 只在 spawn 时注入 ⇒ 临时切换只能换**解释器**，换不了预设的 `MSYSTEM`/PATH 前缀。
- **Q5=A 互斥且沿用既有 spawn 通道**：`shellCommand` 与 `command` 二选一（同填 = 报错），且不自动发首命令；
  win32 直接 `spawn`（无 shell 解释），POSIX 仍 `/bin/sh -c`（**多一层 `sh`**，`pid` 报 `sh`）。
  **不新增** POSIX 分词/引号面。
- **Q6=A 空参触发全局默认**：`pty_open()` 两者都不给 → `defaultShellCommand`；Config 也没配 → 响亮报错
  「必须给 `command` 或 `shellCommand`，或配置 `defaultShellCommand`」。没有这条，全局默认是**死配置**
  （Q5 的互斥必填会让它永远轮不到）。
- **落地（2026-10-20，批 G 第 1 票）**：解析 = `src/pty/index.ts` 的 `resolveShellDeclaration`
  （互斥 / 优先级链 / 空参报错都在这一个纯函数里）；环境侦测上下文 = `src/pty/environment-context.ts`
  （懒算 + 缓存 + 无环境不注入）；配置面 = `./pty` Config 的 `defaultShellCommand`。
  README「会话默认 shell（#149）」写工具面与代价，机器档读数在 `pty-shell-machine.spec.ts`。

## #105 注册面（2026-10-26，ADR-0018；批 J 第 4 票，票内口径自定留档）

- **注册门（fail-closed）**：`custom` 通道在 entry apply 期整表校验（`src/terminal/register.ts`），
  任一条目非法 ⇒ 整行拒绝激活并列出全部原因。矩阵含**禁止覆盖内置 id**（收窄 #54 的
  同 id 覆盖语义）与可执行候选的绝对路径 / 分隔符 / 元字符 / 存在 / 非目录五连；空格合法
  （Windows 安装路径 + argv 数组 + 启动引号），「带参数的执行串」由存在性探测拦住。
- **重启生效 = 进程级快照**：宿主 HMR 会因配置写重组插件树，「不重读文件」保不住契约，
  故 custom 表进程内第一次 apply 定型；行关-开也不换表（字面语义，代价显式接受）。
- **配置页载体**：宿主三个配置插槽全是 client 插槽（React 浏览器半幅），无通用 schema
  渲染页。**#169（2026-10-30）取证闭环 + 落地**：写协议 `form.mutate(ops,
  expectedRevision)` 的 ops 形状已取证（app.asar L496740-496744 / L1903491-1903510）
  = `{op:'set', path:string[], value}` / `{op:'unset', path}`，ns = Loader entry
  id，非 volatile 路径 fail-closed 拒写（`Config field "…" is not volatile`）；
  client 半幅（`plugins.row.config`，key `dsh-shell-host#terminal`）以
  `dsh.client{platform:'web'}` + `./client` 回归（ADR-0013 修订 = tools-only
  唯一例外）。权威存储不变 = custom.d 文件族（ADR-0018 修订）：settings 写
  `custom`（volatile）= **传输**，宿主半幅监听 `loader/volatile-update` 物化成
  文件（human 决策 B，#169）；`ignored: patch-source` 收窄为 legacy 行。

## #52 grill 共识(2026-10-09,进行中)

> **2026-10-19 `#109` 更正（原文保留作历史）**:本节后三条成文于 #61/ADR-0010 **之前**,
> 其中三处关于 `terminals` 缝的表述**已被 ADR-0010 取代**:「env 经 terminals seam spawn spec
> 传递」→ env 由本仓 PTY 核心在 spawn 时合并;「sessionId 即缝会话 id」→ sessionId 是本仓
> 自管 PTY 核心的会话 id;「`shell_open` 走 terminals 缝」→ `shell_open` 跑在本仓自管核心上,
> 不 inject `terminals`。另:同一批表述里的「D8 的单例执行器替换实现保留」也已被推翻
> (ADR-0013 删掉了整个执行器 world,该实现不再存在)。`shell_open` 的当前契约以 README 与
> ADR-0010 为准。

- **启动器预设(Launcher preset)**:`(transport × shell-env)` 的声明式启动单元——本机预设 = local transport × shell 环境;ssh 是下层传输维度(配 host + 远端 shell 环境,复用 ssh 组合器语义,不另起 ssh 工具面孔)。预设表是 descriptor 的复用视图 + detect 常见位置运行时扫描,非独立硬编码表;自定义预设持久在 config(settings 页可增删改查,UI 归后续票)。
- **env 注入 = VS Code profile 语义**:env 属于 preset(profile 字段),spawn 时进程级注入(terminals seam spawn spec 加性扩 env 传递),不做 shell export 行渲染;缝的对外契约不变。
- **工具面**:单工具 `shell_open`(新插件层 entry `./terminal`,独立 settings namespace);send/tail/close 复用 `pty_*`(sessionId 即缝会话 id),不加转发工具。
- **与路 B 的关系**:D8 的单例执行器替换实现保留;`shell_open` 走 terminals 缝,与 `ctx.shell` 完全解耦共存。

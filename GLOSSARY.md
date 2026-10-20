# GLOSSARY.md — dsh-shell-host

> 状态:初始化骨架。术语表与决策随 grill/implement 惰性填充。

## 项目一句话

DSH bundle:**Windows 宿主平面的 shell 执行器替换层**(原名 dsh-bash-msys,#12 改名)—— 在宿主平面完全替换内置平台 shell 执行器(对外接口与 `@deepseek-ai/dsh-bash-local` 逐字段一致,内部按 VS Code 终端 profile 建模),backend 可插拔(msys2 默认 / plain / pwsh,wsl reserved),并自带 Plugins 页设置卡片。MSYS2 backend 是独立于 bash 的环境:安装根/子系统(MSYSTEM)/PATH 表面/pacman/cygpath 是一等公民,bash 只是其中可配置的 shell。

## 已验证事实(来源:代码调研 + 实测,2026-09-30)

- **基线改道(2026-09-30 human 拍板)**:fork 目标从 0.1.7-rc.2 改为 **0.2.0-rc.2**(本地桌面端已是 0.2.0-rc.2)。两版本间 bash-local 的 src/tests 字节级一致(仅版本号),基线成本为零;上游 tag `dsh-v0.2.0-rc.2` = commit `639ed01539`
- **依赖策略(2026-09-30 human 拍板；#23 路 B 已修订 2026-10-08)**:原政策为「@deepseek-ai 包一律不走 npm registry，从本地源码库 `<old-work>\deepseek-harness` 解析」(npm latest 标签陈旧)。[History: 上一句里的 `<old-work>\deepseek-harness` 是旧布局的历史叙述，本机不存在；该政策已由 #23 路 B 废止]**#23 路 B 解耦构建后本条废止**：peerDependencies 只留 cordis + schemastery，其余 @deepseek-ai/* 一律作为普通依赖从 npm registry 解析(构建产物;无 source alias、无 tsc -b 前置)；工具链(typescript/vitest/tsdown)走 npm。#28 起新增依赖同样走此通道(如 `@deepseek-ai/dsh-tools` 钉源锚版本)
- 上游 schema 仅 6 项 volatile 配置(cwd/timeoutMs/maxTimeoutMs/maxOutputBytes/maxSpillBytes/graceMs);bash 二进制硬编码 `'bash'` 沿 PATH 解析,无 bashPath、无 envOverrides 配置项;注册 `ctx.shell`;`static inject = ["subprocess"]`;one-shot = `['bash','-c',cmd]` 非 login 无 rc;env 层叠 ENV_OVERRIDES→caller env→dshEnv;后台作业/spill 输出/ctx.jobs 集成现成
- 上游 vitest.config.ts 在 win32 排除 bash-local 套件("a real POSIX shell is unavailable on Windows")——T1 基线镜像该策略;实测探针(WSL bash):23/36 过,失败全部为 POSIX 环境假设(cwd 字面量/signal 语义),移植接线零缺陷
- `dsh-terminal-bash` 的 shellPath/shellArgs 是其自有独立 Config(默认 `/bin/bash` + `--noprofile --norc -i`),不依赖 executor
- MSYS bash 在 DSH confined 沙箱档无法启动(MSYS runtime 需命名管道,restricted token 拒绝,Win32 error 5)→ 本项目的引擎实际运行档 = unconfined
- Windows 上 PATH 裸 `bash` 不可靠(实测命中 `C:\Windows\System32\bash.exe` = WSL)→ 显式路径是硬需求;且**宿主 app 进程的真实 Windows PATH(机器+用户)不含任何 msys 目录** —— MSYS 会话内 `where bash` 的结果被会话自身 PATH 前缀污染,不能作为宿主发现依据
- 宿主 MSYS2 在 `C:\msys64` 实测可用(bash -lc 'pacman -Q; uname -a' 正常,MSYSTEM=MSYS);VS Code 上游对 MSYS2 的 profile 声明 = `%HOMEDRIVE%\msys64\usr\bin\bash.exe` + `['--login','-i']` + `CHERE_INVOKING=1`(见 ADR-0001)
- loader patch 语义(vendor/include/src/index.ts):`{id, insert, name, ...overrides}`,**`name` 是校验守卫而非重指**(不匹配→跳过);config 整体替换;同层 insert 的行可被后续 patch 命中 → 换实现只能"禁用+insert",不能原地改名
- web-app bundle 以行 id `terminal-controller` 挂载 `@deepseek-ai/dsh-api-terminal-controller`:只注入 `subprocess`+`sandboxPolicy`,**不读会话 shell realm** —— 侧边栏终端是宿主级发现(`shell` 显式 profile + `shellCandidates` 按 PATH 探测),Config 无 env 字段;bash 类自动 argv = `['-i']` 非 login
- 客户端模块表基线(packages/client/web/src/platform.ts `PLATFORM_MODULES`)含 react、react/jsx-runtime、cordis、dsh-client-store、dsh-client-ui-primitives —— 第三方 client half 的 closure factory 只需 require 表内行;voice-mimo 是第三方 bundle 带 client half 的先例

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

## #69 POSIX PTY 实机事实(2026-10-11)

- **@lydell/node-pty = platform prebuilt optionalDependencies**(`@lydell/node-pty-linux-x64` 等,pnpm-lock 可见)——上游 node-pty 需 node-gyp 编译的前提对本 fork **不成立**:npm 11 默认屏蔽 install scripts 下安装即用(#69 容器 lane 实测)。#26 带走的「full 工具链镜像」要求仍满足(lane 用 node:24-bookworm),但构建能力是富余而非必需;dsh-subprocess-local 的上游 node-pty 依赖如仍需 node-gyp 属上游事实,不适用于本包。
- **POSIX 交互式 PTY 实机绿**:podman node:24-bookworm lane(.scratch/issue69-posix-pty-verify.mjs,一条命令见脚本头)17 项 PASS——prebuilt require+裸 spawn、defaultSpawnPty `/bin/sh -c` 包装、createSessionCore 全回环(open/login 旗标/send-tail 增量不重发/exited/autoClose 回收/close 幂等/owner 边界)、detect getpwuid 复验。
- **lane 布局事实**:容器内不可在 /repo 挂载点直接 npm install(Windows pnpm node_modules 污染解析)——把 src/ + 脚本拷进容器内干净目录再装依赖。
- **mac 实机节 PENDING**(无 mac 机器;#26 待实测项 ① 留待有机器时并入 lane)。

## #82 宿主锚与接口事实（**2026-10-17 起锚 `0.2.1-rc.2`**；本节原为 0.2.0-rc.2 实测）

本仓锚 **RC 线**（ADR-0005）：`version` = `0.2.1-rc.2-r1` ↔ 宿主 tag
`dsh-v0.2.1-rc.2`(commit `687f282e`)。前一锚 `0.2.1-rc.1` ↔ `1600d8a1`。
**浅克隆默认分支会落到 alpha 系**
(实测 `dsh-v0.2.1-alpha.4`),必须显式 checkout tag。

- **会话 RPC 两侧一致（原记录有误,2026-10-17 按源码树更正）**:`dsh-v0.2.0-rc.2`
  与 `dsh-v0.2.1-rc.1` / `-rc.2` 各 **19 个 `@Remote`**;`session/initializeDefaultModel` 在
  **两侧都存在**(`packages/api/session-controller/src/index.ts` 的 `@Remote`;
  上游同 tag 的 `docs/subsystems/session.md` 与同 tag 客户端都在调用它),
  rc.2 另有未进旧清单的 `@Remote canOpenWorkspacePath`。原记「只存在于 alpha /
  RC2 全集不含它」与同一 tag 的源码树矛盾 —— **切锚不触及会话 RPC**;
  选模型仍走 **`selectModel`**。
- **`@deepseek-ai/dsh-tools` 的 peer 集随锚变**:rc.2 = 有 `dsh-invariants`、
  `cordis ~4.0.4`、`schemastery ~3.18.4`;**rc.1 = 无 `dsh-invariants`**(上游整包
  移除,官方 upgrade guide `remove-runtime-invariants` 明说不再发布)**、新增
  `dsh-working-directory`、`cordis ~4.0.5`、`schemastery ~3.18.5`**。照 alpha 抄
  peer 会**漏声明**(#82 即此);本仓口径 = 只跟 `dsh-tools` 的直接 peer 集
  (见 [docs/dev-environment.md](docs/dev-environment.md) §4.4)。
- **门禁走区间、认证走精确（2026-10-17 human 拍板；ADR-0005 决策 6）**:manifest
  声明 `engines.dsh = "~0.2.1-rc.1"` —— rc.1 起**只**看它、DSH peer **退出门禁判定**,
  于是「只动版号」的中间 RC（rc.1→rc.2 实测即此）不再被判不兼容、不再需要逐版落地;
  精确钉（`dsh-tools` 依赖 + peer 集）与 release tag 仍表示**我们构建并验证过的那个版本**。
  代价:区间内的未验证版本会被放行 —— 「装得上」不再等于「验过」。
- **rc.1 起 `dsh-tools` 另删了 `./invariant` 子路径导出**,并把
  `ToolPresentationMode` 从 `'native'|'ptc'|'both'` 收成 `'native'|'ptc'`
  (本仓未用该字段,代码零动作)。
- **宿主 `scripts/build.ts` 参数**:rc.1 **同时**接受 `--scope`
  (`complete`/`artifacts`/`check`/`typecheck`)与 `--profile`(客户端构建 profile);
  alpha 用 `--scope artifacts`,rc.2 记的是 `--profile`。
  （构建操作与切 tag 后的清理步骤见 [docs/dev-environment.md](docs/dev-environment.md) §2/§4.3，
  此处只记接口差异本身。）

### typert RPC 参数名逐方法不同(三种形态)

网关按**方法 descriptor**校验参数名,猜错一律 `gateway/arguments-invalid`:

| 形态 | 方法 | payload.args |
|---|---|---|
| 有 `request` 形参 | `create`/`prompt`/`selectModel`/`page`/`projections` | `{ request: … }` |
| `_request` 命名 | `list` | `{ _request: {} }` |
| 纯空对象 | `modelCatalog` | `{}`(传 `_request` 报 `unexpected "_request"`) |

### 会话证据只走 RPC,不读会话文件

`session/list` 的 `projections`(含 `asOfSeq` 游标)+ `session/page`
(`address = {kind:'session',sessionId}`,`throughSeq` 取 `asOfSeq`;超出游标报
`through seq N is past cursor M`)。**不要**读 `session.v4.jsonl.zstd`:事件**批量
落盘**,成功的 turn 也可能只留 header,据此判断会得"turn 没跑成"的**假红**。
同理本宿主上 `llmMs`/`toolMs` **可能为 0 而 turn 已完成** —— 计费证据看
`tokenUsage`,执行证据看 `tool/result` 事件。

### 凭据与模型路由必须配对

账号记录(`deepseek-account-platform/*`)配 **`deepseek-account`** 路由;
`DEEPSEEK_API_KEY` 配 **`deepseek-official`** 路由。配错是**静默失败**:
`turn/end` 正常落、stderr 为空、`usage=0`,唯一痕迹是会话事件里一条
`assistant/attempt → finish → { code: "MISSING_CREDENTIAL" }`。
且**必须先 `selectModel` 再 `prompt`**(乱序则 turn 不起)。

## PTC 模式下第三方工具的等价性（2026-10-18 核查，`0.2.1-rc.2`）

**结论：本仓 `pty_*` / `ssh_*` / `shell_open` 在 PTC（`run_code`）下与官方 `terminal_*`
等价可用，无需任何额外元数据。** 源码 + 受控实验全文见
[docs/research/research-ptc-third-party-tools.md](docs/research/research-ptc-third-party-tools.md)。

- **规则**：PTC 的 SDK 渲染集合 = **调用方 agent 的可见集**减去 `run_code`
  （`packages/core/tools/src/index.ts` 的 `sdkSchemas()`），每条只取
  `name`/`description`/`parameters`/`output.schema` 四个字段；派发侧用**同一个**
  `registry.schemas(agent)` 建绑定 ⇒ **渲染了即能调** —— "第三方"在 PTC 里没有差别。
- **必要条件**（挂载期判定，缺了是**响亮失败**而不是被静默排除）：`defineTool` 必须给
  `output: { schema, render }`；`output.schema` 必须过 `assertSupportedJsonSchema`。本仓
  11 个工具（pty 六 + ssh 四 + `shell_open`）全部满足 —— `pty_list` / `pty_signal` 是
  `#119` 后新增的两个（原记 9 个）。
- **`presentation` 不是工具字段**：`presentation: 'ptc'` 是 loader 行
  `@deepseek-ai/dsh-agent-tool-presentation` 的 `config.mode`（实验里用 `DSH_TOOLS_MODE=ptc`）；
  `presentationMeta` 只是可选投影进结果 `meta` 的展示面，与 PTC 可用性无关。
- **与官方 `tool-terminal` 的实际差距**（都**不影响 PTC 可用性**）：① `pty_list` /
  `pty_signal` 已由 `#119` 补齐 —— 但 Windows/ConPTY 侧 `pty_signal` **只有终止语义**
  （`SIGTERM`/`SIGKILL` = 杀会话，其余白名单项响亮拒绝），是平台事实、不假装与 POSIX
  等价（单源：`src/pty/session-core.ts` 的 `PTY_SIGNAL_SEMANTICS`）；② 无
  `run_in_background`（官方走 `ctx.jobs`）—— **已被 `#120` 决策改变**（接入，见下「#120 grill 共识」）；③ 无 `presentationMeta` / `presentResult` /
  `finalizeContent` 字节上限。
- **`./wsl` entry**：默认 bundle patch 不挂 ⇒ SDK 里不会出现 `win_*`（opt-in entry 的预期行为，非缺陷）。

## #68 POSIX launcher 预设行事实(2026-10-11)

- **launcher 预设 lane 传递依赖**:launchers.ts 经 pty/index 引 `composeSshCommand`,容器 lane 装 `@lydell/node-pty` 外还需 `@deepseek-ai/schemastery@~3.18.5` + `@deepseek-ai/dsh-tools@0.2.1-rc.2`(npm range/钉源锚均可)。**【2026-10-16 修订】**原记 `dsh-tools@0.2.1-alpha.1`,与 **ADR-0005** 的 RC 锚不符(当时 `version` = `0.2.0-rc.2-r1`;2026-10-17 起锚 `0.2.1-rc.2-r1`),已改锚 RC;RC 与 alpha 的**接口差异**见上条 #82。
- **POSIX 预设行实机绿**:podman node:24-bookworm lane(.scratch/issue68-posix-launcher-verify.mjs,一条命令见脚本头)8 项 ALL GREEN——bash 行 resolved(/etc/shells 匹配行,候选全在盘)、zsh/fish 缺席姿态进 absent(probed 列 /etc/shells 匹配行;bookworm 容器无 fish 行故 probed 空)、win32 门控完全休眠、argv 单一出处、shell_open 同构回环。

## D13 (ADR-0013, 2026-10-16, human 拍板 B:执行器 world 整体移除)

- **本包 = 纯工具插件**:shell 执行器 world(`shell-host` 行、`src/index.ts`、
  `src/core/`、`src/backends*`、`src/types|timeout|subprocess-context|wsl-bridge`、
  client 设置卡、`./remote` entry)全部删除;`ctx.shell` 只由平台 shell 执行器
  提供。理由:B 路径(执行器注册/缝组装)已被实证会直接报错。
- **挂载面 = 两个自有 id 行**:`pty` + `terminal`;entry 面 = `./pty`(持久
  PTY 会话核心)、`./terminal`(shell_open launcher 预设)、`./wsl`(WSL 桥
  工具)。`launchers.ts` 吸收了原 backends 的 argv/prefix 常量
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
  (长度前缀 + 请求 id),只传 payload(base64 / `tar` 批量);**不用 SFTP / SSHFS / rsync**,
  零新增依赖。
- **远端零安装**:只要求 `sh` + `base64`/`find`/`stat`/`tar`;不装 server、不做版本目录。
- **升级门槛**:watch/增量、千文件级扫描、断线续期/多客户端 —— 任一成立才升 helper
  (先零安装 `sh` 帧循环,再考虑 node)。
- **远程 one-shot 便捷工具(哨兵法)不在本 ADR**:留独立决定。
- **supersede 范围**:仅覆盖 ADR-0013 的「Remote one-shot goes route C」一节。

## D12 (#ADR-0012, 2026-10-16, human 拍板:只保留独立插件注册)【行清单已被 D13 收窄:现挂载面 = `pty` + `terminal`,无 `shell-host`;又被 D14 扩到 5 行】

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

## 术语表(惰性)

- **Backend Descriptor(后端描述符)**:声明式后端描述 = 有序可执行路径候选 + 分模式 argv 模板(one-shot/interactive)+ env 注入(null=删除)+ 双向路径映射(toShell/fromShell)。落地形态与字段溯源见 `docs/adr/0001-backend-descriptor-layer.md`(模式源:microsoft/vscode terminal profiles)。phase 1 只实现 msys2 后端;pwsh/wsl 为占位注册项。
- **Backend Registry(后端注册表)**:全部已注册 backend descriptor 的集合;`backend` config 单选指向其一(运行时可热切)。#23(路B)起 = msys2 / plain / pwsh / wsl / **ssh**(ssh 入册系 #23 授权,ADR-0006 缩小 ADR-0003 决策 2 的边界;持久会话仍不入册)。
- **WSL 桥(WSL bridge)**:wsl 后端专属的跨 VM 路径映射层,toShell/fromShell 双向(ADR-0003 决策 5)——通用 descriptor 映射与透传都不承担该职责。
- **远程工作区(Remote workspace)**:远端目录 = 工作区根;一个工作区持有**多条**持久会话(shell / 构建 / 测试)与一套远端文件面,命令与文件操作都**在远端就地执行**(长驻 `ssh <host> -- sh` 通道 + 帧化请求),不装远端 server、不用 SFTP(ADR-0016)。前身 = `dsh-shell-remote` 仓的 one-shot 远程执行世界(ADR-0004)与被吸收的 `./remote` entry(ADR-0007 吸收,ADR-0013 删除);现在**不要求**该独立插件安装。
- **持久会话(Persistent session)**:交互式/长生命周期 shell 语义,归 `dsh-pty-session` 仓(本地或 ssh 实例);shell-host 与 shell-remote 都不承载(ADR-0004 决策 5)。ADR-0007 后迁入 shell-host 包的 `./pty` entry,所有权结论不变。
- **Entry(包入口)**:dsh-shell-host 单包多入口的导出单元(ADR-0007)。现行 entry 面(ADR-0016):`./pty`(持久 PTY 会话核心)、`./ssh`(ssh 通道能力 + ssh 四工具)、`./terminal`(`shell_open` launcher 预设)、`./remote`(远程工作区 = 多会话编排 + 连接池)、`./remote-fs`(加性 `ctx.remoteFs` 后端 + `remote_*` 工具)、`./wsl`(WSL 桥工具)。全部是插件层 entry(defineTool + ctx.tools),各 entry 独立 settings namespace,共享包不合并配置面;执行器 entry(`./host`)及其执行语义已随 ADR-0013 删除。
- **会话默认 shell(Session default shell)**:`pty_open` 打开会话时**声明一次**的解释器,形态是**裸命令串**(`shellCommand`:可执行 + 交互 argv,如 `<msys2>/usr/bin/bash.exe --login -i`)。声明后 `pty_send` 的裸命令由它解释(`cd`/管道/`&&` 跨调用生效)。来源链 = 显式 `shellCommand` > `./pty` settings 的 `defaultShellCommand` > 响亮报错(#149 grill)。**与 launcher 预设不是一回事**:预设面归 `shell_open`,本声明不经预设解析、零词汇。
- **Shell 目标(Shell target)**:会话的顶进程是 shell —— 杀它收不回它拥有的子进程,故 `pty_signal` 对 SIGKILL 一律拒绝(`SIGNAL_FORBIDDEN`)、指向 `pty_close`(#119 起的信号语义)。`shell_open` 的预设会话与 #149 的 `shellCommand` 会话同属此类;**不是**从命令文本猜出来的,由声明层显式标记。
- **全局默认 shell(Global default shell)**:`./pty` settings 的 `defaultShellCommand` —— 只在 `pty_open` 两个参数**都不给**时才生效的默认解释器命令(`#149` Q6)。作用域今天是**本插件全局**,不是工作区;工作区作用域(**怎么建 / 生命周期 / 跨工作区隔离**)尚未存在,另票另议。
- **环境侦测上下文(Environment detection context)**:懒算一次并缓存、以 `systemPrompt.context` 交给 agent 的「本机可用 shell 环境(预设 id → 解析出的可执行)」**事实**。是事实不是指令,也**不主动起轮**(`#149` Q2;主动推送推荐属另一张票)。

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

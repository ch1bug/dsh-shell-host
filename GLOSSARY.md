# GLOSSARY.md — dsh-shell-host

> 状态:初始化骨架。术语表与决策随 grill/implement 惰性填充。

> 决策史（D 系列 / 各票共识）已迁 [docs/decisions-log.md](docs/decisions-log.md)

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
- **`./wsl` entry**：随 bundle 挂载但**默认关闭**（#143 起 patch 里该行 `disabled: true`，对 #134「刻意不挂」的改判）⇒ 默认下 SDK 里不会出现 `win_*`；行在 loader 树上可见（disabled 条目不激活、不解析 inject），开启 = 用户侧把该行 `disabled` 置 false 后重启（profile patch 覆盖行；插件页的行级开关粒度未核实，不声称）。

## #68 POSIX launcher 预设行事实(2026-10-11)

- **launcher 预设 lane 传递依赖**:launchers.ts 经 `src/ssh/compose.ts` 引 `composeSshCommand`（`#136` 起；此前经 `pty/index`）,容器 lane 装 `@lydell/node-pty` 外还需 `@deepseek-ai/schemastery@~3.18.5` + `@deepseek-ai/dsh-tools@0.2.1-rc.2`(npm range/钉源锚均可)。**【2026-10-16 修订】**原记 `dsh-tools@0.2.1-alpha.1`,与 **ADR-0005** 的 RC 锚不符(当时 `version` = `0.2.0-rc.2-r1`;2026-10-17 起锚 `0.2.1-rc.2-r1`),已改锚 RC;RC 与 alpha 的**接口差异**见上条 #82。**【`#136` 覆盖】**合成逻辑已搬离 `pty/index`，容器 lane 的传递依赖面是否收窄**未重测**。
- **POSIX 预设行实机绿**:podman node:24-bookworm lane(.scratch/issue68-posix-launcher-verify.mjs,一条命令见脚本头)8 项 ALL GREEN——bash 行 resolved(/etc/shells 匹配行,候选全在盘)、zsh/fish 缺席姿态进 absent(probed 列 /etc/shells 匹配行;bookworm 容器无 fish 行故 probed 空)、win32 门控完全休眠、argv 单一出处、shell_open 同构回环。

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
- **后台发送(Background send)**:一次 `pty_send` / `ssh_send` **不 await settle**,而是登记成宿主作业(`ctx.jobs`,`kind: 'pty-send'`),凭 `jobId` 由 `job_output` 收输出、`job_kill` 取消。它不是第二种发送通道 —— 写入与 settle 仍是同一条 core `send`;`run_in_background: true` 只是把「等 settle」换成「交作业」(`#120`)。
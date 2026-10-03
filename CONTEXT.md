# CONTEXT.md — dsh-shell-host

> 状态:初始化骨架。术语表与决策随 grill/implement 惰性填充。

## 项目一句话

DSH bundle:**Windows 宿主平面的 shell 执行器替换层**(原名 dsh-bash-msys,#12 改名)—— 在宿主平面完全替换内置平台 shell 执行器(对外接口与 `@deepseek-ai/dsh-bash-local` 逐字段一致,内部按 VS Code 终端 profile 建模),backend 可插拔(msys2 默认 / plain / pwsh,wsl reserved),并自带 Plugins 页设置卡片。MSYS2 backend 是独立于 bash 的环境:安装根/子系统(MSYSTEM)/PATH 表面/pacman/cygpath 是一等公民,bash 只是其中可配置的 shell。

## 已验证事实(来源:代码调研 + 实测,2026-09-30)

- **基线改道(2026-09-30 human 拍板)**:fork 目标从 0.1.7-rc.2 改为 **0.2.0-rc.2**(本地桌面端已是 0.2.0-rc.2)。两版本间 bash-local 的 src/tests 字节级一致(仅版本号),基线成本为零;上游 tag `dsh-v0.2.0-rc.2` = commit `639ed01539`
- **依赖策略(2026-10-03 human A0 拍板,推翻 09-30 决策,见 ADR-0006)**:@deepseek-ai 包**一律走 npm 发布 dist**(alpha.1 起官方全套含类型上 npm);peer 精确锚定官方版本,tsc/vitest 一律 node_modules 解析,本地源码 checkout 的三处枚举(overrides/extends/alias)已拆除。工具链(typescript/vitest/tsdown)走 npm
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

## D8 follow-up (#10, 2026-09-30)

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
  (vitest.config.ts `standardDecoratorPlugin`,移植自上游 vitest.shared.ts)
- zod 4.6.x 会让 projection `register` 的泛型推断 TS2589;fork 钉 `zod@4.4.3`
  (与上游一致)
- **依赖策略例外(仅类型)——已随 ADR-0006 失效(2026-10-03)**:fork 的
  `dsh-settings` 类型导入现走 npm dist 声明(`@deepseek-ai/dsh-settings`),
  源链隔离理由(settings→config-editor→hmr 不可编译)仍成立,npm dist 天然
  免疫;历史决策见 ADR-0002


## D9 (#2 grill 共识, 2026-10-03, 见 ADR-0003)

- **多后端 = registry + 运行时单选热切**(Q1=A):`backend` 字段保持单选 volatile,对外契约与 bash-local 逐字段一致不变;不做命名实例、不做 per-call 选择(D8 红线)
- **wsl 进 registry,边界写死**(Q2=C):registry 仅限本机后端(含本机 WSL 发行版);ssh/远程语义永不进 registry,独立票锚定
- **wsl 启动协议**(Q3=A):`wsl.exe -d <distro> -e bash -c <cmd>`,显式 distro,缺失响亮报全部探测点(与 pwsh 探测失败姿态同构)
- **backend 专属字段长在 descriptor 上**(Q6=B,VS Code profile 语义):wsl descriptor 自带 distro 等 VM 字段,无旁路 config 节,无模板占位符发明
- **跨 VM 路径映射由 WSL 桥承载**(Q7):toShell(fromShell)双向都归 wsl 后端专属桥模块——`/mnt/<drive>/` 规则、`\\wsl$\<distro>\` 反向映射、drvfs 边角都在桥内实现与测试
- **拆票**(Q5=C):T1 descriptor 表达力扩展 → T2 multi-backend registry/切换层 → T3 wsl descriptor + 桥;远程票独立

## D10 (#16 grill 共识, 2026-10-03, 见 ADR-0004)

- **远程 one-shot 执行独立成仓 `dsh-shell-remote`**(Q3 修订/Q7=A):三仓三界——shell-host=本地 one-shot;shell-remote=远程 one-shot;pty-session=持久会话(本地或 ssh,见其 #3)。互不注册,shell-remote 永不进 shell-host registry(ADR-0003 决策 2 不变)
- **传输 = shell 出系统 OpenSSH**(Q5=C):`ssh <host> -- bash -c <cmd>`,继承 `~/.ssh/config`/密钥/跳板机;ssh 库(持久连接/多路复用)属持久会话世界,留 revisit
- **D8 契约照守**(Q6=A):ShellResult 字段与 bash-local 逐字段一致;全部路径语义声明为远端路径,不做映射;无远程对应物的宿主能力(spill)响亮拒绝
- **形态分阶段**(Q2=C):薄传输先行;Remote-SSH 式远端组件挂 revisit(交互/长会话需求出现时,且大概率落 pty-session 世界)
- **拆票**(Q9=A):R1 脚手架+descriptor 骨架 → R2 one-shot 执行+D8 一致性测试+spill 拒绝
- **#16 转移**(Q8=C):shell-remote 开镜像票后 #16 关闭留指针

## 术语表(惰性)

- **Backend Descriptor(后端描述符)**:声明式后端描述 = 有序可执行路径候选 + 分模式 argv 模板(one-shot/interactive)+ env 注入(null=删除)+ 双向路径映射(toShell/fromShell)。落地形态与字段溯源见 `docs/adr/0001-backend-descriptor-layer.md`(模式源:microsoft/vscode terminal profiles)。phase 1 只实现 msys2 后端;pwsh/wsl 为占位注册项。
- **Backend Registry(后端注册表)**:全部已注册 backend descriptor 的集合;`backend` config 单选指向其一(运行时可热切)。仅限本机后端(含本机 WSL);远程语义永不入册(ADR-0003)。
- **WSL 桥(WSL bridge)**:wsl 后端专属的跨 VM 路径映射层,toShell/fromShell 双向(ADR-0003 决策 5)——通用 descriptor 映射与透传都不承担该职责。
- **远程执行器(Remote executor)**:`dsh-shell-remote` 仓的 one-shot 远程执行世界(ADR-0004)——薄 ssh 传输、契约与 bash-local 字段一致、路径语义全为远端;永不进 Backend Registry。
- **持久会话(Persistent session)**:交互式/长生命周期 shell 语义,归 `dsh-pty-session` 仓(本地或 ssh 实例);shell-host 与 shell-remote 都不承载(ADR-0004 决策 5)。

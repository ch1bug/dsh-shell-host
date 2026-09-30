# CONTEXT.md — dsh-bash-msys

> 状态:初始化骨架。术语表与决策随 grill/implement 惰性填充。

## 项目一句话

DSH bundle:**Windows 平台的 MSYS2 环境层** —— 在宿主平面完全替换内置平台 shell 执行器(对外接口与 `@deepseek-ai/dsh-bash-local` 逐字段一致,内部按 VS Code 终端 profile 建模),并自带 Plugins 页设置卡片。MSYS2 是独立于 bash 的环境:安装根/子系统(MSYSTEM)/PATH 表面/pacman/cygpath 是一等公民,bash 只是其中可配置的 shell。

## 已验证事实(来源:代码调研 + 实测,2026-09-30)

- **基线改道(2026-09-30 human 拍板)**:fork 目标从 0.1.7-rc.2 改为 **0.2.0-rc.2**(本地桌面端已是 0.2.0-rc.2)。两版本间 bash-local 的 src/tests 字节级一致(仅版本号),基线成本为零;上游 tag `dsh-v0.2.0-rc.2` = commit `639ed01539`
- **依赖策略(2026-09-30 human 拍板)**:@deepseek-ai 包**一律不走 npm registry**(npm latest 标签陈旧);从本地源码库 `<old-work>\deepseek-harness`(已钉在 dsh-v0.2.0-rc.2 tag)解析:tsc 经 tsconfig.base.json paths、vitest 经显式 source alias、声明产物经 `tsc -b` 构建、pnpm overrides link: 兜底。工具链(typescript/vitest/tsdown)走 npm
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
- D7(2026-09-30 triage)backend 描述符层一次到位:executor 第一版即含声明式 backend 层(spawn/argv 模板/env/路径映射),模式参照 VS Code terminal-profile/remote;phase 1 只实现 msys2 后端,pwsh/wsl 描述符占位(#3/#2),落地=填描述符+补测试,不做破坏性重构。WSL 涉及 ssh/远程语义,明确 phase 2
- D8(2026-09-30 human 拍板,方向修订)**从"并列 preset"改为"宿主级替换"**:完全替代内置 bash 执行器、对外接口保持一致、内部实现参考 VS Code、加前端配置页。落地形态:
  - patch 在宿主平面禁用 `pwsh-sandbox`/`bash-sandbox`(win32 守卫)+ insert 本执行器(行 id `bash-msys`)——seam 每 composition 恰一个 provider,preset 树的 tool-bash 解析宿主 ctx.shell,装载即全 preset 生效
  - 已知取舍:web-app standard/minimal preset 的 `pwsh` 工具(win32 启用)在替换后命令文本交给 bash(上游契约:无方言翻译);本部署用 bash-dialect preset
  - 前端设置页 = 包内 client half(lib/client.js closure factory,只外部依赖平台模块表的 primitives + react/jsx-runtime),绑定 configForms namespace **`bash-msys`(= Loader 行 id,settings-controller 自动按行派生表单)**;volatile 字段经 settings user-section 运行时改预算,免重启
  - 顺带覆盖 `terminal-controller`(宿主级侧边栏用户终端):默认 shell 显式指 MSYS2 bash `--login -i`,摘掉裸 `bash` 候选(宿主 PATH 无 MSYS2,裸 bash 只会命中 WSL stub);!!js existsSync 探测,未安装则回退上游发现

## 术语表(惰性)

- **Backend Descriptor(后端描述符)**:声明式后端描述 = 有序可执行路径候选 + 分模式 argv 模板(one-shot/interactive)+ env 注入(null=删除)+ 双向路径映射(toShell/fromShell)。落地形态与字段溯源见 `docs/adr/0001-backend-descriptor-layer.md`(模式源:microsoft/vscode terminal profiles)。phase 1 只实现 msys2 后端;pwsh/wsl 为占位注册项。

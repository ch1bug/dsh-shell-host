# ADR-0018: 自定义 shell 注册面 —— 注册门、重启生效契约与配置页载体

- Status: Accepted（2026-10-29 经 #170 修订，见「修订（#170）」节）
- Date: 2026-10-26
- Deciders: human 立票 #105（批 J 第 4 票）；实现会话按批次纪律自定票内口径并留档
- Context: ADR-0008（launcher 层；其「影响」段把 settings CRUD UI 列为出票范围外，
  本票承接）、ADR-0012（rows-only）、ADR-0013（tools-only）；#54（CustomLauncherConfig
  数据形状）、#56（source/overrode 出处字段）

## 修订（#170，2026-10-29）

#170（注册审计面）的 grill 设计树（票面评论 D1–D9，maintainer 逐条拍板）修订本
ADR 三点：

1. **权威存储：patch 行 → `custom.d/<id>.json` 文件族**。决策 §4 的「配置文件
   就是唯一权威存储与唯一写入口」所指向的存储形态变更：custom 预设的权威存储
   改为每条预设一个独立 JSON 文件（目录由 terminal 设置的 `customDir` 给出）。
   动机是显性隔离：坏一条只禁用一条。`cordis.patch.yml` 行配置里的 custom 条目
   **废止**：挂载时忽略并记审计事件（`ignored: patch-source`），不做兼容双读。
2. **注册门：整批 fail-closed → 单条禁用**。决策 §1 的「任一条目非法 ⇒ 抛错、
   整行拒绝激活」退役：挂载路径不再因单条 reject 抛错；校验不通过的条目被
   **单条禁用**（跳过挂载），在工具面呈现 `disabled` + 校验原因原文；其余条目
   照常挂载。理由：一条写坏的配置拖垮所有正常预设，代价与故障域不成比例；
   「半开的预设表」风险由审计面（可观测）与 #102 权限门（阻断权）分担。
   校验矩阵本身（id 字符集、禁覆盖内置、绝对路径、元字符、存在性）**原样保留**，
   变的只是失败处置。
3. **重启生效契约（决策 §2）随 patch 通道废止而退役**：进程级快照防的是
   「配置对象被原地改 / 行重挂采纳新表」；文件族的恢复语义是「改好文件、
   **下次挂载**自动放行」（#170 设计树 D7），故文件族**每次挂载重读重校**，
   不再做进程级快照。挂载 = 行重挂或进程重启，会话中途表不变的性质由
   「挂载时定型」保留。

审计面本体（append-only JSONL 账本、shell_open 哈希比对告警、`terminal_list`
的 disabled 投影）的边界与显式不做见 #170 票面 spec：审计面是可观测性设施，
无任何强制语义，阻断权归 #102 权限门。

## 背景

`./terminal` 的 settings namespace 自带 `custom` 通道（#54 定形）：用户在配置文件
（profile 的 `cordis.patch.yml`，terminal 行 `config.custom`）里声明自己的启动器预设。
这条通道的本质 = 声明一条**可执行路径 + argv + env + PATH 前缀**——任何 agent 一旦
`shell_open({ preset: id })`，那个程序就在这台机器上运行。注册面本身即攻击面
（#105 票面攻面清单：同名覆盖内置 id、argv 注入、路径解析、写入方、可审计）。

## 决策

### 1. 注册门（apply 期响亮校验，fail-closed）

`src/terminal/register.ts` 在 entry apply 时校验整个 `custom` 数组；任一条目非法 ⇒
**抛错、整行拒绝激活**，错误信息列出每条被拒条目的位置与全部原因。选择 fail-closed
（一条坏登记拖垮整行）而非「跳过坏条目继续」，理由：注册面是执行通道，半开的
预设表比不可用的终端面危险；行的失败原因在插件管理器可见（宿主对 failed row
展示 reason），修复路径明确。校验矩阵（每类一条用例锁定）：

- id：非空、字符集锁定（`[A-Za-z0-9][A-Za-z0-9._-]*`）、数组内不重复；
- **禁止覆盖内置 id**（收窄 #54 的「同 id 覆盖」语义——被诱导注册 `pwsh` 即替换
  内置视图，是最危险的一条；`shell_open` 的 `overrode` 字段保留为出处事实，但经
  本通道不再可能为 true）；
- local 可执行候选：绝对路径、含路径分隔符（裸名沿 PATH 解析 = 改名劫持）、
  无引号与 shell 元字符（含 cmd.exe 扩展集 `?` `!` `^` `%` 与控制字符）、win32 上
  拒 NTFS 备用数据流（第二个冒号）、注册时存在且不是目录；
- 空格**允许**：Windows 合法安装路径含空格（`C:\Program Files\...`），spawn 走
  argv 数组、启动命令有引号包裹；「可执行串带参数」由**存在性探测**拦住
  （带参数后缀的假路径不是文件）；
- base 继承源必须是内置 id 或**更早被接受**的自定义 id（配置顺序即继承顺序）；
- ssh 行必须有 host；argv/env/pathPrefix/cwd 形状各自校验（cwd 必须绝对）。

### 2. 重启生效契约（进程级快照，非「不读文件」）

宿主在 HMR profile 下会因配置写重组插件树（行开关走
`pluginManager.setPluginEnabled`，树随即重组）⇒「靠不重读配置文件」保证不了
重启生效——行重挂不是重启。结构保证：`custom` 表在**进程内第一次 apply 时定型**
（模块级快照），同进程内的后续 apply 复用快照；配置文件的任何修改恰好在宿主
进程重启时生效。守卫测试断言：同进程二次 apply 不采纳新配置、apply 后原地改
配置数组不泄漏进活表。代价（显式接受）：同进程内行关-开也不换表——行重挂不是
重启，这是契约的字面语义。

### 3. 写入方与 agent 面

注册只由**人**经配置文件写入；工具面无任何写注册口（守卫测试：terminal entry
恰注册一个工具 `shell_open`，参数面恰为
`preset/cwd/env/idleTimeoutMs/sandbox_permissions/justification`，全 bundle 工具名
无 registration-writer 形态）。将来若要 agent 可写，必须先接 #102 的权限/审批模型
（独立票，不在本票内顺手做）。

### 4. 配置页载体：client 半幅出票外（候选票），本票落 host 半幅

宿主读数（app.asar 展开文本，2026-10-26；行号口径同 #121）：

- 三个配置插槽 `plugins.item` / `plugins.bundle.config` / `plugins.row.config`
  **全是 client 插槽**——React 表单，由 bundle 浏览器半侧
  `ctx.slots.inject('plugins.row.config', …)` 注册（宿主文档 L498265/L498453）；
- **不存在**通用 schema 渲染的插件配置页：四个宿主配置页各来自伴生 UI 包
  （ui-settings-shell 等，同段点名）；`setPluginConfig` 类通用写入口 0 hit；
- 浏览器半幅装载约定：package.json `dsh.client`（`platform: 'web'`）声明 +
  `exports["./client"]` bundle（dsh-client-modules README，L427564）；
- 配置写协议：页面 owner 提供 `form.state` + `form.mutate(operations,
  expectedRevision)`（L498323），底层 `ctx.remote.settings.mutate(namespace, ops,
  revision)`（ConfigFormController，L537375-537390）——**ops 的具体形状未取证**。

在 ops 形状未取得的情况下写 React 配置页 = 发一个会坏的页。故：本票落 host 半幅
（注册门 + 生效契约 + 守卫 + 文档），配置页（`dsh.client` 声明 + tsdown web 构建
面 + `plugins.row.config` 表单）**另立候选票**；配置文件在本票语义下就是唯一权威
存储与唯一写入口。候选票立项时必须先补两项取证：mutate ops 形状、`dsh.client`
external/基线模块清单。

## 边界与显式不做（复核留档，2026-10-26 两轴）

- **symlink 穿越 / realpath 归一：不做，显式声明**。理由：注册门钉的是**字面路径**；
  注册期 realpath 化挡不住「路径事后被换成 symlink」（TOCTOU 在注册之后仍然存在），
  而拒绝一切 symlink 会误伤合法安装形态（POSIX 发行版的 `/usr/bin/bash` 普遍是
  symlink）。路径事后变化属于**审计面**（下一条），不是校验矩阵能解的问题。
- **攻面「可审计」（登记来源 / 内容哈希 / 路径事后变化可见）：本票不做**。它需要
  持久登记账本与告警通道，且与 #102 的权限/审批模型同面——**并入候选票**
  （审计面 + #102 对齐），不在本票顺手造半套。
- **`id` 与平台门**：win32 上内置 POSIX 行（zsh/bash/fish）不存在（#68 门控），
  故 win32 注册 `id: "zsh"` 不是覆盖、可以接受——这是平台门的既定语义，不是漏洞；
  跨平台同名配置的行为差异由平台门承担（#68 的裁决，此处不重复收窄）。
- **生效语义的实测边界**：HMR 重组行为（行开关 ⇒ 树随即重组）引自宿主文档读数
  （见下「宿主读数」L498261），未做活体 HMR 实测；快照机制对该行为的两个方向
  （重组换表 / 不换表）都保证「同进程不采纳新表」，故该边界不影响契约成立。

## 宿主读数（证据落仓）

本文引用的全部上游行号与结论（三插槽 client 形态、`form.mutate` 契约、
`dsh.client` 装载约定、HMR 重组语义、`ConfigFormController`）的原文摘录与取数
方法落在 **`docs/research/research-plugin-config-slots.md`**（仓内可复核；行号
口径 = 已装宿主 app.asar 展开文本，同 #121）。

## 影响

- `src/terminal/register.ts`（新）：校验单源；`src/terminal/index.ts`：apply 接
  注册门 + 进程级快照（`_resetRegistrationForTests` 测试缝）。
- #54 合并语义中的「同 id 覆盖」在**注册门**处被封死；`resolveLaunchers` 层的
  合并实现保留不动（出处字段与测试口径依赖它），注册门是唯一合法通道。
- 已非法配置在升级后会使 terminal 行拒绝激活（fail-closed 语义变更）——升级
  说明进 README 注册面节。

> 摘自 README（issue #55，ADR-0008；注册面 ADR-0018）。返回 [README](../../README.md)。英文版：[terminal.md](terminal.md)。

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

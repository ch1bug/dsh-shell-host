# ADR-0009: rc.2 桌面线 terminals 缝不可挂载 — #60 blocked 与补缝路线

日期: 2026-10-10 · 状态: 已接受 · 来源: #60（批 D 终点票，human 拍板 Q1–Q4）

## 背景

#55 交付的 `./terminal` entry（shell_open）依赖 `./pty`，`./pty` inject
`terminals` 缝（`TerminalSessionService`）。#55 桌面安装流程实测两组件
「等待依赖」，08b9ec7 将 pty/terminal 两 patch 行撤下，等待挂载前提成立。
#60 的任务：核实上游 profile 形态是否已满足恢复前提；满足则恢复两行，
不满足则确立上游 blocked 结论。

## 调查结论（代码级证据，2026-10-10 rc.2 asar + desktop profile 只读核实）

1. **rc.2 `@deepseek-ai/dsh-terminal` 是纯库包**（asar 内实测 0.2.0-rc.2）：
   main 只导出 `TerminalSessionService` 类与错误类，无 plugin entry / apply /
   provide 代码。挂载该包名不产出任何服务。
2. **全 asar 无构造点**：`new TerminalSessionService` 零命中；唯一引用方
   `dsh-terminal-bash` 只 import 符号（后端实现）。`terminals` 仅在 agent
   执行世界内部构造（世界级 child context），08b9ec7 结论成立且加强。
3. **desktop profile 未装该包**（profile node_modules 无 dsh-terminal），
   bundle yml 全文无 world/plugin-world 挂载声明机制（候选路径 2 证伪）。
4. **对照组**：headless alpha 线的 `dsh-pty-session` bundle（0.2.1-alpha.1-r1）
   能挂，是因为 alpha 宿主自带的 dsh-terminal 入口可 provide——rc.2 桌面线
   没有对应物。

### 已排除的绕过路径

- **全局安装插件**：堵点不是包解析（#55 实测两行已成功加载、卡在依赖等待），
  是组合语义——rc.2 没有任何 provide 入口，装哪里都凭空不多出入口。
- **方向性排除**：cordis 服务自挂载点向上解析；世界内部 provide 的
  `terminals` 实例对 root 组合的插件行不可见。除非上游开 world 级挂载声明，
  root 行永远拿不到世界内部实例。（**2026-10-17 复核：此句已过期** —— rc.1 的
  `subprocess` 就是 root 行，`sdk-minimal` 也有 root 级 `terminals` provide；
  「世界内部 provide」这个框架只对 `terminals` 成立，见下节。）

## 2026-10-17 `0.2.1-rc.1` 复核（事实更正，结论维持）

上游锚换到 `dsh-v0.2.1-rc.1` 后按源码复核：上面「调查结论」的第 1/2 条已随
`0.2.0-rc.2` → `0.2.1-rc.1` 的实质变化而过期，本 ADR 的**结论与决策均不变**。
本节引的 `vendor/…` / `packages/…` 是**上游树**路径（本仓无此树），复现命令见
`docs/research/research-official-terminal-ralph-bundles.md` 附录 B 的
`git show dsh-v0.2.1-rc.1:<path>`；判据与上游原文片段在该文档 §3。

**过期的事实**（只更正依据，不重开讨论）：

1. **`@deepseek-ai/dsh-terminal` 不再是纯库包**：`packages/terminal/terminal/src/index.ts`
   的 `TerminalSessionService extends Service` 在构造器里 `super(ctx, 'terminals')`
   —— 它是正常的 cordis 插件行，可被任意 loader 行挂载。故 rc.2 那句「main 只导出类、
   无 plugin entry / apply / provide」与「全 asar 无构造点」都不再成立。
2. **上游存在 root 级（无 `isolate`）provide 先例**：
   `packages/bundle/sdk-minimal/cordis.patch.yml` 的顶层 `insert` 列表直接挂
   `@deepseek-ai/dsh-terminal`（该文件对 `isolate` 零命中），所以这个模板里的
   `terminals` 是**根组合层 provide**、全树可见。即「重开条件 1」所要求的**能力形态
   已经存在** —— 但它**不在桌面线所用模板里**（桌面/web 线用 `@deepseek-ai/dsh-base`
   + `@deepseek-ai/dsh-web-app`，两者本体都没有 `dsh-terminal` 命中）。

**结论为什么仍维持**（rc.1 源码里的判据）：

- **`isolate: { terminals: true }` 给的是 entry 私有 realm**：
  `vendor/loader/src/config/isolate.ts` 的 `access()` 在 `label === true` 时
  `entry.realm ??= new LocalRealm(entry)`；同文件 `LocalRealm.suffix = '#' + entry.options.id`
  （而 `GlobalRealm.suffix = '@' + label`）⇒ 私有符号形如 `terminals#<entry id>`
  （如 `terminals#optional-persistent-terminals`），只对该组**之下**的 ctx 可见。
- **realm key 不一致即解析失败**：`vendor/cordis/src/reflect.ts` 的 `provide` 用
  `this.ctx.root[symbols.isolate][name]` 取 key，`inject` 沿 fiber 链上行时
  `if (fiber.parent[symbols.isolate][prop] !== key) throw` ⇒ 第三方在 profile root
  插的行只能看见 root 符号上的 `terminals`，拿不到 entry 私有实例。
- **「用同一 label 加入」这扇门也没开**：上游各挂载点用的是 `true`（私有）而非字符串
  label，没有可共享的命名 realm；且字符串 label 走 `GlobalRealm`，其 `@label` 后缀与
  `LocalRealm` 的 `#id` **永不相同**。

⇒ 甲方案（root provide + 复用上游类）在**今天桌面线所用模板**里仍无入口；ADR-0010
「自带通道」的选择仍然成立。

**重开条件 1 的细化**（原文「composition 层 provide 入口」过宽 —— `sdk-minimal`
先例就落在它的字面内，却与桌面线无关）：以下任一成立才重开 ——

1. **桌面线所用模板**（`dsh-base` / `dsh-web-app` 本体或二者的随附 preset）里出现
   root 级 `terminals` provide；
2. 上游留下一个**可命名加入**的 realm label（`isolate: { terminals: '<label>' }`），
   让 profile root 的第三方行能 join 与官方实例**同一个** realm。

`sdk-minimal` 的 root 先例**不满足**第 1 条 —— 它不是桌面线所用模板。

## 决策（human 2026-10-10 Q4 拍板：blocked + 甲方案立后续票）

1. **#60 走 AC(c)**：不恢复 pty/terminal 两行；撤下状态维持，本 ADR 即
   blocked 结论与重开条件载体。上游 issue（world 级挂载机制请求）起草后
   随批末 gate 确认再提交。
2. **后续路线选「甲：本仓补缝」**，弃「乙：无缝独立插件」——甲 = 新增
   provide entry，import 上游 `TerminalSessionService` 类（rc.2 公开发包，
   加依赖即解析）+ 挂 `dsh-terminal-bash` 后端，root 组合 provide
   `terminals`，然后恢复 pty/terminal 两行。服务语义（owner 授权、清理、
   id 铸造）全部复用上游实现，`./pty`/`./terminal`/shell_open（#56 语义）
   零改动。
3. **弃乙的理由**：乙需要在本仓重写会话注册表 + 直接 spawn（`src/pty`
   现状是缝上的薄工具面，核心都在缝服务里），工作量是甲的超集，且上游
   缝落地后变孤儿实现。乙仅在「不愿依赖上游 dsh-terminal 包」时才成立。

## 后果

- 桌面端 shell_open 在补缝票落地前保持不可用（撤下状态即现状，无回归）。
- 补缝票（后续票）落地时需桌面实测跨 world 的 owner 授权语义；rc.2↔alpha
  API 漂移时本缝随迁。
- 重开条件（任一满足即重开 world 挂载讨论，补缝可退役；第 1 条已于 2026-10-17 细化）：
  1. **桌面线所用模板**里出现 root 级 `terminals` provide，或上游留下一个可命名加入的
     realm label（细化与 `sdk-minimal` 反例见上节「重开条件 1 的细化」）；
  2. desktop profile 形态改为在组合层构造/provide `terminals`。

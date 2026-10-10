# ADR-0009: rc.2 桌面线 terminals 缝不可挂载 — #60 blocked 与补缝路线

日期: 2026-10-10 · 状态: 已接受 · 来源: #60（批 D 终点票，human 拍板 Q1–Q4）

## 背景

#55 交付的 `./terminal` entry（shell_open）依赖 `./pty`，`./pty` inject
`terminals` 缝（`TerminalSessionService`）。#55 桌面安装流程实测两组件
「等待依赖」，e2290a0 将 pty/terminal 两 patch 行撤下，等待挂载前提成立。
#60 的任务：核实上游 profile 形态是否已满足恢复前提；满足则恢复两行，
不满足则确立上游 blocked 结论。

## 调查结论（代码级证据，2026-10-10 rc.2 asar + desktop profile 只读核实）

1. **rc.2 `@deepseek-ai/dsh-terminal` 是纯库包**（asar 内实测 0.2.0-rc.2）：
   main 只导出 `TerminalSessionService` 类与错误类，无 plugin entry / apply /
   provide 代码。挂载该包名不产出任何服务。
2. **全 asar 无构造点**：`new TerminalSessionService` 零命中；唯一引用方
   `dsh-terminal-bash` 只 import 符号（后端实现）。`terminals` 仅在 agent
   执行世界内部构造（世界级 child context），e2290a0 结论成立且加强。
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
  root 行永远拿不到世界内部实例。

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
- 重开条件（任一满足即重开 world 挂载讨论，补缝可退役）：
  1. 上游 rc/alpha 线为 `@deepseek-ai/dsh-terminal` 提供 composition 层
     provide 入口或 world 级 bundle 挂载声明；
  2. desktop profile 形态改为在组合层构造/provide `terminals`。

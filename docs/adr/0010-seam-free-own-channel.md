# ADR-0010: 改道自带通道 — #61 弃补缝，pty 会话核心自管

日期: 2026-10-10 · 状态: 已接受 · 来源: #61（human 拍板改道；ADR-0009 决策 2 由本 ADR 取代）

## 背景

ADR-0009 拍板的后续路线是「甲：补缝 provide entry」（root 组合 provide
`terminals`，复用上游 `TerminalSessionService` 类）。human 在生态调查后
改道：「还是自带通道吧」——即不依赖 `terminals` 缝，会话核心自管。

## 生态先例（2026-10-10 gh 实读源码调查）

桌面可达的终端类插件全部绕开 `terminals` 缝，自带全栈通道：

- **caoyiwei850/dsh-ssh-ops**（0.3.19）：宿主 inject 只有
  `tools/storageDomain/webServer`；PTY 会话由 `ssh2` 自管（自建注册表
  sessionId → live PTY），客户端自注册右侧边栏 tab + xterm 渲染 + LRU
  池保活滚动缓冲，输出流走自建 `webServer` stream API。
- **weisiren000/dsh-remote-ssh-ops**：同款架构，依赖仅 `ssh2`。

上游源码（本地检出 dsh-v0.2.0-rc.2 tag）佐证必然性：`subprocess` 同样是
agent 执行世界级服务，官方 `api-terminal-controller` 都只能
`agent.ctx.get('subprocess')` 按 agent 解析。世界级服务（`terminals` /
`subprocess`）对 root 组合插件行不可见——自带通道是社区事实标准。

## 决策

1. **#61 改道乙方案（自带通道）**：`./pty` 不再 inject `terminals`——
   本地 PTY 用 node-pty（ConPTY）自管：自建会话注册表（sessionId、
   owner 绑定、dispose 清理、#56 的软上限/idleTimeoutMs 语义迁移）、
   自带 backend（MSYS2 / pwsh / cmd / wsl，候选顺序沿用 descriptors）。
2. **工具面与 patch 行**：pty_open/send/tail/close + shell_open 的对外
   语义不变（sessionId 仍是会话 id，#56 字段集保持）；pty/terminal 两行
   恢复随 bundle 挂载，无依赖等待（不再有 `terminals` 前置）。
3. **不做的**：不做 ssh-ops 式客户端 UI（本包工具面面向模型，无 xterm
   面板需求）；ssh 维度仍走既有 ssh 组合器，不经本地 PTY。
4. ADR-0009 的 blocked 结论与重开条件仍然成立；其决策 2（甲方案）由本
   ADR 取代。上游若日后提供可用的世界级挂载机制，可再评估迁移回缝。

## 后果

- `src/pty` 从「缝上的薄工具面」变为自管核心：会话注册表、spawn、读取
  游标、清理全部本仓实现并测试（工作量显著大于甲，#61 为常规实现票）。
- 引入 node-pty 原生依赖（Windows ConPTY），打包/verify:pack 需覆盖。
- 与上游缝彻底解耦：rc↔alpha API 漂移不再影响本包；上游缝开放后本实现
  成为孤儿路径，迁移与否届时再议（ADR-0009 重开条件仍是触发器）。

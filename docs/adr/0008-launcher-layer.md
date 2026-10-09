# ADR-0008: Launcher 层 — (transport × shell-env) 多实例终端

日期: 2026-10-09 · 状态: 已接受 · 来源: #52 grill（Q1–Q7 共识）

## 背景

dsh-shell-host 现状是单例执行器（路 B，#23/D8：替换 ctx.shell，backend 单选热切）。
限制：无法与平台 shell 执行器共存（cordis service 同 key 单注册）；做不到 VS Code
终端面板式「随去随用」多实例。包内 `./pty` entry 的持久会话缝（pty_open/send/
tail/close）已支持多实例、owner-scoped、跨调用持久——缺的只是「按 shell 环境一键
启动」的语义层。

## 决策

1. **启动器预设 = `(transport × shell-env)` 的声明式启动单元**。本机预设 =
   local transport × shell 环境；ssh 是下层传输维度（host + 远端 shell 环境），
   复用 ssh 组合器（keepalive/-o 语义，#21/#50），**不设 ssh 预设、不另起 ssh
   工具面孔**——ssh_start 四工具家族已沉淀三层语义，预设层做不出完整继承。
2. **预设表是 descriptor 的复用视图**（`src/backends.ts` interactive argv 模板 +
   `src/detect.ts` 常见位置运行时扫描），非独立硬编码表——避免同一 shell 两处
   argv 漂移；descriptor 没有的（git-bash/cmd/python-repl 类）以纯数据行补入。
3. **env = VS Code profile 语义**：env 属于 preset（profile 字段），spawn 时
   进程级注入——terminals seam 的 spawn spec **加性扩展** env 传递，缝的对外
   契约不变；不做 shell export 行渲染（core.open 现状是 POSIX export 行，
   对 cmd/pwsh 静默无效，不作为新层的机制）。
4. **新插件层 entry `./terminal`**（仿 `./wsl` 先例：defineTool + ctx.tools +
   patch insert 行），独立 settings namespace——机制（`./pty`）与语义（启动器）
   分层（ADR-0007 entry 词汇）。
5. **单工具 `shell_open`**；send/tail/close 复用 `pty_*`（返回的 sessionId 即
   缝会话 id），不加转发工具（Middle Man）。
6. **与路 B 共存**：D8 的单例执行器实现原样保留；`shell_open` 走 terminals 缝，
   与 `ctx.shell` 完全解耦，启用 shell-host 不再要求 disable 平台 shell。

## 备选与取舍

- 独立硬编码预设表（票面原案）：加 shell 零改动，但与 descriptor 双源漂移 → 弃。
- ssh 薄别名预设：继承不了 keepalive/options/校验，只会是残缺版 → 弃。
- shell export 行 env：POSIX-only，对非 POSIX 静默无效 → 弃（缝加性扩 spec）。
- `terminal_*` 三工具家族：Middle Man → 弃。

## 影响

- touch-set: `src/pty/index.ts`（seam/core env 加性扩展）、`src/launchers.ts`（新）、
  `src/terminal/index.ts`（新 entry）、`cordis.patch.yml`、settings 面新增 namespace。
- 拆票：T1 缝环境传递 → T2 预设层 → T3 entry 集成 + 多实例共存 AC。
- settings CRUD UI、跨 DSH 重启会话持久化、GUI 终端面板 = 明确出票范围外。

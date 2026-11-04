> 从 README 迁出（issue #136，ADR-0016）。返回 [README](../../README.md)。English: [ssh.md](ssh.md)。

## The `./ssh` entry (issue #136, ADR-0016 Q1)

`src/ssh/` is the INTERACTIVE full-duplex ssh instance as its own component
(#136 split it out of `./pty`): `ssh_start` / `ssh_tail` / `ssh_send` /
`ssh_close`, opened on the `./pty` entry's session core — the returned
sessionId IS a core session id, so `pty_send` / `pty_tail` / `pty_close` /
`pty_signal` still operate it (one registry, unchanged).

```js
import * as ssh from 'dsh-shell-host/ssh'   // { name, inject, Config, apply }
```

Independent settings namespace (`ssh`) with the ssh family's own
`enableRunInBackground` (the background-send section below describes the shared
path).

**迁移（只挂 `pty` 的老 profile 会失去 ssh 工具）**：`#136` 之前四个 `ssh_*` 工具是
`./pty` 行的一部分；现在只有挂 `ssh` 行才有它们。只挂 `pty` 的老 profile 升级后
**`ssh_*` 全部消失**（`pty_*` 不变）—— 在自己的 profile patch 里补一行
（迁移总说明统一在 [*The bundle patch*](../../README.md#the-bundle-patch) 的「怎么装、怎么加行」（#142）；本节写必须知道的细节）：

```yaml
- insert:
    - id: ssh
      name: dsh-shell-host/ssh
```

同一条迁移还包含两处**面收窄**（都写在这里，免得踩到）：

1. `./pty` 模块**不再导出** ssh 合成符号（`composeSshCommand` / `SSH_KEEPALIVE_*` /
   `SshOption*`）—— 它们随组件搬到 `src/ssh/compose.ts`；从 `dsh-shell-host/pty` 具名 import
   这些符号的代码会变成 `undefined`，改指新模块。
2. `pty` 命名空间的 `enableRunInBackground` **只再管 `pty_send`**；要关 ssh 的后台发送
   得在 `ssh` 行配置（默认 true，未配置的部署零变化）。

```yaml
- insert:
    - id: ssh
      name: dsh-shell-host/ssh
```

`ssh_start({ host, jump?, shell? })` composes the ssh command line
(`host`/`jump` are argv atoms — no whitespace/shell metacharacters) and opens it
on the core PTY; the three passthroughs reuse the core's cursors and reads
verbatim. **合成逻辑单一来源**：`src/ssh/compose.ts`（keepalive 默认值 / `port` /
`-o` 透传 / argv 合成）——`./terminal` 的 ssh transport 维度也吃同一份，行为与 #136 之前逐字一致。

远程 one-shot 分工按 ADR-0016 修订：单次执行使用 `dsh-ssh` 的 `ssh_exec`，本包不新增 one-shot 工具。
原独立 `dsh-shell-remote`（route C）仅为历史分工；
`ssh_start` remains for sessions a human/agent
converses with (long-lived remote shell, intermediate output via the tail
cursor).

Long-session hardening (#21 phase 1):

- `ssh_start({ ..., port })` — non-standard remote port, passed as `-p`
  (integer 1..65535; `user@host:port` is NOT valid ssh syntax).
- Keepalive defaults ride on every start: `-o ServerAliveInterval=15 -o
  ServerAliveCountMax=4` — without them, NAT/firewall idle drops kill
  sessions silently. (Single source #49: exported as
  `SSH_KEEPALIVE_INTERVAL_DEFAULT` / `SSH_KEEPALIVE_COUNT_DEFAULT` from
  `src/ssh/compose.ts` — code, tool description, and tests derive from there.)
- `ssh_start({ ..., options })` — free `-o` passthrough for remote-workspace
  capabilities building on this surface (#50, additive dual shape per entry:
  an atomic string — `"Key=value"` or a valueless `"Key"`, no whitespace —
  or a structured `{ key, value? }` whose value may carry spaces and is
  POSIX-quoted into one shell word, e.g. `ProxyCommand`). An option whose
  key is `ServerAliveInterval` / `ServerAliveCountMax` suppresses its
  default (exact key match).

**传输形态（ADR-0017，接口在 `src/ssh/transport.ts`）**：v1 在**所有**客户端都是
「每会话一条独立连接」——`ssh_start` 结果带 `transport` 结构化事实
（`shape: "per-session-connection"` + `controlMasterUsable`），远程工作区用它回答
「这条会话走的是哪种形态」。**Windows 客户端不能用 ControlMaster**（实测 socket 与 fd 两处都失败）
⇒ 那里**永不**去"先试 master 再回退"（那会在每次会话多打一条失败日志）。POSIX 客户端按
ADR-0017 **决策 2** 才是 master+channel 形态 —— 那条路径随远程工作区（#137）落地；本票是
**重构票**、不改开会话路径，所以结果里如实报的永远是**实际形态**（今天 = 每会话一条连接），
不虚报"可能形态"。
**远端登录 shell 必须是 POSIX 系**（会话打开时探测 `uname` / `$SHELL`，非 POSIX 响亮拒绝、
点名原因）；**Windows 远端 v1 明确不支持**。这两件的探测/拒绝随远程会话的打开路径（#137+）
落地，本票只承载接口与契约。

Reconnect semantics: **RECONNECT-NO, explicit** — a dropped session (network
cut, remote drop) surfaces `status.kind = "exited"` on the next send/tail;
nothing auto-reconnects. Recovery = `ssh_start` again (new session id); the
dead id is reclaimed by `ssh_close` (idempotent).

Live verification (machine lane): `tests/ssh-pty-live.spec.ts` runs the full
start → interactive → incremental tail → close round-trip against a real
host; it is gated on `DSH_SSH_LIVE_HOST` (optionally `DSH_SSH_LIVE_JUMP`)
and skips loudly when unset — no network in the default test lanes.

### marker 会话（#186，ADR-0020）：声明 bash 的远端 shell 带哨兵

`ssh_start` 传入 `shell: "bash --login"`（或任何 bash 名的远端 shell 文本）时，
会话以 `marker: "bash"` 打开——初始 settle 之后 core 向交互远端 bash 写入那一行
setup（`PS0` 开哨兵 + `PROMPT_COMMAND` 闭哨兵，用户既有钩子按 bash 语法接在后
面），于是 `ssh_tail` / `ssh_send` 默认读**过滤视图**：远端命令自己的输出，
横幅、回显与提示符行不进。`view: "raw"` 点名完整消毒流。**不传** `shell` 则远端
登录 shell 未知、不注入（声明不推断）；非 bash 的 `shell` 值同样不注入。机制、
信任规则与已声明局限都在 pty entry——见 `./pty` entry 文档 #186 节。

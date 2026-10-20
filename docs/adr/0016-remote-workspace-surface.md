# ADR-0016: The remote workspace comes back — three entries, remote-side execution, zero remote install

- Status: Accepted
- Date: 2026-10-19
- Deciders: human (2026-10-19 grill, 逐问拍板:
  Q1=A ssh becomes its own component · Q2=B a workspace holds multiple sessions ·
  Q3=B 文件面独立成组件 · Q4'=A file operations execute on the remote side ·
  Q5=A no remote server, zero install · Q7=A 与 `dsh-ssh` 正交分工 ·
  Q11=A 承载面 = 本地锚点目录 · Q12=A v1 不做前端 · Q13/Q14=A 文件面走 `ctx.fs`
  路由后端 —— 见下方「修订（2026-10-19，文件面改走 `ctx.fs`）」)
- Context: ADR-0013 ("this package is a tools-only plugin"; its section
  "Remote one-shot goes route C" sent remote work to the standalone
  `dsh-shell-remote` plugin); ADR-0004/0006/0007/0008 (remote boundaries, entry
  forms, launcher layer); GLOSSARY D8/D10/D13 (`Remote executor` = remote
  one-shot executor).
- Supersedes: **only ADR-0013's section "Remote one-shot goes route C"**. The rest
  of ADR-0013 stands: the executor world stays dead, `ctx.shell` stays
  platform-only, every entry here is plugin-layer.

## Context

Two measured facts made the current split untenable:

1. The interactive ssh four-tool family (`ssh_start` / `ssh_tail` / `ssh_send` /
   `ssh_close`) lives **inside** the `./pty` entry today — the "PTY session
   core" and the "ssh tool face" are one component, and the ssh command
   composition, keepalive constants and `port` / `-o` parsing are all in that
   same file.
2. After ADR-0013 the package has no remote *command or file* capability at
   all: the `./remote` entry was deleted and the standalone
   `dsh-shell-remote` plugin is **not installed** in the desktop profile
   (checked in `package.json` dependencies and the profile's bundle list;
   the "installed" claim in GLOSSARY D13 was true on 2026-10-16, not now —
   tracked as `#134`).

The goal is not "a remote command tool" but a **remote workspace**: the working
directory lives on the remote host, sessions persist, files are readable and
writable there. A reference-implementation survey (VS Code Remote-SSH, its
`docs/remote/ssh.md`) settled the transport question:

- VS Code **does not use SFTP**: it installs a VS Code Server on the remote and
  executes file operations **on the remote side**; the client only carries
  protocol frames over **one** SSH tunnel.
- It explicitly does not design for "SFTP only, no shell" hosts, and tells users
  who want local tools against remote files to mount SSHFS or sync with rsync —
  while stating that path is "significantly slower than working through VS Code".

## Decision

**1. Three entries; `./pty` returns to being a pure session core (Q1=A, Q2=B, Q3=B).**

- `./ssh` (new, own component): owns the ssh four tools, the command
  composition (`composeSshCommand`, single source), the keepalive defaults, the
  `port` / `-o` option parsing and session opening; exposes an **ssh service**
  for consumers; own settings namespace `ssh`.
- `./pty`: persistent PTY session core only (session registry, soft cap,
  dispose, `ctx.provide("pty")`); **no ssh tools**.
- `./remote` (new): the remote workspace = **multi-session orchestration** (one
  workspace may hold several sessions: shell, build, test), plus session
  bookkeeping, the `cwd` / `env` entry contract, workspace-level listing and
  teardown; own settings namespace `remote`.
- `./remote-fs` (new, a **sibling** of `./remote`, deliberately not merged into
  it): provides **`ctx.remoteFs`** — a *separate* service with the same shape as
  `dsh-fs`'s `ctx.fs` contract (`resolve` / `stat` / `readText` / `streamText` /
  `readBytes` / `listDir` / `watch` / `writeText` / `editText` + stable error
  codes) — plus the model-facing **`remote_*` tools** that consume it. It
  **never replaces `ctx.fs`**: the platform backend (`fs-local` / `fs-sandbox`)
  and every upstream file tool keep their exact behaviour (see 修订, Q13/Q14/Q15).
- Mount surface: `cordis.patch.yml` goes from two own-id rows (`pty`, `terminal`) to
  **five** (`pty` / `ssh` / `terminal` / `remote` / `remote-fs`); `tests/patch-shape.spec.ts`'s
  ratchet is updated explicitly (that is what the ratchet is for).
- Everything stays **plugin-layer** (`defineTool` + `ctx.tools` + own settings
  namespace): the executor world is not resurrected and `ctx.shell` remains
  provided by the platform shell executors alone.

**2. File operations execute on the remote side, behind `ctx.remoteFs` (Q4'=A, Q13/Q15=A).**

`./remote-fs` serves remote targets through `ctx.remoteFs`: each call is framed
onto the workspace's **single long-lived `ssh host -- sh` channel** and executed
in place with `sh` + coreutils; only request parameters and payload (base64, or
`tar` for batches) cross the tunnel. Its tools mirror the upstream shapes
(`remote_read` / `remote_write` / `remote_edit` / `remote_ls` / `remote_glob` …)
with the same stable error codes and the same "atomic write + version guard"
semantics, so a remote workspace does not inherit a weaker editing model.
Rationale: same shape as the reference implementation, zero new dependencies, and
it inherits the user's OpenSSH configuration file, jump hosts and the agent.
**No SFTP (library or binary), no SSHFS, no rsync, and no `ctx.fs` replacement.**

**3. Zero remote install (Q5=A).**

The remote host needs `sh` plus basic coreutils (`base64` / `find` / `stat` /
`tar`). No server, no transferred binary, no version directory. This is the one
place where this package is deliberately an order of magnitude lighter than the
reference implementation.

**4. When a resident helper becomes justified (hard trigger, not now).**

Re-evaluate only if **any** of these holds:

1. **watch / incremental** file observation is required (polling is not enough);
2. **thousands of files in one sweep** (round trips, not the protocol, become the
   bottleneck);
3. **reconnect / multiple clients** sharing one remote context.

Upgrade order: first a zero-install `sh` frame loop, then — and only then — a
node helper (which reintroduces exactly the install/version surface ADR-0013
wanted gone).

**5. The command face stays PTY sessions; no one-shot executor (Q5=A scope).**

Remote commands run inside a workspace session, i.e. the persistent session core.
Whether a one-shot convenience tool (send a command and wait for an exit sentinel)
should exist is **not decided here** — it stays a separate ticket.

**6. Carrier: a local anchor directory (Q11=A).**

A remote workspace is registered in DSH's own workspace registry as an ordinary
project whose path is a **local anchor directory** (empty except for a marker
file naming host and remote root). Sessions bind to that anchor as their `cwd`
(so session history keeps its per-workspace partition and `dsh-working-directory`
keeps working); the `ctx.fs` router translates anchor-prefixed paths to the
remote host. The remote directory is never mirrored locally: the anchor is an
identity, not a copy.

**7. Configuration: settings namespace, zero credentials (Q12=A).**

Non-secret workspace metadata (title, ssh host alias, remote root, anchor path,
default preset, connection options) lives in this package's own settings
namespace and is persisted by DSH's settings service. **No credential is stored
by this package at all**: host/user/port/key/jump host come from the user's
OpenSSH configuration and agent. v1 ships **no front-end half** (no `dsh.client`
bundle); humans interact through DSH's own workspace list and the tools.

**8. Connection lifecycle is owned by the workspace service, not the model.**

The remote workspace service holds one channel per host (ref-counted by
workspace/session), with keepalive and bounded reconnect. Channels are opened
**eagerly when the composition loads** — before the first agent turn — so the
model never spends a turn "connecting" and a failure surfaces before any work is
attempted. Tools never open connections: on a dead channel they return a stable
error code plus the reason, and `remote_status` exposes the connection state to
the model and to humans.

[2026-10-20, ADR-0017 (Accepted): the "one channel per host" wording is revised —
ssh multiplexing is measured unusable from a Windows client (`getsockname failed:
Not a socket`), so the shape becomes one TRANSPORT per host on POSIX clients and
one CONNECTION PER SESSION on Windows clients; the ref-counting unit is a
connection, not a host, because a shared shell would let one session's `cd`
silently move every other session's working directory.]

**9. The residual risk is the two-vocabulary split, not the local paths (Q14 correction).**

Because `ctx.fs` stays untouched, a bug in this package cannot break a local
workspace — that blast radius is gone. What remains: inside a remote workspace the
anchor directory looks **empty** to `read` / `write` / `edit`, so the model can
pick the wrong tool family. Mitigations: the `remote_*` descriptions state the
boundary; opening a remote workspace returns an explicit hint naming that family;
and a local tool hitting an anchor path gets an error message that points at the
remote family. The clean long-term fix — a **workspace-scoped `ctx.fs`** — is a
DSH upstream capability, not something this package can do today.

**10. Isomorphism with the upstream contract is a hard design constraint.**

If DSH later ships the corresponding capability (a workspace-scoped `ctx.fs`), we
must be able to **put their implementation in place of ours with almost no
friction** — measured in edits, not in intent. Therefore:

- `ctx.remoteFs` mirrors the `dsh-fs` contract **name-for-name and
  shape-for-shape**: `resolve` / `stat` / `readText` / `streamText` /
  `readBytes` / `listDir` / `watch` / `writeText` / `editText`, the same
  `FS_*` error codes, and the same optional version guards;
- our tools mirror the upstream tool semantics (`read` / `write` / `edit`, and
  the search family) **parameter-for-parameter**, differing only by the `remote_`
  prefix — so a migration deletes the prefix and re-points at `ctx.fs`;
- the channel and framing stay strictly **behind the service**: no upstream-visible
  protocol, no tool that speaks frames, so swapping the backend touches neither
  tool schemas nor prompts.

This is why the parallel "own coarse-grained tools" option was rejected: it would
have made the eventual upstream migration a rewrite instead of a swap.

## Consequences

- Positive: the three pieces a remote workspace needs (channel / session / files)
  are separately explainable and separately mountable; zero new dependencies; the
  remote side needs only `sh`.
- Costs, stated explicitly:
  - Mount surface grows by two rows and the ratchet must change; a profile that
    mounts only `pty` **loses the ssh four tools** ⇒ one-line migration note
    (add the rows) is mandatory in the release notes / README.
  - We own a small frame protocol (length prefix or NUL separation) and must test
    half packets, sticky packets, error frames and channel death; large files need
    chunking or `tar` batching.
  - The remote must offer a shell; "SFTP-only, no shell" hosts are **not
    supported** (same non-goal as the reference implementation, stated here
    explicitly).
  - **Live-verification gap**: this machine has no ssh target (the OpenSSH config
    carries no Host entry, `DSH_SSH_LIVE_HOST` is unset). Remote live cases can only
    skip loudly; the shipping evidence is the fake channel harness plus the
    synthetic layer, and `not run locally: remote live` must be declared wherever
    it matters.
- Glossary: `Remote executor` (remote one-shot executor) becomes **`Remote
  workspace`** (multi-session + remote file face); `dsh-shell-remote` is recorded
  as the **predecessor** plugin (no longer expected to be installed). The
  "installed in the profile" claim is removed (tracked in `#134`).
- Existing guards touched: the patch ratchet (**2→5** rows), the doc-reference
  guard (new module headers reference real paths), and the ssh live suite (the
  tools move from `./pty` to `./ssh`; the harness stays). `ctx.fs` and the
  upstream file tools are **not** touched (Q14 correction).

## Acceptance (detail belongs to the tickets)

- Synthetic layer: `./ssh` reuses the existing `bootPlugin({ spawnPty })` fake-PTY
  seam; `./remote` and `./remote-files` share **one** fake-channel harness whose
  frame codec is the shipping one (positive case, half packet, sticky packet,
  error frame, timeout, channel death).
- Live layer: one `DSH_SSH_LIVE_HOST` gate (reusing the existing env), running
  "open workspace → ls → read → atomic write → close"; no gate ⇒ `!! SKIP (loud)`.

## 参考实现与可抄点（2026-10-19 调研）

三个实现被逐一读过（一手代码 / 文档）：

| 实现 | 形状 | 裁决 |
|---|---|---|
| VS Code Remote-SSH | 远端装 VS Code Server；**文件在远端就地读写**；客户端只经一条 SSH 隧道；明确**不用 SFTP**（要让本地工具碰远端文件时建议 sshfs/rsync，并承认更慢） | 采纳"远端就地执行"的结论（决策 2）；**不采纳**"远端 server"（决策 3/4） |
| ZCode（`zai-org/ZCode`，Apache-2.0） | `ssh2` 库 + **远端部署 runtime**（manifest + SHA-256 + CDN 双模式 + 部署锁 + node-pty 预编译），agent 在远端跑 | **不采纳**（与零安装冲突）；下列五点照抄 |
| `@linxin666/dsh-ssh`（dsh-web） | `ssh2` 池化长连接 + `exec`（stderr 分离）+ **SFTP 传输** + 隧道 + 集群 + GUI | **正交分工**（Q7）；不重复其传输 / GUI |

照抄的五点（实现约束，票面逐条落）：

1. **exec 一律包 `/bin/sh`** —— 远端默认 shell 是 fish/zsh 时 POSIX 语法会翻车；我们的单条远程命令必须显式 `sh -c`。
2. **`exit` 只记码、`close` 才收尾** —— 帧化 stdio 上等价存在：EOF 与尾部数据的先后必须处理对。
3. **传输要有"降级形态"的意识** —— 网关 / 跳板机下 exec 与 SFTP 可能落在不同文件系统视图；我们用单一 exec 通道 + base64，这本身就是那个降级形态，文档要写明是有意选择。
4. **断连补偿事件** —— 底层 `error` / `close` / `end` 与业务流 close 不是同一条链，必须有断连事件 + `remote_status`，否则半开会话不会被回收。
5. **握手带协议版本 + clientId** —— 版本不配就响亮拒绝，别让新旧帧格式互相误读。

**活体验证用 Docker sshd 挂具**（`#141` 的方向）：起一个容器 sshd（固定密钥、非 22 端口）、
等就绪、用完即收，把"开工作区 → ls → read → 原子写 → 关闭"变成**本机可复跑读数**，不再依赖
一台真实主机；没有 Docker 时仍响亮跳过（`DSH_SSH_LIVE_HOST` 保留为真实主机通道）。

## 修订（2026-10-19，与 dsh-web 的 `dsh-ssh` 分工：Q7=A）

调研 `zhu1090093659/dsh-web` 的 `packages/dsh-ssh`（npm `@linxin666/dsh-ssh`）后拍板
**正交分工**。它的实测形状：`ssh2@^1.17` 库在进程内 + 每主机池化长连接（空闲 30 分钟断、
断线重连 ≤3）、`exec`（stdout/stderr 分离、60s 超时、2MB 截断）、**SFTP** 上传/下载
（宿主 ↔ 远端搬文件）、本地端口转发、集群并发、GUI 终端（xterm）、主机配置
`$DSH_HOME/dsh-ssh.json`（0600、自己存凭据）、六个 Agent 工具
（`ssh_list`/`ssh_exec`/`ssh_upload`/`ssh_download`/`ssh_tunnel`/`ssh_cluster`）。

- **它管的**：库内 ssh 会话池、一次性命令、SFTP 传输、隧道、集群、GUI、自管认证。
- **本包管的**：远程**工作区**（多会话编排）+ **远端就地读写**（agent 直接编辑远端文件，
  不落地本地）+ 零依赖的系统 OpenSSH 通道。
- **边界一句话**：「在远端编辑」归本包，「在两边搬」归 `dsh-ssh`。
- 推论：决策 5 里留待决定的 **one-shot 便捷工具 ⇒ 不做**；需要一次性远程命令的场景
  指向 `dsh-ssh` 的 `ssh_exec`。决策 3/4（零安装、无 server）不变。
- 推论：文件面的语义**只做就地读写**，不做"上传/下载"；进度流、断点续传、目录树同步
  都不在本包（那是传输语义，归 `dsh-ssh`）。

## 修订（2026-10-19，文件面改走加性后端：Q13=A → Q14 纠正 → Q15=A）

**查到的内核实证**（读 DSH 安装内的 `@deepseek-ai/dsh-fs` / `dsh-tool-fs` 源码：

- `ctx.fs` 是 cordis `Service`，**每个组合一个**（由 `fs-local` 或 `fs-sandbox` 填充）；
- `dsh-tool-fs` 的每次解析都用**它自己那个** `ctx.fs`（app 级），cwd 则来自
  `ctx.workingDirectory.ensure(agent)` ⇒ **"按会话换一个远程 fs"在今天不可行**；
- 但 `dsh-fs` 的契约本身明确为"一个执行世界的文件系统"设计，文档写明**远程后端**可以
  实现它（`resolve` / `stat` / `readText` / `streamText` / `readBytes` / `listDir` /
  `watch` / `writeText` / `editText` + `FS_NOT_FOUND` / `FS_STALE_VERSION` /
  `FS_AMBIGUOUS_EDIT` 等稳定错误码；策略在 `dsh-fs-observation-policy` 里，通过
  `fs/write-intent` / `fs/edit-intent` / `fs/observed` 三个事件）。

**拍板经过**：Q13 先选 A（做远程 `ctx.fs` 后端）；随后 human 纠正
**「我们实现的后端，不应替换 DSH 原本的」**；Q15 定为 **A = 加性**。

**因此本 ADR 的决策 1/2/9 按加性改写**：

- 我们提供 **`ctx.remoteFs`**（与 `dsh-fs` 同形的独立服务）+ 消费它的 **`remote_*`** 工具族；
- **`ctx.fs` 与 `fs-local` / `fs-sandbox` 一字不动**，上游 `read` / `write` / `edit` /
  `glob` / `grep` 行为完全不变；
- 确定代价：**两套文件词汇**（锚点目录对上游工具是空目录），缓解措施见决策 9；
- 干净的长期方案 = DSH 上游支持**工作区作用域化的 `ctx.fs`**；本包不自行实现它，
  但 `ctx.remoteFs` 保持同形契约以便那一天**平移**（届时只需把同一个实现挂到 scoped fs）。

# ADR-0016: The remote workspace comes back — three entries, remote-side execution, zero remote install

- Status: Accepted
- Date: 2026-10-19
- Deciders: human (2026-10-19 grill, five questions settled one by one:
  Q1=A ssh becomes its own component · Q2=B a workspace holds multiple sessions ·
  Q3=B `remote-files` is a sibling component · Q4'=A file operations execute on the
  remote side · Q5=A no remote server, zero install)
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
- `./remote-files` (new, a **sibling** of `./remote`, deliberately not merged
  into it): the remote file face (list / read / write / stat / path), depending
  on `./ssh` only; own settings namespace `remote-files`.
- Mount surface: `cordis.patch.yml` goes from two own-id rows (`pty`, `terminal`) to
  **five** (`pty` / `ssh` / `terminal` / `remote` / `remote-files`); `tests/patch-shape.spec.ts`'s
  ratchet is updated explicitly (that is what the ratchet is for).
- Everything stays **plugin-layer** (`defineTool` + `ctx.tools` + own settings
  namespace): the executor world is not resurrected and `ctx.shell` remains
  provided by the platform shell executors alone.

**2. File operations execute on the remote side (Q4'=A).**

`./remote-files` sends framed requests over the workspace's **single long-lived
`ssh host -- sh` channel**; the remote side performs the reads/writes in place
with `sh` + coreutils; only request parameters and payload (base64, or `tar` for
batches) cross the tunnel. Rationale: same shape as the reference
implementation, zero new dependencies, and it inherits the user's OpenSSH
configuration file, jump hosts and the agent. **No SFTP (library or binary), no
SSHFS, no rsync.**

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
- Existing guards touched: the patch ratchet (2→4 rows), the doc-reference guard
  (new module headers reference real paths), and the ssh live suite (the tools
  move from `./pty` to `./ssh`; the harness stays).

## Acceptance (detail belongs to the tickets)

- Synthetic layer: `./ssh` reuses the existing `bootPlugin({ spawnPty })` fake-PTY
  seam; `./remote` and `./remote-files` share **one** fake-channel harness whose
  frame codec is the shipping one (positive case, half packet, sticky packet,
  error frame, timeout, channel death).
- Live layer: one `DSH_SSH_LIVE_HOST` gate (reusing the existing env), running
  "open workspace → ls → read → atomic write → close"; no gate ⇒ `!! SKIP (loud)`.

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

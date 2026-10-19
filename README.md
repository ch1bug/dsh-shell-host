# dsh-shell-host

DSH bundle: **a tools-only plugin (ADR-0012/0013)** — persistent PTY sessions
(`./pty`), launcher-preset terminals (`shell_open`, `./terminal`), and WSL
bridge tools (`./wsl`). No shell executor, no `ctx.shell` provider, no
upstream loader-row takeover: every row in `cordis.patch.yml` is an own-id
insert, and the shell seam belongs to the platform shell executors alone.

> History: this package was formerly a shell executor (MSYS2-first, VS Code
> terminal-profile modeled, routed backends incl. `ssh`) with host-only forks
> of the permission-presets and pwsh-tool rows. That world was removed in two
> steps — ADR-0012 (no upstream-row takeover) and ADR-0013 (executor world
> deleted) — after the executor registration/composition path kept failing in
> practice. Remote ONE-SHOT execution now lives in the standalone
> `dsh-shell-remote` plugin (route C).

## The bundle patch

`cordis.patch.yml` mounts exactly two own-id rows and touches nothing else:

1. `pty` (`dsh-shell-host/pty`) — the persistent session core.
2. `terminal` (`dsh-shell-host/terminal`) — the `shell_open` launcher surface.

The platform executors (`pwsh-sandbox` / `bash-sandbox`) keep their DSH-native
posture untouched; the one-shot `bash`/`pwsh` tool faces are the platform's own
(including upstream's pwsh-fallback behavior when PowerShell 7 is absent).

### Host MSYS2 prerequisites（宿主环境最低工具集，2026-10-02 实测补齐）

launcher 预设与 ssh 会话都假定宿主 MSYS2 工具链可用——**本 bundle 不负责装齐
MSYS2 工具链**。裸 MSYS2 缺常用工具会让 agent 的验证手段悄悄降级（实测：
diff/cmp 缺失时所有 diff 类验证被迫绕 `git diff --no-index`）。安装后请补齐：

```bash
pacman -S --needed diffutils patch jq unzip rsync
```

判定方法：agent 会话里 `command -v diff` 落空即缺。新增工具需求时在此处追加清单。

## The `./pty` entry (issue #28, ADR-0007; seam-free since #61, ADR-0010)

`src/pty/` is the absorbed dsh-pty-session module (pure move from the
dsh-pty-session repo, anchored at `dsh-v0.2.1-alpha.1-r1` per ADR-0005): a
Layer 0, protocol-agnostic PTY session core — SEAM-FREE since #61
(ADR-0010): sessions are SELF-MANAGED on node-pty (Windows ConPTY) via
`src/pty/session-core.ts` — an owner-scoped registry (sessionId → live
session, owner binding, awaited dispose cleanup), per-session line buffers
with incremental read cursors, the #56 soft cap (`maxSessions`, default 8,
counted from the registry so an entry remount cannot reset it — the #62
root cause is structurally gone) and the opt-in per-session
`idleTimeoutMs` (auto-close on no new output). Six tools — `pty_open` /
`pty_send` / `pty_tail` / `pty_close` / `pty_list` / `pty_signal` — plus a
programmatic facade (`ctx.provide("pty")`) for consumer plugins. Persistent/
interactive session ownership (ADR-0004 decision 5) is unchanged, and the
entry keeps its own settings namespace (`dsh-pty-session` plugin name,
`maxSessions` + `tailLines` config) — ADR-0007: sharing the package does not
merge config surfaces.

```js
import * as pty from 'dsh-shell-host/pty'   // { name, inject, Config, apply }
```

Mount it via the bundle layer with `name: 'dsh-shell-host/pty'` — no
dependency on any platform seam (the bundle patch mounts the pty + terminal
rows unconditionally).

### pty_list / pty_signal（#119）

补齐官方 `terminal_list` / `terminal_signal` 的工具面覆盖。两者都**只作用于调用方
agent 自己持有的会话**（数据源就是核心的 owner 注册表，与 `pty_close` 的
`SESSION_OWNED` 同一姿态）：`pty_list` 只列自己的（别人的会话根本不出现在结果里）；
`pty_signal` 拿别人的 id 一律 `SESSION_OWNED`、未知 id `NO_SESSION`，**归属判据先于信号名
校验**（别人的 id 配一个非法信号名也只会得到 `SESSION_OWNED`）。

- **`pty_list`**：每行 `{ id, status, pid? }`，**顺序稳定 = 创建顺序**（按 id 的数字
  后缀排；字典序会在第 10 个会话起错位，`pty-10` 会跑到 `pty-2` 前面）。已退出但仍被
  持有的会话照旧列出 —— 持久会话的契约是 `pty_close` 才回收。
- **`pty_signal`**：白名单与官方一致（`SIGINT` / `SIGTERM` / `SIGKILL` / `SIGTSTP` /
  `SIGHUP`）。**平台语义与代码共用同一份常量**（`PTY_SIGNAL_SEMANTICS`，
  `src/pty/session-core.ts` 导出；工具描述逐字引用它，本节的取舍与它同源）：
  - **POSIX**：`process.kill(-pid, signal)` 投递到会话的**进程组**（forkpty 的子进程是
    session leader，pid 即 pgid）—— 真信号投递、尽力而为。**前台进程组够不着**（Node
    没有 `tcgetpgrp`）：交互式 shell 把前台作业放进独立进程组时收不到，那种场景用
    `pty_send` 发 `"\u0003"`（Ctrl-C，由终端驱动投递给前台组）。
  - **Windows / ConPTY**：node-pty 的 `kill(signal)` 在 Windows 上直接抛
    「Signals not supported on windows.」（摘录见落地文档的证据载体），**只有终止一种语义**
    ⇒ 只接受 `SIGTERM` / `SIGKILL`，两者都等于**终止会话**（ConPTY 进程树被拆掉）；
    `SIGINT` / `SIGTSTP` / `SIGHUP` **响亮拒绝**，不做静默映射。这是平台事实，不假装与
    POSIX 等价。
  - **`SIGKILL` 对 shell 目标一律拒绝**（官方同款语义：POSIX 上硬杀 shell 收不回它拥有的
    子进程），改用 `pty_close` 走完整关闭路径。Windows 上任何可投递信号本来就是整棵进程树
    的拆除，所以那里**结束 shell 会话的正规做法就是 `SIGTERM`**（`SIGKILL` 仍按官方的名字
    拒掉）。**「shell 目标」由打开方声明**：`shell_open`（启动器预设，`./terminal`）传
    `shell: true`；核心**不从命令行文本猜**，所以 `pty_open({ command: "bash" })` 不算
    shell 目标 —— 猜不准就不猜（边界见 `src/pty/session-core.ts` 的 `OpenSpec.shell`）。
    ssh 会话同理**不是** shell 目标：它的本地顶层进程是 ssh 客户端而不是 shell，
    `SIGKILL` 在那里是一次正当的硬断开。
  - 投递**不自己关闭**会话：信号之后用 `pty_tail` 读后事，再用 `pty_close` 回收（幂等）。
    注意带 `idleTimeoutMs` 的会话若因信号停止产出，**空闲 watcher 之后仍可能把它回收** ——
    那是空闲策略，不是 `pty_signal` 关的。

### ssh 四工具（issue #24，承接 dsh-pty-session#3）

The `./pty` entry additionally registers `ssh_start` / `ssh_tail` /
`ssh_send` / `ssh_close` — the INTERACTIVE full-duplex ssh instance over the
same core. `ssh_start({ host, jump?, shell? })` composes the ssh command
line (`host`/`jump` are argv atoms — no whitespace/shell metacharacters) and
opens it on the core PTY; the three passthroughs reuse the core's cursors
and reads verbatim.

Division of labor (README-documented): ONE-SHOT remote commands belong to the
standalone `dsh-shell-remote` plugin (ADR-0013, route C — formerly this
package's `./remote` entry); `ssh_start` is for sessions a human/agent
converses with (long-lived remote shell, intermediate output via the tail
cursor).

Long-session hardening (#21 phase 1):

- `ssh_start({ ..., port })` — non-standard remote port, passed as `-p`
  (integer 1..65535; `user@host:port` is NOT valid ssh syntax).
- Keepalive defaults ride on every start: `-o ServerAliveInterval=15 -o
  ServerAliveCountMax=4` — without them, NAT/firewall idle drops kill
  sessions silently. (Single source #49: exported as
  `SSH_KEEPALIVE_INTERVAL_DEFAULT` / `SSH_KEEPALIVE_COUNT_DEFAULT` from
  `src/pty/index.ts` — code, tool description, and tests derive from there.)
- `ssh_start({ ..., options })` — free `-o` passthrough for remote-workspace
  capabilities building on this surface (#50, additive dual shape per entry:
  an atomic string — `"Key=value"` or a valueless `"Key"`, no whitespace —
  or a structured `{ key, value? }` whose value may carry spaces and is
  POSIX-quoted into one shell word, e.g. `ProxyCommand`). An option whose
  key is `ServerAliveInterval` / `ServerAliveCountMax` suppresses its
  default (exact key match).

Reconnect semantics: **RECONNECT-NO, explicit** — a dropped session (network
cut, remote drop) surfaces `status.kind = "exited"` on the next send/tail;
nothing auto-reconnects. Recovery = `ssh_start` again (new session id); the
dead id is reclaimed by `ssh_close` (idempotent).

Live verification (machine lane): `tests/ssh-pty-live.spec.ts` runs the full
start → interactive → incremental tail → close round-trip against a real
host; it is gated on `DSH_SSH_LIVE_HOST` (optionally `DSH_SSH_LIVE_JUMP`)
and skips loudly when unset — no network in the default test lanes.

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

### 覆盖规则 / 并发上限 / 空闲超时（#56 裁决）

- **预设覆盖**：custom 同 id 覆盖 built-in 视图（用户显式配置优先），**不报错** ——
  但 `shell_open` 结果带响亮字段 `source: 'builtin'|'custom'` 和
  `overrode: true|false`（仅当 custom 真正替换了一个存在的 built-in 视图时为
  true；shadow 一个未安装的 built-in 不算覆盖）。结果同时含
  `executable`（命中候选）/ `probed`（全部候选点）/ `cwd`（实际生效值）；
  不返回完整 env（合并后即整条 PATH，无增量），argv 不重复返回（`command`
  已含）。判定单源在 `resolveLauncherDetailed`（`src/launchers.ts`）。
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

```js
import * as terminal from 'dsh-shell-host/terminal' // { name, inject, apply }
```

Mount it via the bundle patch (`cordis.patch.yml`, row id `terminal`, name
`dsh-shell-host/terminal`). It needs the `pty` service — mount `./pty`
alongside (the patch order does not matter; both rows are plugin-layer).

## The `./wsl` entry (issue #30, ADR-0007)

`src/wsl-plugin/` is the absorbed dsh-wsl-bridge module (pure move, source
anchored at `dsh-v0.2.1-alpha.1-r1` per ADR-0005): Windows access tools for
agents running inside WSL — `win_ls` / `win_read` / `win_write` / `win_run`
(cmd / powershell / direct interop) / `win_open` / `win_path` / `win_drives`.
Path normalization accepts both `C:\Users\me` and `/mnt/c/Users/me` forms
(the entry's own simplified converters; relative paths pass through);
`win_run` writes temp `.bat`/`.ps1` files to `C:\Windows\Temp` and cleans up
after itself. [ADR-0013: the `wsl` BACKEND and its strict cross-VM mapping
layer (`src/wsl-bridge.ts`) are gone — this entry is self-contained now.]

```js
import * as wsl from 'dsh-shell-host/wsl'   // { name, inject, apply }
```

`./wsl` is **exported but deliberately NOT bundle-mounted** (ADR-0013): the
bundle patch mounts only two rows (`pty`, `terminal` — see *The bundle patch*
above), so installing the bundle does NOT give you the `win_*` tools. That is
by design — the row was never in the patch, so its absence is not a regression.
The tools exist for an agent hosted **inside WSL** reaching the Windows side;
with DSH running natively on Windows the semantics do not hold (path
normalization is redundant, and `win_run`'s temp `.bat`/`.ps1` staging under
`C:\Windows\Temp` has no point).

To use it, add the row to your own profile patch —
`$DSH_HOME/profiles/<name>/cordis.patch.yml` — then restart the profile (the
host composes the tree once at startup; see `docs/agents/profile-install.md`):

```yaml
- insert:
    - id: wsl
      name: dsh-shell-host/wsl
```

The row's `name` is the module specifier that decides which entry loads (`id`
is just the row identity); the source repo's old plugin name `dsh-wsl-bridge`
no longer resolves post-absorption. Plugin-LAYER entry (ADR-0007 "Entry form
differences"): built on `defineTool` + `ctx.tools`, registers model tools —
never an execution backend.

## Division of labor with the official optional bundles

DSH's optional-bundle list (`OPTIONAL_BUNDLES`) holds several bundles a person
switches on from the Plugins page; two of them bear on this package. Both are
offered switched **OFF** and are selected by no shipped template:

- `@deepseek-ai/dsh-experimental-terminal-bundle` — the official persistent
  terminal: `@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash` (the
  Windows row reuses the same backend package with `shellDialect: pwsh`) +
  `@deepseek-ai/dsh-tool-terminal`, i.e. six tools (`terminal_open` /
  `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` /
  `terminal_list`). While it is on it is a **global tool layer**: every agent
  in every preset sees those tools.
- `@deepseek-ai/dsh-experimental-ralph-bundle` — the `ralph` tool (a fixed
  script plus one fresh structured-output child per round). It injects
  `tools` / `workflowEngine` / `subagents` / `systemPrompt`, but registers no
  tool this package also registers: enabling it only adds the one global
  `ralph` tool.

Tool names and loader row ids do not collide, so the official bundles and this
one can coexist in a single profile. The recommended posture is nonetheless
**do not enable the official terminal bundle together with this package's
`./pty` / `./terminal`**: two session registries (`terminal_*` over the
official `terminals` service, `pty_*` over this package's own node-pty core)
plus the official bundle's own `tool:pty` system-prompt section — this package
registers no prompt section at all, so the model gets one mental model
described twice, and reading both it has no way to tell which registry a given
session id belongs to. Keep one of them: this package's `pty_*` / `shell_open`
(seam-free, ADR-0010) or the official six tools.

Two claims that must stay separate (merging them is the drift this section
exists to prevent):

- **Default inside the `minimal` preset** — the shipped `minimal` **agent
  preset** carries a `persistent-shell` group (`@deepseek-ai/dsh-terminal` +
  `@deepseek-ai/dsh-terminal-bash` + `dsh-tool-bash-persistent` /
  `dsh-tool-pwsh-persistent`), which surfaces a `bash` / `pwsh` tool whenever
  that preset is selected. It is part of the `minimal` preset; it is **not**
  the terminal bundle.
- **Optional and off by default** — the
  `dsh-experimental-terminal-bundle` described above. The default `standard`
  preset has no persistent-terminal row at all, so the `terminal_*` tools do
  not exist until a person turns the bundle on in the Plugins page.

"Officially provided" therefore does not mean "on by default". Upstream source
paths, patch excerpts and reproducible commands:
`docs/research/research-official-terminal-ralph-bundles.md`.

## Build & verify

`node --run install` / `node --run build` need no `deepseek-harness` checkout:
`peerDependencies` (cordis, schemastery, and the `@deepseek-ai/dsh-*` packages
that `dsh-tools` declares) resolve from npm.

```bash
node --run typecheck      # tsc --noEmit -p tsconfig.json
node --run build          # tsc -p tsconfig.build.json → tsdown (lib/*.js)
node --run test           # typecheck + scripts/verify-all.mjs (the single check entry)
node --run test:release   # build + verify:pack (exports pointers resolve from the tarball)
```

Scripts use `node --run` rather than a package-manager shim, so they work in an
environment that has only Node (no `pnpm`/`npm` on PATH) — issue #79.

**First clone, once:** enable the local pre-commit guard. Git does not ship hook
configuration with a clone, so the file is present but inert until this is run:

```bash
git config core.hooksPath .githooks
```

It checks detached HEAD + lockfile agreement + typecheck, and skips LOUDLY
(never blocking) when a tool is missing. Bypass deliberately with
`SKIP_HOOKS=1 git commit …`.

No CI (maintainer decision 2026-09-30; boundaries in ADR-0014) — local
verification is the only channel. In the `verify-all` summary, `PASS*` means the
case contained a loud skip and its environment-side assertions were NOT
verified; `SKIP` means a gate was off. See `docs/agents/TESTING.md` for the
tiering and evidence rules, and `docs/dev-environment.md` for isolation,
source deployment and build gotchas.

## Provenance

- History: started as a fork of `@deepseek-ai/dsh-bash-local` **0.2.0-rc.2**
  (© DeepSeek AI, MIT; see `LICENSE`), became an independent shell executor
  (issue #23), and ended as a tools-only plugin (ADR-0012/0013, 2026-10-16).
  The PTY/wsl modules are pure moves absorbed from their source repos
  (ADR-0005 anchors).
- Dependencies: `peerDependencies` = `@deepseek-ai/cordis` +
  `@deepseek-ai/schemastery` + the current `@deepseek-ai/dsh-tools` **direct peer
  set** (10 `dsh-*` pins that track the certified anchor — ADR-0005, dev-environment
  §4.4); admission is gated separately by the `engines.dsh` range (ADR-0005
  decision 6, dev-environment §2.1); deps are `@deepseek-ai/dsh-tools` +
  `@lydell/node-pty`; tooling
  (typescript/vitest/tsdown) comes from npm.

Status: v0.2.1-rc.2-r1, tools-only (ADR-0012/0013): `./pty` + `./terminal` +
`./wsl`; remote one-shot via the standalone `dsh-shell-remote` plugin.

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
`idleTimeoutMs` (auto-close on no new output). Four tools — `pty_open` /
`pty_send` / `pty_tail` / `pty_close` — plus a programmatic facade
(`ctx.provide("pty")`) for consumer plugins. Persistent/interactive session
ownership (ADR-0004 decision 5) is unchanged, and the entry keeps its own
settings namespace (`dsh-pty-session` plugin name, `maxSessions` +
`tailLines` config) — ADR-0007: sharing the package does not merge config
surfaces.

```js
import * as pty from 'dsh-shell-host/pty'   // { name, inject, Config, apply }
```

Mount it via the bundle layer with `name: 'dsh-shell-host/pty'` — no
dependency on any platform seam (the bundle patch mounts the pty + terminal
rows unconditionally).

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

Mount it via the bundle layer with `name: 'dsh-shell-host/wsl'` (the row name
is the module path of this entry — the source repo's old plugin name
`dsh-wsl-bridge` no longer resolves post-absorption). Plugin-LAYER entry
(ADR-0007 "Entry form differences"): built on `defineTool` + `ctx.tools`,
registers model tools — never an execution backend.

## Build & verify

`pnpm install && pnpm build` needs no `deepseek-harness` checkout:
`peerDependencies` are only `@deepseek-ai/cordis` +
`@deepseek-ai/schemastery`; everything else resolves from npm.

```bash
pnpm typecheck   # one facade: tsconfig.json
pnpm build       # tsc -p tsconfig.build.json → tsdown (lib/)
pnpm test        # typecheck + vitest unit + machine (ssh-pty-live skips without DSH_SSH_LIVE_HOST)
```

## Provenance

- History: started as a fork of `@deepseek-ai/dsh-bash-local` **0.2.0-rc.2**
  (© DeepSeek AI, MIT; see `LICENSE`), became an independent shell executor
  (issue #23), and ended as a tools-only plugin (ADR-0012/0013, 2026-10-16).
  The PTY/wsl modules are pure moves absorbed from their source repos
  (ADR-0005 anchors).
- Dependencies: `peerDependencies` are only `@deepseek-ai/cordis` +
  `@deepseek-ai/schemastery`; deps are `@deepseek-ai/dsh-tools` +
  `@lydell/node-pty`; tooling (typescript/vitest/tsdown) comes from npm.

Status: v0.2.0-rc.2-r1, tools-only (ADR-0012/0013): `./pty` + `./terminal` +
`./wsl`; remote one-shot via the standalone `dsh-shell-remote` plugin.

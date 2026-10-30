# dsh-shell-host

DSH bundle: **a tools-only plugin (ADR-0012/0013)** — persistent PTY sessions
(`./pty`), interactive ssh sessions (`./ssh`), launcher-preset terminals
(`shell_open`, `./terminal`), remote workspaces and file services
(`./remote` / `./remote-fs`), plus WSL bridge tools (`./wsl`, off by default).
No shell executor, no `ctx.shell` provider, no upstream loader-row takeover:
every row in `cordis.patch.yml` is an own-id insert, and the shell seam belongs
to the platform shell executors alone.

> **Language**: English is the authoritative documentation. The complete
> Chinese companion lives in [README_zh.md](README_zh.md); per-entry documents
> under [`docs/entries/`](docs/entries/) exist as `<name>.md` (English) and
> `<name>_zh.md` (Chinese) pairs with identical content. Content changes land
> in English first and are followed into the `_zh` twins.

> History: this package was formerly a shell executor (MSYS2-first, VS Code
> terminal-profile modeled, routed backends incl. `ssh`) with host-only forks
> of the permission-presets and pwsh-tool rows. That world was removed in two
> steps — ADR-0012 (no upstream-row takeover) and ADR-0013 (executor world
> deleted) — after the executor registration/composition path kept failing in
> practice. The old remote one-shot "route C" split was superseded by
> ADR-0016; the workspace capability now lives in this package, orthogonally
> to `dsh-ssh/ssh_exec` one-shot execution.

## The bundle patch

`cordis.patch.yml` mounts six own-id rows and takes over no upstream row
(since #143 `wsl` is mounted with the bundle but disabled by default):

1. `pty` (`dsh-shell-host/pty`) — the persistent session core.
2. `ssh` (`dsh-shell-host/ssh`) — the interactive ssh instance (`ssh_start` /
   `ssh_tail` / `ssh_send` / `ssh_close`), over the `pty` core (#136).
3. `terminal` (`dsh-shell-host/terminal`) — the `shell_open` launcher surface.
4. `remote` (`dsh-shell-host/remote`) — remote workspace registration, warm-up
   and long-lived connections (#137).
5. `remote-fs` (`dsh-shell-host/remote-fs`) — the additive `ctx.remoteFs` and
   the `remote_*` file tools consuming it (`remote_ls` / `remote_read` /
   `remote_write` / `remote_edit`, #137–#139); depends on the previous row
   (row order is the dependency).
6. `wsl` (`dsh-shell-host/wsl`, `disabled: true`) — Windows interop tools
   (seven `win_*`, #143). The row is on the mount face but off by default —
   see [the `./wsl` entry doc](docs/entries/wsl.md) for how to enable it.

### How to install and add rows (#142)

Installing the bundle = merging those six `- insert` rows into your profile's
patch (`$DSH_HOME/profiles/<name>/cordis.patch.yml`; the host composes the
tree once at startup — mechanics in `docs/agents/profile-install.md`). To add
a single capability, copy just its row — `cordis.patch.yml` itself is the
complete six-row copy source (copy the `wsl` row together with
`disabled: true` unless you mean to enable it, see
[the `./wsl` entry doc](docs/entries/wsl.md)). The `./ssh` (migration section),
`./remote` and `./wsl` entry docs carry paste-ready insert snippets; the
`pty` / `terminal` / `remote-fs` rows can be copied from the list above or
from `cordis.patch.yml` directly.

**Migrating an old profile (one sentence)**: if you only ever mounted
`pty` + `terminal`, add the `ssh` row (since #136 the four `ssh_*` tools moved
into `./ssh` — without the row they disappear; face-narrowing details in
[the `./ssh` entry doc](docs/entries/ssh.md), migration section); add
`remote` + `remote-fs` too if you want the remote file face.

**Two file vocabularies, do not mix them (Q14 correction, kept up front)**:
this package does **not** replace the upstream `ctx.fs`; upstream
`read` / `write` / `edit` / `glob` / `grep` behave **exactly as before**
(ADR-0016 decisions 1/2/9: what this package adds is an **additive**
`ctx.remoteFs`, the upstream surface untouched). Inside a remote workspace,
file operations go through **`remote_*`**: the workspace directory is only a
**local anchor** — it holds a `.dsh-remote-workspace.json` marker and mirrors
no remote file, and **is an empty directory to the local upstream file
tools**; local `read` / `write` / `edit` see the anchor, not the remote file.

**`./ssh` vs `./wsl` (one word: direction)**: `./ssh` is the **remote
channel** — from this machine to a remote POSIX host (interactive
`ssh_start`; the remote workspace file channel also rides it). `./wsl` is
**Windows interop** — for agents **running inside WSL** to reach the Windows
side (seven `win_*` tools), **not** remote access; it is bundle-mounted but
**disabled by default** (`disabled: true`, opt-in, see
[the `./wsl` entry doc](docs/entries/wsl.md)).

The platform executors (`pwsh-sandbox` / `bash-sandbox`) keep their DSH-native
posture untouched; the one-shot `bash`/`pwsh` tool faces are the platform's own
(including upstream's pwsh-fallback behavior when PowerShell 7 is absent).

### Host MSYS2 prerequisites (minimum host toolset, verified 2026-10-02)

Launcher presets and ssh sessions assume a working MSYS2 toolchain on the
host — **this bundle does not install one**. A bare MSYS2 missing common tools
silently downgrades the agent's verification options (observed: without
`diff`/`cmp`, every diff-style check had to detour through
`git diff --no-index`). After installing, fill the gap with:

```bash
pacman -S --needed diffutils patch jq unzip rsync
```

Test: inside an agent session, `command -v diff` coming up empty means it is
missing. Append new tool requirements to this list when they appear.

## Entry documents

The per-entry documentation moved out of this file — each entry has a complete
English document and a `*_zh.md` Chinese twin:

| Entry | What it covers | Docs |
|---|---|---|
| `./pty` | persistent PTY sessions: six `pty_*` tools + programmatic facade; session default shell (#149), `initialOutput` (#154), `pty_list`/`pty_signal` (#119), background send (#120), presentation metadata (#121), one-shot `autoClose` (#146), hard deadline (#159) | [pty.md](docs/entries/pty.md) · [中文](docs/entries/pty_zh.md) |
| `./ssh` | interactive ssh sessions over the pty core; migration + face narrowing (#136), keepalives, `-o` passthrough, transport shape (ADR-0017), RECONNECT-NO | [ssh.md](docs/entries/ssh.md) · [中文](docs/entries/ssh_zh.md) |
| `./remote` + `./remote-fs` | remote workspaces: registration/anchors, `remote_*` file tools, multi-session orchestration (#140), transport and boundaries | [remote.md](docs/entries/remote.md) · [中文](docs/entries/remote_zh.md) |
| `./terminal` | `shell_open` launcher presets; concurrency cap, idle timeout (#56), custom shell registration surface + audit ledger (#105/#170, ADR-0018), config page (#169) | [terminal.md](docs/entries/terminal.md) · [中文](docs/entries/terminal_zh.md) |
| `./wsl` | Windows interop for agents inside WSL (`win_*` ×7); mounted but dormant by default (#143), how to enable | [wsl.md](docs/entries/wsl.md) · [中文](docs/entries/wsl_zh.md) |

## Permission model (#102): resolve host policy per execution, escalate via official approval

The package's three **execution faces** (`pty_open` / `shell_open` /
`ssh_start`) all spawn **processes**, and `win_*` runs commands through the
host shell seam. **Before #102** they read neither `ctx.sandboxPolicy` nor
`ctx.approval` — a `read-only` session or `approval/policy = ask` could still
spawn processes and write bytes (an arbitrary-execution face bypassing the
official approval UI). All three faces now join the host permission model,
implemented in one place, `src/permission-gate.ts` (single source):

| Face | Behavior |
|---|---|
| `pty_open` / `shell_open` / `ssh_start` | **Before every execution**, `sandboxPolicy.resolve({ session })`: `read-only` **refuses** to spawn; `workspace-write` only allows starting **inside workspaceRoot** (with `cwd` omitted it defaults to workspaceRoot; relative cwd resolves against it); `danger-full-access` unrestricted |
| `pty_send` / `ssh_send` | **Re-resolved on every write**: the write baseline = the mode the session was **authorized under** (with escalation open, that is the one-shot granted mode). A current mode **narrower** than the baseline is refused (policy dropped to `read-only`, or a session opened via escalation under read-only ⇒ the grant does not leak). **Widening** is not a downgrade. Reads (`pty_tail`) and teardown (`pty_close` / `ssh_close`) carry **no gate** — they do not amplify permissions |
| `win_*` | The resolved policy rides **every shell request** to the executor (the executor is the real enforcement face); on refusal the result carries the official `[sandbox: file access denied under <mode> mode]` marker + same-turn escalation hint |

**Escalation (one-shot retry)**: after a refusal, retry the **same call** with
`sandbox_permissions` (`workspace-write` / `danger-full-access`) +
`justification` (a one-sentence reason, **paired** with the former). The
request goes through `ctx.approval.request` to the **official approval UI**
(this package builds no dialog of its own) and **only `allowed-once`
unlocks**; `rejected` / `cancelled` / `unavailable` all refuse and echo the
outcome back to the model (fail closed, no silent retry). With
`approval/policy = never` the official service rules `rejected` outright (no
dialog) — this package handles it through the same refusal path.

**Wording provenance (honestly labeled, not claimed "verbatim")**: the
escalation request's `reason` / `displayReason` text, the `allowed-once`
grant semantics and the non-grant dispositions come **directly from**
`@deepseek-ai/dsh-sandbox`'s `approveEscalation`; the refusal marker /
same-turn hint / `sandbox_permissions` parameter description come from the
same package's `sandboxDenialMarker` / `escalationHintMarker` /
`sandboxPermissionsDescription` (the same vocabulary as upstream's `bash` /
`pwsh` / `fs` families). **The mode-ladder precondition comparison is this
package's own** (using the official `WIDER_MODES` table, separating
"parameter error" from "policy refusal", hence one extra sentence in the
error text listing allowed targets) — an **intentional fork**, stated here
rather than claimed verbatim.

**Missing service = fail closed**: if `ctx.get('sandboxPolicy')` /
`ctx.get('approval')` is missing, execution is **refused** with an error
naming the absent service plus mounting guidance (**never silently
allowed**); all four entries also declare both services in `inject`, so in
deployments lacking them these rows **never activate**. ⇒ Without
`dsh-sandbox-policy` + `dsh-user-approval` mounted, `pty_*` / `shell_open` /
`ssh_start` / `win_*` are **unavailable by design** — deliberate (fail loud,
do not bypass). The official **base** bundle (`web` / `headless` profiles)
mounts both rows by default (mode `DSH_PERMISSION_MODE ??
'workspace-write'`); **`sdk-minimal` does not** (it is
`danger-full-access` and mounts no approval) ⇒ under that profile this
package's tool face is unavailable per the above; use a base-family profile
or add the approval rows yourself.

**Honest boundary (no pretending)**: `ctx.subprocess`'s spawn spec has **no**
`sandboxPolicy` field, so this package cannot obtain process-level isolation.
What it can promise is **policy decision (mode) + launch workspace boundary +
approval gate** — once the process is up, OS-level reads/writes remain the
platform executors'/sandbox dialect's job; this package does not impersonate
them.

**No custom command allowlist** (matching upstream): `pty_open` takes a
**free command line**; `shell_open` is the **narrower channel** (executables
only from the launcher preset table + probe points). A real command
allowlist would change the public face (`allowedCommands` config +
`resolveExecutable` in the same execution world) — that is **another
ticket**; this package does not pre-build forked semantics.

`pty_open` / `shell_open` / `ssh_start` results carry `sandboxMode` (the mode
this run executed under; with escalation, the **granted** mode).

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
  `@lydell/node-pty` + `diff` (#139's context-diff card, pinned to the upstream
  version); tooling (typescript/vitest/tsdown) comes from npm.

Status: v0.2.1-rc.2-r1, tools-only (ADR-0012/0013): the bundle mounts six rows
(`pty` / `ssh` / `terminal` / `remote` / `remote-fs` / `wsl`); `./wsl` ships
mounted but dormant (`disabled: true`, #143 — see
[the `./wsl` entry doc](docs/entries/wsl.md)). Remote one-shot is
`dsh-ssh`'s `ssh_exec` (ADR-0016); the standalone `dsh-shell-remote` plugin was
the historical route-C predecessor.

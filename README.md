# dsh-shell-host

DSH bundle: **an independent shell executor for the DSH shell seam on Windows**
— VS Code terminal-profile modeled, routed backends selectable per config
(`msys2` default, `plain`, `pwsh`, `wsl`, `ssh`), coexisting with the
platform shell executors, plus a Plugins-page settings card. MSYS2 is the
default backend, not the bundle's identity.

Positioning: MSYS2 is an ENVIRONMENT independent of any one shell — install
root (`msysRoot`), subsystem (`MSYSTEM`), PATH surface, pacman/cygpath tooling
are first-class; bash is just the environment's configurable shell binary.
The executor implements the DSH `ctx.shell` seam (the `ShellExecutor`
contract) with an interface-compatible surface — same `bash` tool schema,
jobs, spill files, exit markers, and configForms namespace shape — so every
preset's tooling works over it unchanged. It is NOT a fork of
`@deepseek-ai/dsh-bash-local`: the implementation is independent, modeled on
VS Code's terminal-profile declaration.

## What the bundle does (coexistence, issue #23)

`cordis.patch.yml` operates on the HOST plane (applies to every preset):

1. Leaves the platform executors alone — `pwsh-sandbox`/`bash-sandbox` keep
   their DSH-native posture.
2. Inserts this package's executor as a coexisting `shell-host` row,
   **disabled by default**; the user enables it on the Plugins page and its
   row then takes over `ctx.shell` (one provider per composition — enabled =
   this executor, disabled = the platform shell). Backend routing
   (`config.backend`): `plain` / `msys2` / `pwsh` / `wsl` / `ssh`, default
   `msys2` with subsystem `UCRT64`. Changing the backend applies to new
   commands without a reload. The `permission` row (the #10 host-only fork)
   is mounted UNCONDITIONALLY — it reads `ctx.sandboxPolicy`, never
   `ctx.shell`, so `/permission`, the settings PermissionRow, and the input
   permission picker stay alive in either posture.
3. Overrides `terminal-controller` (the right-sidebar USER terminal): MSYS2
   bash `--login -i` becomes the default shell with a visible name, and the
   bare `bash` candidate is pruned (host PATH has no MSYS2, so it can only
   resolve to the WSL stub). Install-probed: no MSYS2 → upstream discovery
   stands.

## Decoupled build (issue #23)

`pnpm install && pnpm build` needs no `deepseek-harness` checkout: the
shell-seam types (`ShellExecRequest`/`ShellExecSpec`/`ShellRunResult`/
`ShellProcess`/`ShellProcessRead`/`CollectedOutput`/`ShellSandboxInfo`) are
inlined in `src/types.ts`, the timeout arithmetic in `src/timeout.ts`, and
the `ShellExecutor` base in `src/core/executor.ts`. `peerDependencies` are
only `@deepseek-ai/cordis` + `@deepseek-ai/schemastery`; everything else is a
regular dependency resolved from npm, and `build` is `tsdown` alone. If a DSH
upgrade does not change those shapes, this package republishes nothing
(peer pins only the two vendor packages).

The `ssh` backend (merged from dsh-shell-remote, issue #23 AC9) runs
`ssh <host> -- bash -c <cmd>` through system OpenSSH — `~/.ssh/config` aliases,
keys, agent, and jump hosts all apply. `sshHost` is required (loud failure
when blank); all path semantics are remote paths, never mapped.

### Host MSYS2 prerequisites（宿主环境最低工具集，2026-10-02 实测补齐）

本 bundle 只把 shell 缝绑到 MSYS2 bash——**不负责装齐 MSYS2 工具链**。裸 MSYS2 缺
常用工具会让 agent 的验证手段悄悄降级（实测：diff/cmp 缺失时所有 diff 类验证被迫
绕 `git diff --no-index`）。安装后请补齐：

```bash
pacman -S --needed diffutils patch jq unzip rsync
```

判定方法：agent 会话里 `command -v diff` 落空即缺。新增工具需求时在此处追加清单。

Known trade-off: web-app's `standard`/`minimal` presets enable the `pwsh`
tool on win32; after the replacement its command text is handed to bash (the
seam has no dialect translation, by upstream contract). Use bash-dialect
presets on deployments with this bundle.

## VS Code-modeled internals

Backend descriptors (`src/backends.ts`) mirror VS Code terminal profiles:
ordered executable candidates (`ITerminalExecutable`), per-mode argv templates
(`IShellLaunchConfig`), profile env (`MSYSTEM`, `CHERE_INVOKING=1` so login
shells keep the working directory), and `addEnvMixinPathPrefix`-style PATH
prefixing. Detection (`src/detect.ts`) follows VS Code's probe order with the
WSL System32 stub excluded, and fails loudly naming every probed location.

## Front-end settings page

`src/client/` ships the browser half (served as
`/plugins/dsh-shell-host/client.js`): a Plugins-page card (order 11, after the
stock Shell card) bound to the `shell-host` configForms namespace — backend,
subsystem, install root, bash path, plus the command budgets. Values write
through the settings user-section and re-apply to new commands without a
reload (all config fields are volatile). The bundle's `lib/client.js` is a
closure-factory artifact over the platform module table (requires only
`@deepseek-ai/dsh-client-ui-primitives` and `react/jsx-runtime`).

## The `./pty` entry (issue #28, ADR-0007)

`src/pty/` is the absorbed dsh-pty-session module (pure move from the
dsh-pty-session repo, anchored at `dsh-v0.2.1-alpha.1-r1` per ADR-0005): a
Layer 0, protocol-agnostic PTY session core over the harness's owner-scoped
terminal seam (`ctx.terminals`). Four tools — `pty_open` / `pty_send` /
`pty_tail` / `pty_close` — plus a programmatic facade (`ctx.provide("pty")`)
for consumer plugins. Persistent/interactive session ownership (ADR-0004
decision 5) is unchanged; only the home moved, and the entry keeps its own
settings namespace (`dsh-pty-session` plugin name, `backendType` +
`tailLines` config) — ADR-0007: sharing the package does not merge config
surfaces.

```js
import * as pty from 'dsh-shell-host/pty'   // { name, inject, Config, apply }
```

Mount it via the bundle layer with `name: 'dsh-shell-host/pty'` (plus a
terminal provider — the plugin needs `ctx.terminals`, which default desktop
compositions do not mount). Division of labor with `backends/ssh.ts`
(ADR-0006): the ssh registry backend runs ONE-SHOT commands over a
ControlMaster connection opened and torn down per invocation; `./pty` owns
PERSISTENT sessions (survive turns, incremental tail cursor) — for a
long-running remote session, point `pty_open` at an ssh-capable backend
type; do not route it through the one-shot registry backend.

## The `./remote` entry (issue #29, ADR-0007)

`src/remote/` is the absorbed dsh-shell-remote module (pure move, source
anchored at `dsh-v0.2.1-alpha.1-r1` per ADR-0005): ONE-SHOT remote shell
execution over system OpenSSH — `ssh <host> -- bash -c <cmd>`, with the user's
`~/.ssh/config` aliases, keys, agent, and jump hosts applying for free. The
`RemoteShellExecutor` resolves/validates the descriptor loudly, composes the
remote payload (`cd -- <workdir> && eval <command>`, POSIX-quoted — the
workdir is a REMOTE path, never mapped), caps both streams in memory with the
tail retained (spill loudly rejects: host capability, no remote meaning), and
settles a ShellResult field-identical to the seam's `ShellRunResult` (D8,
runtime-locked by `tests/remote-conformance.spec.ts`).

```js
import * as remote from 'dsh-shell-host/remote'   // { RemoteShellExecutor, sshDescriptor, ... }
```

Two boundaries, per ADR-0007:

- **`./remote` is NOT a registry backend.** The executor config's `backend`
  single-select (ADR-0003/ADR-0006) never points at it — the remote one-shot
  world and the local registry stay separate layers, each with its own seam
  and settings namespace.
- **Division of labor with the ADR-0006 `ssh` registry entry**: that backend
  runs one-shot commands over a ControlMaster connection opened and torn down
  per invocation, inside the local registry's routing; `./remote` has its own
  standalone transport (bare system ssh, no ControlMaster) and its own
  executor contract. ADR-0006 is unaffected by the absorption — only
  ADR-0004's separate-repo half is superseded; the D8 field-identical contract
  and the loud spill rejection carry over as-is.

## Provenance (issue #23 status)

- History: started as a fork of `@deepseek-ai/dsh-bash-local` **0.2.0-rc.2**
  (© DeepSeek AI, MIT; see `LICENSE`); since issue #23 the implementation is
  independent (inlined seam types + local base class) while keeping the
  external interface compatible. The VS Code terminal-profile modeling
  (`src/backends.ts` / `src/detect.ts`) predates the decoupling and remains
  the descriptor vocabulary.
- Dependencies: `peerDependencies` are only `@deepseek-ai/cordis` +
  `@deepseek-ai/schemastery`. All other `@deepseek-ai/*` specifiers resolve
  from the npm registry (built packages); typecheck and vitest consume the
  same npm artifacts. Tooling (typescript/vitest/tsdown) comes from npm.

Status: v0.2.0-rc.2-r1 + issue #23 route B: decoupled build (inlined types,
tsdown-only, npm-resolved deps), backend routing (msys2/plain/pwsh/wsl/ssh),
coexistence with the platform shell (default disabled), ssh backend merged
from dsh-shell-remote, backend dropdown in the settings card.
See `CONTEXT.md` and GitHub Issues for the plan.

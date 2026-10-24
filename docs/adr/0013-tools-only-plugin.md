# ADR-0013: The executor world is removed — dsh-shell-host is a tools-only plugin

- Status: Accepted
- Date: 2026-10-16
- Deciders: human (route B, 2026-10-16: "shell-host 这不就是 B 路径么…B,因为这条
  路径也已被证明会直接报错"; remote 归 C 路线 = 独立 `dsh-shell-remote` 插件)
- Context: ADR-0012 (rows-only mounting); ADR-0001/0003/0004/0006/0007/0008;
  GLOSSARY D8/D9/D10/D12

## Decision

The shell EXECUTOR world leaves this package entirely. dsh-shell-host becomes a
tools-only plugin registering model tools via its own loader rows — it no
longer provides `ctx.shell`, no longer mounts a shell-seam provider, and no
longer carries any execution backend. The platform shell executors
(bash-sandbox / pwsh-sandbox) are the sole ctx.shell providers again.

Removed:

- `shell-host` loader row (the last own-id executor row) and the whole executor
  world behind it: `src/index.ts`, `src/core/`, `src/backends.ts`,
  `src/backends/`, `src/types.ts`, `src/timeout.ts`,
  `src/subprocess-context.ts`, `src/wsl-bridge.ts`, `src/client/` (the
  shell-host settings card and the whole client bundle — `dsh.client` inject
  is gone from package.json), and the `./remote` entry (`src/remote/`).
- Launcher-consumed constants (`MSYS2/PWSH/WSL_INTERACTIVE_ARGV`,
  `msys2PathPrefix`, `parseWslDistroList`) moved into `src/launchers.ts` —
  the launcher layer was their only remaining consumer.

What remains (plugin-layer entries only): `./pty` (persistent PTY session
core), `./terminal` (`shell_open` launcher presets), `./wsl` (WSL bridge
tools). [History: at decision time `cordis.patch.yml` mounted exactly two
own-id rows, `pty` + `terminal`, and `./wsl` was deliberately not among them —
Windows-interop tools only make sense for an agent hosted inside WSL
(issue #134). Both the row count (stale since #136/#137) and the `./wsl`
absence (superseded 2026-10-19, amendment below) no longer describe the
current mount face.]

## Remote one-shot goes route C

Remote one-shot execution is owned by the standalone `dsh-shell-remote` plugin
(ADR-0004's original boundary, the "C 路线"), installed in the profile
independently at the time. **Superseded by ADR-0016**: the remote workspace
moves back into this package and the plugin is no longer required (its
"installed" claim was true only as of 2026-10-16 — issue #134).

## Amendment (2026-10-19, #143): `./wsl` mounts dormant

Human's ruling revises the #134 "deliberately not mounted" call above: the
`wsl` row IS on the bundle's mount face — `cordis.patch.yml` inserts it with
`disabled: true` (own id + `dsh-shell-host/` name prefix, so the ADR-0012
shape is unchanged). The row stays on the loader tree and shows up as a
component in the plugin face, but a disabled entry is never activated, its
`inject` is never resolved, and the `win_*` tools stay off every agent's tool
face until the user turns it on (override the row with `disabled: false` in
the profile patch, then restart — the verified route; a Plugins-page per-row
switch is unverified and not claimed here). Enabling does
not reintroduce an executor: `./wsl` remains a plugin-layer entry running
every `win_*` call through the platform shell seam.

## Superseded scope

- ADR-0001 (backend descriptor layer) — superseded: no backends remain here.
- ADR-0003 (multi-backend registry and WSL) — superseded: the registry is gone
  (the WSL user tools survive as the `./wsl` plugin-layer entry).
- ADR-0006 (ssh backend via route B) — superseded: no ssh backend; remote
  belongs to dsh-shell-remote (route C). ADR-0012 had left the ssh/remote
  worlds in place; this ADR removes them.
- ADR-0007/0008 remain VALID for the surviving entries, narrowed: the package
  is still single-package-multi-entry, but every entry is plugin-layer
  (defineTool + own settings namespace); the executor-entry/`./host` notions
  are historical.

## Consequences

- The error surface that motivated this decision (executor registration /
  ctx.shell seam composition failures) is structurally gone: nothing in the
  package touches the shell seam anymore.
- The `bash`/`pwsh` one-shot tool faces are the platform's own (tool-bash /
  tool-pwsh rows, upstream behavior including the #63 pwsh fallback).
- Test lanes shrink accordingly: the e2e executor checklist (T5) and the
  executor/registry/backend suites are deleted; machine lane = terminal +
  ssh-pty live. The pre-existing `wsl-backend` live failure (hardcoded `C:\`
  cwd assumption with the repo on `D:`) leaves with the suite.
- Dependencies shrink to cordis (peer) + schemastery (peer) + dsh-tools +
  @lydell/node-pty.

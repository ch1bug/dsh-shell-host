> Extracted from the README (issue #30, ADR-0007; default-off since #143). Back to the [README](../../README.md). 中文版：[wsl_zh.md](wsl_zh.md)。

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

As of #143 (human's 2026-10-19 ruling, revising #134's "deliberately not
mounted" call), `./wsl` **is bundle-mounted but dormant by default**: the bundle
patch carries the row with `disabled: true` — the row stays on the loader tree
(visible as a component in the plugin face; a disabled entry is not activated,
so nothing resolves its `inject` and the tools cost nothing until enabled), and
the `win_*` tools do NOT appear on an agent's tool face until you turn it on.
Before #143 the bundle patch mounted five rows (`pty`, `ssh`, `terminal`,
`remote`, `remote-fs` — see *The bundle patch* above) and `./wsl` was not among
them at all; that absence is what this change replaces (single source of truth —
the old "exported but deliberately NOT bundle-mounted" claim is gone).

The tools exist for an agent hosted **inside WSL** reaching the Windows side;
with DSH running natively on Windows the semantics mostly do not hold (path
normalization is redundant, and `win_run`'s temp `.bat`/`.ps1` staging under
`C:\Windows\Temp` has no point) — that is why the row ships disabled rather
than absent, and why you opt in per profile.

To enable it, override the row in your own profile patch —
`$DSH_HOME/profiles/<name>/cordis.patch.yml` — then restart the profile (the
host composes the tree once at startup; see
[`docs/agents/profile-install.md`](../../docs/agents/profile-install.md)):

```yaml
- id: wsl
  disabled: false
```

(the override targets the already-mounted row by its `id`; the source repo's old
plugin name `dsh-wsl-bridge` no longer resolves post-absorption). After the
restart the seven `win_*` tools register on the tool face of agents in that
profile. Plugin-LAYER entry (ADR-0007 "Entry form differences"): built on
`defineTool` + `ctx.tools`, registers model tools — never an execution backend.

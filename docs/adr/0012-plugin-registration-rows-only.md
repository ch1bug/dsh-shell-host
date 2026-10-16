# ADR-0012: Plugin-registration rows only — every upstream-row takeover path is dropped

- Status: Accepted
- Date: 2026-10-16
- Deciders: human ("完全摒弃改上游路径,只保留独立注册插件的路径", 2026-10-16; scope
  confirmed Q1–Q6 all-recommended in the grill session)
- Context: ADR-0002 (permission-presets fork, superseded), ADR-0011 (pwsh tool
  fork, superseded), GLOSSARY D8 (host-level replacement) and its
  terminal-controller addendum; `cordis.patch.yml`

## Decision

This bundle mounts ONLY through its own loader row ids. Every patch row that
took over or reconfigured an upstream row is removed, together with the source
that existed solely to back it:

- `permission` row (same-id takeover of upstream permission-presets) — the
  `dsh-shell-host/permission-presets` fork entry (`src/permission-presets.ts`)
  and its tests are deleted. Upstream `@deepseek-ai/dsh-permission-presets`
  composes again; its behavior (including the confining-executor posture and
  the #63 pwsh-fallback surface it implies) is upstream's again.
- `tool-pwsh` row (same-id takeover of the platform `dsh-tool-pwsh` row) — the
  `dsh-shell-host/pwsh` fork entry (`src/pwsh.ts`) and its tests are deleted.
  The platform pwsh tool's bare-`pwsh` lookup and its silent bash fallback
  (#63) return; this bundle deliberately stops papering over them.
- `terminal-controller` row (config override of the upstream
  api-terminal-controller row) — removed. Sidebar terminal discovery returns
  to upstream defaults, including the bare `bash` candidate (the WSL stub on
  stock Windows PATHs).

What remained in `cordis.patch.yml` were own-id insert rows only: `shell-host`
(the executor, default disabled), `pty`, `terminal`; the backends pwsh
descriptor (`src/backends.ts`) was the executor dimension and was untouched.
[2026-10-16, ADR-0013: the executor world — including the `shell-host` row and
`src/backends.ts` — has since left the package; this patch surface is now
`pty` + `terminal` only. ADR-0013 is written on top of this ADR and refines
its "what remains" list.]

## Superseded scope

- ADR-0002 (host-only permission-presets fork) — superseded in full.
- ADR-0011 (host-only pwsh tool fork) — superseded in full.
- GLOSSARY D8's patch-side corollaries: the `terminal-controller` coverage
  bullet and the "same-id takeover" mounting shape. D8's executor-replacement
  core (the `shell-host` row, the client settings card, the ctx.shell seam
  semantics) is NOT superseded — the executor row is an own-id plugin row.

## Consequences

- Behavior regressions accepted (human, 2026-10-16): upstream permission
  surfaces, the pwsh tool's bash fallback when PS7 is absent, and stock
  sidebar-terminal discovery (bare `bash` → WSL stub) all return.
- `zod@4.4.3` pinning and the `dsh-settings` built-declarations type-import
  exception (ADR-0002 implementation facts) lose their in-repo consumer; the
  npm dependency channel itself (GLOSSARY 依赖策略) stays — it was a build
  decision independent of any fork.
- The decorator-lowering guard (`tests/built-artifact.spec.ts`) now points at
  the executor artifact (`lib/index.js`); the tsdown/vitest decorator
  pre-transforms stay (the executor uses decorators too).
- Any future need to fix upstream behavior goes through an upstream PR or a
  NEW own-id row/entry, never a same-id takeover.

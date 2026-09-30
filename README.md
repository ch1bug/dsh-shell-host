# dsh-bash-msys

DSH bundle: **the MSYS2 platform layer for Windows** — a host-plane replacement
of the built-in platform shell executors, with a Plugins-page settings card.

Positioning: MSYS2 is an ENVIRONMENT independent of any one shell — install
root (`msysRoot`), subsystem (`MSYSTEM`), PATH surface, pacman/cygpath tooling
are first-class; bash is just the environment's configurable shell binary.
The executor inside is a fork/generalization of `@deepseek-ai/dsh-bash-local`
(0.2.0-rc.2) with an **identical external interface** — same `bash` tool
schema, jobs, spill files, exit markers, and configForms namespace shape — so
every preset's tooling works over it unchanged.

## What the bundle does (host replacement)

`cordis.patch.yml` operates on the HOST plane (applies to every preset):

1. Disables the base bundle's platform executors on Windows: `pwsh-sandbox`
   (yields the platform-shell role) and `bash-sandbox` (re-stated; its win32
   `bash -c` would hit the `C:\Windows\System32\bash.exe` WSL stub anyway).
2. Inserts this package's executor as `ctx.shell` (row id `bash-msys`,
   backend `msys2`, subsystem `UCRT64`). Every preset's `tool-bash` resolves
   the host seam — Matt 工作流, shipped presets, anything bash-dialect.
3. Overrides `terminal-controller` (the right-sidebar USER terminal): MSYS2
   bash `--login -i` becomes the default shell with a visible name, and the
   bare `bash` candidate is pruned (host PATH has no MSYS2, so it can only
   resolve to the WSL stub). Install-probed: no MSYS2 → upstream discovery
   stands.

All rows carry win32 guards; on POSIX the bundle is dormant.

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
`/plugins/dsh-bash-msys/client.js`): a Plugins-page card (order 11, after the
stock Shell card) bound to the `bash-msys` configForms namespace — backend,
subsystem, install root, bash path, plus the command budgets. Values write
through the settings user-section and re-apply to new commands without a
reload (all config fields are volatile). The bundle's `lib/client.js` is a
closure-factory artifact over the platform module table (requires only
`@deepseek-ai/dsh-client-ui-primitives` and `react/jsx-runtime`).

## Provenance (fork baseline, T1)

- Forked from `@deepseek-ai/dsh-bash-local` **0.2.0-rc.2** (© DeepSeek AI,
  MIT; see `LICENSE`). Source: upstream monorepo tag `dsh-v0.2.0-rc.2`,
  commit `639ed01539` (`packages/shell/bash-local`). Between 0.1.7-rc.2 and
  0.2.0-rc.2 this package's src/tests are byte-identical (only the version
  field moved); baseline = what the local desktop (0.2.0-rc.2) runs.
- **Functional deviations: none.** `src/index.ts` is upstream verbatim.
  Ported-test deviations (mechanical only, both documented here):
  - `tests/executor.spec.ts` imports `LocalBashExecutor` from `../src/index.ts`
    instead of the upstream package name (the package here is `dsh-bash-msys`).
  - `tests/settings.spec.ts` imports `live-config.ts` from `./helpers/` —
    the helper is ported verbatim from upstream
    `packages/settings/settings/tests/live-config.ts`.
- Dependencies: `@deepseek-ai/*` packages are **never fetched from npm**.
  Typecheck/build/tests resolve them against the local upstream monorepo
  checkout (`../deepseek-harness`, pinned to tag `dsh-v0.2.0-rc.2`):
  `tsc` via the inherited `tsconfig.base.json` paths map, vitest via
  explicit source aliases, `tsc -b`-built declarations for the declaration
  emit, and pnpm `link:` overrides so the installer never touches the
  registry for the scope. Tooling (typescript/vitest/tsdown) comes from npm.

Status: v0.1.0 — host-plane replacement + settings page landed
(typecheck both facades, vitest 36 passed, win32 live E2E green).
See `CONTEXT.md` and GitHub Issues for the plan.

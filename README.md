# dsh-bash-msys

DSH bundle: native MSYS2 (UCRT64) bash for the DSH shell seam.

Fork/generalization of `@deepseek-ai/dsh-bash-local`: makes the bash binary
explicitly configurable (defaulting to the MSYS2 bash at a configurable root)
and injects the MSYS2 environment (MSYSTEM=UCRT64, CHERE_INVOKING, PATH) for
one-shot calls, so the model's `bash` tool and the session terminal both run a
real MSYS2 environment on Windows — pacman, cygpath, `/c/` paths, the full
`/usr/bin` toolchain.

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
- Test lanes mirror upstream's own `vitest.config.ts` policy: on win32 the
  bash-local suites are excluded ("a real POSIX shell is unavailable on
  Windows"). A one-off win32 probe of the full ported suite (against the
  WSL bash on PATH) passed 23/36; every failure was POSIX-environmental
  (POSIX cwd literals, signal semantics through the WSL bridge), matching
  upstream's exclusion rationale one-for-one. T2's descriptor layer
  revisits this.
- Dependencies: `@deepseek-ai/*` packages are **never fetched from npm**.
  Typecheck/build/tests resolve them against the local upstream monorepo
  checkout (`../deepseek-harness`, pinned to tag `dsh-v0.2.0-rc.2`):
  `tsc` via the inherited `tsconfig.base.json` paths map, vitest via
  explicit source aliases, `tsc -b`-built declarations for the declaration
  emit, and pnpm `link:` overrides so the installer never touches the
  registry for the scope. Tooling (typescript/vitest/tsdown) comes from npm.

Status: T1 fork baseline landed (build + typecheck + win32-lane tests green). See `CONTEXT.md` and GitHub Issues for the plan.

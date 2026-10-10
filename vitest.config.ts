import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from './vitest.shared.ts'

// Since issue #23 no source aliases: every @deepseek-ai/* import resolves to
// the npm-published BUILT package through node_modules (the same closure the
// typecheck facade uses).

// Mirrors upstream vitest.config.ts `windowsUnsupportedPackages` policy for
// this package: on win32 the ported bash-local suites stay excluded ("a real
// POSIX shell is unavailable on Windows" — upstream's own words). T2's
// descriptor layer reopens the lane for what a Windows shell CAN serve: the
// msys2 backend suite runs through the explicit-config public boundary
// (ADR-0001 Consequences), so the executor's msys2 behavior is regression-
// guarded on Windows; the ported POSIX suites stay excluded until a later
// ticket serves them a POSIX lane.

// #34 (extended by #32): the suites whose live cases spawn real wsl.exe (5–8s per case,
// VM/process-start bound) run as their own project with file parallelism
// OFF, and `pnpm test` schedules the unit project FIRST and the machine
// project SECOND (sequential `&&` invocations, so the lanes can never
// interleave in a shared worker pool). Under full-suite concurrency the
// concurrent WSL spawns jittered past their timeouts with a different
// failing set each run (pre-existing on bare HEAD); serializing the
// machine lane restores the signal without weakening any assertion or
// skipping coverage — on a WSL-less host the same suites still run their
// injected/loud-failure cases here and keep their skipIf guards.
// #44: the unit lane collects by POSITION CONVENTION — any tests/**/*.spec.ts
// is collected with zero config (a new spec can no longer be silently missed
// by a stale allowlist). The only exclusions are EXPLICIT, each with a stated
// reason. `machineLane` below stays an explicit list on purpose: it selects
// the suites that run SERIALLY (fileParallelism off, live WSL spawns), so
// membership there is a deliberate per-suite choice, not collection gating.
const machineLane = ['tests/wsl-backend.spec.ts', 'tests/registry.spec.ts', 'tests/wsl-plugin-live.spec.ts', 'tests/ssh-pty-live.spec.ts', 'tests/terminal-machine.spec.ts', 'tests/pwsh-tool-machine.spec.ts']
// Explicit exclusion outlet: a spec listed here is exempt from the unit lane,
// each with its reason. machineLane files are excluded because the serial
// machine project owns them; _e2e-smoke is excluded because the EXPLICIT e2e
// lane (vitest.e2e.config.ts, `pnpm test:e2e`) owns it. Add an entry ONLY to
// exempt a spec from the unit lane entirely — every other tests/**/*.spec.ts
// is collected by position, with zero config.
const unitLaneExclusions = [
  ...machineLane,
  'tests/_e2e-smoke.spec.ts',
  // executor.spec.ts exercises POSIX signal semantics (TERM-trap → SIGKILL
  // escalation). Win32-conditional, mirroring the upstream
  // windowsUnsupportedPackages policy family ("a real POSIX shell is
  // unavailable on Windows"): POSIX hosts keep collecting it.
  ...(process.platform === 'win32' ? ['tests/executor.spec.ts'] : []),
]
const specInclude = ['tests/**/*.spec.ts', ...unitLaneExclusions.map((f) => `!${f}`)]

const shared = {
  environment: 'node',
  passWithNoTests: true,
} as const

// Every lane that loads decorator suites carries the same pre-transform.
const lanePlugins = [standardDecoratorPlugin()]

export default defineConfig({
  // Top-level plugins do NOT inherit into test.projects entries — each lane
  // carries the shared standard-decorator pre-transform itself.
  test: {
    projects: [
      {
        plugins: lanePlugins,
        test: { ...shared, name: 'unit', include: specInclude },
      },
      {
        plugins: lanePlugins,
        test: {
          ...shared,
          name: 'machine',
          include: machineLane,
          fileParallelism: false,
        },
      },
    ],
  },
})


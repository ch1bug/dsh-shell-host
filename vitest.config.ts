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
const machineLane = ['tests/wsl-backend.spec.ts', 'tests/registry.spec.ts', 'tests/wsl-plugin-live.spec.ts']
const specInclude = process.platform === 'win32'
  ? ['tests/descriptor.spec.ts', 'tests/detect.spec.ts', 'tests/permission-presets.spec.ts', 'tests/pty-session.spec.ts', 'tests/built-artifact.spec.ts', 'tests/wsl-bridge.spec.ts', 'tests/ssh-backend.spec.ts', 'tests/remote-descriptor.spec.ts', 'tests/remote-executor.spec.ts', 'tests/remote-types.spec.ts', 'tests/remote-conformance.spec.ts', 'tests/wsl-plugin.spec.ts', 'tests/subprocess-context-pin.spec.ts']
  : ['tests/**/*.spec.ts']

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
        test: { ...shared, name: 'unit', include: [...specInclude, ...machineLane.map((f) => `!${f}`)] },
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

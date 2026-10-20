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
// OFF, and `node --run test` schedules the unit project FIRST and the machine
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
// e2e-tool-call-machine boots REAL `dsh web` instances (host + mock provider),
// so it belongs to the serial lane as well: it must never share a worker pool
// with the unit suites, and it skips loudly when its trees are absent.
// e2e-tarball-machine (#89) runs the same chain from an `npm pack` artifact and
// carries that same cost, so it is in the serial lane for the same reason.
// pty-signal-machine (#119) opens a REAL ConPTY session and kills it through
// pty_signal, so it spawns/tears down real processes: serial, like its peers.
// pty-shell-machine (#149) opens real msys2/git-bash sessions (a declared
// `shellCommand`), measures output bytes, and switches interpreters inside one
// session: real processes with wall-clock cost, so it is serial too.
// pty-oneshot-machine (#146) must observe a REAL ConPTY exit event (one-shot
// exit code) and a REAL CreateProcess failure (the readable diagnostic) — a
// fake spawner cannot produce either, so the suite is serial like its peers.
const machineLane = [
  'tests/ssh-pty-live.spec.ts',
  'tests/terminal-machine.spec.ts',
  'tests/pty-signal-machine.spec.ts',
  'tests/pty-shell-machine.spec.ts',
  'tests/pty-oneshot-machine.spec.ts',
  'tests/e2e-tool-call-machine.spec.ts',
  'tests/e2e-real-llm-machine.spec.ts',
  'tests/e2e-tarball-machine.spec.ts',
]
// #123: the WRITER lane. `tests/clean-lib.spec.ts` really runs `node --run build`
// twice, and each build first DELETES lib/'s three entry directories plus the
// top-level chunks before tsc/tsdown rebuilds them. So that spec is a WRITER of
// `lib/`, while `tests/verify-pack.spec.ts` (copies lib/ into a fixture repo) and
// `tests/built-artifact.spec.ts` (imports lib/pty/index.js) are READERS of the
// same tree. Sharing one worker pool made the readers observe a half-rebuilt
// tree — the intermittent red this ticket is about (measured: 1 red in 5
// single-lane repeats, both failures inside verify-pack.spec.ts, reporting
// exactly the three entry directories missing while the old prelude gate
// reported nothing missing — i.e. a check-then-use race, not a "wait for the
// window to close" one).
// Two defences, each covering half: THIS lane split keeps the internal writer
// out of the readers' pool; `tests/helpers/lib-snapshot.ts` freezes lib/ so an
// EXTERNAL build (someone running `node --run test:release` by hand) cannot
// race the readers either.
const writersLane = ['tests/clean-lib.spec.ts']
// Explicit exclusion outlet: a spec listed here is exempt from the unit lane,
// each with its reason. machineLane files are excluded because the serial
// machine project owns them; writersLane files because the serial writer
// project owns them (see above). Add an entry ONLY to
// exempt a spec from the unit lane entirely — every other tests/**/*.spec.ts
// is collected by position, with zero config.
const unitLaneExclusions = [...machineLane, ...writersLane]
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
      {
        // #123: serial by construction. `clean-lib.spec.ts` writes `lib/` (real
        // `node --run build` ×2); running it alone — and AFTER the readers'
        // lane, see `scripts/verify-all.mjs` LANES — is what removes the
        // writer/reader race for the in-repo case. `fileParallelism: false`
        // additionally keeps its two build-running cases from overlapping each
        // other (both touch `lib/`).
        plugins: lanePlugins,
        test: {
          ...shared,
          name: 'writers',
          include: writersLane,
          fileParallelism: false,
        },
      },
    ],
  },
})


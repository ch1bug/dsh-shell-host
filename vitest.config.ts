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
// pty-deadline-machine (#162) needs a REAL ConPTY tree teardown racing a REAL
// shell's last execution window (the output-leak repro): serial like its peers.
// e2e-pty-loop-machine (#148) drives pty_list / pty_signal through a REAL
// instance's tool loop over a REAL long-lived PTY process: the same
// boot-a-real-instance cost as its e2e peers, so it is serial too.
// #182：成员为何被隔离出争用——vitest 4.1.12 的调度器（dist 的 groupSpecs/executeTests）
// 把 fileParallelism:false（⇒ maxWorkers 1）project 的文件收进**排序末尾的 sequential 组**：
// 它只在所有并发池组全部 settle 之后起跑，组内文件一次一个。因此进本清单在**两种调用形态**
// 下都把该档移出并发 worker 池：逐车道 `&&` 链（scripts/verify-all.mjs）与单次调用全量
// （scripts/msys-lane.sh，即 pre-push 车道）。sequential 组**内部**顺序 = 排序器
// （groupOrder 优先，其后按 project 名），而 'machine' < 'writers' —— 故本清单成员仍排在
// clean-lib 重建（#123 的写者/读者序）之前；该序靠的是 project **名字**字母序而非声明语义，
// 改名 project 时必须复查这一条。
const machineLane = [
  'tests/ssh-pty-live.spec.ts',
  'tests/terminal-machine.spec.ts',
  'tests/pty-signal-machine.spec.ts',
  'tests/pty-shell-machine.spec.ts',
  'tests/pty-oneshot-machine.spec.ts',
  'tests/pty-deadline-machine.spec.ts',
  // #137：真实 bash 执行 shipping 帧循环，不能由 fake-channel 代验。
  'tests/remote-frame-machine.spec.ts',
  'tests/remote-fs-machine.spec.ts',
  // #139：真实多请求原子写/分块上传，串行避免MSYS进程启动负载污染。
  'tests/remote-write-machine.spec.ts',
  // #141：真实 ssh 活体往返（DSH_SSH_LIVE_HOST 优先，否则 Docker sshd 挂具），
  // 真实网络 + 容器生命周期，墙钟成本高，串行同 ssh-pty-live。
  'tests/remote-roundtrip-live.spec.ts',
  'tests/e2e-tool-call-machine.spec.ts',
  'tests/e2e-real-llm-machine.spec.ts',
  'tests/e2e-tarball-machine.spec.ts',
  // #148：真实例 tool loop 真驱动 pty_list / pty_signal（dogfooding 证据）。
  'tests/e2e-pty-loop-machine.spec.ts',
  // #175：真实宿主 sandbox/mode 事件写路径（/permission 命令）→ projection 折叠
  // → resolve → assertSessionWritable 的同步约束，跨三条真实 prompt 驱动；多轮
  // 真实例 + 墙钟成本，串行同其 e2e 兄弟档。
  'tests/sandbox-mode-machine.spec.ts',
  // #182：verify-pack 每例真 spawn 子进程（import 零副作用由子进程实测、#118 守卫自检
  // 真 CLI 通路）且 cpSync 整棵 lib/ 做 fixture——CPU/磁盘负载重，在 unit 并发池里被
  // 拖过 60s 用例超时（#179 会话全量首跑 6 例假红，单跑 8s 全绿）；真 spawn 档串行同族。
  'tests/verify-pack.spec.ts',
  // #182：win32 用例经 PTY facade 真 spawn bash 组合 ssh 命令（detectPlainBash 门），
  // settle 时序对 CPU 争用敏感——并发池里进程提前退出报 REMOTE_SESSION_EXITED 假红
  // （#177 会话 pre-push 车道；副本单跑 17 例全绿）；真 CLI 档串行同族。
  'tests/remote-session-launch.spec.ts',
]
// #123: the WRITER lane. `tests/clean-lib.spec.ts` really runs `node --run build`
// twice, and each build first DELETES lib/'s four entry directories plus the
// top-level chunks before tsc/tsdown rebuilds them. So that spec is a WRITER of
// `lib/`, while `tests/built-artifact.spec.ts` (imports lib/pty/index.js) is a
// READER of the same tree in this pool; `tests/verify-pack.spec.ts` (copies lib/
// into a fixture repo) is the other reader — #182 moved it into the machine lane
// (serial) for its own contention reds, and it still runs before this writer
// (see the #182 scheduling note above the machineLane list). Sharing one worker
// pool made the readers observe a half-rebuilt
// tree — the intermittent red this ticket is about (measured: 1 red in 5
// single-lane repeats, both failures inside verify-pack.spec.ts, reporting
// exactly the entry directories missing while the old prelude gate
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


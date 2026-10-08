/**
 * Inlined shell-seam type vocabulary (issue #23, AC1). Field-identical forks
 * of the `@deepseek-ai/dsh-shell` types (which re-export the subprocess seam's
 * captured-output vocabulary) plus the sandbox-policy shapes the seam carries
 * through verbatim. This file is the decoupling boundary: the executor and the
 * router import these shapes locally, so the build never needs an upstream
 * source checkout. Drift policy: field names, order, and optionality mirror
 * upstream at the pinned tag (dsh-v0.2.0-rc.2; r1 anchor dsh-v0.2.1-alpha.1);
 * re-diff on every DSH bump — if the shapes changed upstream, this module must
 * republish (AC10's "if the shapes did not change, no republish").
 * @module dsh-shell-host/types
 */

// ── Subprocess seam vocabulary (inlined from @deepseek-ai/dsh-subprocess) ──

/** Namespace prefix reserved for DeepSeek Harness-managed child environment facts. */
export const DSH_ENV_PREFIX = 'DSH_' as const

/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
export type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`

/** Trusted DeepSeek Harness variables for one child-process execution. */
export type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>

/** One captured stream: the (possibly truncated) text plus recovery info. */
export interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}

/**
 * Bounded in-memory collection for one output stream, with an optional
 * full-stream spill file. Omitting `spill` keeps only the in-memory tail —
 * the diagnostic-tail shape; including it makes the complete stream
 * recoverable up to its cap (the bash tool shape).
 */
export interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
  }
}

/**
 * stdout/stderr disposition. `'pipe'` exposes the raw `Readable` for the
 * caller's protocol decoding; `'inherit'` passes the parent's descriptor
 * through; a {@link SubprocessCollect} object buffers boundedly with
 * offset-based reads.
 */
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect

/** Per-stream stdio dispositions, all explicit — the seam applies no defaults. */
export interface SubprocessStdio {
  stdin: 'ignore' | 'pipe' | { readonly data: string }
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
  /** Request a separate byte-mode duplex channel; omission creates none. */
  control?: 'pipe'
}

/** A fully-specified spawn request; every disposition, limit, and directory is explicit. */
export interface SubprocessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /** Per-stream stdio dispositions. */
  stdio: SubprocessStdio
  /**
   * Positive finite grace period in milliseconds, no greater than
   * `MAX_TIMER_DELAY_MS`, available to the provider's termination procedure
   * and used for draining still-open collected pipes after the process exits.
   */
  graceMs: number
  /** Abort signal — starts the terminate escalation on the managed range when it fires. */
  signal?: AbortSignal | undefined
  /** Explicit environment entries merged onto the implementation's scrubbed parent base. */
  env?: NodeJS.ProcessEnv | undefined
}

/** Exit facts of one closed process — Node's `close`-event vocabulary. */
export interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
}

/** One incremental offset read over a collected output stream. */
export interface SubprocessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}

/** Cursor-free incremental access to one collected output stream. */
export interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`.
   * @param fromByte - whole-stream offset to resume from (0 for the first read).
   */
  readFrom(fromByte: number): SubprocessOutputRead
}

/** Offset-based readers for the streams spawned in collect mode. */
export interface SubprocessCollectedOutputs {
  /** Present iff stdout is a {@link SubprocessCollect}. */
  readonly stdout?: SubprocessOutputReader
  /** Present iff stderr is a {@link SubprocessCollect}. */
  readonly stderr?: SubprocessOutputReader
}

/** A live subprocess and its provider-managed process range. */
export interface SubprocessHandle {
  readonly stdin: import('node:stream').Writable | undefined
  readonly stdout: import('node:stream').Readable | undefined
  readonly stderr: import('node:stream').Readable | undefined
  readonly control: import('node:stream').Duplex | undefined
  /** Offset-based readers for collect-mode streams (also readable after exit). */
  readonly collected: SubprocessCollectedOutputs
  /** Resolves with spawned-command exit facts; rejects for spawn or provider failures. */
  readonly done: Promise<SubprocessOutcome>
  /** Begin the provider's termination procedure on the managed range. Idempotent. */
  terminate(): void
  /** Wait until the managed range is empty. */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

// ── Sandbox vocabulary (inlined from @deepseek-ai/dsh-sandbox) ──

/** File-effect confinement modes (verbatim upstream union). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Opaque identity of the calling session. NOT inlined: the upstream type is
 * symbol-branded (`@deepseek-ai/dsh-brand`), which a local declaration cannot
 * reproduce, so the type imports from the npm `dsh-session` package (a regular
 * dependency since #23 — the permission-presets fork already carries it). A
 * nominal drift here is caught by the typecheck, not silently coerced.
 */
export type SessionId = import('@deepseek-ai/dsh-session').SessionId

/** Fully resolved per-call sandbox policy carried through the shell seam. */
export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
  /** Opaque identity of the calling session; absent for agentless calls. */
  sessionId?: SessionId
}

/** Enforcement completeness for a host (`partial` = an active backend declined part of the surface). */
export type SandboxEnforcement = 'full' | 'partial'

// ── Shell seam vocabulary (inlined from @deepseek-ai/dsh-shell) ──

/**
 * Non-consuming offset readers over a background process's captured streams,
 * for observers independent of the consuming {@link ShellProcess.readOutput}
 * cursor.
 */
export interface ShellObservedStreams {
  /** Offset reader over captured stdout. */
  stdout: SubprocessOutputReader
  /** Offset reader over captured stderr (the spawn-failure note after a rejected spawn). */
  stderr: SubprocessOutputReader
}

/** Sandbox facts for one run, present iff a sandboxing executor handled it. */
export interface ShellSandboxInfo {
  /** The mode the command actually ran under. */
  mode: SandboxMode
  /** Whether the sandbox denied a file operation. */
  denied: boolean
  /** How completely the selected runner enforced the requested mode. */
  enforcement?: SandboxEnforcement
  /** Whether the sandbox runner failed before the command could run. */
  runnerFailed?: boolean
}

/** What the executor does when the deadline expires: `kill` (default) or `none`. */
export type ShellExpiryPolicy = 'kill' | 'none'

/** A caller's execution REQUEST: `workdir`/`timeoutMs` optional, filled by the executor's resolve. */
export interface ShellExecRequest {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
  /** Deadline policy at `timeoutMs` expiry (default `'kill'`). */
  onExpiry?: ShellExpiryPolicy | undefined
  /** Foreground stdout capture budget in bytes; absent uses the executor's default cap. */
  stdoutMaxBytes?: number | undefined
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /** Bytes to write to the command's stdin, then close it; absent leaves stdin empty. */
  stdin?: string | undefined
  /** Ordinary environment entries for the command, merged after the credential scrub. */
  env?: Record<string, string> | undefined
  /** Harness-owned `DSH_*` variables for this execution; merges last (innermost win). */
  dshEnv?: DshEnvironment | undefined
  /** Fully resolved per-call sandbox policy; sandboxing executors default it. */
  sandboxPolicy?: SandboxExecutionPolicy | undefined
}

/** A resolved execution spec: resolve() fills and caps the required fields. */
export interface ShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /** Deadline policy at `timeoutMs` expiry. */
  onExpiry: ShellExpiryPolicy
  /** Resolved stdout capture budget, applied to every execution's stdout. */
  stdoutMaxBytes: number
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /** Bytes to write to stdin before closing it; absent means no stdin. */
  stdin?: string | undefined
  /** Ordinary environment entries carried through from the request. */
  env?: Record<string, string> | undefined
  /** Managed `DSH_*` snapshot; merges after {@link env}. */
  dshEnv?: DshEnvironment | undefined
  /** Resolved sandbox policy; ignored by executors that do not confine. */
  sandboxPolicy: SandboxExecutionPolicy | undefined
}

/** The outcome of a foreground run, including timeout during preparation. */
export interface ShellRunResult {
  /** Exit code; null when preparation expired or the process died from a signal. */
  exitCode: number | null
  /** Terminating signal, or null when none was reported. */
  signal: NodeJS.Signals | null
  /** True when the executor's own timeout was the FIRST cause (mutually exclusive with aborted). */
  timedOut: boolean
  /** True when the caller's AbortSignal was the FIRST cause (and not the executor's timeout). */
  aborted: boolean
  /** The effective timeout applied to this run (after defaulting/capping). */
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  /** Sandbox execution facts, absent for an unsandboxed executor. */
  sandbox?: ShellSandboxInfo
}

/** Lifecycle of a background process. */
export type ShellProcessStatus = 'running' | 'completed' | 'killed'

/** One incremental {@link ShellProcess.readOutput} read. */
export interface ShellProcessRead {
  /** Output produced since the previous read (stderr in a marked section). */
  delta: string
  /** True when truncation dropped unread bytes the delta cannot include. */
  lossy: boolean
  /** Full stdout spill file, when stdout truncation occurred and a safe path is available. */
  stdoutSpillPath?: string
  /** Full stderr spill file, when stderr truncation occurred and a safe path is available. */
  stderrSpillPath?: string
}

/** A background process handle; the only access path to a running command. */
export interface ShellProcess {
  /** Process lifecycle state (settled exactly once). */
  status: ShellProcessStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /** Resolves when the underlying process settles (never rejects). */
  readonly done: Promise<void>
  /** Sandbox facts, stamped once a confined process settles. */
  sandbox?: ShellSandboxInfo
  /** Read output produced since the previous read (consuming). */
  readOutput(): ShellProcessRead
  /** Non-consuming offset readers over the same captured streams. */
  observed: ShellObservedStreams
  /** Terminate the provider-managed range. Returns false when already finished; idempotent. */
  kill(): boolean
}

/** The one execution handle {@link ShellExecutor.execute} returns: the live process plus result(). */
export interface ShellExecution extends ShellProcess {
  /**
   * Foreground projection: settles when the process closes. Rejects only for
   * infrastructure failures; created on demand and memoized.
   */
  result(): Promise<ShellRunResult>
}

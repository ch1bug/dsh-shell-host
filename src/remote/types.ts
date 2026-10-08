/**
 * Type vocabulary of the `./remote` entry (absorbed from dsh-shell-remote,
 * issue #29 — ADR-0007 pure move, source anchored at dsh-v0.2.1-alpha.1-r1
 * per ADR-0005), forked field-by-field from
 * `@deepseek-ai/dsh-bash-local` (the dsh-shell seam types it re-exports).
 *
 * D8 contract (ADR-0004 decision 4): {@link ShellResult} stays field-identical
 * to the seam's `ShellRunResult`; all path semantics are REMOTE paths — the
 * caller passes remote-valid cwd/spill inputs, the executor never maps paths.
 * Host-dependent capabilities with no remote meaning (spill) loudly reject;
 * their request surface is reserved here at the type level (R1), implemented
 * in R2.
 * @module dsh-shell-host/remote/types
 */

/**
 * One captured output stream, forked field-identical from the seam's
 * `CollectedOutput` (`@deepseek-ai/dsh-subprocess`). The remote executor never
 * produces a local {@link spillPath}: spill is a host-plane capability with no
 * remote meaning — any spill request loudly rejects (R2), so this field stays
 * absent for remote results while the shape remains field-identical (D8).
 */
export interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. Never populated by the remote executor: spill loudly rejects (host capability, no remote meaning). */
  spillPath?: string
}

/**
 * The result of one settled one-shot remote command, forked field-identical
 * from the seam's `ShellRunResult` (D8, ADR-0004 decision 4). Field names,
 * order, and optionality match `@deepseek-ai/dsh-bash-local` exactly; the
 * contract conformance test (R2) enforces the field-by-field diff.
 */
export interface ShellResult {
  /** Exit code; null when preparation expired or the process died from a signal. */
  exitCode: number | null
  /** Terminating signal, or null when none was reported, including preparation expiry. */
  signal: NodeJS.Signals | null
  /** True when the executor's own timeout was the FIRST cause to cut the command short. Mutually exclusive with {@link aborted}: one fused deadline drives both the timeout and the caller's cancellation, so a timeout and an abort racing before process close report the single first-abort cause, not both. */
  timedOut: boolean
  /** True when the caller's `AbortSignal` was the FIRST cause to kill the command (and it was not the executor's own timeout). Mutually exclusive with {@link timedOut} — the first-cause classification. */
  aborted: boolean
  /** The effective timeout applied to this run (after defaulting/capping). */
  timeoutMs: number
  /** Collected stdout (remote bytes, UTF-8 decoded). */
  stdout: CollectedOutput
  /** Collected stderr (remote bytes, UTF-8 decoded; ssh transport notes ride here). */
  stderr: CollectedOutput
  /** Sandbox execution facts, absent for an unsandboxed executor. The remote executor never confines, so this stays absent while the field remains for shape identity (D8). DELIBERATE D8 DEVIATION: typed `never` instead of the seam's `ShellSandboxInfo` — the repo stands alone (no dsh-sandbox dependency in R1) and remote sandbox facts cannot exist; the R2 conformance test locks this field as reserved-never-populated. */
  sandbox?: never
}

/**
 * A caller's one-shot execution request. `workdir` is a REMOTE path passed
 * through verbatim — the executor never maps it (no `/mnt/c` counterpart to
 * map to; ADR-0004 decision 4). No `sandboxPolicy` field: remote execution is
 * never confined, and the field-identical mandate (D8) covers ShellResult,
 * not the request surface.
 */
export interface ShellExecRequest {
  /** The command string, run remotely as `bash -c <command>`. */
  command: string
  /** REMOTE working directory for the command; required explicitly (no host-side cwd default — the local process cwd has no remote meaning). */
  workdir: string
  /** Foreground timeout in milliseconds. */
  timeoutMs: number
  /** Caller cancellation; aborting kills the remote command via the ssh transport's own teardown. */
  signal?: AbortSignal
  /** Per-stream in-memory output cap in bytes. No spill option: overflow truncates (tail retained) — spill loudly rejects (host capability, D8). */
  stdoutMaxBytes?: number
}

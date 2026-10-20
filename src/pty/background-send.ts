/**
 * Background sends (#120): the `run_in_background` path shared by `pty_send`
 * and `ssh_send`, wired to the HOST's background-job stack.
 *
 * The two host packages are a PAIR (measured against `0.2.1-rc.2`):
 * `@deepseek-ai/dsh-jobs` is the abstract registry seam only — its `start`
 * refuses work while no attached controller serves the owner's session, and
 * `@deepseek-ai/dsh-tool-jobs` is that controller (`ctx.jobs.attachController`)
 * plus the `job_output` / `job_list` / `job_kill` tools and the completion
 * delivery. Declaring the first without the second is a path that can only
 * fail loudly, which is why the missing-service error names BOTH packages.
 *
 * The job spec mirrors the official `terminal_send` field for field (kind,
 * label, toolCall, owner, outputLimitBytes, one pull source, run): this is
 * WIRING into an existing host capability, not a second job framework. The
 * FOREGROUND path never enters this module — it keeps the core's settle
 * semantics byte for byte.
 *
 * @module dsh-shell-host/pty/background-send
 */

import type { JobId, JobOutputSource, JobSpec, JobToolCall } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SendResult } from './session-core.ts'

// This package's own namespace entry in the host's merge-extensible kind map.
// The official `terminal_send` registers `pty-send` at exactly this seam; the
// merge is what makes `kind: 'pty-send'` assignable to JobKind at all.
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'pty-send': 'pty-send'
  }
}

/**
 * Cap for one complete model-facing job read, in UTF-8 bytes: the official
 * tool's `DEFAULT_MAX_RESULT_BYTES` (256 KiB). Deliberately a CONSTANT — the
 * byte-budget surface (`#121`, this batch's `#121`-adjacent ticket) is where a
 * configurable cap belongs; inventing a second config knob here would be
 * speculative generality.
 */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024

/**
 * The two loud failures of this path (AC4). Both state what has to change: a
 * silent downgrade to a foreground send would hand the model a settle block it
 * did not ask for, and would hide a broken host configuration.
 */
export const BACKGROUND_DISABLED_MESSAGE =
  'background sends are disabled by the ./pty entry configuration (enableRunInBackground: false)'

export const BACKGROUND_REQUIRES_JOBS_MESSAGE =
  'background sends require @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs'

/**
 * The registry slice this module consumes — the host's `ctx.jobs`
 * (`JobRegistry` in `@deepseek-ai/dsh-jobs`, narrowed to what a producer
 * needs). Duck-typed so the unit lane can stand in a registry that enforces
 * the same refusals without booting the host's implementation.
 */
export interface BackgroundJobRegistry {
  start(spec: JobSpec): JobId
}

/** One background send's inputs: the host service, the job record fields the
 * official tool carries, and the send to run. */
export interface BackgroundSendRequest {
  /** `ctx.get('jobs')`; `undefined` = the host mounted no job stack. */
  readonly jobs: BackgroundJobRegistry | undefined
  /** The owning agent's session id — the job contract's authorization fence. */
  readonly owner: SessionId
  /** Creating tool invocation, retained in the durable job records. */
  readonly toolCall?: JobToolCall
  /** One-line model-facing label (`<sessionId>: <text>`). */
  readonly label: string
  /** The foreground send, given the cancellation signal it must honour. */
  readonly send: (signal: AbortSignal) => Promise<SendResult>
}

/**
 * Start one background send: preflight the two loud failures, then hand the
 * host registry a job whose `run` performs the send on its OWN abort signal.
 * Returns the tool's background result face — `{ kind: 'background', jobId }` —
 * immediately; the job lives in the registry, where `job_output` reads it and
 * `job_kill` stops it.
 */
export function startBackgroundSend(request: BackgroundSendRequest): { kind: 'background'; jobId: JobId } {
  const { jobs } = request
  if (jobs === undefined) throw new Error(BACKGROUND_REQUIRES_JOBS_MESSAGE)

  /**
   * The send's terminal flag. A kill that lands mid-settle makes the send
   * itself RESOLVE (its abort signal cuts the settle short) rather than throw,
   * so the producer has to remember that a cancellation was asked for: the
   * registry's contract is to report which of the two ended the job.
   */
  let cancelled = false
  let controller: AbortController | undefined

  /**
   * The bytes this send produced so far. The core hands its delta over AT
   * SETTLE (never incrementally), while the registry pumps a pull source on its
   * own cadence — so this buffer is the meeting point.
   *
   * It is deliberately **non-consuming**: `read(fromByte)` re-serves the same
   * bytes for the same offset (`JobOutputSource.read`'s "without consuming it"),
   * a read at one past the end is an empty page, and `lossy` is always false
   * because nothing is ever dropped here — the registry's ring owns retention,
   * not this source.
   */
  let produced = Buffer.alloc(0)

  const source: JobOutputSource = {
    read: (fromByte) => {
      const from = Math.min(Math.max(fromByte, 0), produced.byteLength)
      if (from >= produced.byteLength) return { text: '', nextOffset: produced.byteLength, lossy: false }
      return {
        // A mid-blob offset (reachable only if the registry re-reads a page it
        // already took) re-serves the tail. UTF-8 decoding may replace a code
        // point split by that offset, which is why the resume point stays the
        // blob's END rather than `from + bytes(text)`: offsets only advance.
        text: produced.subarray(from).toString('utf8'),
        nextOffset: produced.byteLength,
        lossy: false,
      }
    },
  }

  const jobId = jobs.start({
    kind: 'pty-send',
    label: request.label,
    // Spread, not an explicit undefined: the spec's optional fields stay
    // ABSENT when there is nothing to say (the recorded job then carries no
    // tool call, exactly like an unowned/unattributed job).
    ...(request.toolCall === undefined ? {} : { toolCall: request.toolCall }),
    owner: request.owner,
    outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    output: [source],
    run: () => {
      controller = new AbortController()
      const settled = request.send(controller.signal)
      return {
        cancel: () => {
          cancelled = true
          controller?.abort()
        },
        done: settled.then(
          (result) => {
            // Fill BEFORE resolving, and note the ORDER this relies on: the
            // registry drains every pull source one last time AFTER `done`
            // resolves and then closes the ring ("a producer folds nothing into
            // its done" — JobSpec.run's contract). That ordering lives in
            // dsh-jobs-local, which this package does not mount, so it is
            // ASSUMED here and declared unverified in the ticket's landing doc.
            produced = Buffer.from(result.delta)
            return { status: cancelled ? ('killed' as const) : ('completed' as const), detail: sendDetail(result, cancelled) }
          },
          (error) => ({ status: 'failed' as const, detail: String(error) }),
        ),
      }
    },
  })

  return { kind: 'background', jobId }
}

/**
 * The terminal reason rendered under the job (`job_output`'s status line): how
 * many bytes this send handed the ring, and whether the write landed on a live
 * session. A kill keeps its own wording so `job_kill`'s effect is legible.
 */
function sendDetail(result: SendResult, cancelled: boolean): string {
  const bytes = Buffer.byteLength(result.delta)
  const session =
    result.status.kind === 'exited'
      ? `session exited (code ${result.status.exitCode ?? 'null'})`
      : 'session running'
  return cancelled ? `cancelled after ${bytes} bytes read` : `${bytes} bytes read; ${session}`
}
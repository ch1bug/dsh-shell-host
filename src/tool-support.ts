/**
 * Tool-face pieces SHARED by the `pty_*` and `ssh_*` families (#136).
 *
 * Before #136 the ssh family lived inside `./pty`, so these were private to
 * that module. Now that the families have separate entries (`./pty` =
 * session core, `./ssh` = the interactive ssh instance) they still speak the
 * SAME model-facing face: the `run_in_background` parameter and its render,
 * the call card, the owner requirement and the bridge into the host job stack.
 * One definition is the point — two copies would drift the moment one family
 * gains a row (#120 measured the cost of that drift once already).
 *
 * @module dsh-shell-host/tool-support
 */

import type { JobToolCall } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  BACKGROUND_DISABLED_MESSAGE,
  startBackgroundSend,
  type BackgroundJobRegistry,
} from './pty/background-send.ts'
import type { SendResult } from './pty/session-core.ts'

/** Owner (Agent) identity passed to every core call. */
export type Owner = unknown

/** The send-tool execution slice the background branch reads (#120): the
 * owning agent, its cancellation, and the two call ids the host's job record
 * carries. The ids are OPAQUE STRINGS at this boundary for the same reason
 * `Owner` is `unknown` — the seam is duck-typed (the unit harnesses pass plain
 * object literals), so the host's branded `ToolCallId` is asserted once, at the
 * job record, the only place that has to speak the host's type. `agent` is
 * optional because a harness may pass `{ agent }` alone. */
export type SendExec = { agent?: Owner; signal?: AbortSignal; callId?: string; rootCallId?: string }

/** Shared render for structured tool output: one JSON text block. */
export const jsonRender = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

// ---------------------------------------------------------------------------
// #120 — the model-facing faces of a background send
//
// ONE definition, shared by `pty_send` and `ssh_send`: the parameter, the
// description tail, the two extra result properties, the render and the call
// card. The executor is already a single branch (`background-send.ts`); copying
// these four would leave the drift surface wide open — the exact failure the
// one-facade split exists to prevent.
// ---------------------------------------------------------------------------

/** The `run_in_background` parameter, advertised only while the path is open
 * (official posture: a disabled deployment does not offer a parameter it will
 * refuse). */
export const RUN_IN_BACKGROUND_PARAM = {
  type: 'boolean',
  description: 'Return a job id immediately; collect with job_output or stop with job_kill.',
} as const

/** Description tail of both send tools while the background path is open. */
export const RUN_IN_BACKGROUND_SUFFIX =
  ' With run_in_background: true the call returns a job id immediately instead of awaiting the settle — ' +
  'collect it with job_output, stop it with job_kill (that path needs the host job stack mounted).'

/** The two result properties a BACKGROUND call adds. The foreground result
 * keeps its shape (`{ delta, status }`), so both stay absent there. */
export const BACKGROUND_RESULT_PROPERTIES = {
  kind: { type: 'string', description: 'Present exactly when the send ran in the background: "background".' },
  jobId: { type: 'string', description: 'Registry-issued job id (background calls only) — pass it to job_output / job_kill.' },
} as const

/** A background call renders ONLY its job id; every other outcome keeps the
 * structured JSON block. */
export const renderSend = (_args: unknown, value: { kind?: string; jobId?: string }) =>
  value.kind === 'background'
    ? [{ type: 'text' as const, text: `started background job ${value.jobId ?? '(unknown id)'}` }]
    : jsonRender(_args, value)

/** Call card: the background form swaps to the generic card and carries the
 * text as raw input (the official `terminal_send` posture); the foreground
 * keeps the terminal card. */
export const presentSendCall = (args: { id: string; data: string; run_in_background?: boolean }) =>
  args.run_in_background === true
    ? { card: 'generic' as const, title: `Send to session ${args.id} in background`, kind: 'execute' as const, rawInput: args.data }
    : { card: 'terminal' as const, title: args.data }

/** Local structural JsonValue: the upstream type lives in
 * `@deepseek-ai/dsh-util-values`, which is NOT a dependency of this package —
 * the projector only needs the structural contract (lossless JSON, no
 * undefined-valued members) that `defineTool`'s `presentationMeta` enforces. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * #121: presentationMeta projector of a send tool (the official `terminal_send`
 * posture — a foreground result projects the STRUCTURED read, a background one
 * projects nothing). Pure display metadata: it rides `tool/result.meta` only
 * (persisted, replay-preserved); the model-facing render and schema are
 * untouched. The built-in Web Client keeps rendering third-party tool names
 * with the generic card — the consumers of this field are the session event
 * stream / replay / PTC dispatch logs (see README 「展示元数据（#121）」).
 */
export const presentSendMeta = (_args: unknown, value: { kind?: string; delta?: string; status?: JsonValue }): JsonValue =>
  value.kind === 'background'
    ? null
    : {
        // Meta must be lossless JSON: members whose value is absent are
        // omitted, never `undefined`-valued keys.
        ...(value.delta === undefined ? {} : { delta: value.delta }),
        ...(value.status === undefined ? {} : { status: value.status }),
      }

/**
 * Every pty/ssh tool requires an owning agent session (owner-scoped core).
 * The prose is kept VERBATIM from the pre-#136 ssh family as well: this ticket
 * is a refactor, and the ssh tools have always answered with this line.
 *
 * #137: the family name is a PARAMETER now (see {@link requireAgentFor}) — the
 * `remote_*` tools answer with their own family name, and this alias keeps the
 * pty/ssh wording byte-for-byte what it was.
 */
export function requireAgent(exec: { agent?: Owner }): Owner {
  return requireAgentFor('pty', exec)
}

/** The same contract, naming the calling FAMILY: `<family>_* tools require an
 * owning agent session`, `code: NO_AGENT`. One implementation, so the code can
 * never drift while the prose stays family-correct. */
export function requireAgentFor(family: string, exec: { agent?: Owner }): Owner {
  const owner = exec?.agent
  if (owner === undefined) {
    throw Object.assign(new Error(`${family}_* tools require an owning agent session`), { code: 'NO_AGENT' })
  }
  return owner
}

/** How a send tool reaches the background path (#120): the gate, then the job
 * start. One function, so `pty_send` and `ssh_send` cannot drift apart. */
export type BackgroundStarter = (
  owner: Owner,
  exec: SendExec,
  label: string,
  send: (signal: AbortSignal) => Promise<SendResult>,
) => { kind: 'background'; jobId: string }

/**
 * Build the background-send starter over one entry's service lookup.
 *
 * `ctx.get('jobs')` is read PER CALL, never at apply time: a host that mounts
 * the job stack after this row still serves the tool, and a host without one
 * gets the loud two-package error on the first background request instead of a
 * tool that quietly never offers the path.
 */
export function createBackgroundStarter(
  ctx: { get: (name: string) => unknown },
  enabled: boolean,
): BackgroundStarter {
  return (owner, exec, label, send) => {
    if (!enabled) throw new Error(BACKGROUND_DISABLED_MESSAGE)
    const jobs = ctx.get('jobs') as BackgroundJobRegistry | undefined
    return startBackgroundSend({
      jobs,
      // The job contract fences access by the owning agent's SESSION id; this
      // package treats the Agent as an opaque owner, so the id is read here
      // and branded at the one boundary that has to name the host type.
      owner: (owner as { id: SessionId }).id,
      ...(exec.callId === undefined || exec.rootCallId === undefined
        ? {}
        : { toolCall: { callId: exec.callId as JobToolCall['callId'], rootCallId: exec.rootCallId as JobToolCall['rootCallId'] } }),
      label,
      send,
    })
  }
}

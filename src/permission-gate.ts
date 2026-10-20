/**
 * #102 — the host permission model for the tools-only execution surfaces.
 *
 * The `pty_*` / `shell_open` / `ssh_*` tools start PROCESSES and the `win_*`
 * tools run commands through the host shell seam. Before #102 the first three
 * neither resolved the host's `sandboxPolicy` nor went through
 * `ctx.approval`, so a `read-only` session (or `permission = ask`) could still
 * spawn arbitrary commands — an execution surface that bypassed the approval
 * UI. This module is the ONE home for the missing layer, shared by all three
 * entries:
 *
 *  1. **Per-execution resolve** (the documented contract: "Tool layers call
 *     resolve for each execution"): the standing policy is resolved on EVERY
 *     call from the calling agent's session — never cached at apply time.
 *  2. **The official escalation choreography**, taken from
 *     `@deepseek-ai/dsh-sandbox`'s `approveEscalation` + its vocabulary (not
 *     re-spelled here): `sandbox_permissions` + `justification` travel
 *     together, a strictly wider target asks the user through
 *     `ctx.approval.request`, and `'allowed-once'` is the only grant; every
 *     other outcome fails closed. The denial/hint markers are the same
 *     `[sandbox: …]` lines the upstream `bash` / `pwsh` / `fs` families emit,
 *     so the model reads a policy denial identically everywhere.
 *  3. **Missing services fail closed**: a deployment without
 *     `sandboxPolicy`/`approval` refuses to execute and names the missing
 *     service instead of silently running unconstrained. This is deliberate
 *     (issue #102 「影响面与迁移」): the tools become unusable without the
 *     permission model, which is the point.
 *
 * Honest boundary (ticket #102 「宿主侧契约」): `ctx.subprocess`'s spawn specs
 * carry no `sandboxPolicy` field, so a PTY spawn cannot be OS-confined here.
 * What this gate can promise is the POLICY DECISION (mode), the WORKSPACE
 * BOUNDARY (the start cwd under `workspace-write`) and the APPROVAL GATE —
 * never process isolation. The upstream tool families keep their own
 * enforcement dialect; this module never fakes one.
 *
 * @module dsh-shell-host/permission-gate
 */

import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
  type SandboxMode,
} from '@deepseek-ai/dsh-sandbox'
import { isAbsolute, relative as relativePath, resolve as resolvePath, sep } from 'node:path'

export type { SandboxMode }

// Re-exported so the three entries import the permission vocabulary from ONE
// module: the marker/hint lines the model reads stay the official ones.
export { escalationHintMarker, sandboxDenialMarker }

/** The three file-effect modes, weakest first (`sandboxPolicy.resolve` vocabulary).
 * This ONE literal is the ladder: `MODE_RANK` derives from it (the upstream
 * package exports `WIDER_MODES` + `ESCALATION_TARGETS` for the escalation
 * targets, but no rank, so the ordering home is here). */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Mode ranks: the only ordering used here (a downgrade is a rank decrease). */
const MODE_RANK: Record<SandboxMode, number> = Object.fromEntries(
  SANDBOX_MODES.map((mode, index) => [mode, index]),
) as Record<SandboxMode, number>

/**
 * The complete per-call policy the host service resolves (the slice this
 * module consumes; structurally the upstream `SandboxExecutionPolicy`).
 */
export interface SandboxExecutionPolicyLike {
  mode: SandboxMode
  workspaceRoot: string
  sessionId?: unknown
}

/** The `ctx.sandboxPolicy` slice (`SandboxPolicyService.resolve`). */
export interface SandboxPolicyServiceLike {
  resolve(request?: { session?: unknown; mode?: SandboxMode }): SandboxExecutionPolicyLike
}

/** The closed approval outcome vocabulary (`ApprovalOutcome`). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The `ctx.approval` slice. Structurally a SUPERSET of the upstream
 * `ApprovalService.request` (upstream requires `callId` and `reason`, both of
 * which the official `approveEscalation` passes); they are optional here only
 * because the duck-typed unit harnesses and an agent-less execution may carry
 * neither, and the upstream call shape stays assignable. */
export interface ApprovalServiceLike {
  request(request: {
    agent: unknown
    toolName: string
    callId?: string
    reason?: string
    displayReason?: { readonly en: string; readonly [locale: string]: string }
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/** The service lookup slice every consumer ctx exposes (duck-typed seam). */
export interface PermissionCtx {
  get: (name: string) => unknown
}

/** The calling agent is opaque at this boundary; the session is what policy resolution needs. */
export type Owner = unknown

/** The session a policy resolution is bound to (the agent's own session, when it has one). */
export function sessionOf(agent: Owner): unknown {
  return (agent as { session?: unknown } | null | undefined)?.session
}

/** A service the deployment failed to mount: loud, naming the exact id (§6 fail closed). */
const serviceMissing = (service: string, toolName: string) =>
  Object.assign(
    new Error(
      `${toolName} refused: this deployment has no \`${service}\` service, so execution cannot be authorized. ` +
        'Failing closed — mount the official permission model (the @deepseek-ai/dsh-sandbox-policy and ' +
        '@deepseek-ai/dsh-user-approval rows) instead of bypassing it.',
    ),
    { code: 'PERMISSION_SERVICE_MISSING', service },
  )

const requireService = <T>(ctx: PermissionCtx, name: string, toolName: string): T => {
  const service = ctx.get(name) as T | undefined
  if (service === undefined) throw serviceMissing(name, toolName)
  return service
}

/** The narrowest escalation target strictly wider than `mode` (undefined at the ceiling). */
export function narrowestWiderMode(mode: SandboxMode): SandboxMode | undefined {
  return ESCALATION_TARGETS.find((target) => MODE_RANK[target] > MODE_RANK[mode])
}

/**
 * A structured policy denial in the OFFICIAL vocabulary: the `[sandbox: …]`
 * marker (same line the upstream families emit), what was refused, the
 * same-turn escalation hint, and the narrowest wider mode that would suffice.
 * `code: 'SANDBOX_DENIED'` lets a consumer branch without matching prose.
 * `advice` is the family's own next step (the ticket's "命令白名单" second
 * question: the free-command-line spawn points at the narrower preset channel).
 */
function denial(toolName: string, subject: string, mode: SandboxMode, detail: string, advice?: string): Error {
  const narrowest = narrowestWiderMode(mode)
  const target = narrowest === undefined
    ? 'already the widest mode in this deployment'
    : `${narrowest} (escalation targets: ${ESCALATION_TARGETS.join(' / ')})`
  return Object.assign(
    new Error(
      [
        sandboxDenialMarker(mode),
        `${toolName} refused: ${detail}`,
        escalationHintMarker(subject),
        `Narrowest wider mode that suffices: ${target}.`,
        ...(advice === undefined ? [] : [advice]),
      ].join('\n'),
    ),
    { code: 'SANDBOX_DENIED', mode },
  )
}

/** The `shell_open` pointer that rides a FREE-COMMAND-LINE spawn denial (#102
 * 「命令白名单」§2): the narrower executable channel, stated honestly — it is
 * bound by the same policy, so it is a route to the RIGHT COMMAND, not to a
 * wider mode. Only pty_open's denial carries it (shell_open IS that channel). */
const PRESET_CHANNEL_ADVICE =
  'Narrower executable channel: shell_open runs a launcher preset (the executable comes from the preset table and its ' +
  'probe points — never a free command line). It is bound by this same policy: it cannot start a process under ' +
  'read-only either, and its preset cwd must still be inside the workspace under workspace-write.'

/** Is `candidate` inside `root`? `path.relative` is case-insensitive on win32 and
 * case-sensitive on POSIX — exactly the platform's own containment semantics. */
export function isInsideWorkspace(candidate: string, root: string): boolean {
  const rel = relativePath(root, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false // a different drive/root: not comparable
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * Resolve the policy for ONE execution, applying the official escalation
 * choreography when the caller asked to retry wider. Returns the standing
 * (pre-escalation) mode and the granted mode: the GRANTED one is what the
 * opening surfaces record as the session's write baseline (see
 * {@link PermissionGate.assertSessionWritable}).
 *
 * Validation order is upstream's (#102 AC: fail closed before anything runs):
 * services → argument pairing → policy resolve → mode-width pre-check check →
 * approval → caller rules.
 *
 * INTENTIONAL DIVERGENCE (documented in README 「文案来源」): the two argument
 * pre-checks below (repeat-mode, strictly-wider) duplicate what
 * `approveEscalation` does, on purpose — they separate a CALLER error (with
 * `INVALID_ARGS` and the allowed-target list) from a policy denial, so a
 * malformed retry never reaches the user as an approval prompt. The ask itself
 * is still the official `approveEscalation`, so its reason/displayReason texts
 * and `allowed-once` semantics cannot drift from upstream.
 */
export async function resolvePolicyWithEscalation(
  ctx: PermissionCtx,
  request: {
    toolName: string
    agent: Owner
    session?: unknown
    callId?: string
    signal?: AbortSignal
    sandboxPermissions?: string
    justification?: string
    /** The family's noun in user-facing texts (`command` for spawns, `operation` for the fs-ish family). */
    subject: string
  },
): Promise<{ policy: SandboxExecutionPolicyLike; standingMode: SandboxMode; grantedMode: SandboxMode }> {
  const policyService = requireService<SandboxPolicyServiceLike>(ctx, 'sandboxPolicy', request.toolName)
  const approvalService = requireService<ApprovalServiceLike>(ctx, 'approval', request.toolName)
  // The pairing rule is the official one (permissions ⇔ justification).
  validateEscalationArgs(request.sandboxPermissions, request.justification)
  const standing = policyService.resolve(request.session === undefined ? {} : { session: request.session })
  if (request.sandboxPermissions === undefined) {
    return { policy: standing, standingMode: standing.mode, grantedMode: standing.mode }
  }
  const requestedMode = request.sandboxPermissions as SandboxMode
  // Repeating the standing mode needs no approval (upstream's own rule). A
  // narrower/unknown target is a CALLER error, not a policy denial, so it fails
  // with its own code before the user is ever asked.
  if (requestedMode === standing.mode) {
    return { policy: standing, standingMode: standing.mode, grantedMode: standing.mode }
  }
  const wider = WIDER_MODES[standing.mode] ?? []
  if (!wider.includes(requestedMode)) {
    throw Object.assign(
      new Error(
        `sandbox escalation to "${requestedMode}" is not strictly wider than this call's current "${standing.mode}" mode` +
          (wider.length === 0 ? ' (this mode is already the ceiling)' : `; allowed targets: ${wider.join(' / ')}`),
      ),
      { code: 'INVALID_ARGS' },
    )
  }
  try {
    const grantedMode = await approveEscalation(
      {
        requestedMode,
        justification: request.justification ?? '',
        effectiveMode: standing.mode,
        subject: request.subject,
      },
      {
        approver: approvalService,
        agent: request.agent,
        callId: request.callId,
        toolName: request.toolName,
        signal: request.signal,
      },
    )
    return { policy: { ...standing, mode: grantedMode }, standingMode: standing.mode, grantedMode }
  } catch (error) {
    // A non-grant outcome (rejected / cancelled / unavailable) fails closed. It
    // is re-expressed in the STRUCTURED denial shape (#102 §4) so the model
    // sees the same `[sandbox: …]` marker + hint it gets from a policy refusal,
    // with the official outcome text preserved verbatim.
    throw denial(
      request.toolName,
      request.subject,
      standing.mode,
      `escalation to ${requestedMode} was not granted — ${error instanceof Error ? error.message : String(error)}. ` +
        'Nothing ran; a refused escalation is final for this call — do not retry it another way.',
    )
  }
}

/** One spawn authorization: what mode it runs under, the grant to record as the
 * session's write baseline, and the cwd the spawn must actually use. */
export interface SpawnAuthorization {
  /** The mode this spawn runs under (the policy mode, or the approved one-shot grant). */
  grantedMode: SandboxMode
  /** The standing policy mode BEFORE escalation — the deployment policy this
   * call resolved (kept for reporting; NOT the write baseline: a one-shot grant
   * must not outlive its call, so the session records `grantedMode`). */
  standingMode: SandboxMode
  /** The cwd the spawn must use: concrete under `workspace-write`, else the caller's value. */
  cwd?: string
}

/** The gate every tool surface drives (one instance per entry). */
export interface PermissionGate {
  /**
   * Authorize starting a PROCESS (pty_open / shell_open / ssh_start):
   * `read-only` refuses, `workspace-write` requires the start cwd inside the
   * session workspace, `danger-full-access` passes. An approved escalation
   * decides with the granted mode instead of the standing one.
   */
  authorizeSpawn(request: {
    toolName: string
    agent: Owner
    session?: unknown
    callId?: string
    signal?: AbortSignal
    cwd?: string
    sandboxPermissions?: string
    justification?: string
    subject: string
    /** True for a FREE-command-line spawn (pty_open): its denial carries the
     * `shell_open` preset-channel pointer (ticket 「命令白名单」§2). */
    presetChannel?: boolean
  }): Promise<SpawnAuthorization>
  /**
   * Re-resolve the policy for an EXISTING session write (#102 §5): the write is
   * refused when the freshly resolved mode is NARROWER than the mode the session
   * was authorized under. That covers both a later policy downgrade (e.g. to
   * `read-only`) and a session opened under a one-shot grant — an escalation
   * never becomes a standing write permission. Reads (`pty_tail`) and the close
   * paths are deliberately NOT gated — they do not widen anything.
   */
  assertSessionWritable(request: {
    toolName: string
    agent: Owner
    session?: unknown
    sessionId: string
    /** The mode the session was AUTHORIZED under when it opened (the one-shot
     * grant for an escalated spawn); undefined = not opened through this gate. */
    authorizedMode?: SandboxMode
    /** The family's close tool, named in the deny text (`pty_close` / `ssh_close`). */
    closeTool: string
  }): void
}

/** Create the gate over one entry's service lookup. */
export function createPermissionGate(ctx: PermissionCtx): PermissionGate {
  return {
    async authorizeSpawn(request) {
      const { policy, standingMode, grantedMode } = await resolvePolicyWithEscalation(ctx, request)
      const advice = request.presetChannel === true ? PRESET_CHANNEL_ADVICE : undefined
      if (grantedMode === 'read-only') {
        throw denial(
          request.toolName,
          request.subject,
          grantedMode,
          `${request.subject} execution is not permitted under read-only — no process may be started.`,
          advice,
        )
      }
      if (grantedMode === 'workspace-write') {
        // The workspace boundary is the start cwd: a relative cwd resolves
        // against the workspace root (the session directory), and an omitted
        // cwd DEFAULTS to that root rather than inheriting the host process
        // cwd — otherwise the promise "the process starts inside the
        // workspace" would be nominal (no OS-level confinement exists here).
        const root = policy.workspaceRoot
        const requested = request.cwd
        const cwd = requested === undefined
          ? root
          : isAbsolute(requested)
            ? requested
            : resolvePath(root, requested)
        if (!isInsideWorkspace(cwd, root)) {
          throw denial(
            request.toolName,
            request.subject,
            grantedMode,
            `cwd ${JSON.stringify(cwd)} is outside this session's workspace root ${JSON.stringify(root)} — ` +
              'workspace-write starts processes only inside it.',
            advice,
          )
        }
        return { grantedMode, standingMode, cwd }
      }
      return { grantedMode, standingMode, ...(request.cwd === undefined ? {} : { cwd: request.cwd }) }
    },

    assertSessionWritable(request) {
      const policyService = requireService<SandboxPolicyServiceLike>(ctx, 'sandboxPolicy', request.toolName)
      const standing = policyService.resolve(request.session === undefined ? {} : { session: request.session })
      const baseline = request.authorizedMode
      if (baseline === undefined) return // not opened through this gate: the opener's own gate owns it
      if (MODE_RANK[standing.mode] >= MODE_RANK[baseline]) return
      // The baseline is the mode the SESSION WAS AUTHORIZED under — for an
      // escalated spawn that is the one-shot GRANT. A grant never becomes a
      // standing write permission: under a narrower standing policy the write
      // is refused even though no "downgrade event" happened (it was narrower
      // from the start).
      throw Object.assign(
        new Error(
          [
            sandboxDenialMarker(standing.mode),
            `${request.toolName} refused: session ${JSON.stringify(request.sessionId)} was authorized under ` +
              `${baseline}, but the session's sandbox mode is ${standing.mode}, which is narrower.`,
            'A one-shot escalation grant covers ONLY the call it was approved for — it never turns a narrow policy into ' +
              'a standing write permission.',
            `Close the session with ${request.closeTool} and re-open it under the current policy (or ask the user to ` +
              'widen the policy) before writing again.',
          ].join('\n'),
        ),
        { code: 'SESSION_SANDBOX_DOWNGRADED', mode: standing.mode, authorizedMode: baseline },
      )
    },
  }
}

/**
 * The `sandbox_permissions` / `justification` parameter pair, advertised by
 * every execution tool (upstream wording from the same package, so the model
 * reads one contract).
 */
export function sandboxPermissionParameters(subject: string): Record<string, unknown> {
  return {
    sandbox_permissions: {
      type: 'string',
      enum: [...ESCALATION_TARGETS],
      description: sandboxPermissionsDescription(subject),
    },
    justification: {
      type: 'string',
      description:
        `Required with sandbox_permissions: one sentence for the user explaining why this exact ${subject} needs the ` +
        "wider access. Use the language of the user's current request.",
    },
  }
}

/** The per-execution policy sentence shared by every spawn tool description. */
export const SANDBOX_EXECUTION_SEMANTICS =
  'Every execution resolves the session sandbox policy first (dsh-sandbox-policy): read-only refuses to start a process, ' +
  'workspace-write starts it inside the session workspace only, danger-full-access runs unrestricted. ' +
  'A denial returns the official [sandbox: …] marker; a one-shot retry may be requested with ' +
  'sandbox_permissions + justification, which asks the user through the host approval service (only ' +
  '"allowed-once" grants, and the grant covers that one call). A deployment without the permission services ' +
  'refuses to execute instead of running unconstrained.'

/** The re-resolve sentence shared by every session-write tool description.
 * Authored as a FUNCTION because the close tool differs per family
 * (`pty_close` / `ssh_close`) and a shared constant naming the wrong one sends
 * the model to a tool that does not exist on that surface. */
export function sandboxSessionWriteSemantics(closeTool: string): string {
  return (
    'Every write re-resolves the session sandbox policy: the write is refused when the current mode is narrower than ' +
    `the mode the session was authorized under (a one-shot escalation covers only the call it was approved for). ` +
    `Close the session with ${closeTool} and re-open it under the current policy before writing again.`
  )
}
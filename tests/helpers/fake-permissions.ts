/**
 * #102 test harness: the two host services the permission gate consumes
 * (`sandboxPolicy` / `approval`), faked in-process.
 *
 * ONE home for the fakes, because every unit lane that boots an execution
 * surface (pty / terminal / wsl) must mount them — the gate is FAIL CLOSED
 * (a missing service refuses to execute, deliberately), so a harness without
 * these two services would turn every existing tool test red for a reason that
 * has nothing to do with what it asserts.
 *
 * Defaults are the PERMISSIVE posture (`danger-full-access` + `allowed-once`)
 * so an unrelated suite keeps testing what it was written to test; the #102
 * spec overrides the mode/outcome to pin the gate itself.
 *
 * Neither fake judges anything: `fakeSandboxPolicy` records every resolve and
 * returns the configured mode; `fakeApproval` records every request and returns
 * the scripted outcome. Judgement lives in the spec's assertions.
 *
 * @module tests/helpers/fake-permissions
 */

import type {
  ApprovalOutcome,
  SandboxExecutionPolicyLike,
  SandboxMode,
  SandboxPolicyServiceLike,
} from "../../src/permission-gate.ts";

/** One `resolve()` call, as the fake recorded it. */
export interface FakeResolveCall {
  session?: unknown;
  mode?: SandboxMode;
}

/** A `ctx.sandboxPolicy` stand-in that records resolves and tracks a mutable mode. */
export interface FakeSandboxPolicy extends SandboxPolicyServiceLike {
  /** The current deployment mode (an explicit `resolve({mode})` still outranks it). */
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
  /** Every `resolve()` call in order — proves the PER-EXECUTION resolve. */
  readonly resolves: FakeResolveCall[];
  /** Flip the deployment mode between calls (the #102 downgrade scenario). */
  setMode(mode: SandboxMode): void;
}

/**
 * @param opts.mode Initial deployment mode (default `danger-full-access`,
 *   the permissive posture that leaves unrelated suites unchanged).
 * @param opts.workspaceRoot The `workspace-write` boundary (default =
 *   `process.cwd()`, same fallback the host service uses).
 */
export function fakeSandboxPolicy(opts: { mode?: SandboxMode; workspaceRoot?: string } = {}): FakeSandboxPolicy {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  let mode: SandboxMode = opts.mode ?? "danger-full-access";
  const resolves: FakeResolveCall[] = [];
  return {
    get mode() {
      return mode;
    },
    workspaceRoot,
    resolves,
    setMode(next: SandboxMode) {
      mode = next;
    },
    resolve(request?: { session?: unknown; mode?: SandboxMode }): SandboxExecutionPolicyLike {
      resolves.push({
        ...(request?.session === undefined ? {} : { session: request.session }),
        ...(request?.mode === undefined ? {} : { mode: request.mode }),
      });
      // An explicit mode is the approved escalation grant: it outranks the
      // standing mode exactly like the host service's `resolve({mode})`.
      return { mode: request?.mode ?? mode, workspaceRoot };
    },
  };
}

/** One approval request, as the fake received it. */
export interface FakeApprovalRequest {
  agent?: unknown;
  toolName: string;
  callId?: string;
  reason?: string;
  displayReason?: { readonly en: string; readonly [locale: string]: string };
  signal?: AbortSignal;
}

/** A `ctx.approval` stand-in that records requests and returns a scripted outcome. */
export interface FakeApproval {
  readonly requests: FakeApprovalRequest[];
  request(request: FakeApprovalRequest): Promise<ApprovalOutcome>;
}

/**
 * @param outcome A single outcome for every ask, or a queue consumed per ask
 *   (the queue falling empty resolves `'unavailable'`, the fail-closed value).
 * @param hooks.onRequest Fires BEFORE the outcome is returned — a spec uses it
 *   to snapshot "nothing has spawned yet" (the ask-before-run ordering).
 */
export function fakeApproval(
  outcome: ApprovalOutcome | ApprovalOutcome[] = "allowed-once",
  hooks: { onRequest?: (request: FakeApprovalRequest) => void } = {},
): FakeApproval {
  const queue = Array.isArray(outcome) ? [...outcome] : undefined;
  const requests: FakeApprovalRequest[] = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      hooks.onRequest?.(request);
      if (queue === undefined) return outcome as ApprovalOutcome;
      return queue.length > 0 ? (queue.shift() as ApprovalOutcome) : "unavailable";
    },
  };
}

/** The pair, mounted under the two service ids the gate looks up. */
export function fakePermissionServices(
  opts: { mode?: SandboxMode; workspaceRoot?: string; approvalOutcome?: ApprovalOutcome | ApprovalOutcome[] } = {},
): { sandboxPolicy: FakeSandboxPolicy; approval: FakeApproval } {
  return {
    sandboxPolicy: fakeSandboxPolicy({ ...(opts.mode === undefined ? {} : { mode: opts.mode }), ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }) }),
    approval: fakeApproval(opts.approvalOutcome ?? "allowed-once"),
  };
}

/**
 * The `ctx.get` every boot harness needs since #102: the gate looks the two
 * permission services up by name and FAILS CLOSED when one is absent, so each
 * harness has to answer for both. One helper instead of the same four-line
 * cascade copied into every lane's boot (the duplication a review flagged).
 *
 * @param permissions The pair to mount.
 * @param fallback The lane's own services (e.g. `provided.get`); called only
 *   for names the helper does not answer.
 */
export function permissionServiceLookup(
  permissions: { sandboxPolicy: FakeSandboxPolicy; approval: FakeApproval },
  fallback: (name: string) => unknown = () => undefined,
): (name: string) => unknown {
  return (name: string): unknown => {
    if (name === "sandboxPolicy") return permissions.sandboxPolicy;
    if (name === "approval") return permissions.approval;
    return fallback(name);
  };
}
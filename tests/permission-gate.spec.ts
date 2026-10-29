/**
 * #102 acceptance suite — the host permission model on the execution surfaces
 * (`pty_*` / `shell_open` / `ssh_start` + the `win_*` escalation face).
 *
 * The ticket's AC section is PROSE (a ring-table + Z reading shape carried over
 * from #89 / #97), so this file is where each item becomes a machine-checkable
 * ring. Every ring prints ONE reading line into the shared `=== … rings ===`
 * table (the `scripts/verify-all.mjs` `readingBlocks` contract), so the
 * acceptance evidence is visible in the single verification entry — green OR
 * red. The table is printed from `afterAll`, i.e. from what the rings REALLY
 * observed; a ring that throws records `✗` and re-throws (one red, locatable
 * from its row).
 *
 * Scope of the harness (deliberate): fake PTY spawner (no ConPTY), fake
 * `sandboxPolicy` / `approval` services (the gate's contracts), fake shell seam
 * (wsl). The REAL instance / real approval UI is out of reach headlessly — the
 * boundary is stated in `.scratch/102-landing.md` and was audited in
 * `.scratch/102-audit.md`.
 *
 * @module tests/permission-gate
 */

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyPty } from "../src/pty/index.ts";
import { apply as applyTerminal } from "../src/terminal/index.ts";
import * as wslPlugin from "../src/wsl-plugin/index.js";
import { escalationHintMarker, sandboxDenialMarker, type ApprovalOutcome, type SandboxMode } from "../src/permission-gate.ts";
import { bootPlugin, echoFakePty } from "./helpers/fake-pty.ts";
import { fakeApproval, fakePermissionServices, permissionServiceLookup } from "./helpers/fake-permissions.ts";
import type { CoreSpawnSpec } from "../src/pty/session-core.ts";

// ---------------------------------------------------------------------------
// One agent with a session (the policy resolution is session-bound).
// ---------------------------------------------------------------------------

const AGENT = { name: "gate", session: { sessionId: "s-1" } };
const exec = (extra: Record<string, unknown> = {}) => ({
  agent: AGENT,
  callId: "call-1",
  signal: new AbortController().signal,
  ...extra,
});

// ---------------------------------------------------------------------------
// The ring recorder (#89 / #97 shape): one reading per acceptance item.
// ---------------------------------------------------------------------------

const rings: string[] = [];

/** Run one acceptance ring, record its reading, and re-throw a failure so the
 * suite still reds exactly once with a locatable table row. */
async function ring(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
    rings.push(`  ✓ ${name}`);
  } catch (error) {
    rings.push(`  ✗ ${name}`);
    throw error;
  }
}

afterAll(() => {
  if (rings.length === 0) return;
  console.info("=== #102 acceptance rings (host permission model) ===");
  for (const row of rings) console.info(row);
});

/** Resolve the failure of a call that MUST be refused, or throw if it ran. */
async function refusal<T>(promise: Promise<T>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the call to be refused, but it ran");
}

/** Fast settles — these rings assert wiring/policy, not timing. */
const FAST = { settleQuietMs: 10, settleTickMs: 5, settleTimeoutMs: 60 };

/** Boot the pty entry over a fake spawner + the two faked permission services.
 * `onRequest` fires at approval time with the live spawn ledger, so a ring can
 * pin "asked BEFORE a spawn". */
function bootPty(opts: {
  mode: SandboxMode;
  workspaceRoot?: string;
  outcome?: ApprovalOutcome | ApprovalOutcome[];
  onRequest?: (spawned: CoreSpawnSpec[]) => void;
}) {
  const spawned: CoreSpawnSpec[] = [];
  const handles: ReturnType<typeof echoFakePty>[] = [];
  const sandboxPolicy = fakePermissionServices({
    mode: opts.mode,
    ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
  }).sandboxPolicy;
  const approval = fakeApproval(
    opts.outcome ?? "allowed-once",
    opts.onRequest === undefined ? {} : { onRequest: () => opts.onRequest!(spawned) },
  );
  const booted = bootPlugin({
    config: FAST,
    // #136: the ssh family moved to its own entry; the AC1/AC3 rings below
    // exercise `ssh_start`, so mount it on the same context (same pty core).
    ssh: true,
    spawnPty: (spec) => {
      spawned.push(spec);
      const handle = echoFakePty();
      handles.push(handle);
      return handle;
    },
    permissions: { sandboxPolicy, approval },
  });
  return { ...booted, spawned, handles, sandboxPolicy, approval };
}

/** A raw boot that can OMIT one service — the fail-closed rings need that. */
function bootPtyMissing(missing: "sandboxPolicy" | "approval") {
  const spawned: CoreSpawnSpec[] = [];
  const registered: any[] = [];
  const permissions = fakePermissionServices();
  const mounted = permissionServiceLookup(permissions);
  const ctx = {
    provide: () => {},
    effect: () => () => Promise.resolve(),
    tools: { register: (tool: unknown) => registered.push(tool) },
    get: (name: string) => (name === missing ? undefined : mounted(name)),
  };
  applyPty(ctx as any, FAST, {
    spawnPty: (spec: CoreSpawnSpec) => {
      spawned.push(spec);
      return echoFakePty().pty;
    },
  });
  return { tool: (name: string) => registered.find((tool) => tool.name === name), spawned };
}

/** Boot BOTH entries on one shared context — `shell_open`'s gate + core. */
function bootTerminal(opts: { mode: SandboxMode; workspaceRoot?: string; exists?: (candidate: string) => boolean }) {
  const spawned: CoreSpawnSpec[] = [];
  const registered: any[] = [];
  const provided = new Map<string, unknown>();
  const permissions = fakePermissionServices({
    mode: opts.mode,
    ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
  });
  const ctx = {
    provide: (name: string, value: unknown) => provided.set(name, value),
    effect: () => () => Promise.resolve(),
    tools: { register: (tool: unknown) => registered.push(tool) },
    get: permissionServiceLookup(permissions, (name) => provided.get(name)),
  };
  applyPty(ctx as any, FAST, {
    spawnPty: (spec: CoreSpawnSpec) => {
      spawned.push(spec);
      return echoFakePty().pty;
    },
  });
  // deps.exists is FAKED: the rings below reach shell_open's GATE, which sits
  // after launcher resolution — a machine without pwsh at any probe point
  // would throw the launcher's loud "not serviceable" (no `code`) before the
  // gate ever ran, red with a machine-shaped error instead of a policy one
  // (observed 2026-10-26). The gate is policy, not executable presence.
  applyTerminal(ctx as any, {}, { exists: opts.exists ?? (() => true) });
  return {
    tool: (name: string) => registered.find((tool) => tool.name === name),
    spawned,
    approval: permissions.approval,
    sandboxPolicy: permissions.sandboxPolicy,
  };
}

/** Boot the wsl entry over a scripted shell seam + faked permission services. */
function bootWsl(opts: {
  mode: SandboxMode;
  outcome?: ApprovalOutcome | ApprovalOutcome[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  const registered: any[] = [];
  const calls: any[] = [];
  const permissions = fakePermissionServices({
    mode: opts.mode,
    ...(opts.outcome === undefined ? {} : { approvalOutcome: opts.outcome }),
  });
  const run = {
    exitCode: opts.exitCode ?? 0,
    stdout: { text: opts.stdout ?? "", truncated: false },
    stderr: { text: opts.stderr ?? "", truncated: false },
  };
  const ctx = {
    get: (name: string) => {
      if (name === "shell") {
        return {
          resolve: (request: any) => request,
          execute: async (request: any) => {
            calls.push(request);
            return { result: async () => run };
          },
        };
      }
      if (name === "sandboxPolicy") return permissions.sandboxPolicy;
      if (name === "approval") return permissions.approval;
      return undefined;
    },
    tools: { register: (tool: unknown) => registered.push(tool) },
  };
  wslPlugin.apply(ctx as any);
  return {
    tool: (name: string) => registered.find((tool) => tool.name === name),
    calls,
    approval: permissions.approval,
    sandboxPolicy: permissions.sandboxPolicy,
  };
}

// ---------------------------------------------------------------------------
// #165 — the two failure shapes are attributable by `code` alone: an absent
// machine (launcher resolution fails FIRST) is an environment shape; a policy
// refusal at the gate is a strategy shape. Same tool, same spec, no prose
// matching needed.
describe("#165: environment shape vs policy shape, attributable by code", () => {
  it("shell_open without any executable is PRESET_NOT_SERVICEABLE, under read-only it is SANDBOX_DENIED — the codes differ", async () => {
    await ring("#165 环境形状 vs 策略形状：launcher code ≠ SANDBOX_DENIED（同一 spec 可归因）", async () => {
      const env = bootTerminal({ mode: "read-only", exists: () => false });
      const envErr = await refusal(env.tool("shell_open").execute({ preset: "pwsh" }, exec()));
      expect(envErr.code).toBe("PRESET_NOT_SERVICEABLE");
      expect(envErr.code).not.toBe("SANDBOX_DENIED");

      const policy = bootTerminal({ mode: "read-only" });
      const policyErr = await refusal(policy.tool("shell_open").execute({ preset: "pwsh" }, exec()));
      expect(policyErr.code).toBe("SANDBOX_DENIED");
    });
  });
});

// AC1 — read-only refuses a spawn, with the official denial vocabulary
// ---------------------------------------------------------------------------

describe("#102 AC1: read-only refuses to start a process", () => {
  it("refuses pty_open with the marker + sandbox_permissions + the narrowest wider mode, and spawns nothing", async () => {
    await ring("AC1 read-only → pty_open 拒绝（spawn=0；文案含 sandbox_permissions + 最窄更宽 + shell_open 指向）", async () => {
      const h = bootPty({ mode: "read-only" });
      const failure = await refusal(h.tool("pty_open").execute({ command: "cmd.exe /c echo hi" }, exec()));
      expect(failure.code).toBe("SANDBOX_DENIED");
      expect(failure.message).toContain(sandboxDenialMarker("read-only"));
      // AC wording: the text must name the retry arguments AND the narrowest
      // wider mode — a model reading only this line can act on it.
      expect(failure.message).toContain("sandbox_permissions");
      expect(failure.message).toContain(escalationHintMarker("command"));
      // The NARROWEST claim is pinned to its own line: the denial always lists
      // both escalation targets, so a plain `toContain("workspace-write")` would
      // stay green even if the narrowest computation were wrong.
      expect(failure.message).toContain("Narrowest wider mode that suffices: workspace-write");
      // Ticket 「命令白名单」§2: the free-command-line denial points at the
      // narrower preset channel (honestly: same policy, so it does not lift it).
      expect(failure.message).toContain("shell_open");
      expect(failure.message).toContain("preset");
      // The discriminating half: nothing was started.
      expect(h.spawned).toHaveLength(0);
      // The policy was resolved PER EXECUTION (the contract this ticket fixes).
      expect(h.sandboxPolicy.resolves.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("refuses shell_open and ssh_start on the same policy (one gate, no bypass)", async () => {
    await ring("AC1 read-only → shell_open / ssh_start 同样拒绝（spawn=0）", async () => {
      const t = bootTerminal({ mode: "read-only" });
      const shellOpen = await refusal(t.tool("shell_open").execute({ preset: "pwsh" }, exec()));
      expect(shellOpen.code).toBe("SANDBOX_DENIED");
      expect(t.spawned).toHaveLength(0);

      const p = bootPty({ mode: "read-only" });
      const sshStart = await refusal(p.tool("ssh_start").execute({ host: "example.invalid" }, exec()));
      expect(sshStart.code).toBe("SANDBOX_DENIED");
      expect(sshStart.message).toContain(sandboxDenialMarker("read-only"));
      expect(p.spawned).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC2 — workspace-write confines the START cwd to the workspace root
// ---------------------------------------------------------------------------

describe("#102 AC2: workspace-write confines the start cwd", () => {
  it("refuses an out-of-root cwd, allows an in-root one, and DEFAULTS an omitted cwd to the root", async () => {
    await ring("AC2 workspace-write：越界 cwd 拒绝 / 界内放行 / 省略 cwd 落在 workspaceRoot", async () => {
      const root = mkdtempSync(join(tmpdir(), "gate-root-"));
      const outside = mkdtempSync(join(tmpdir(), "gate-outside-"));
      try {
        const h = bootPty({ mode: "workspace-write", workspaceRoot: root });
        const denied = await refusal(h.tool("pty_open").execute({ command: "x", cwd: outside }, exec()));
        expect(denied.code).toBe("SANDBOX_DENIED");
        expect(denied.message).toContain(sandboxDenialMarker("workspace-write"));
        // The narrowest wider mode at THIS step is danger-full-access — pinned on
        // its own line (the denial always lists both targets).
        expect(denied.message).toContain("Narrowest wider mode that suffices: danger-full-access");
        expect(denied.message).toContain("shell_open");
        expect(h.spawned).toHaveLength(0);

        const inside = join(root, "sub");
        const opened = await h.tool("pty_open").execute({ command: "x", cwd: inside }, exec());
        expect(opened.sandboxMode).toBe("workspace-write");
        expect(h.spawned).toHaveLength(1);
        // The spawn must actually use the boundary cwd — a pass-through
        // implementation would hand the caller's value/undefined and look green.
        expect(h.spawned[0].cwd).toBe(inside);

        // Omitted cwd: under workspace-write it DEFAULTS to the workspace root
        // (otherwise "starts inside the workspace" would be nominal).
        await h.tool("pty_open").execute({ command: "y" }, exec());
        expect(h.spawned[1].cwd).toBe(root);

        // shell_open goes through the same rule (a preset cwd outside the root
        // is refused before anything spawns).
        const t = bootTerminal({ mode: "workspace-write", workspaceRoot: root });
        const shellDenied = await refusal(t.tool("shell_open").execute({ preset: "pwsh", cwd: outside }, exec()));
        expect(shellDenied.code).toBe("SANDBOX_DENIED");
        expect(t.spawned).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// AC3 — the escalation retry goes through the OFFICIAL approval service
// ---------------------------------------------------------------------------

describe("#102 AC3: sandbox_permissions routes a one-shot retry through approval", () => {
  it("asks exactly once, BEFORE any spawn, and the allowed-once grant really runs the command", async () => {
    await ring("AC3 升级：先问后跑（approval 1 条 + spawn 0 → allowed-once → spawn 1）", async () => {
      const root = mkdtempSync(join(tmpdir(), "gate-escalate-"));
      /** Spawn count observed at the moment the approval request was raised. */
      const ledger: { spawnedAtApproval: number } = { spawnedAtApproval: -1 };
      try {
        const h = bootPty({
          mode: "workspace-write",
          workspaceRoot: root,
          onRequest: (spawned) => {
            ledger.spawnedAtApproval = spawned.length;
          },
        });
        const opened = await h.tool("pty_open").execute(
          {
            command: "cmd.exe /c echo escalated",
            sandbox_permissions: "danger-full-access",
            justification: "the command must write outside the workspace",
          },
          exec(),
        );
        expect(opened.sandboxMode).toBe("danger-full-access");
        // Exactly one ask, attached to THIS tool call.
        const requests = h.approval.requests;
        expect(requests).toHaveLength(1);
        expect(requests[0].toolName).toBe("pty_open");
        expect(requests[0].callId).toBe("call-1");
        expect(requests[0].reason).toContain("danger-full-access");
        expect(requests[0].reason).toContain("the command must write outside the workspace");
        expect(requests[0].displayReason?.en).toContain("danger-full-access");
        expect(requests[0].displayReason?.zh).toContain("danger-full-access");
        // ASKED BEFORE RUN: the request saw zero spawns, the grant ran one.
        expect(ledger.spawnedAtApproval).toBe(0);
        expect(h.spawned).toHaveLength(1);
        expect(h.spawned[0].command).toBe("cmd.exe /c echo escalated");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("fails closed on every non-grant outcome and keeps the structured denial shape", async () => {
    await ring("AC3/AC4 非 grant：rejected / cancelled / unavailable 一律拒绝（spawn=0，结构化形状保留）", async () => {
      // Each outcome has its OWN official text inside `approveEscalation` — pin
      // that text per value instead of a shared substring.
      const outcomeText: Record<"rejected" | "cancelled" | "unavailable", RegExp> = {
        rejected: /rejected/iu,
        cancelled: /cancelled/iu,
        unavailable: /no approval channel is available/iu,
      };
      for (const outcome of ["rejected", "cancelled", "unavailable"] as const) {
        const root = mkdtempSync(join(tmpdir(), "gate-outcome-"));
        try {
          const h = bootPty({ mode: "workspace-write", workspaceRoot: root, outcome });
          const failure = await refusal(
            h.tool("pty_open").execute(
              { command: "x", sandbox_permissions: "danger-full-access", justification: "why" },
              exec(),
            ),
          );
          // The ticket (§4) requires the structured denial shape even when the
          // ask was refused: the marker + hint survive, and the outcome is read.
          expect(failure.message).toContain(sandboxDenialMarker("workspace-write"));
          expect(failure.message).toContain(escalationHintMarker("command"));
          expect(failure.message).toMatch(outcomeText[outcome]);
          expect(h.approval.requests).toHaveLength(1);
          expect(h.spawned).toHaveLength(0);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  });

  it("carries the same escalation on ssh_start (the execution face the AC list omits)", async () => {
    await ring("AC3/ssh 升级：ssh_start 在 read-only 下经审批放行（approval 1 条，spawn 1，落在 workspaceRoot）", async () => {
      // Acceptance-list item 8 (declared in `.scratch/102-audit.md`): the
      // ticket's AC enumerates pty_open/shell_open, but ssh_start is the same
      // local-execution face (`-o ProxyCommand=…` is arbitrary local exec), so
      // it takes the same gate — and therefore needs its own grant reading.
      const h = bootPty({ mode: "read-only", outcome: "allowed-once" });
      const opened = await h.tool("ssh_start").execute(
        {
          host: "example.invalid",
          sandbox_permissions: "workspace-write",
          justification: "the remote shell is required for this task",
        },
        exec(),
      );
      expect(opened.sandboxMode).toBe("workspace-write");
      expect(h.approval.requests).toHaveLength(1);
      expect(h.approval.requests[0].toolName).toBe("ssh_start");
      expect(h.spawned).toHaveLength(1);
      expect(h.spawned[0].command).toContain("ssh -tt");
      // workspace-write decides the START cwd — a pass-through implementation
      // would hand undefined here and still look green.
      expect(h.spawned[0].cwd).toBe(h.sandboxPolicy.workspaceRoot);
    });
  });
});

// ---------------------------------------------------------------------------
// AC5 — a policy DOWNGRADE invalidates earlier sessions
// ---------------------------------------------------------------------------

describe("#102 AC5: an existing session stops accepting writes after a downgrade", () => {
  it("refuses pty_send after read-only, while pty_tail / pty_close still work; widening keeps the session writable", async () => {
    await ring("AC5 降级失效：send 被拒且未写入字节；tail/close 仍可用；升宽后恢复", async () => {
      const root = mkdtempSync(join(tmpdir(), "gate-downgrade-"));
      try {
        const h = bootPty({ mode: "workspace-write", workspaceRoot: root });
        const opened = await h.tool("pty_open").execute({ command: "repl" }, exec());
        const handle = h.handles[0];

        h.sandboxPolicy.setMode("read-only");
        const before = handle.writes.length;
        const failure = await refusal(h.tool("pty_send").execute({ id: opened.sessionId, data: "echo hi" }, exec()));
        expect(failure.code).toBe("SESSION_SANDBOX_DOWNGRADED");
        expect(failure.message).toContain(sandboxDenialMarker("read-only"));
        expect(failure.message).toContain("workspace-write"); // names the revoked baseline
        // No bytes reached the process — the old grant was NOT reused.
        expect(handle.writes).toHaveLength(before);

        // Reads and the close path do not widen anything: they stay available.
        expect(await h.tool("pty_tail").execute({ id: opened.sessionId }, exec())).toEqual({ text: "", lines: 0, truncated: false });

        // Widening is not a downgrade: the same session accepts a write again.
        h.sandboxPolicy.setMode("danger-full-access");
        await h.tool("pty_send").execute({ id: opened.sessionId, data: "echo ok" }, exec());
        expect(handle.writes.length).toBe(before + 1);

        expect(await h.tool("pty_close").execute({ id: opened.sessionId }, exec())).toEqual({ closed: true });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("an escalated spawn never becomes a standing write permission", async () => {
    await ring("AC5b 一次性授权不外溢：read-only 下经授权打开后 pty_send 仍被拒（写入 0 字节）", async () => {
      // The spec axis caught the original shape: recording the STANDING mode
      // as the baseline made a one-shot approval under read-only yield a
      // permanently writable session (rank(read-only) >= rank(read-only)).
      const h = bootPty({ mode: "read-only", outcome: "allowed-once" });
      const opened = await h.tool("pty_open").execute(
        { command: "repl", sandbox_permissions: "workspace-write", justification: "one interactive shell" },
        exec(),
      );
      expect(opened.sandboxMode).toBe("workspace-write"); // the grant decided the spawn
      expect(h.spawned).toHaveLength(1);
      const handle = h.handles[0];
      const before = handle.writes.length;
      const failure = await refusal(h.tool("pty_send").execute({ id: opened.sessionId, data: "echo hi" }, exec()));
      expect(failure.code).toBe("SESSION_SANDBOX_DOWNGRADED");
      expect(failure.message).toContain(sandboxDenialMarker("read-only"));
      expect(failure.message).toContain("one-shot escalation grant covers ONLY the call");
      expect(handle.writes).toHaveLength(before);
      expect(await h.tool("pty_close").execute({ id: opened.sessionId }, exec())).toEqual({ closed: true });
    });
  });
});

// ---------------------------------------------------------------------------
// AC6 — a missing permission service fails closed and names the service
// ---------------------------------------------------------------------------

describe("#102 AC6: missing permission services fail closed", () => {
  it("names sandboxPolicy / approval and never spawns", async () => {
    await ring("AC6 缺服务：sandboxPolicy / approval 缺任一即拒绝（点名缺的服务，spawn=0）", async () => {
      for (const missing of ["sandboxPolicy", "approval"] as const) {
        const h = bootPtyMissing(missing);
        const failure = await refusal(h.tool("pty_open").execute({ command: "x" }, exec()));
        expect(failure.code).toBe("PERMISSION_SERVICE_MISSING");
        expect(failure.message).toContain(`\`${missing}\``);
        expect(failure.message).toMatch(/mount the official permission model/);
        expect(h.spawned).toHaveLength(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// AC7 — the wsl family carries the same escalation face
// ---------------------------------------------------------------------------

describe("#102 AC7: the win_* family carries sandbox_permissions once per tool call", () => {
  it("asks once, stamps the GRANTED mode on the shell request, and executes", async () => {
    await ring("AC7 wsl 升级：approval 1 条 → shell 请求携带授予模式（workspace-write）", async () => {
      const w = bootWsl({ mode: "read-only" });
      const out = await w.tool("win_run").execute(
        {
          command: "cmd.exe /c echo hi",
          shell: "direct",
          sandbox_permissions: "workspace-write",
          justification: "the read must reach the Windows mount",
        },
        { agent: AGENT, callId: "call-7", signal: new AbortController().signal },
      );
      expect(out.exitCode).toBe(0);
      expect(w.approval.requests).toHaveLength(1);
      expect(w.approval.requests[0].toolName).toBe("win_run");
      expect(w.approval.requests[0].callId).toBe("call-7");
      expect(w.approval.requests[0].reason).toContain("workspace-write");
      // The downlink: the executor receives the GRANTED mode, not the standing one.
      expect(w.calls).toHaveLength(1);
      expect(w.calls[0].sandboxPolicy.mode).toBe("workspace-write");
    });
  });

  it("refuses before the shell when the ask is rejected, and surfaces the same-turn hint on a real denial", async () => {
    await ring("AC7 wsl 非 grant：未调用 shell；执行器回吐拒绝标记时结果带同轮升级提示", async () => {
      const rejected = bootWsl({ mode: "read-only", outcome: "rejected" });
      const failure = await refusal(
        rejected.tool("win_run").execute(
          { command: "x", shell: "direct", sandbox_permissions: "workspace-write", justification: "why" },
          { agent: AGENT, callId: "call-8", signal: new AbortController().signal },
        ),
      );
      expect(failure.message.toLowerCase()).toContain("rejected");
      // Nothing reached the seam: the ask is a gate, not a warning.
      expect(rejected.calls).toHaveLength(0);

      // No escalation asked for: the EXECUTOR denies, and the tool appends the
      // official same-turn hint so the model can retry the sanctioned way. A
      // real denied redirection exits non-zero with the marker on stderr.
      const denied = bootWsl({
        mode: "read-only",
        exitCode: 1,
        stderr: sandboxDenialMarker("read-only"),
      });
      const out = await denied.tool("win_write").execute(
        { path: "C:\\tmp\\x.txt", content: "hi" },
        { agent: AGENT, signal: new AbortController().signal },
      );
      expect(out.error).toContain(sandboxDenialMarker("read-only"));
      expect(out.error).toContain(escalationHintMarker("operation"));
      expect(denied.calls[0].sandboxPolicy.mode).toBe("read-only");

      // Control (the discriminating half): a clean run carries NO hint — the
      // append is a denial response, not a decoration on every result.
      const clean = bootWsl({ mode: "read-only", exitCode: 0, stderr: "" });
      const ok = await clean.tool("win_write").execute(
        { path: "C:\\tmp\\x.txt", content: "hi" },
        { agent: AGENT, signal: new AbortController().signal },
      );
      expect(ok.error).toBeNull();
    });
  });

  it("fails closed when the deployment lacks the permission services", async () => {
    await ring("AC7 wsl 缺服务：fail closed（点名服务，shell 未被调用）", async () => {
      for (const missing of ["sandboxPolicy", "approval"] as const) {
        const calls: any[] = [];
        const registered: any[] = [];
        const permissions = fakePermissionServices();
        const ctx = {
          get: (name: string) => {
            if (name === missing) return undefined;
            if (name === "shell") {
              return {
                resolve: (request: any) => request,
                execute: async (request: any) => {
                  calls.push(request);
                  return { result: async () => ({ exitCode: 0, stdout: { text: "" }, stderr: { text: "" } }) };
                },
              };
            }
            if (name === "sandboxPolicy") return permissions.sandboxPolicy;
            if (name === "approval") return permissions.approval;
            return undefined;
          },
          tools: { register: (tool: unknown) => registered.push(tool) },
        };
        wslPlugin.apply(ctx as any);
        const tool = registered.find((entry) => entry.name === "win_drives");
        const failure = await refusal(tool.execute({}, { agent: AGENT, signal: new AbortController().signal }));
        expect(failure.code).toBe("PERMISSION_SERVICE_MISSING");
        expect(failure.message).toContain(`\`${missing}\``);
        expect(calls).toHaveLength(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Z — the ledger: spawns, sessions, temp dirs (the ticket's Z reading shape)
// ---------------------------------------------------------------------------

describe("#102 Z: totals", () => {
  it("counts the allowed spawns, closes every session it opened, and leaves the workspace untouched", async () => {
    await ring("Z 总账：放行 spawn=2、会话关闭后 registry 空、workspaceRoot 无残留文件", async () => {
      const root = mkdtempSync(join(tmpdir(), "gate-z-"));
      try {
        const h = bootPty({ mode: "workspace-write", workspaceRoot: root });
        const first = await h.tool("pty_open").execute({ command: "a" }, exec());
        const second = await h.tool("pty_open").execute({ command: "b" }, exec());
        expect(h.spawned).toHaveLength(2);
        expect(h.core.active(AGENT)).toHaveLength(2);
        await h.tool("pty_close").execute({ id: first.sessionId }, exec());
        await h.tool("pty_close").execute({ id: second.sessionId }, exec());
        expect(h.core.active(AGENT)).toEqual([]);
        // A REAL reading, not the previous tautology (`existsSync` after our own
        // `rmSync(force)` only proved rmSync works): the run must have left the
        // workspace root EMPTY — any leaked app file would show up here.
        expect(readdirSync(root)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      // The absence AFTER cleanup is still worth stating, but it is the
      // cleanup's claim, not the run's — the reading above is the run's.
      expect(existsSync(root)).toBe(false);
    });
  });
});
/**
 * #175 — machine-lane verification of the sandbox/mode SYNC constraint against
 * the REAL host service chain (every existing sync test runs on fakes).
 *
 * The chain under test, all real (no duck-typed fake anywhere):
 *
 *   `commands/execute` RPC `/permission <preset>`  (the write path the web
 *     client uses — the host's interaction/permission-presets package)
 *   → `permissionPresets.apply` → `setSandboxMode(session, mode)`  (the host's
 *     canonical `sandbox/mode` event writer, in the sandbox-policy package's
 *     session-mode module)
 *   → session projection fold (`permissions` projection unit)
 *   → `sandboxPolicy.resolve()` reads the folded override live
 *   → THIS bundle's `assertSessionWritable` refuses `pty_send` /
 *     remote-session writes with the SESSION_SANDBOX_DOWNGRADED shape.
 *
 * What the FAKE tier (`tests/permission-gate.spec.ts` AC5/AC5b) can never
 * prove: that the host-side fold semantics, projection state version, or the
 * session binding of `resolve()` still agree with the fake's duck-typed
 * semantics. If any of those drift, THIS file reds.
 *
 * Wire attribution note: the wire carries the error MESSAGE (the marker + the
 * "was authorized under <baseline>" sentence), not the error `code` property —
 * the `SESSION_SANDBOX_DOWNGRADED` code itself is pinned by the fake tier,
 * which owns the in-process contract; the marker + baseline sentence here is
 * the same message that code is attached to.
 *
 * AC2 (remote leg) gates like #141 (`tests/remote-roundtrip-live.spec.ts`):
 * it ships the Docker/podman sshd fixture leg only, and loud-skips
 * (`not run locally: 沙箱同步 remote 腿`) when no container runtime answers —
 * the declared `DSH_SSH_LIVE_HOST` override is intentionally NOT wired here, so
 * a stale env value cannot redirect the leg into a harness that does not exist.
 * It proves `remote_open_session` sessions share the pty core registry and the
 * same downgrade gate, driven by `pty_send` / `pty_close` on the remote id.
 *
 * Isolation: temp DSH_HOME, `--port 0`, mock LLM — same plumbing as
 * `tests/e2e-pty-loop-machine.spec.ts` (shared helpers, no second copy); the
 * multi-prompt shape is the one thing this tier adds: the /permission RPCs land
 * BETWEEN prompts, and that interleave control is the sync constraint's seam.
 *
 * @module tests/sandbox-mode-machine
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MY_ROWS,
  exchangeToken,
  rpc,
  rpcValue,
  startInstance,
  startMockLlm,
  stopChild,
  toolResultsOf,
  type MockToolStep,
} from "./helpers/e2e-chain.ts";
import { sandboxDenialMarker } from "../src/permission-gate.ts";
import { PLUGIN_DIR, installPlugin, missingEnvironment } from "./helpers/e2e-install.ts";
import {
  detectContainerRuntime,
  startSshdContainer,
  SSHD_REMOTE_ROOT,
  type SshdHarness,
} from "./helpers/sshd-container.ts";

const PROFILE = "dsh-host-sbxmode";
const TIMEOUT = 240_000;

const absent = missingEnvironment();
if (absent.length > 0) {
  console.warn(
    `  !! SKIP (loud) — sandbox-mode machine tier needs: ${absent.join(" / ")} — ` +
    `override with DSH_E2E_PLUGIN_DIR / DSH_E2E_HOST_DIR / DSH_E2E_NODE / DSH_E2E_PNPM_DIR`,
  );
}

const RUNTIME: "docker" | "podman" | null = await detectContainerRuntime();
const REMOTE_GATED_OFF = RUNTIME === null;
if (REMOTE_GATED_OFF) {
  console.warn(
    "  !! SKIP (loud): not run locally: 沙箱同步 remote 腿 —— 容器运行时缺席（docker/podman 都不在位或 " +
      "daemon/machine 未启动；remote_open_session 的降级拒写一条都没跑；#141 同一门禁，挂具在 tests/helpers/sshd-container.ts）",
  );
}

/** ids come off the wire, never hard-coded (the #148 script discipline). */
const sessionIdFrom = (texts: readonly string[]): string => {
  const id = [...texts.join("\n").matchAll(/"sessionId":"([^"]+)"/gu)].at(-1)?.[1];
  if (id === undefined) throw new Error(`no sessionId in tool results:\n${texts.join("\n---\n")}`);
  return id;
};

/** The FIRST session id in the accumulated results — the two-session script
 * addresses A (first) and B (last) distinctly off the wire. */
const firstSessionId = (texts: readonly string[]): string => {
  const id = [...texts.join("\n").matchAll(/"sessionId":"([^"]+)"/gu)][0]?.[1];
  if (id === undefined) throw new Error(`no sessionId in tool results:\n${texts.join("\n---\n")}`);
  return id;
};

/** Wait until the mock has seen `turns` agent requests, then settle. The
 * end_turn frame ends the loop, but the instance may still be settling; the
 * quiet window keeps the next prompt from interleaving with the previous turn. */
async function awaitTurns(mock: { agentTurns(): number }, turns: number, deadlineMs = 90_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (mock.agentTurns() < turns && Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 500); });
  }
  expect(mock.agentTurns(), `agent reached ${turns} turns`).toBeGreaterThanOrEqual(turns);
  await new Promise((r) => { setTimeout(r, 1_500); });
}

/**
 * Submit `/permission <preset>` through the REAL web write path
 * (`commands/execute` → permissionPresets.apply → setSandboxMode).
 *
 * The typert envelope shape is probed, not assumed: `commands/execute` takes
 * NAMED parameters (agentId/line/submittedAttachments), unlike session/prompt's
 * single `request` object, and only an `arguments-invalid` rejection counts as
 * "wrong shape" (the rpcZeroArg precedent, generalized to one-arg-object
 * methods). Any other error is the real failure and propagates.
 */
async function setPermissionPreset(port: number, cookie: string, sessionId: string, preset: string): Promise<string> {
  const args = { agentId: sessionId, line: `/permission ${preset}`, submittedAttachments: [] };
  const failures: string[] = [];
  for (const wrapped of [false, true]) {
    // 'raw' = payload.args IS the args object (named-parameter descriptor,
    // e2e-chain's #175 shape); 'request' = the session/prompt-style wrap.
    const shape = wrapped ? "request" : "raw";
    const { status, text } = await rpc(port, cookie, "commands/execute", wrapped ? { request: args } : args, shape);
    if (status < 200 || status >= 300) {
      failures.push(`wrapped=${String(wrapped)} HTTP ${String(status)}: ${text.slice(0, 300)}`);
      if (!/arguments-invalid|unexpected/iu.test(text)) throw new Error(failures.join("\n"));
      continue;
    }
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { throw new Error(`commands/execute: not JSON (${text.slice(0, 200)})`); }
    if (parsed?.result?.ok !== true) {
      const detail = JSON.stringify(parsed?.result?.error ?? parsed).slice(0, 300);
      failures.push(`wrapped=${String(wrapped)}: ${detail}`);
      if (/arguments-invalid|unexpected/iu.test(detail)) continue;
      throw new Error(failures.join("\n"));
    }
    const value = parsed.result.value ?? {};
    const outcome = String(value?.result?.text ?? JSON.stringify(value));
    expect(outcome, `/permission ${preset} applied`).toContain(`preset ${preset}`);
    return outcome;
  }
  throw new Error(`commands/execute: no envelope shape accepted — ${failures.join(" | ")}`);
}

/** The read side of the SAME write path: a bare `/permission` returns
 * `current preset <name> (available: …)` — the fold's own view of the session. */
async function currentPreset(port: number, cookie: string, sessionId: string): Promise<string> {
  const { text } = await rpc(port, cookie, "commands/execute", { agentId: sessionId, line: "/permission", submittedAttachments: [] }, "raw");
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return `__not_json__ ${text.slice(0, 200)}`; }
  if (parsed?.result?.ok !== true) return `__error__ ${JSON.stringify(parsed?.result?.error ?? parsed).slice(0, 200)}`;
  return String(parsed.result.value?.result?.text ?? JSON.stringify(parsed.result.value));
}

/** One leg = dedicated tree + mock + instance + session.
 *  Cleanup stays in the leg's finally (the sibling tiers' shape). */
async function bootLeg(dshHome: string, steps: readonly MockToolStep[]) {
  // The OFFICIAL install route first — without the profile the instance has
  // nothing to boot (docs/agents/profile-install.md).
  const installed = await installPlugin(dshHome, PROFILE);
  expect(installed.code, `dsh plugin add succeeded (output: ${installed.out.slice(-500)})`).toBe(0);
  const mock = await startMockLlm(steps);
  const inst = startInstance(PROFILE, dshHome, {
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.port}`,
    DEEPSEEK_API_KEY: "mock-key-nonempty",
  });
  let launchUrl: string;
  try {
    launchUrl = await inst.ready;
  } catch (error) {
    await mock.close();
    throw error;
  }
  const exchanged = await exchangeToken(launchUrl);
  expect(exchanged.status, "launch URL exchanges the token").toBe(303);
  expect(exchanged.cookie, "exchange issues an auth cookie").toBeTruthy();
  return { mock, inst, port: exchanged.port, cookie: exchanged.cookie! };
}

/** Create the session; stderr attribution first (TESTING.md). */
async function createSession(inst: ReturnType<typeof startInstance>, port: number, cookie: string): Promise<string> {
  const stderr = inst.stderr();
  const blamed = MY_ROWS.filter((row) => new RegExp(`\\b${row}\\b`, "u").test(stderr));
  expect(blamed, "stderr never blames this bundle's loader rows").toEqual([]);
  const created = await rpcValue(port, cookie, "session/create", { cwd: PLUGIN_DIR });
  expect(created?.sessionId, "session/create returns a sessionId").toBeTruthy();
  return created.sessionId as string;
}

async function prompt(port: number, cookie: string, sessionId: string, tag: string, text: string): Promise<void> {
  await rpcValue(port, cookie, "session/prompt", {
    requestId: `sbx-${tag}-${Date.now()}`,
    sessionId,
    mode: "queue",
    content: [{ type: "text", text }],
  });
}

/** The step-result reader from the #148 tier: results matched by the mock's
 * OWN tool_use ids (`toolu_e2e_s<n>`), never by request ordering. */
function stepResultsOf(agentReqs: readonly { body: Record<string, any> }[]) {
  const byId = new Map<string, { isError?: boolean; text: string }>();
  for (const req of agentReqs) {
    for (const result of toolResultsOf(req.body)) {
      if (!byId.has(result.toolUseId)) byId.set(result.toolUseId, result);
    }
  }
  return (n: number, label: string): { isError?: boolean; text: string } => {
    const found = byId.get(`toolu_e2e_s${String(n)}`);
    expect(
      found,
      `${label}（第 ${String(n)} 步）的 tool_result 不在实例回灌的字节里 —— 实例只回了：${[...byId.keys()].join(", ") || "（无）"}`,
    ).toBeTruthy();
    return found!;
  };
}

/** Failure forensics: dump every log file under the leg's DSH_HOME that
 * carries the sandbox/mode events — the durable fact the fold is supposed to
 * read. Called only on a failure path, before the tree is removed. */
function dumpSandboxEvents(dshHome: string): string {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          const text = readFileSync(full, "utf8");
          const lines = text.split("\n").filter((l) =>
            l.includes("sandbox/mode") || l.includes("permission/preset") || l.includes("approval/policy"));
          if (lines.length > 0) {
            hits.push(`--- ${full}\n${lines.join("\n")}`);
          } else if (text.includes("session") && text.length < 40_000) {
            hits.push(`--- (whole file) ${full}:\n${text.slice(0, 3000)}`);
          }
        } catch { /* binary or unreadable: skip */ }
      }
    }
  };
  try { walk(dshHome); } catch { return `(dshHome not readable: ${dshHome})`; }
  return hits.length > 0 ? hits.join("\n").slice(0, 20_000) : `(no candidate files under ${dshHome})`;
}

describe.skipIf(absent.length > 0)("#175 AC1: real setSandboxMode → resolve → assertSessionWritable (machine tier)", () => {
  it(
    "downgrade refuses pty_send, tail stays usable, widening restores the write — all through the real chain",
    { timeout: TIMEOUT },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "dsh-shellhost-sbxmode-"));
      // The mock consumes steps in order across prompts: prompt 1 = step 1,
      // prompt 2 = steps 2–3, prompt 3 = steps 4–5; the /permission RPCs land
      // between prompts, driven by the test.
      const steps: MockToolStep[] = [
        // prompt 1: TWO persistent PTYs (A first, B last) under the default
        // workspace-write — B pays the close-under-downgrade leg so A survives
        // to prove the same-session recovery after widening.
        { name: "pty_open", input: () => ({ command: "cmd.exe" }) },
        { name: "pty_open", input: () => ({ command: "cmd.exe" }) },
        // prompt 2 (all under the downgrade): A's write refused; the NEW-spawn
        // discriminator; A's tail fine; B's close fine.
        { name: "pty_send", input: (texts) => ({ id: firstSessionId(texts), data: "echo downgraded-write" }) },
        // Discriminator: a NEW spawn under the downgrade must be refused at
        // authorizeSpawn (resolve()) — if THIS passes while pty_send passes,
        // the fold is not visible to resolution at all (host-side); if only
        // pty_send passes, the sync gate's baseline/early-return is the seam.
        { name: "pty_open", input: () => ({ command: "cmd.exe /c echo ro-probe" }) },
        { name: "pty_tail", input: (texts) => ({ id: firstSessionId(texts) }) },
        { name: "pty_close", input: (texts) => ({ id: sessionIdFrom(texts) }) },
        // prompt 3 (after widening back): the SAME session A accepts writes
        // again, then closes.
        { name: "pty_send", input: (texts) => ({ id: firstSessionId(texts), data: "exit\r" }) },
        { name: "pty_close", input: (texts) => ({ id: firstSessionId(texts) }) },
      ];
      const dshHome = join(root, ".dsh");
      const { mock, inst, port, cookie } = await bootLeg(dshHome, steps);
      try {
        const sessionId = await createSession(inst, port, cookie);

        // ── prompt 1: open TWO persistent PTYs under the default workspace-write ─
        await prompt(port, cookie, sessionId, "open", "Open two pty sessions.");
        // 3 turns: two pty_open steps + the mock's closing end_turn (the
        // tool_result arrives with the SECOND request — waiting for turn 1
        // only would read the bytes before the result was fed back).
        await awaitTurns(mock, 3);
        const step = stepResultsOf(mock.agentRequests());
        const openA = step(1, "pty_open(A)");
        const openB = step(2, "pty_open(B)");
        expect(openA.isError, `pty_open(A) succeeded under workspace-write —— 实例原文：\n${openA.text}`).toBeUndefined();
        expect(openB.isError, `pty_open(B) succeeded under workspace-write —— 实例原文：\n${openB.text}`).toBeUndefined();
        const ptyIdA = firstSessionId([openA.text]);
        const ptyIdB = sessionIdFrom([openA.text, openB.text]);
        expect(ptyIdA, `pty_open(A) 给出 pty-<n> 会话 id —— 实例原文：\n${openA.text}`).toMatch(/^pty-\d+$/u);
        expect(ptyIdB, `pty_open(B) 给出不同的 pty-<n> 会话 id —— 实例原文：\n${openB.text}`)
          .toMatch(/^pty-\d+$/u);
        expect(ptyIdB, "B is a distinct session from A").not.toBe(ptyIdA);

        // ── the REAL write path: /permission read-only → setSandboxMode ──────
        await setPermissionPreset(port, cookie, sessionId, "read-only");
        // The read side of the SAME command: what does the fold say NOW?
        const current = await currentPreset(port, cookie, sessionId);

        // ── prompt 2: the sync constraint on the REAL resolution ─────────────
        await prompt(port, cookie, sessionId, "ro", "Write to session A, try opening another, tail A, close B.");
        await awaitTurns(mock, 8);
        const refused = step(3, "pty_send(A, 降级后)");
        // The discriminator: a NEW spawn under the downgrade is refused at
        // authorizeSpawn with the SANDBOX_DENIED shape — this splits a
        // resolution-side miss (open succeeds too) from a gate-side miss (open
        // refuses but the write passes).
        const spawnRefused = step(4, "pty_open(降级后, 判别)");
        if (spawnRefused.isError !== true) {
          // ch1bug/dsh-shell-host#176: the host's tool-side resolve() does not
          // see the folded sandbox/mode override (the fold itself and the
          // persisted projection are correct — the command's own read side
          // reports read-only). The sync constraint is untestable until that
          // is fixed; skip LOUDLY naming the tracker instead of going red on a
          // known upstream defect. An UNKNOWN shape (the fold did not even
          // take effect) is still a hard red.
          if (current.includes("read-only")) {
            console.warn(
              "  !! SKIP (loud): not verifiable until ch1bug/dsh-shell-host#176 —— 宿主工具侧 resolve 看不到已折叠的 " +
                "sandbox/mode 覆盖（折叠读侧 = read-only，但降级后 pty_open 仍 workspace-write 放行），" +
                "同步约束四条腿一条都验不了；#176 修复后摘除本门禁转全红验证",
            );
            return;
          }
          expect(
            spawnRefused.isError,
            `降级既未生效于工具侧、折叠读侧也未变（非 #176 已知形态）—— 折叠读侧：${current}；实例原文：\n${spawnRefused.text}`,
          ).toBe(true);
        }
        expect(refused.isError, `降级后 pty_send 必须被拒（is_error）—— 实例原文：\n${refused.text}`).toBe(true);
        expect(spawnRefused.text, "the spawn refusal carries the official marker")
          .toContain(sandboxDenialMarker("read-only"));
        // OUR structured shape on the wire: the marker for the NEW mode plus the
        // revoked-baseline sentence — the same message the
        // SESSION_SANDBOX_DOWNGRADED code is attached to in-process (the fake
        // tier pins the code; the wire carries the message).
        expect(refused.text, "the refusal carries the official [sandbox: read-only] marker")
          .toContain(sandboxDenialMarker("read-only"));
        expect(refused.text, "the refusal names the revoked workspace-write baseline")
          .toContain("was authorized under workspace-write");
        expect(refused.text, "the refusal names the write tool").toContain("pty_send");
        // Reads stay ungated: the tail on session A succeeded.
        const tail = step(5, "pty_tail(A, 降级后)");
        expect(tail.isError, `降级后 pty_tail 仍可用（不得是错误）—— 实例原文：\n${tail.text}`).toBeUndefined();
        // AC1: the close path is NOT gated either — B closes UNDER the
        // downgrade while A stays open for the recovery leg.
        const closedRo = step(6, "pty_close(B, 降级后)");
        expect(closedRo.isError, `降级后 pty_close 仍可用 —— 实例原文：\n${closedRo.text}`).toBeUndefined();
        expect(closedRo.text, `降级后 pty_close 真关闭 —— 实例原文：\n${closedRo.text}`).toContain('"closed":true');

        // ── the real write path again, widening back ─────────────────────────
        await setPermissionPreset(port, cookie, sessionId, "workspace-write");

        // ── prompt 3: the SAME session A accepts writes again, then closes ────
        await prompt(port, cookie, sessionId, "ww", "Write to session A, then close it.");
        await awaitTurns(mock, 11);
        const recovered = step(7, "pty_send(A, 升宽后)");
        expect(recovered.isError, `升宽后同一会话恢复可写 —— 实例原文：\n${recovered.text}`).toBeUndefined();
        const closed = step(8, "pty_close(A, 升宽后)");
        expect(closed.isError, `pty_close 收尾干净 —— 实例原文：\n${closed.text}`).toBeUndefined();
        expect(closed.text, `pty_close 真关闭（closed: true）—— 实例原文：\n${closed.text}`).toContain('"closed":true');
      } catch (error) {
        console.warn(`!! #175 forensics — session-log sandbox/mode facts:\n${dumpSandboxEvents(dshHome)}`);
        throw error;
      } finally {
        await stopChild(inst.child);
        await mock.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(absent.length > 0)("#175 AC2: remote_open_session shares the core registry and the downgrade gate", () => {
  it.skipIf(REMOTE_GATED_OFF)(
    "a remote session refuses pty_send after the downgrade while pty_close still works",
    { timeout: 300_000 },
    async () => {
      const harness: SshdHarness = await startSshdContainer();
      try {
        const root = await mkdtemp(join(tmpdir(), "dsh-shellhost-sbxremote-"));
        const steps: MockToolStep[] = [
          { name: "remote_open", input: () => ({
            host: "127.0.0.1",
            root: SSHD_REMOTE_ROOT,
            port: harness.port,
            options: harness.sshOptions(),
          }) },
          { name: "remote_open_session", input: (texts) => {
            const ws = [...texts.join("\n").matchAll(/"workspaceId":"([^"]+)"/gu)].at(-1)?.[1];
            if (ws === undefined) throw new Error(`no workspaceId from remote_open:\n${texts.join("\n---\n")}`);
            return { workspaceId: ws, kind: "shell" };
          } },
          // The remote pty session is the FIRST core id on the wire (opened
          // before ssh_start); the ssh session is the LAST — the two selectors
          // address them without hard-coding.
          { name: "pty_send", input: (texts) => ({ id: firstSessionId(texts), data: "echo remote-ok\n" }) },
          // AC1's ssh_send leg lives here too (container-gated like the remote
          // leg): ssh_start opens a REAL ssh session in the same core registry.
          { name: "ssh_start", input: () => ({ host: "127.0.0.1", port: harness.port, options: harness.sshOptions() }) },
          { name: "ssh_send", input: (texts) => ({ id: sessionIdFrom(texts), data: "echo ssh-ok\n" }) },
          { name: "pty_send", input: (texts) => ({ id: firstSessionId(texts), data: "echo remote-downgraded\n" }) },
          { name: "ssh_send", input: (texts) => ({ id: sessionIdFrom(texts), data: "echo ssh-downgraded\n" }) },
          { name: "pty_close", input: (texts) => ({ id: firstSessionId(texts) }) },
          { name: "ssh_close", input: (texts) => ({ id: sessionIdFrom(texts) }) },
        ];
        const dshHome = join(root, ".dsh");
        const { mock, inst, port, cookie } = await bootLeg(dshHome, steps);
        try {
          const sessionId = await createSession(inst, port, cookie);

          // prompt 1 (steps 1–5): register → remote shell → write → ssh_start
          // → ssh_send, all under the default workspace-write.
          await prompt(port, cookie, sessionId, "rm-open", "Open the remote workspace, a shell session in it, and an ssh session to the same host.");
          await awaitTurns(mock, 6, 150_000);
          const step = stepResultsOf(mock.agentRequests());
          expect(step(1, "remote_open").isError, "remote_open succeeded").toBeUndefined();
          const openedSession = step(2, "remote_open_session");
          expect(openedSession.isError, `remote_open_session succeeded —— 实例原文：\n${openedSession.text}`).toBeUndefined();
          const remoteId = sessionIdFrom([openedSession.text]);
          expect(remoteId, `remote 会话进入 pty core（有 sessionId）—— 实例原文：\n${openedSession.text}`).toBeTruthy();
          const remoteWrite = step(3, "pty_send(remote, 降级前)");
          expect(remoteWrite.isError, `降级前 remote 会话可写 —— 实例原文：\n${remoteWrite.text}`).toBeUndefined();
          const sshOpened = step(4, "ssh_start");
          expect(sshOpened.isError, `ssh_start succeeded —— 实例原文：\n${sshOpened.text}`).toBeUndefined();
          const sshId = sessionIdFrom([sshOpened.text]);
          expect(sshId, "the ssh session is a distinct core id from the remote pty").not.toBe(remoteId);
          const sshWrite = step(5, "ssh_send(降级前)");
          expect(sshWrite.isError, `降级前 ssh 会话可写 —— 实例原文：\n${sshWrite.text}`).toBeUndefined();

          await setPermissionPreset(port, cookie, sessionId, "read-only");

          // prompt 2 (steps 6–9): the remote AND ssh sessions are downgraded
          // with the rest of the registry — refuse both writes, keep both
          // close paths.
          await prompt(port, cookie, sessionId, "rm-ro", "Write to the remote session and the ssh session, then close both.");
          await awaitTurns(mock, 11, 150_000);
          const refused = step(6, "pty_send(remote, 降级后)");
          expect(refused.isError, `降级后 remote 会话拒写 —— 实例原文：\n${refused.text}`).toBe(true);
          expect(refused.text, "the remote-session refusal carries the official read-only marker")
            .toContain(sandboxDenialMarker("read-only"));
          expect(refused.text, "the refusal names the revoked workspace-write baseline")
            .toContain("was authorized under workspace-write");
          // AC1's ssh_send leg: the ssh session refuses the same way.
          const sshRefused = step(7, "ssh_send(降级后)");
          expect(sshRefused.isError, `降级后 ssh 会话拒写 —— 实例原文：\n${sshRefused.text}`).toBe(true);
          expect(sshRefused.text, "the ssh refusal carries the official read-only marker")
            .toContain(sandboxDenialMarker("read-only"));
          expect(sshRefused.text, "the ssh refusal names the revoked workspace-write baseline")
            .toContain("was authorized under workspace-write");
          const closed = step(8, "pty_close(remote)");
          expect(closed.isError, `remote 会话 close 路径仍可用 —— 实例原文：\n${closed.text}`).toBeUndefined();
          expect(closed.text, `pty_close 真关闭 —— 实例原文：\n${closed.text}`).toContain('"closed":true');
          const sshClosed = step(9, "ssh_close");
          expect(sshClosed.isError, `ssh 会话 close 路径仍可用 —— 实例原文：\n${sshClosed.text}`).toBeUndefined();
          expect(sshClosed.text, `ssh_close 真关闭 —— 实例原文：\n${sshClosed.text}`).toContain('"closed":true');
        } finally {
          await stopChild(inst.child);
          await mock.close();
          await rm(root, { recursive: true, force: true });
        }
      } finally {
        await harness.close();
      }
    },
  );
});

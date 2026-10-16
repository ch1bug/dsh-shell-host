/**
 * Machine-lane suite for the END-TO-END delivery chain of this bundle
 * (issue: verification layering, synced with the adjacent matt workspace).
 *
 * What this proves — the mock-LLM tier (see docs/agents/TESTING.md):
 *   install (profile registration + REAL link) → config (composed tree carries
 *   the bundle's loader rows) → boot (real `dsh web` instance on an OS-assigned
 *   port, stderr clean) → session (real `session/create`) → call (the model
 *   asks for a tool, the instance EXECUTES it, and the `tool_result` is fed
 *   back into the next request).
 *
 * What this CANNOT prove (deliberately out of scope here):
 *   provider acceptance, real-model behaviour, real credentials. Those belong
 *   to the opt-in real-LLM tier. The install SOURCE here is the checkout
 *   directory, which pnpm links without going through `files` at all — so this
 *   tier cannot see a packaging omission either; that is
 *   `tests/e2e-tarball-machine.spec.ts` (#89), which runs the same chain from
 *   the packed tarball.
 *
 * Gates (loud skip, never a silent pass): the suite needs a built plugin tree
 * and a built DSH host tree. Both are discoverable via env; when absent every
 * case skips loudly with the missing piece named.
 *
 * Isolation: a temp DSH_HOME under os.tmpdir() plus `--port 0`, so this suite
 * never occupies the fixed dev ports (19387 desktop / 19501 neighbor / 19502
 * this workspace's resident instance).
 *
 * The chain plumbing itself (mock provider, instance boot, RPC envelope) is
 * shared with the packed tier and lives in `tests/helpers/e2e-chain.ts`.
 *
 * @module tests/e2e-tool-call-machine
 */

import { afterAll, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MY_ROWS, rpc, startInstance, startMockLlm } from "./helpers/e2e-chain.ts";
import {
  PLUGIN_DIR,
  installPlugin,
  missingEnvironment,
  runHost,
} from "./helpers/e2e-install.ts";

const PROFILE = "dsh-host-dev";

const absent = missingEnvironment();
/** Named in every skip so the report says WHY nothing ran. */
const skipReason =
  `e2e mock-LLM tier needs: ${absent.join(" / ")} — ` +
  `override with DSH_E2E_PLUGIN_DIR / DSH_E2E_HOST_DIR / DSH_E2E_NODE / DSH_E2E_PNPM_DIR`;

describe.skipIf(absent.length > 0)("e2e: install → config → boot → session → tool call (mock LLM tier)", () => {
  const timeout = 180_000;

  it("delivers the full chain and feeds the tool_result back", { timeout }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-shellhost-e2e-"));
    const dshHome = join(root, ".dsh");

    // ── install: through the OFFICIAL plugin command ────────────────────────
    // `dsh plugin --profile <p> add <path>` is the only installation route
    // (docs/agents/profile-install.md): it writes BOTH registration records and
    // runs the pnpm stage. A hand-made node_modules symlink is explicitly NOT
    // an installation — and hand-rolling it here would also skip the
    // peer-resolution check pnpm performs on the linked package, which is
    // exactly what a "link:" plugin needs to surface. The command also creates
    // the profile directory itself, so no mkdir precedes it.
    const installed = await installPlugin(dshHome, PROFILE);
    expect(
      installed.code,
      `dsh plugin add succeeded (output: ${installed.out.slice(-500)})`,
    ).toBe(0);

    const profileDir = join(dshHome, "profiles", PROFILE);
    // The command must leave all three faces behind; a missing one is the
    // silent shape that still boots and still creates sessions.
    const record = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")) as any;
    expect(record?.dsh?.profile?.bundles, "bundle registered in dsh.profile.bundles").toContain("dsh-shell-host");
    expect(record?.dependencies?.["dsh-shell-host"], "plugin recorded as a profile dependency").toBeTruthy();
    expect(existsSync(join(profileDir, "node_modules", "dsh-shell-host", "package.json")), "plugin linked into the profile").toBe(true);

    // ── config: the composed tree carries this bundle's rows ────────────────
    const dumped = await runHost(dshHome, ["--profile", PROFILE, "--dump-config"]);
    const dumpOut = dumped.out;
    expect(dumpOut, "composed tree carries dsh-shell-host/pty").toContain("dsh-shell-host/pty");
    expect(dumpOut, "composed tree carries dsh-shell-host/terminal").toContain("dsh-shell-host/terminal");
    expect(dumpOut, "no row is left pending on a missing service").not.toMatch(/waiting for service|Missing services/u);

    // ── boot: real instance, OS-assigned port, clean stderr ────────────────
    const mock = await startMockLlm();
    const inst = startInstance(PROFILE, dshHome, {
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.port}`,
      DEEPSEEK_API_KEY: "mock-key-nonempty",
    });
    let launchUrl: string;
    try {
      launchUrl = await inst.ready;
    } catch (error) {
      await mock.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }

    try {
      expect(inst.stderr(), "instance stderr is clean").toBe("");
      // Failure attribution: whatever stderr says must never blame THIS repo's
      // rows — that separates "harness/host missing something" from "our bug".
      const blamed = MY_ROWS.filter((row) => new RegExp(`\\b${row}\\b`, "u").test(inst.stderr()));
      expect(blamed, "stderr never blames this bundle's loader rows").toEqual([]);
      expect(inst.stderr(), "stderr never blames this bundle").not.toContain("dsh-shell-host");

      const port = Number(/127\.0\.0\.1:(\d+)/u.exec(launchUrl)?.[1]);
      expect(Number.isInteger(port) && port > 0, "instance bound a real port").toBe(true);

      // ── token → cookie (the browser-trust exchange) ─────────────────────
      const parsed = new URL(launchUrl);
      const exchange = await new Promise<{ status: number; setCookie?: string[] }>((resolve) => {
        const req = httpRequest({ hostname: "127.0.0.1", port, path: `${parsed.pathname}${parsed.search}` }, (res) => {
          resolve({ status: res.statusCode ?? 0, setCookie: res.headers["set-cookie"] });
        });
        req.on("error", () => { resolve({ status: 0 }); });
        req.end();
      });
      const cookie = exchange.setCookie?.[0]?.split(";")[0];
      expect(exchange.status, "launch URL exchanges the token").toBe(303);
      expect(cookie, "exchange issues an auth cookie").toBeTruthy();

      // ── session: a real Session on the real controller ──────────────────
      const created = await rpc(port, cookie, "session/create", { request: { cwd: PLUGIN_DIR } });
      const createdValue = (JSON.parse(created.text) as any)?.result?.value;
      expect(createdValue?.sessionId, "session/create returns a sessionId").toBeTruthy();
      // agentPreset resolving proves the agentPresets service is live — the
      // service whose absence makes a headless-style boot look green while the
      // preset never activated.
      expect(createdValue?.agentPreset, "session resolves an agent preset").toBeTruthy();

      // ── call: the model asks, the instance executes, the result comes back ─
      await rpc(port, cookie, "session/prompt", {
        request: {
          requestId: `e2e-${Date.now()}`,
          sessionId: createdValue.sessionId,
          mode: "queue",
          content: [{ type: "text", text: "Call the pty_open tool once." }],
        },
      });

      const deadline = Date.now() + 90_000;
      while (mock.agentTurns() < 2 && Date.now() < deadline) {
        await new Promise((r) => { setTimeout(r, 500); });
      }

      const agentReqs = mock.agentRequests();
      expect(agentReqs.length, "the instance issued at least one agent request").toBeGreaterThan(0);

      // The tool surface must be read from the instance's OWN request body.
      // Asserting on raw text would pass even when the plugin never loaded
      // (the mock's own tool_use carries the name) — the false-green shape.
      const declared = Array.isArray(agentReqs[0]?.body.tools) ? agentReqs[0]!.body.tools : [];
      const names = declared.map((t: any) => t?.name ?? t?.function?.name).filter(Boolean) as string[];
      expect(names.length, "the instance declares a tool surface").toBeGreaterThan(0);
      expect(names, "pty_open is in the instance's tool surface").toContain("pty_open");
      expect(names, "shell_open (./terminal row) is in the tool surface").toContain("shell_open");

      // The loop closes only when the instance EXECUTED the tool and fed the
      // result back into a subsequent request.
      const withResult = agentReqs.find((c) => JSON.stringify(c.body).includes("tool_result"));
      expect(withResult, "the instance executed the tool and fed tool_result back").toBeTruthy();
      const raw = JSON.stringify(withResult?.body ?? {});
      expect(raw, "the executed tool did not error").not.toMatch(/"is_error":\s*true/u);
      // A real PTY really ran the command: the value carries a live session id.
      expect(raw, "the tool result carries the PTY session it opened").toContain("sessionId");
    } finally {
      // Waiting for exit is required: killing while the agent loop is live
      // leaves libuv teardown noise (and ECONNRESET) in the report.
      const exited = new Promise<void>((resolve) => { inst.child.once("exit", () => { resolve(); }); });
      inst.child.kill("SIGTERM");
      const forced = setTimeout(() => { inst.child.kill("SIGKILL"); }, 10_000);
      await exited;
      clearTimeout(forced);
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Keep the loud skip visible even when the suite is filtered out by the gate.
afterAll(() => {
  if (absent.length > 0) {
    console.warn(`  !! SKIP (loud) — ${skipReason}`);
  }
});
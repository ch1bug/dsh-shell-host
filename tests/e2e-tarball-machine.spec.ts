/**
 * Machine-lane suite for the PACKED delivery chain (#89): the install source is
 * the published artifact, not the checkout.
 *
 * Why this exists — the gap it closes: `tests/e2e-tool-call-machine.spec.ts`
 * installs the SOURCE DIRECTORY, and pnpm links a directory without going
 * through `files` at all. So a packaging omission (`files` dropping
 * `cordis.patch.yml`, a loader row, an entry module) never reaches the
 * "boot + agent turn" chain, and the release guard
 * (`scripts/verify-pack.mjs`, `node --run test:release`) only judges pointers
 * statically. Here the source is a tarball this suite packs on the spot, in
 * five rings, each with its own assertion so a failure names the ring:
 *
 *   1. pack    — a real packer produces the .tgz, and the ARTIFACT (not the
 *                working tree) carries `cordis.patch.yml`: the runtime version
 *                of #88's manifest-pointer guard
 *   2. install — `dsh plugin add <tarball>` leaves all three installation
 *                faces, and the registration record points at the .tgz itself
 *   3. config  — `--dump-config` composes both rows, nothing pending
 *   4. boot    — real instance on `--port 0`: stderr verbatim empty, and a
 *                failure never blames this bundle's rows
 *   5. session+turn — `session/create` → `prompt` → the mock asks for
 *                `pty_open` → the instance EXECUTES it → `tool_result` comes
 *                back without `is_error`
 *
 * Gates (loud skip with the missing piece named, never a silent pass): the env
 * gates shared with the other tiers (built plugin tree + built DSH host tree +
 * pnpm shim + node), plus this tier's two — the tree has its bundle patch file,
 * and a packer is reachable.
 *
 * Read the patch-file gate carefully, because the two halves differ on purpose:
 * the TREE having `cordis.patch.yml` is a skip condition (a tree without it
 * cannot compose the rows at all), while the TARBALL having it is ring 1's
 * FAILING assertion. Were both a skip condition, "the packer dropped the file"
 * would earn a skip instead of a red — the opposite of what this ticket wants.
 *
 * Isolation: temp `DSH_HOME`, pack destination, unpack dir and session cwd all
 * live under one `os.tmpdir()` root that the `finally` removes; the instance
 * binds `--port 0`, so no fixed dev port (19387 / 19501 / 19502) is touched.
 *
 * What this CANNOT prove (out of scope, deliberately): provider acceptance and
 * real-model behaviour (opt-in `tests/e2e-real-llm-machine.spec.ts`), and the
 * GUI ring (ADR-0013 removed the client face).
 *
 * @module tests/e2e-tarball-machine
 */

import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MY_ROWS, rpc, startInstance, startMockLlm } from "./helpers/e2e-chain.ts";
import {
  PLUGIN_DIR,
  installSpec,
  missingEnvironment,
  packTarball,
  runHost,
  tarballFiles,
} from "./helpers/e2e-install.ts";
import { findPacker } from "../scripts/verify-pack.mjs";

const PROFILE = "dsh-host-tarball";

/** The install-face contract file: the tree must have it (gate below), and the
 * packaged ARTIFACT must carry it (ring 1's assertion). */
const BUNDLE_PATCH = join(PLUGIN_DIR, "cordis.patch.yml");

const absent = missingEnvironment([
  existsSync(BUNDLE_PATCH) ? null : `bundle patch file ${BUNDLE_PATCH}`,
  findPacker() === null ? "a reachable packer (Node-bundled npm / PATH npm·pnpm) for packing" : null,
]);
/** Named in every skip so the report says WHY nothing ran. */
const skipReason =
  `e2e packed-delivery tier needs: ${absent.join(" / ")} — ` +
  `override with DSH_E2E_PLUGIN_DIR / DSH_E2E_HOST_DIR / DSH_E2E_NODE / DSH_E2E_PNPM_DIR`;

// Printed at COLLECTION time, and deliberately not from an `afterAll`: when the
// gate trips, every case in this file is skipped and vitest 4 never runs a
// file-scope `afterAll` hook (verified: a probe file carrying both prints only
// the collection-time one), so the reason would never reach the report.
// TESTING.md requires a skipped gate to say WHAT is missing — this is that.
// (`e2e-tool-call-machine` / `e2e-real-llm-machine` still carry the hook
// spelling, so their skip stays silent; that pre-existing gap is reported on
// #89 rather than folded into its diff.)
if (absent.length > 0) {
  console.warn(`  !! SKIP (loud) — ${skipReason}`);
}

describe.skipIf(absent.length > 0)("e2e: pack → install from tarball → config → boot → session → tool call", () => {
  const timeout = 240_000;

  it("delivers the full chain with the packed tarball as the install source", { timeout }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-shellhost-tarball-"));
    const dshHome = join(root, ".dsh");
    const packDir = join(root, "packed");
    await mkdir(packDir, { recursive: true });

    let instance: ReturnType<typeof startInstance> | undefined;
    let mock: Awaited<ReturnType<typeof startMockLlm>> | undefined;
    try {
      // ── ring 1: pack — the artifact, not the tree ─────────────────────────
      const tarball = packTarball(packDir);
      const packedFiles = tarballFiles(tarball, join(root, "unpacked"));
      // Non-vacuity anchor: without it, "the file is missing" and "unpacking
      // never happened" would be the same red.
      expect(packedFiles, "the unpacked artifact is a package tree").toContain("package.json");
      expect(
        packedFiles,
        "the packed artifact carries cordis.patch.yml (the working tree having it proves nothing)",
      ).toContain("cordis.patch.yml");

      // ── ring 2: install — through the OFFICIAL plugin command ─────────────
      // Same two-step install as the checkout tier (docs/agents/profile-install.md);
      // only the spec handed to `dsh plugin add` differs: a .tgz this suite packed.
      const installed = await installSpec(dshHome, PROFILE, tarball);
      expect(installed.code, `dsh plugin add <tarball> succeeded (output: ${installed.out.slice(-500)})`).toBe(0);

      const profileDir = join(dshHome, "profiles", PROFILE);
      // The command must leave all three faces behind; a missing one is the
      // silent shape that still boots and still creates sessions.
      const record = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")) as any;
      expect(record?.dsh?.profile?.bundles, "bundle registered in dsh.profile.bundles").toContain("dsh-shell-host");
      expect(record?.dependencies?.["dsh-shell-host"], "plugin recorded as a profile dependency").toBeTruthy();
      // THE POINT (#89): the recorded source is the tarball. A directory install
      // records a `link:` spec instead — and that is exactly the shape this
      // tier must never silently accept, since it would bypass `files`.
      expect(
        record?.dependencies?.["dsh-shell-host"],
        "the recorded install source is the packed tarball, not the checkout directory",
      ).toMatch(/\.tgz$/u);
      expect(existsSync(join(profileDir, "node_modules", "dsh-shell-host", "package.json")), "plugin linked into the profile").toBe(true);

      // ── ring 3: config — the composed tree carries this bundle's rows ─────
      const dumped = await runHost(dshHome, ["--profile", PROFILE, "--dump-config"]);
      const dumpOut = dumped.out;
      expect(dumpOut, "composed tree carries dsh-shell-host/pty").toContain("dsh-shell-host/pty");
      expect(dumpOut, "composed tree carries dsh-shell-host/terminal").toContain("dsh-shell-host/terminal");
      expect(dumpOut, "no row is left pending on a missing service").not.toMatch(/waiting for service|Missing services/u);

      // ── ring 4: boot — real instance, OS-assigned port, clean stderr ──────
      mock = await startMockLlm();
      instance = startInstance(PROFILE, dshHome, {
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.port}`,
        DEEPSEEK_API_KEY: "mock-key-nonempty",
      });
      const launchUrl = await instance.ready;

      // Failure attribution comes BEFORE the cleanliness check, on purpose:
      // when stderr is not empty, the first red must say whether it blames this
      // bundle's rows — that is what separates an environment gap from our own
      // bug (TESTING.md). Asserting emptiness first would abort on the bare
      // fact and never reach the attribution, making the two checks below
      // unreachable (a green that proves nothing extra).
      const blamed = MY_ROWS.filter((row) => new RegExp(`\\b${row}\\b`, "u").test(instance!.stderr()));
      expect(blamed, "stderr never blames this bundle's loader rows").toEqual([]);
      expect(instance.stderr(), "stderr never blames this bundle").not.toContain("dsh-shell-host");
      expect(instance.stderr(), "instance stderr is clean").toBe("");

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

      // ── ring 5: session + one agent turn ────────────────────────────────
      // The session cwd is the temp root, NOT the checkout: with the checkout as
      // cwd, Node's own self-reference could resolve `dsh-shell-host/*` from the
      // source tree and make a broken profile install look green.
      const created = await rpc(port, cookie, "session/create", { request: { cwd: root } });
      const createdValue = (JSON.parse(created.text) as any)?.result?.value;
      expect(createdValue?.sessionId, "session/create returns a sessionId").toBeTruthy();
      // agentPreset resolving proves the agentPresets service is live — the
      // service whose absence makes a headless-style boot look green while the
      // preset never activated.
      expect(createdValue?.agentPreset, "session resolves an agent preset").toBeTruthy();

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
      if (instance !== undefined) {
        const child = instance.child;
        const exited = new Promise<void>((resolve) => { child.once("exit", () => { resolve(); }); });
        child.kill("SIGTERM");
        const forced = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
        await exited;
        clearTimeout(forced);
      }
      await mock?.close();
      // One root holds the tarball, the unpack dir and the temp DSH_HOME, so a
      // failure in ANY ring still reclaims all three — the loud-skip leak of
      // #90 is not reproduced here.
      await rm(root, { recursive: true, force: true });
    }
  });
});
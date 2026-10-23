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
 * statically. Here the source is a tarball this suite packs on the spot.
 *
 * Rings (each one assertion group, named after the ticket's list):
 *
 *   1 pack    — a real packer produces the .tgz, and the ARTIFACT (not the
 *               working tree) carries `cordis.patch.yml`: the runtime version
 *               of #88's manifest-pointer guard
 *   2 install — `dsh plugin add <tarball>` leaves all three installation
 *               faces, and the registration record points at the .tgz itself
 *   3 config  — `--dump-config` composes both rows, nothing pending
 *   4 boot    — real instance on `--port 0`: stderr verbatim empty, and a
 *               failure never blames this bundle's rows
 *   5 session+turn — token → cookie → `session/create` → `prompt` → the mock
 *               asks for `pty_open` → the instance EXECUTES it → `tool_result`
 *               comes back without `is_error`
 *   Z cleanup — the instance stopped and the temp tree (tarball + unpack dir +
 *               temp DSH_HOME) is gone
 *
 * The ring table is deliberate, mirroring the sibling workspace's clean-env e2e
 * (#75 in dsh-matt-preset, the same ticket shape, whose review rejected
 * "silently missing line" as a defect): EVERY ring emits exactly one line —
 * `✓` pass, `✗` fail, `–` not reached — and the run reds ONCE at the end with
 * the whole table. A later ring that cannot run because an earlier one failed
 * says so; it never just disappears. `Z cleanup` is a ring for the same reason:
 * the isolation AC needs a reading, not only an action.
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
 * live under one `os.tmpdir()` root that the `Z` ring removes and verifies; the
 * instance binds `--port 0`, so no fixed dev port (19387 / 19501 / 19502) is
 * touched.
 *
 * What this CANNOT prove (out of scope, deliberately): provider acceptance and
 * real-model behaviour (opt-in `tests/e2e-real-llm-machine.spec.ts`), and the
 * GUI ring (ADR-0013 removed the client face).
 *
 * @module tests/e2e-tarball-machine
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MY_ROWS, exchangeToken, portOf, rpc, startInstance, startMockLlm, stopChild } from "./helpers/e2e-chain.ts";
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
// (The two older tiers carried the hook spelling and stayed silent on a tripped
// gate; that pre-existing gap is fixed in #98, which copied this spelling. Any
// future tier must print from here too.)
if (absent.length > 0) {
  console.warn(`  !! SKIP (loud) — ${skipReason}`);
}

describe.skipIf(absent.length > 0)("e2e: pack → install from tarball → config → boot → session → tool call", () => {
  const timeout = 240_000;

  it("delivers the full chain with the packed tarball as the install source", { timeout }, async () => {
    // ── ring table (see the header): one line per ring, red once at the end ──
    const results: string[] = [];
    const failures: string[] = [];
    /** vitest's AssertionError body is multi-line (expected/received); the table needs one line. */
    const oneLine = (error: unknown, max = 300): string => {
      const text = error instanceof Error ? error.message : String(error);
      return text.replace(/\s+/gu, " ").trim().slice(0, max);
    };
    const ok = (name: string, detail = ""): void => { results.push(`  ✓ ${name}${detail === "" ? "" : ` — ${detail}`}`); };
    const bad = (name: string, error: unknown): void => { results.push(`  ✗ ${name} — ${oneLine(error)}`); failures.push(name); };
    /** An earlier ring is red, so this one cannot run: said out loud, never a missing line. */
    const note = (line: string): void => { results.push(`  – ${line}`); };
    /** One ring = its own assertions. Exceptions are RECORDED, not thrown: throwing
     * would make every later ring silently absent, which is the defect this shape fixes. */
    const ring = async (name: string, body: () => string | Promise<string> | void): Promise<void> => {
      try { ok(name, (await body()) ?? ""); } catch (error) { bad(name, error); }
    };

    const root = await mkdtemp(join(tmpdir(), "dsh-shellhost-tarball-"));
    const dshHome = join(root, ".dsh");
    const packDir = join(root, "packed");
    await mkdir(packDir, { recursive: true });

    let instance: ReturnType<typeof startInstance> | undefined;
    let mock: Awaited<ReturnType<typeof startMockLlm>> | undefined;
    let port = 0;
    try {
      // ── ring 1: pack — the artifact, not the tree ─────────────────────────
      let tarball: string | undefined;
      await ring("1 pack: the artifact carries the install face", () => {
        tarball = packTarball(packDir);
        const packedFiles = tarballFiles(tarball, join(root, "unpacked"));
        // Non-vacuity anchor: without it, "the file is missing" and "unpacking
        // never happened" would be the same red.
        expect(packedFiles, "the unpacked artifact is a package tree").toContain("package.json");
        expect(
          packedFiles,
          "the packed artifact carries cordis.patch.yml (the working tree having it proves nothing)",
        ).toContain("cordis.patch.yml");
        return `${basename(tarball)} — ${String(packedFiles.length)} files unpacked`;
      });
      if (tarball === undefined) {
        note("2–5 not run: no tarball was produced (ring 1 red above)");
      } else {
        const packed = tarball;

        // ── ring 2: install — through the OFFICIAL plugin command ───────────
        // Same two-step install as the checkout tier (docs/agents/profile-install.md);
        // only the spec handed to `dsh plugin add` differs: a .tgz this suite packed.
        let installed = false;
        await ring("2 install: the tarball is the recorded source", async () => {
          const result = await installSpec(dshHome, PROFILE, packed);
          expect(result.code, `dsh plugin add <tarball> succeeded (output: ${result.out.slice(-500)})`).toBe(0);

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
          installed = true;
          return String(record?.dependencies?.["dsh-shell-host"]);
        });

        if (!installed) {
          note("3–5 not run: the install face is unproven (ring 2 red above)");
        } else {
          // ── ring 3: config — the composed tree carries this bundle's rows ──
          let configured = false;
          await ring("3 config: all five loader rows composed, nothing pending", async () => {
            const dumped = await runHost(dshHome, ["--profile", PROFILE, "--dump-config"]);
            const dumpOut = dumped.out;
            expect(dumpOut, "composed tree carries dsh-shell-host/pty").toContain("dsh-shell-host/pty");
            expect(dumpOut, "composed tree carries dsh-shell-host/ssh (#136)").toContain("dsh-shell-host/ssh");
            expect(dumpOut, "composed tree carries dsh-shell-host/terminal").toContain("dsh-shell-host/terminal");
            // #137: the remote workspace pair — `remote-fs` injects `remote`, so a
            // tree that carries only one of them would leave the other pending.
            expect(dumpOut, "composed tree carries dsh-shell-host/remote (#137)").toContain("dsh-shell-host/remote");
            expect(dumpOut, "composed tree carries dsh-shell-host/remote-fs (#137)").toContain("dsh-shell-host/remote-fs");
            expect(dumpOut, "no row is left pending on a missing service").not.toMatch(/waiting for service|Missing services/u);
            configured = true;
            return "dsh-shell-host/pty + ssh + terminal + remote + remote-fs";
          });

          let launchUrl: string | undefined;
          if (!configured) {
            note("4–5 not run: the composed tree is wrong (ring 3 red above)");
          } else {
            // ── ring 4: boot — real instance, OS-assigned port, clean stderr ─
            await ring("4 boot: real instance on --port 0, stderr clean", async () => {
              mock = await startMockLlm();
              instance = startInstance(PROFILE, dshHome, {
                DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.port}`,
                DEEPSEEK_API_KEY: "mock-key-nonempty",
              });
              launchUrl = await instance.ready;

              // Failure attribution comes BEFORE the cleanliness check, on purpose:
              // when stderr is not empty, the first red must say whether it blames
              // this bundle's rows — that is what separates an environment gap from
              // our own bug (TESTING.md). Asserting emptiness first would abort on
              // the bare fact and never reach the attribution.
              const blamed = MY_ROWS.filter((row) => new RegExp(`\\b${row}\\b`, "u").test(instance!.stderr()));
              expect(blamed, "stderr never blames this bundle's loader rows").toEqual([]);
              expect(instance.stderr(), "stderr never blames this bundle").not.toContain("dsh-shell-host");
              expect(instance.stderr(), "instance stderr is clean").toBe("");

              port = portOf(launchUrl);
              expect(Number.isInteger(port) && port > 0, "instance bound a real port").toBe(true);
              return launchUrl;
            });

            if (launchUrl === undefined) {
              note("5 not run: the instance never came up (ring 4 red above)");
            } else {
              const url = launchUrl;

              // ── ring 5: session + one agent turn ──────────────────────────
              await ring("5 session+turn: the tool loop closes on the instance's own bytes", async () => {
                const llm = mock;
                if (llm === undefined) throw new Error("no mock provider (ring 4 red above)");

                // token → cookie (the browser-trust exchange)
                const exchanged = await exchangeToken(url);
                expect(exchanged.status, "launch URL exchanges the token").toBe(303);
                const cookie = exchanged.cookie;
                expect(cookie, "exchange issues an auth cookie").toBeTruthy();

                // The session cwd is the temp root, NOT the checkout: with the
                // checkout as cwd, Node's own self-reference could resolve
                // `dsh-shell-host/*` from the source tree and make a broken profile
                // install look green.
                const created = await rpc(port, cookie, "session/create", { cwd: root });
                const createdValue = (JSON.parse(created.text) as any)?.result?.value;
                expect(createdValue?.sessionId, "session/create returns a sessionId").toBeTruthy();
                // agentPreset resolving proves the agentPresets service is live —
                // the service whose absence makes a headless-style boot look green
                // while the preset never activated.
                expect(createdValue?.agentPreset, "session resolves an agent preset").toBeTruthy();

                await rpc(port, cookie, "session/prompt", {
                  requestId: `e2e-${Date.now()}`,
                  sessionId: createdValue.sessionId,
                  mode: "queue",
                  content: [{ type: "text", text: "Call the pty_open tool once." }],
                });

                const deadline = Date.now() + 90_000;
                while (llm.agentTurns() < 2 && Date.now() < deadline) {
                  await new Promise((r) => { setTimeout(r, 500); });
                }

                const agentReqs = llm.agentRequests();
                expect(agentReqs.length, "the instance issued at least one agent request").toBeGreaterThan(0);

                // The tool surface must be read from the instance's OWN request body.
                // Asserting on raw text would pass even when the plugin never loaded
                // (the mock's own tool_use carries the name) — the false-green shape.
                const declared = Array.isArray(agentReqs[0]?.body.tools) ? agentReqs[0]!.body.tools : [];
                const names = declared.map((t: any) => t?.name ?? t?.function?.name).filter(Boolean) as string[];
                expect(names.length, "the instance declares a tool surface").toBeGreaterThan(0);
                expect(names, "pty_open is in the instance's tool surface").toContain("pty_open");
                expect(names, "shell_open (./terminal row) is in the tool surface").toContain("shell_open");
                // #136: the ssh family is its own row — the split must not have
                // dropped it from the packed bundle's surface.
                expect(names, "ssh_start (./ssh row) is in the tool surface").toContain("ssh_start");
                // #137: the remote workspace pair registers its tools in the packed
                // artifact too (a `files` omission would silently drop them).
                expect(names, "remote_open (./remote row) is in the tool surface").toContain("remote_open");
                expect(names, "remote_ls (./remote-fs row) is in the tool surface").toContain("remote_ls");

                // The loop closes only when the instance EXECUTED the tool and fed
                // the result back into a subsequent request.
                const withResult = agentReqs.find((c) => JSON.stringify(c.body).includes("tool_result"));
                expect(withResult, "the instance executed the tool and fed tool_result back").toBeTruthy();
                const raw = JSON.stringify(withResult?.body ?? {});
                expect(raw, "the executed tool did not error").not.toMatch(/"is_error":\s*true/u);
                // A real PTY really ran the command: the value carries a live session id.
                expect(raw, "the tool result carries the PTY session it opened").toContain("sessionId");
                return `${String(names.length)} tools declared, ${String(agentReqs.length)} agent requests`;
              });
            }
          }
        }
      }
    } finally {
      // Stop the instance before touching the tree (killing while the agent loop
      // is live leaves libuv teardown noise and ECONNRESET in the report), and
      // report whether it actually stopped: a hung child is a reading, not a hang.
      if (instance === undefined) {
        note("Z cleanup: no instance was started");
      } else if (await stopChild(instance.child)) {
        ok("Z cleanup: instance stopped", "SIGTERM → exit");
      } else {
        bad("Z cleanup: instance stopped", "ignored SIGTERM and SIGKILL within the budget");
      }
      try {
        await mock?.close();
      } catch (error) {
        bad("Z cleanup: mock provider closed", error);
      }
    }

    // ── Z ring: cleanup is one of the ACs, so it needs a reading ─────────────
    // One root holds the tarball, the unpack dir and the temp DSH_HOME, so a
    // failure in ANY ring still reclaims all three (the loud-skip leak of #90 is
    // not reproduced here) — and it is verified, not assumed.
    try {
      await rm(root, { recursive: true, force: true });
      if (existsSync(root)) bad("Z cleanup: temp tree removed", `still present: ${root}`);
      else ok("Z cleanup: temp tree removed", root);
    } catch (error) {
      bad("Z cleanup: temp tree removed", error);
    }

    // One red at the end, carrying the whole table: locatable to the ring, and
    // no ring is ever a missing line.
    console.log(`\n=== packed-delivery rings (pack → install → config → boot → turn → cleanup) ===\n${results.join("\n")}`);
    expect(failures, `packed-delivery e2e: ${String(failures.length)} ring(s) red — full table:\n${results.join("\n")}`).toEqual([]);
  });
});
/**
 * Shared plumbing for the delivery-chain e2e tiers
 * (`e2e-tool-call-machine`, `e2e-real-llm-machine`, `e2e-tarball-machine`).
 *
 * The install step goes through the OFFICIAL plugin command —
 * `dsh plugin --profile <p> add <path>` — never a hand-made node_modules
 * symlink. `docs/agents/profile-install.md` states the rule: a symlink dropped
 * into `<profile>/node_modules` by hand is NOT an installation. Hand-rolling it
 * also skips the pnpm stage and the `.plugin-manager/logs/` diagnostics, and it
 * bypasses the peer-resolution check pnpm performs on the linked package.
 *
 * The packed tier (#89) additionally needs the two ends of the ARTIFACT:
 * `packTarball()` produces the tarball through the SAME packer lookup the
 * release guard uses (`scripts/verify-pack.mjs`), and `tarballFiles()` reads
 * back what that tarball really carries — both live here so no spec grows its
 * own packer table.
 *
 * @module tests/helpers/e2e-install
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { findPacker, untarGz } from "../../scripts/verify-pack.mjs";

/** Windows node runs the host plus the native pieces (B1 posture); msys2 node
 * cannot load the rolldown/node-pty bindings. Overridable for other layouts. */
export const NODE = process.env.DSH_E2E_NODE ?? "C:/Program Files/nodejs/node.exe";
/** The plugin checkout under test (must be built: lib/*.js present). */
export const PLUGIN_DIR = process.env.DSH_E2E_PLUGIN_DIR ?? "C:/msys64/home/<user>/dsh-shellhost-src";
/** The DSH host source checkout providing apps/cli/src/bin.ts. */
export const HOST_DIR = process.env.DSH_E2E_HOST_DIR ?? "C:/msys64/home/<user>/dsh-host-src";
/** Directory holding the `pnpm` shim: `dsh plugin` shells out to pnpm, so the
 * command fails outright ("'pnpm' is not recognized") without it on PATH. */
export const PNPM_BIN_DIR = process.env.DSH_E2E_PNPM_DIR ?? "C:/msys64/home/<user>/.corepack/bin";

const HOST_BIN = "apps/cli/src/bin.ts";

/** Environment for every host CLI invocation in these suites. */
export function hostEnv(dshHome: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "Path";
  const existing = process.env[pathKey] ?? "";
  return {
    ...process.env,
    [pathKey]: `${PNPM_BIN_DIR};${existing}`,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    ...extra,
  };
}

/** Run a host CLI subcommand to completion, capturing combined output. */
export function runHost(dshHome: string, args: string[], extra: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(NODE, ["--import", "tsx/esm", HOST_BIN, ...args], {
      cwd: HOST_DIR,
      env: hostEnv(dshHome, extra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { out += c.toString(); });
    child.once("error", (error) => { resolve({ code: null, out: `${out}\n${String(error)}` }); });
    child.once("exit", (code) => { resolve({ code, out }); });
  });
}

/**
 * Install an explicit package spec into an isolated profile through the OFFICIAL
 * commands, in the order the CLI expects:
 *
 *   1. `--from-default-profile web` seeds the profile from the shipped web
 *      template. This is NOT optional: it is what writes `cordis.yml` /
 *      `pnpm-workspace.yaml` and the base entry list. `dsh plugin add` alone
 *      leaves the profile without them, and a later `dsh web` boot then produces
 *      NO output at all (observed: 120s timeout, empty stdout and stderr).
 *   2. `plugin --profile <p> add <spec>` registers the bundle and runs pnpm.
 *
 * The spec is whatever pnpm accepts (and the host parses): a source directory
 * for the checkout tier, a `.tgz` path for the packed tier (#89) — the ONLY
 * difference between those two chains, so it is a parameter here rather than a
 * second install routine.
 *
 * Returns the install result so a caller can assert on the failure text.
 */
export async function installSpec(
  dshHome: string,
  profile: string,
  spec: string,
): Promise<{ code: number | null; out: string }> {
  const seeded = await runHost(dshHome, ["--profile", profile, "--from-default-profile", "web", "--dump-config"]);
  if (seeded.code !== 0) return { code: seeded.code, out: `--from-default-profile failed:\n${seeded.out}` };
  return runHost(dshHome, ["plugin", "--profile", profile, "add", spec]);
}

/** Install the plugin checkout itself (directory source) — the source-directory tier. */
export function installPlugin(
  dshHome: string,
  profile: string,
  pluginDir: string = PLUGIN_DIR,
): Promise<{ code: number | null; out: string }> {
  return installSpec(dshHome, profile, pluginDir);
}

/**
 * Pack the plugin tree with a shim-free packer and return the tarball path.
 *
 * Same lookup as the release guard (`findPacker` in `scripts/verify-pack.mjs`):
 * the bundled DSH node ships no npm, so the candidates fall back to the
 * conventional Windows node install and then to PATH npm/pnpm. `--silent`
 * makes npm print just the filename (its last stdout line) — the same contract
 * `scripts/verify-pack.mjs` reads, so both callers share one interpretation.
 *
 * @param destination Existing directory to write the .tgz into.
 * @param pluginDir Tree to pack; defaults to the checkout under test.
 * @throws when no packer is reachable or it produced no file: a tier that
 * cannot pack must say so loudly, never continue against a missing artifact.
 */
export function packTarball(destination: string, pluginDir: string = PLUGIN_DIR): string {
  const packer = findPacker();
  if (packer === null) {
    throw new Error(
      "packTarball: no reachable packer (Node-bundled npm / PATH npm·pnpm) — this tier needs a real `npm pack`",
    );
  }
  const args = ["pack", "--pack-destination", destination, "--silent"];
  // `shell: true` only for the PATH-resolved npm/pnpm shims (`.cmd` files);
  // the npm-cli candidate is a JS file and needs the node executable.
  const out = packer.kind === "npm-cli"
    ? execFileSync(process.execPath, [packer.path, ...args], { cwd: pluginDir, encoding: "utf8" })
    : execFileSync(packer.path, args, { cwd: pluginDir, encoding: "utf8", shell: true });
  const name = out.trim().split("\n").pop()?.trim() ?? "";
  const tarball = join(destination, name);
  if (!existsSync(tarball)) {
    throw new Error(`packTarball: packer printed ${JSON.stringify(name)} but wrote no tarball (output: ${out.slice(-400)})`);
  }
  return tarball;
}

/**
 * The package-root-relative file list a tarball really carries, read by
 * unpacking it (the `untarGz` reader the release guard already unit-tests, not
 * a second tar parser and not the packer's own `--json` dialect).
 *
 * This is the artifact-side answer to "did `files` actually ship it": the
 * working tree can hold a file that never made it into the tarball, and a
 * directory install would not notice (issue #89).
 *
 * @param tarball .tgz produced by `packTarball`.
 * @param scratchDir Directory to unpack into; reused (wiped) on each call.
 */
export function tarballFiles(tarball: string, scratchDir: string): string[] {
  rmSync(scratchDir, { recursive: true, force: true });
  untarGz(readFileSync(tarball), scratchDir);
  // npm tarballs carry everything under `package/`. Without that prefix the walk
  // would describe the destination's own root instead of the artifact, so an
  // unexpected layout returns an empty list — and the caller's non-vacuity
  // anchor (`package.json` must be listed) turns that into a failure.
  const root = join(scratchDir, "package");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    // Directory entries come along for the ride with a recursive walk; the
    // contract here is the FILES the tarball carries.
    .filter((entry) => !statSync(join(root, entry)).isDirectory())
    .sort();
}

/** A gate that cannot be satisfied must skip LOUDLY, naming what is missing. */
export function missingEnvironment(extra: (string | null)[] = []): string[] {
  return [
    !existsSync(PLUGIN_DIR) ? `plugin tree ${PLUGIN_DIR}` : null,
    !existsSync(`${PLUGIN_DIR}/lib/pty/index.js`) ? `built artifact ${PLUGIN_DIR}/lib/pty/index.js` : null,
    !existsSync(`${HOST_DIR}/${HOST_BIN}`) ? `DSH host tree ${HOST_DIR}` : null,
    !existsSync(NODE) ? `node executable ${NODE}` : null,
    !existsSync(PNPM_BIN_DIR) ? `pnpm shim dir ${PNPM_BIN_DIR} (dsh plugin shells out to pnpm)` : null,
    ...extra,
  ].filter((v): v is string => v !== null);
}
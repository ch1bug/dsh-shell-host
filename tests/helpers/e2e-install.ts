/**
 * Shared plumbing for the two delivery-chain e2e tiers
 * (`e2e-tool-call-machine`, `e2e-real-llm-machine`).
 *
 * The install step goes through the OFFICIAL plugin command —
 * `dsh plugin --profile <p> add <path>` — never a hand-made node_modules
 * symlink. `docs/agents/profile-install.md` states the rule: a symlink dropped
 * into `<profile>/node_modules` by hand is NOT an installation. Hand-rolling it
 * also skips the pnpm stage and the `.plugin-manager/logs/` diagnostics, and it
 * bypasses the peer-resolution check pnpm performs on the linked package.
 *
 * @module tests/helpers/e2e-install
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

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
 * Install the plugin under test into an isolated profile through the OFFICIAL
 * commands, in the order the CLI expects:
 *
 *   1. `--from-default-profile web` seeds the profile from the shipped web
 *      template. This is NOT optional: it is what writes `cordis.yml` /
 *      `pnpm-workspace.yaml` and the base entry list. `dsh plugin add` alone
 *      leaves the profile without them, and a later `dsh web` boot then produces
 *      NO output at all (observed: 120s timeout, empty stdout and stderr).
 *   2. `plugin --profile <p> add <path>` registers the bundle and runs pnpm.
 *
 * Returns the install result so a caller can assert on the failure text.
 */
export async function installPlugin(
  dshHome: string,
  profile: string,
  pluginDir: string = PLUGIN_DIR,
): Promise<{ code: number | null; out: string }> {
  const seeded = await runHost(dshHome, ["--profile", profile, "--from-default-profile", "web", "--dump-config"]);
  if (seeded.code !== 0) return { code: seeded.code, out: `--from-default-profile failed:\n${seeded.out}` };
  return runHost(dshHome, ["plugin", "--profile", profile, "add", pluginDir]);
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
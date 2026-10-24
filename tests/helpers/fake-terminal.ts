/**
 * Shared boot for the `./terminal` entry suites (#156): the pty entry rides
 * bootPlugin's shared fake ctx (hand-rolled `ctx = {…}` lives in ONE place,
 * tests/helpers/fake-pty.ts) and the terminal entry is mounted on THAT SAME
 * context afterwards. Deliberately a THIN WRAPPER, not a bootPlugin flag —
 * folding terminal in there would grow the pty boot into a super-boot that
 * mounts every entry (#156 ruling: terminal converges SEPARATELY from pty).
 * @module tests/helpers/fake-terminal
 */

import { join } from "node:path";
import { apply as applyTerminal } from "../../src/terminal/index.ts";
import type { CustomLauncherConfig, LauncherDeps } from "../../src/launchers.ts";
import { bootPlugin, echoFakePty, type FakePtyHandle } from "./fake-pty.ts";
import type { CoreSpawnSpec } from "../../src/pty/session-core.ts";

const MSYS_BASH = "C:\\msys64\\usr\\bin\\bash.exe";
export const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

function existsEverything(candidate: string): boolean {
  const known = [MSYS_BASH, PWSH, join("C:\\Windows", "System32", "cmd.exe")];
  return known.some((k) => k.toLowerCase() === candidate.toLowerCase());
}

export const FULL_ENV = { SystemRoot: "C:\\Windows", Path: "C:\\Windows\\System32" } as NodeJS.ProcessEnv;
/** The every-launcher-present probe environment (the #55 unit posture): the
 * three built-in executables all report a hit, so every built-in preset
 * resolves without touching the real machine. */
export const fullDeps: LauncherDeps = { exists: existsEverything, env: FULL_ENV, path: FULL_ENV.Path, listDistros: () => [] };

export interface TerminalBoot {
  tool: (name: string) => any;
  spawnSpecs: CoreSpawnSpec[];
  handles: FakePtyHandle[];
  /** The pty entry's facade — `active(owner)` is the registry-derived
   * liveness view (#62: the cap/idle fact source). */
  core: { active(owner: unknown): string[] };
  /** The boot context — a remount test re-applies the terminal entry on it
   * to prove the cap count survives (#62). */
  ctx: any;
  registered: any[];
  provided: Map<string, unknown>;
}

/**
 * Boot the pty AND terminal entries on one self-managed core.
 *
 *  - `deps` omitted ⇒ the terminal entry's DEFAULT launcher deps (the real
 *    `resolveLaunchers` probing — the machine lane's production shape);
 *  - `opts.fakeSpawn` ⇒ the pty entry gets the in-process echo fake
 *    (`spawnPty: echoFakePty`, direct pass-through since #156's signature
 *    alignment); omitted ⇒ the REAL node-pty spawner.
 *
 * `config` is the terminal entry's settings namespace, `deps` the launcher
 * probe seam ( LauncherDeps). */
export function bootTerminal(
  config: { custom?: CustomLauncherConfig[]; maxSessions?: number } = {},
  deps?: LauncherDeps,
  opts: { fakeSpawn?: boolean } = {},
): TerminalBoot {
  const boot = bootPlugin(opts.fakeSpawn === true ? { spawnPty: echoFakePty } : {});
  applyTerminal(boot.ctx, config, deps);
  return {
    tool: boot.tool,
    spawnSpecs: boot.specs,
    handles: boot.handles,
    core: boot.core,
    ctx: boot.ctx,
    registered: boot.registered,
    provided: boot.provided,
  };
}

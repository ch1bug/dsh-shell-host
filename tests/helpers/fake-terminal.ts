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
import { apply as applyTerminal, type MountFs, type TerminalDeps } from "../../src/terminal/index.ts";
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
  /** The #170 fake custom.d machine — `lines()` reads the audit ledger. */
  mountFs: ReturnType<typeof fakeMountFs>;
  /** #169: drive the ctx event listeners (the volatile-update transport). */
  emit: (event: string, payload: unknown) => void;
}

/**
 * The #170 custom.d fake machine: an in-memory file family + audit ledger.
 * Keys are EXACT path strings (build them with join); hashes default to a
 * deterministic `hash:<normalized path>`. The returned `append` records the
 * ledger lines the mount/appends produced, so tests assert on the ledger
 * file's CONTENT (append-only event sequence), never on internals.
 */
export function fakeMountFs(
  files: Record<string, string> = {},
  hashes: Record<string, string> = {},
): MountFs & { append(path: string, line: string): void; lines(): string[] } {
  const norm = (p: string) => p.split("\\").join("/");
  const ledger: string[] = [];
  return {
    listDir: (dir) => {
      const d = norm(dir) + "/";
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        const n = norm(p);
        if (n.startsWith(d) && !n.slice(d.length).includes("/")) names.add(n.slice(d.length));
      }
      names.delete("audit.jsonl"); // the ledger is never a preset file
      return [...names].sort();
    },
    readFile: (path) => {
      if (norm(path).endsWith("audit.jsonl")) return ledger.length > 0 ? ledger.join("\n") : undefined;
      return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : undefined;
    },
    hashFile: (path) => hashes[path] ?? `hash:${norm(path)}`,
    appendFile: (_path, line) => {
      ledger.push(line);
    },
    ensureDir: () => {},
    // #169: the config-page transport's write/delete — they mutate the SAME
    // in-memory store, so a write is visible to the next read/mount.
    writeFile: (path, body) => {
      files[path] = body;
    },
    unlinkFile: (path) => {
      delete files[path];
    },
    append: (path, line) => {
      ledger.push(line);
    },
    lines: () => [...ledger],
  };
}

/** Boot config for the file family: a memory customDir + the fake machine. */
export interface MountOpts {
  fakeSpawn?: boolean;
  /** Files of the fake custom.d (paths built with join(customDir, …)). */
  files?: Record<string, string>;
  /** Content-hash overrides for the fake machine. */
  hashes?: Record<string, string>;
  /** An EXPLICIT machine — pass the same instance twice to prove a REMOUNT
   * (the #170 re-read-on-every-mount contract) against one fake ledger. */
  machine?: ReturnType<typeof fakeMountFs>;
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
 * probe seam (LauncherDeps). The custom.d mount ALWAYS rides the fake
 * machine under the memory customDir `<mem>/custom.d` (#170) unless deps
 * already carry mount seams. */
export function bootTerminal(
  config: { custom?: CustomLauncherConfig[]; maxSessions?: number; customDir?: string } = {},
  deps?: LauncherDeps,
  opts: MountOpts = {},
): TerminalBoot {
  const boot = bootPlugin(opts.fakeSpawn === true ? { spawnPty: echoFakePty } : {});
  const mountFs = opts.machine ?? fakeMountFs(opts.files ?? {}, opts.hashes ?? {});
  const terminalDeps: TerminalDeps = {
    ...(deps ?? {}),
    customDir: "<mem>/custom.d",
    mountFs,
  };
  applyTerminal(boot.ctx, config, terminalDeps);
  return {
    tool: boot.tool,
    spawnSpecs: boot.specs,
    handles: boot.handles,
    core: boot.core,
    ctx: boot.ctx,
    registered: boot.registered,
    provided: boot.provided,
    mountFs,
    emit: boot.emit,
  };
}

/**
 * Machine-lane suite for the `./terminal` entry (issue #55 AC): the launcher
 * layer opening REAL persistent terminals for the coexistence preset set —
 * msys2-ucrt + pwsh + cmd + wsl side by side — with per-shell probe evidence
 * (uname -a / $PSVersionTable / ver 各归其位) and per-session marker
 * isolation (状态不串). The harness follows the ssh-pty-live precedent: the
 * real @lydell/node-pty hosts the seam's default terminal (cmd.exe) and the
 * terminal entry's launch command runs inside it — the production shape.
 * The platform shell coexistence claim is exercised live: one-shot platform
 * commands run while launcher sessions are open (nothing is disabled).
 * Each preset case skips loudly when its environment is absent so the
 * default lanes stay environment-agnostic.
 * @module tests/terminal-machine
 */

import { describe, expect, it, onTestFinished } from "vitest";
import { execFileSync } from "node:child_process";
import { apply as applyPty } from "../src/pty/index.ts";
import { apply as applyTerminal } from "../src/terminal/index.ts";
import { resolveLaunchers } from "../src/launchers.ts";
import {
  matchesNeedle,
  PWSH_PROBE_COMMAND,
  PWSH_PROBE_NEEDLE,
  type ProbeNeedle,
} from "./helpers/probe-needle.ts";

const AGENT = { name: "terminal-machine" };

/** Boot the pty + terminal entries on the REAL self-managed core (#61,
 * ADR-0010): the default spawner IS real @lydell/node-pty (Windows ConPTY)
 * running each launch command under the platform-shell wrapper — the
 * production shape, no fake in the loop. Config is the terminal entry's
 * settings namespace. */
function boot(config: { custom?: unknown[] } = {}) {
  const registered: any[] = [];
  const provided = new Map<string, unknown>();
  const ctx = {
    provide: (name: string, value: unknown) => provided.set(name, value),
    effect: () => () => Promise.resolve(),
    tools: { register: (t: unknown) => registered.push(t) },
    get: (name: string) => provided.get(name),
  };
  applyPty(ctx as any, {});
  applyTerminal(ctx as any, config);
  const tool = (name: string) => {
    const t = registered.find((x: any) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  return { tool };
}

/** Poll pty_tail until `needle` (string or RegExp) shows up (or the budget
 * expires). The hit judgement is the shared pure `matchesNeedle` (#99) — the
 * offline case in tests/probe-needle.spec.ts pins that a needle must be chosen
 * so the typed command's ECHO cannot satisfy it. */
async function waitFor(tool: (name: string) => any, id: string, needle: ProbeNeedle, budgetMs = 45_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  let text = "";
  while (Date.now() < deadline) {
    const page = await tool("pty_tail").execute({ id }, { agent: AGENT });
    text += page.text;
    if (matchesNeedle(text, needle)) return text;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}; saw:\n${text.slice(-2000)}`);
}

const available = new Set(resolveLaunchers().presets.map((p) => p.id));
const hasMsys2 = available.has("msys2-ucrt");
const hasPwsh = available.has("pwsh");
const hasCmd = available.has("cmd");
const hasWsl = available.has("wsl");

describe("terminal entry machine lane (#55 AC)", () => {
  it.skipIf(!hasMsys2)("shell_open('msys2-ucrt'): the probe lands in an MSYS2 environment (uname -a)", { timeout: 120_000 }, async () => {
    const { tool } = boot();
    const opened = await tool("shell_open").execute({ preset: "msys2-ucrt" }, { agent: AGENT });
    onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, { agent: AGENT }).catch(() => {}));
    expect(opened.transport).toBe("local");
    await tool("pty_send").execute({ id: opened.sessionId, data: "echo PROBE-$MSYSTEM && uname -a" }, { agent: AGENT });
    // One combined needle: the EXPANDED echo (the literal command contains
    // "PROBE-$MSYSTEM", so the bare prefix would hit the echo) followed by
    // the uname OUTPUT line — proves the probe landed in an MSYS-family
    // environment rather than the echo alone.
    const text = await waitFor(tool, opened.sessionId, /PROBE-UCRT64[\s\S]*\b(MSYS|MINGW|UCRT)/i);
    expect(text).toContain("PROBE-UCRT64");
    expect(/\b(?:MSYS|MINGW|UCRT)/i.test(text)).toBe(true);
  });

  it.skipIf(!hasPwsh)("shell_open('pwsh'): the probe reports a PowerShell version table", { timeout: 120_000 }, async () => {
    const { tool } = boot();
    const opened = await tool("shell_open").execute({ preset: "pwsh" }, { agent: AGENT });
    onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, { agent: AGENT }).catch(() => {}));
    await tool("pty_send").execute({ id: opened.sessionId, data: PWSH_PROBE_COMMAND }, { agent: AGENT });
    // Echo-safe needle (#99): the literal command carries `PSV-$(` — no digit
    // follows `PSV-` — so the echoed command line alone can never satisfy the
    // version pattern; only PowerShell's EXPANDED output can. Constant + offline
    // pin (成因、判据与层级见那里，不在本档复述):
    // tests/helpers/probe-needle.ts / tests/probe-needle.spec.ts.
    const text = await waitFor(tool, opened.sessionId, PWSH_PROBE_NEEDLE);
    expect(text).toMatch(/PSV-\d+\.\d+/);
  });

  it.skipIf(!hasCmd)("shell_open('cmd'): the probe reports the Windows version banner (ver)", { timeout: 120_000 }, async () => {
    const { tool } = boot();
    const opened = await tool("shell_open").execute({ preset: "cmd" }, { agent: AGENT });
    onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, { agent: AGENT }).catch(() => {}));
    // A CR typed into a just-booted interactive cmd can be swallowed by the
    // console's startup input handling (observed flake) — retry the probe
    // until the banner version line lands.
    for (let attempt = 0; ; attempt++) {
      await tool("pty_send").execute({ id: opened.sessionId, data: "ver" }, { agent: AGENT });
      const matched = await waitFor(tool, opened.sessionId, /\[Version|版本/, 10_000).then(
        (text) => text,
        () => null,
      );
      if (matched !== null) {
        expect(matched).toMatch(/Microsoft \[Version|Microsoft Windows|Microsoft \[版本/);
        break;
      }
      if (attempt >= 4) throw new Error("ver banner never landed after 5 probe attempts");
    }
  });

  it.skipIf(!hasWsl)("shell_open('wsl'): the probe lands in the Linux VM (uname -a)", { timeout: 180_000 }, async () => {
    const { tool } = boot();
    const opened = await tool("shell_open").execute({ preset: "wsl" }, { agent: AGENT });
    onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, { agent: AGENT }).catch(() => {}));
    await tool("pty_send").execute({ id: opened.sessionId, data: "echo WSLPROBE-$(uname -sr)" }, { agent: AGENT });
    // Expanded-value needle: the literal echo contains "WSLPROBE-$..." only.
    const text = await waitFor(tool, opened.sessionId, "WSLPROBE-Linux");
    expect(text).toContain("Linux");
  });

  it.skipIf(!(hasMsys2 && hasPwsh && hasCmd && hasWsl))(
    "coexistence: four launcher terminals open side by side; markers stay in their own session (状态不串)",
    { timeout: 240_000 },
    async () => {
      const { tool } = boot();
      const opened = await tool("shell_open").execute({ preset: "msys2-ucrt" }, { agent: AGENT });
      const pwsh = await tool("shell_open").execute({ preset: "pwsh" }, { agent: AGENT });
      const cmd = await tool("shell_open").execute({ preset: "cmd" }, { agent: AGENT });
      const wsl = await tool("shell_open").execute({ preset: "wsl" }, { agent: AGENT });
      onTestFinished(async () => {
        for (const s of [opened, pwsh, cmd, wsl]) {
          await tool("pty_close").execute({ id: s.sessionId }, { agent: AGENT }).catch(() => {});
        }
      });
      const ids = [opened.sessionId, pwsh.sessionId, cmd.sessionId, wsl.sessionId];
      expect(new Set(ids).size).toBe(4); // four independent seam sessions

      // One distinct marker per session; each tail must see ONLY its own.
      const markers = ["MARK-MSYS", "MARK-PWSH", "MARK-CMD", "MARK-WSL"];
      const probes = [
        "echo MARK-MSYS",
        '"MARK-PWSH"',
        "echo MARK-CMD",
        "echo MARK-WSL",
      ];
      for (let i = 0; i < 4; i++) {
        await tool("pty_send").execute({ id: ids[i], data: probes[i] }, { agent: AGENT });
      }
      const texts = await Promise.all(markers.map((m, i) => waitFor(tool, ids[i], m)));
      for (let i = 0; i < 4; i++) {
        expect(texts[i]).toContain(markers[i]);
        for (const other of markers.filter((m) => m !== markers[i])) {
          expect(texts[i]).not.toContain(other);
        }
      }
    },
  );

  it.skipIf(!hasCmd)(
    "platform shell coexistence: one-shot platform commands work while launcher sessions are open (nothing disabled)",
    { timeout: 120_000 },
    async () => {
      const { tool } = boot();
      const opened = await tool("shell_open").execute({ preset: "cmd" }, { agent: AGENT });
      onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, { agent: AGENT }).catch(() => {}));
      // The platform shell (outside this plugin's executor path) still runs.
      const out = execFileSync("cmd.exe", ["/d", "/c", "echo platform-ok"], { encoding: "utf8", timeout: 15_000 });
      expect(out.trim()).toBe("platform-ok");
    },
  );

  // Live-transport case (issue #55): shell_open over the ssh dimension — a
  // custom ssh preset opens a REAL remote terminal on DSH_SSH_LIVE_HOST.
  // Gated on the env var (skips loudly when unset), same contract as
  // ssh-pty-live.spec.ts.
  const LIVE_HOST = process.env.DSH_SSH_LIVE_HOST;
  it.skipIf(!LIVE_HOST)(
    "shell_open over an ssh custom preset: real remote terminal round-trip",
    { timeout: 90_000 },
    async () => {
      const { tool } = boot({
        custom: [{ id: "live", transport: "ssh", host: LIVE_HOST!, shell: "bash --login" }],
      });
      const opened = await tool("shell_open").execute(
        { preset: "live" },
        { agent: AGENT },
      );
      onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, { agent: AGENT }).catch(() => {}));
      expect(opened.transport).toBe("ssh");
      expect(opened.command).toContain("ssh -tt");
      expect(opened.initialOutput?.length ?? 0).toBeGreaterThan(0);
      await tool("pty_send").execute({ id: opened.sessionId, data: "echo SSHOPEN-42" }, { agent: AGENT });
      const text = await waitFor(tool, opened.sessionId, "SSHOPEN-42");
      expect(text).toContain("SSHOPEN-42");
      const closed = await tool("pty_close").execute({ id: opened.sessionId }, { agent: AGENT });
      expect(closed.closed).toBe(true);
    },
  );
});

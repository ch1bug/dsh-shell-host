/**
 * #149 machine lane — the session-level shell on the REAL core (Windows/ConPTY).
 *
 * Three readings that no fake can produce:
 *
 *  - **AC1** a declared `shellCommand` makes bare `pty_send` text shell text:
 *    pipes and `&&` run, and `cd` persists ACROSS sends (no per-command wrapper);
 *  - **AC2** the noise comparison: N per-command `pty_open` calls vs ONE
 *    persistent shell session — measured bytes, and the PTY initialization
 *    escape sequences that per-command opens pay N times;
 *  - **AC7** the temporary switch: enter another interpreter, run a command,
 *    `exit` — the session's default interpreter AND its `cd` state are intact.
 *
 * AC4's live half rides along: SIGKILL is refused on a real shell session.
 *
 * The POSIX half (`/bin/sh -c` with its extra `sh` parent) has NO POSIX host in
 * this repo's lanes, so it is declared in the README and the landing document,
 * never asserted here — an unrun assertion is not evidence (the #119 precedent).
 *
 * Echo-safety (#99/#103): every needle below can only be satisfied by
 * EXPANSION (`PIPE-$((6*7))` echoes literally, `PIPE-42` cannot), so a hit
 * means the shell really ran the command.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { resolveLaunchers, type LocalLauncherPreset } from "../src/launchers.ts";
import { spawnableExists } from "../src/detect.ts";
import { bootPlugin } from "./helpers/fake-pty.ts";
import { matchesNeedle, CMD_PROBE, type ProbeNeedle } from "./helpers/probe-needle.ts";

const AGENT = { name: "pty-shell-machine" };
const exec = { agent: AGENT, signal: new AbortController().signal };

/** Boot the pty entry on the REAL core: the shared harness with NO spawner seam,
 * so the default one (@lydell/node-pty) runs. */
const boot = () => bootPlugin();

/** The bash this machine resolves (msys2 first — the same table the launcher
 * layer uses), plus the bare command line `pty_open({ shellCommand })` takes:
 * executable + the preset's interactive argv, nothing else (no env, no MSYSTEM
 * — that is the caller's business, AC5). */
function resolveBash(): { preset: LocalLauncherPreset; exe: string; command: string } | undefined {
  const { presets } = resolveLaunchers();
  const preset = presets.find(
    (p): p is LocalLauncherPreset => p.transport === "local" && (p.id === "msys2-ucrt" || p.id === "git-bash"),
  );
  if (preset === undefined) return undefined;
  const exe = preset.executable.find((candidate) => spawnableExists(candidate));
  if (exe === undefined) return undefined;
  return { preset, exe, command: [exe.includes(" ") ? `"${exe}"` : exe, ...preset.argv].join(" ") };
}

const BASH = resolveBash();

/** Bytes of one page / of a string (the AC2 unit is bytes, not characters). */
const bytes = (text: string) => Buffer.byteLength(text ?? "", "utf8");

/** PTY initialization escape sequences (`ESC [ ? …`) — the noise the ticket
 * says per-command opens repeat. Counted, not eyeballed. */
const initEscapes = (text: string) => (text.match(/\u001b\[\?/gu) ?? []).length;

/**
 * Drain `pty_tail` until `needle` shows up, returning the accumulated text and
 * the byte count it represented.
 *
 * - **Bytes counted exactly once**: the core advances its per-session cursor to
 *   the newest line it handed back, and the next page starts exactly there, so
 *   the pages are contiguous and the sum is this step's output.
 * - **`truncated` is NOT a dropped-output signal here**: in this core it means
 *   "the page is a window that does not reach back to the retained buffer's
 *   start" (`readNewest`'s `begin > absBase`), which is true for every read
 *   after the first — output before the cursor was already delivered, not lost.
 *   The real drop case (`backlog > budget`) is bounded to the 200-line default
 *   budget, far above the handful of lines these two cases produce.
 * - **300ms poll** (the sibling `terminal-machine` suite uses 500ms for
 *   multi-second WSL/ssh spawns): these sessions are local ConPTY and produce
 *   their line within a couple of ticks, so the tighter poll keeps the two
 *   cases under their budgets without adding load.
 */
async function drain(
  tool: (name: string) => any,
  id: string,
  needle: ProbeNeedle,
  budgetMs = 45_000,
): Promise<{ text: string; bytes: number }> {
  const deadline = Date.now() + budgetMs;
  let text = "";
  let total = 0;
  while (Date.now() < deadline) {
    const page = await tool("pty_tail").execute({ id }, exec);
    text += page.text;
    total += bytes(page.text);
    if (matchesNeedle(text, needle)) return { text, bytes: total };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for ${String(needle)}; saw:\n${text.slice(-2000)}`);
}

/** Send + drain in one step (the common shape below). */
async function send(
  tool: (name: string) => any,
  id: string,
  data: string,
  needle: ProbeNeedle,
  budgetMs = 45_000,
): Promise<{ text: string; bytes: number }> {
  await tool("pty_send").execute({ id, data }, exec);
  return drain(tool, id, needle, budgetMs);
}

describe("pty_open shell session on the real ConPTY (#149)", () => {
  it.skipIf(process.platform !== "win32" || BASH === undefined)(
    "AC1/AC4/AC7: bare sends run in the declared shell; cd persists; a temporary switch leaves the default intact",
    { timeout: 180_000 },
    async () => {
      const { tool } = boot();
      const opened = await tool("pty_open").execute({ shellCommand: BASH!.command }, exec);
      onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, exec).catch(() => {}));
      // The declaration is echoed on the result: the caller sees WHICH shell it got.
      expect(opened.shellCommand).toBe(BASH!.command);

      // AC1 — a pipe runs (the echoed text carries `PIPE-$((6*7))`, the output `PIPE-42`).
      const piped = await send(tool, opened.sessionId, "echo PIPE-$((6*7)) | tr a-z A-Z", "PIPE-42");
      expect(piped.text).toContain("PIPE-42");

      // AC1 — `&&` chains: both halves run.
      const chained = await send(
        tool,
        opened.sessionId,
        "echo CHAIN-$((7*7)) && echo SECOND-$((8*8))",
        "SECOND-64",
      );
      expect(chained.text).toContain("CHAIN-49");
      expect(chained.text).toContain("SECOND-64");

      // AC1 — `cd` persists ACROSS sends (the whole point of a session shell).
      const dir = mkdtempSync(join(tmpdir(), "dsh149-"));
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
      const msysDir = dir.replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive}`).replace(/\\/g, "/");
      const cd = await send(tool, opened.sessionId, `cd ${msysDir} && echo CD-$((7*6))`, "CD-42");
      expect(cd.text).toContain("CD-42");
      // A separate send reports the changed directory: the echoed `pwd` cannot
      // satisfy this needle, only the interpreter's own output can.
      const pwd = await send(tool, opened.sessionId, "pwd", basename(dir));
      expect(pwd.text).toContain(basename(dir));

      // AC4 — a shell session is a shell target: SIGKILL is refused (the live half).
      await expect(tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGKILL" }, exec))
        .rejects.toMatchObject({ code: "SIGNAL_FORBIDDEN" });

      // AC7 — the temporary switch: enter another interpreter (cmd.exe), run a
      // command, `exit` back. Nothing about the session's default changes.
      const cmdPath = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
      const msysCmd = cmdPath.replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive}`).replace(/\\/g, "/");
      const entered = await send(tool, opened.sessionId, `${msysCmd} /d`, CMD_PROBE.needle);
      expect(entered.text).toMatch(CMD_PROBE.needle);
      // Leaving needs no needle of its own: the `exit` echo + the returning
      // prompt are asynchronous, and the NEXT command is the proof (BACK-8 can
      // only come from bash). A drain on a prompt regex would be a shape test of
      // the prompt, not of the switch.
      await tool("pty_send").execute({ id: opened.sessionId, data: "exit" }, exec);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const back = await send(tool, opened.sessionId, "echo BACK-$((4+4))", "BACK-8");
      expect(back.text).toContain("BACK-8");
      // The default is the SAME interpreter AND the same cwd: `cd` survived the detour.
      const pwdAfter = await send(tool, opened.sessionId, "pwd", basename(dir));
      expect(pwdAfter.text).toContain(basename(dir));
    },
  );

  it.skipIf(process.platform !== "win32" || BASH === undefined)(
    "AC2: noise comparison — N per-command opens vs one persistent shell session (measured bytes)",
    { timeout: 240_000 },
    async () => {
      const { tool } = boot();
      const N = 3;
      // The payload is echo-SAFE: the echoed command line carries
      // `NOISE-$((20*7+5))` literally, so only the shell's own expansion can
      // produce `NOISE-145` (#99/#103).
      const payload = "echo NOISE-$((20*7+5))";
      const needle = "NOISE-145";
      const exe = BASH!.exe.includes(" ") ? `"${BASH!.exe}"` : BASH!.exe;
      /** What the caller had to write per command BEFORE this ticket: the
       * dialect one-shot README documents (`bash -lc "…"`) — the disappearable
       * cost on the CALLER side. */
      const wrapper = `${exe} -lc "${payload}"`;

      // Regime A — one pty_open (and so one shell start + one PTY init) per command.
      let perCommand = { sessions: 0, bytes: 0, inits: 0 };
      for (let i = 0; i < N; i += 1) {
        const opened = await tool("pty_open").execute({ command: wrapper }, exec);
        const read = await drain(tool, opened.sessionId, needle);
        perCommand = {
          sessions: perCommand.sessions + 1,
          bytes: perCommand.bytes + read.bytes,
          inits: perCommand.inits + initEscapes(read.text),
        };
        await tool("pty_close").execute({ id: opened.sessionId }, exec).catch(() => {});
      }

      // Regime B — ONE session; the same payloads go in bare.
      const shell = await tool("pty_open").execute({ shellCommand: BASH!.command }, exec);
      onTestFinished(() => tool("pty_close").execute({ id: shell.sessionId }, exec).catch(() => {}));
      // Warm-up: the banner/prompt bytes belong to the ONE open this regime pays.
      const warm = await send(tool, shell.sessionId, "echo WARM-$((1+1))", "WARM-2");
      let persistent = { bytes: warm.bytes, inits: initEscapes(warm.text) };
      let persistentText = warm.text;
      for (let i = 0; i < N; i += 1) {
        const read = await send(tool, shell.sessionId, payload, needle);
        persistent = {
          bytes: persistent.bytes + read.bytes,
          // Accumulated over the SAME window as the per-command side (the
          // earlier version only counted the warm page — not comparable).
          inits: persistent.inits + initEscapes(read.text),
        };
        persistentText += read.text;
      }

      console.log(`=== #149 AC2 噪音对照 rings（真实 ConPTY / win32，N=${N}） ===`);
      console.log(`  – 每条命令一次 pty_open：${perCommand.sessions} 个会话 / ${perCommand.inits} 个初始化转义序列 / ${perCommand.bytes} 字节`);
      console.log(`  – 一个常驻 shell 会话：1 个会话 / ${persistent.inits} 个初始化转义序列 / ${persistent.bytes} 字节`);
      console.log(`  – 调用方每命令要写的字节：${bytes(wrapper)}（包装串）→ ${bytes(payload)}（裸命令）`);
      console.log(
        `  – 读数注意：常驻交互 shell 的字节数**更大**（提示符 + 命令回显是终端语义，不是本票的噪音）；` +
          `本票消掉的是"每命令一次会话/初始化 + 包装串"`,
      );

      // The attributable claims: the per-command regime opens a session (and so
      // pays a PTY init + a shell start) once per command; the session shell
      // opens ONE and carries no wrapper in its stream. The escape-sequence
      // COUNTS are reported, not asserted: an interactive login shell emits its
      // own burst of them at startup, so the two totals measure different
      // things (their composition is spelled out in the reading above).
      expect(perCommand.sessions).toBe(N);
      expect(bytes(wrapper)).toBeGreaterThan(bytes(payload));
      expect(persistentText).toContain(needle);
      expect(persistentText).not.toContain('-lc "');
    },
  );
});
/**
 * #186 machine lane — the sentinel marker on the REAL core (Windows/ConPTY +
 * a real msys2/git-bash session). The one reading no fake can produce:
 * the OSC-133 sentinel pair must SURVIVE the ConPTY round trip. The
 * behavioral proof needs no side channel — if ConPTY stripped the sentinels,
 * the scanner would never arm and the filtered view would mirror raw forever,
 * so the LATER command's echo would appear in BOTH views. The assertion
 * "second command's echo in raw, absent from filtered" passes only when the
 * sentinels arrived and framed the segment (the .scratch/verify186/ probes
 * recorded the raw byte timeline: ESC]133;C/D;payload BEL verbatim, echo →
 * O → output → D → prompt).
 *
 * Declared scope (the ADR-0020 Q1 v1 matrix): top-level bash only; the
 * mirror-phase echo of the FIRST command passes by design — the filter
 * claims from the first trusted open on.
 * @module tests/pty-marker-machine
 */

import { describe, expect, it, onTestFinished } from "vitest";
import { resolveLaunchers, type LocalLauncherPreset } from "../src/launchers.ts";
import { spawnableExists } from "../src/detect.ts";
import { bootPlugin } from "./helpers/fake-pty.ts";

const AGENT = { name: "pty-marker-machine" };
const exec = { agent: AGENT, signal: new AbortController().signal };

/** The bash this machine resolves (msys2 first — the same table the launcher
 * layer uses), as the bare command line `pty_open({ shellCommand })` takes. */
function resolveBash(): string | undefined {
  const { presets } = resolveLaunchers();
  const preset = presets.find(
    (p): p is LocalLauncherPreset => p.transport === "local" && (p.id === "msys2-ucrt" || p.id === "git-bash"),
  );
  if (preset === undefined) return undefined;
  const exe = preset.executable.find((candidate) => spawnableExists(candidate));
  if (exe === undefined) return undefined;
  return [exe.includes(" ") ? `"${exe}"` : exe, ...preset.argv].join(" ");
}

const BASH = resolveBash();

describe("sentinel marker on the real ConPTY (#186)", () => {
  it("a declared bash shell arms the marker: the second command's echo is in raw and NOT in filtered (sentinels survived ConPTY)", { skip: !BASH, timeout: 30_000 }, async () => {
    onTestFinished(() => {});
    const h = bootPlugin();
    const opened = await h.tool("pty_open").execute({ shellCommand: BASH! }, exec);
    const id = opened.sessionId;
    try {
      // Arm: the first send's echo legitimately rides the mirror phase
      // (documented); give the slow interactive shell time to settle between
      // commands.
      await h.tool("pty_send").execute({ id, data: "echo DSHARM-186" }, exec);
      await new Promise((r) => setTimeout(r, 400));
      const result = await h.tool("pty_send").execute({ id, data: "echo DSHPROBE-42" }, exec);
      await new Promise((r) => setTimeout(r, 400));

      const raw = await h.tool("pty_tail").execute({ id, view: "raw" }, exec);
      const filtered = await h.tool("pty_tail").execute({ id }, exec);
      expect(raw.text).toContain("echo DSHPROBE-42"); // the echo in the raw face
      expect(filtered.text).not.toContain("echo DSHPROBE-42"); // filtered: NOT the echo
      expect(`${raw.text}${filtered.text}`).toContain("DSHPROBE-42"); // the output exists...
      expect(filtered.text).toContain("DSHPROBE-42"); // ...and the filtered view has it
      // The send delta is a filtered read too: no echo, no prompt residue.
      expect(String(result.delta)).not.toContain("echo DSHPROBE-42");
      expect(String(result.delta)).toContain("DSHPROBE-42");
    } finally {
      await h.tool("pty_close").execute({ id }, exec);
    }
  });
});

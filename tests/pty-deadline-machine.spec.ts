/**
 * #162 machine lane — the deadline output cut on the REAL core (Windows/ConPTY):
 *
 * The #159 deadline kill leaves the killed shell one last execution window
 * (the tree teardown takes the direct child first; the shell runs one more
 * command before its own exit event surfaces). The core now CUTS the one-shot
 * result's output at the kill-sequence start (#162), so that residue —
 * deterministic on this host (the issue's repro hit 2/2) — never reaches a
 * `timeout: true` result.
 *
 * Why a separate machine file (#119/#146/#149 precedent): the leak needs a
 * REAL ConPTY tree teardown and a REAL shell that outlives its child for a
 * beat; a fake spawner can only prove the wiring (that is pty-deadline.spec's
 * job). Serial like its peers.
 */

import { describe, expect, it } from "vitest";
import { bootPlugin } from "./helpers/fake-pty.ts";

const AGENT = { name: "pty-deadline-machine" };
const exec = { agent: AGENT, signal: new AbortController().signal };

/** The issue's deterministic repro shape: print, block past the deadline,
 * then print the leak marker — the killed shell's last execution window. */
const REPRO = `node -e "console.log('T0'); setTimeout(() => { console.log('T1_LEAK'); }, 60000)"`;

describe("deadline output cut on the real ConPTY (#162)", () => {
  it(
    "a timeout result carries the pre-deadline output but never the post-kill leak",
    { timeout: 120_000 },
    async () => {
      const { tool } = bootPlugin();
      const opened = (await tool("pty_open").execute(
        { command: REPRO, autoClose: true, deadlineMs: 3_000 },
        exec,
      )) as any;
      // The deadline fired and the marker rides the result (#159, unchanged).
      expect(opened.timeout).toBe(true);
      // The command's own pre-deadline output IS in the result.
      expect(opened.initialOutput).toContain("T0");
      // The post-kill residue is NOT — cut at the kill-sequence start (#162),
      // independent of whether this host's shell actually won the race.
      expect(opened.initialOutput).not.toContain("T1_LEAK");
      // The exit code is the real teardown code, never a fabricated success.
      expect(opened.status.kind).toBe("exited");
      expect(opened.status.exitCode).not.toBe(0);
    },
  );
});

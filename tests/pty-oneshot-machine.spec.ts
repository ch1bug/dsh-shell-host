/**
 * #146 machine lane — one-shot as an exec面 on the REAL core (Windows/ConPTY):
 *
 *  - **AC1** `autoClose: true` waits for the process to actually exit and the
 *    result carries the REAL exit code — two readings: a fast success (0) and a
 *    deliberate non-zero (3);
 *  - **AC3/AC4** a command whose argv[0] cannot be spawned fails with a
 *    READABLE diagnostic: the name it tried, plus the direct-spawn hint. The
 *    synthetic case is `echo`; this machine case uses a shell BUILT-IN (`cd`)
 *    because that is the exact shape an agent writes by mistake — and unlike
 *    `echo`, no `cd.exe` exists on a Windows PATH (MSYS2 ships `echo.exe`), so
 *    the reading cannot silently become a successful spawn on another host.
 *
 * Why a separate machine file (#119/#149 precedent — the machineLane is an
 * explicit per-suite list, and both of those tickets added their own real-process
 * suite to it): the real ConPTY spawn is
 * serial (see `vitest.config.ts` machineLane) and the unit lane must stay
 * hermetic. Every assertion below needs a real `CreateProcess` / a real ConPTY
 * exit event; a fake spawner can only prove the wiring (that is pty-core's job).
 */

import { describe, expect, it } from "vitest";
import { SPAWN_FAILURE_HINT } from "../src/pty/session-core.ts";
import { bootPlugin } from "./helpers/fake-pty.ts";

const AGENT = { name: "pty-oneshot-machine" };
const exec = { agent: AGENT, signal: new AbortController().signal };

/** Boot the pty entry on the REAL core (no spawner seam). */
const boot = () => bootPlugin();

describe("one-shot exit code on the real ConPTY (#146 AC1/AC4)", () => {
  it(
    "a fast one-shot returns exited with the real exit code 0 and its output (#146 AC1)",
    { timeout: 120_000 },
    async () => {
      const { tool } = boot();
      const opened = await tool("pty_open").execute(
        { command: `node -e "console.log('one-shot-ok')"`, autoClose: true },
        exec,
      );
      // The status is the EXITED form — not the old `{ kind: "running" }` that
      // made the exit code unreachable after the auto-reclaim.
      expect(opened.status).toEqual({ kind: "exited", exitCode: 0 });
      expect(opened.initialOutput).toContain("one-shot-ok");
    },
  );

  it(
    "a non-zero one-shot carries the real code through the status (#146 AC1)",
    { timeout: 120_000 },
    async () => {
      const { tool } = boot();
      const opened = await tool("pty_open").execute(
        { command: `node -e "process.exit(3)"`, autoClose: true },
        exec,
      );
      expect(opened.status).toEqual({ kind: "exited", exitCode: 3 });
    },
  );
});

describe("readable spawn diagnostic on the real ConPTY (#146 AC3/AC4)", () => {
  it.skipIf(process.platform !== "win32")(
    "a shell built-in names argv[0] and the explicit-shell hint instead of a bare `File not found`",
    { timeout: 120_000 },
    async () => {
      const { tool } = boot();
      // `cd` is a cmd built-in with no cd.exe on a normal Windows PATH: the
      // direct spawn fails in CreateProcess, which is exactly the agent trap
      // this ticket closes (write `echo hi && echo bye`, get `File not found: `).
      const failure = await tool("pty_open")
        .execute({ command: "cd /d C:\\Windows" }, exec)
        .then(
          (value: unknown) => ({ kind: "resolved", value }),
          (error: unknown) => ({ kind: "rejected", error }),
        );
      expect(failure.kind, "a built-in cannot be spawned directly — the call must fail loudly").toBe("rejected");
      const message = failure.kind === "rejected" && failure.error instanceof Error
        ? failure.error.message
        : String(failure.kind === "rejected" ? failure.error : failure.value);
      // It names the program it tried...
      expect(message).toContain(`could not start "cd"`);
      // ...and teaches the fix with the SAME authored hint the unit lane pins
      // to the tool description's spellings (no second copy here).
      expect(message).toContain(SPAWN_FAILURE_HINT);
    },
  );
});
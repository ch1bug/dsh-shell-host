/**
 * Machine-lane suite for `pty_signal` (#119): the REAL self-managed core on
 * Windows/ConPTY, where the platform semantics are not a design choice —
 * node-pty's own contract is `kill(signal)` **throws** on Windows
 * (`lib/windowsTerminal.js`: "Signals not supported on windows."), so the only
 * reachable semantic is a plain `kill()` = TERMINATION. This suite pins that
 * reading live: SIGINT is refused loudly and leaves the session running,
 * SIGTERM terminates it and the status flips to exited.
 *
 * The POSIX half (real process-group delivery through `process.kill(-pid…)`)
 * has NO POSIX host in this repo's lanes, so it is deliberately NOT asserted
 * live here — an unrun assertion is not evidence. It is implemented behind the
 * injected `procKill` seam and unit-covered for both branches
 * (`tests/pty-core.spec.ts`); the honest boundary is recorded in
 * `.scratch/119-landing.md` §7.
 * @module tests/pty-signal-machine
 */

import { describe, expect, it, onTestFinished } from "vitest";
import { apply } from "../src/pty/index.ts";
import { waitUntil } from "./helpers/wait-until.ts";

const AGENT = { name: "pty-signal-machine" };

/** Boot the pty entry on the REAL core (default spawner = @lydell/node-pty). */
function boot() {
  const registered: any[] = [];
  const provided = new Map<string, unknown>();
  const ctx = {
    provide: (name: string, value: unknown) => provided.set(name, value),
    effect: () => () => Promise.resolve(),
    tools: { register: (t: unknown) => registered.push(t) },
  };
  apply(ctx as any, {});
  const tool = (name: string) => {
    const t = registered.find((x: any) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  return { tool };
}

/** A long-running real child: node keeps the event loop alive, produces no
 * output — so the session stays "running" until something kills it. */
const LONG_RUNNING = 'node -e "setInterval(() => {}, 1000)"';

describe("pty_signal machine lane (#119, Windows/ConPTY)", () => {
  it.skipIf(process.platform !== "win32")(
    "SIGINT is refused loudly (no silent mapping); SIGTERM terminates the real session",
    { timeout: 60_000 },
    async () => {
      const { tool } = boot();
      const opened = await tool("pty_open").execute({ command: LONG_RUNNING }, { agent: AGENT });
      onTestFinished(() => tool("pty_close").execute({ id: opened.sessionId }, { agent: AGENT }).catch(() => {}));
      const status = async () => (await tool("pty_list").execute({}, { agent: AGENT })).sessions[0]?.status;
      expect(await status()).toEqual({ kind: "running" });

      // A signal ConPTY cannot deliver: loud, and the session is untouched.
      await expect(tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGINT" }, { agent: AGENT }))
        .rejects.toMatchObject({ code: "SIGNAL_UNSUPPORTED" });
      expect(await status()).toEqual({ kind: "running" });

      // The one reachable semantic: terminate.
      expect(await tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGTERM" }, { agent: AGENT }))
        .toMatchObject({ delivered: true, semantics: "terminate" });
      // The real exit event lands asynchronously — poll the listing, don't sleep.
      let observed = "";
      await waitUntil(async () => {
        const sessions = (await tool("pty_list").execute({}, { agent: AGENT })).sessions;
        observed = JSON.stringify(sessions);
        return sessions[0]?.status?.kind === "exited";
      }, {
        timeoutMs: 20_000,
        describeObserved: () => `sessions = ${observed}`,
      });
      // Still held (persistent default): pty_close is the reclaim path, not the signal.
      expect((await tool("pty_list").execute({}, { agent: AGENT })).sessions.map((row: any) => row.id)).toContain(opened.sessionId);
    },
  );
});
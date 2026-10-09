/**
 * Unit spec for the `asChildProcess` IPty→ChildProcess adapter (#51): a fake
 * IPty object exercises the shape contract the shared fake-seam helper
 * (tests/helpers/fake-terminals.ts) relies on — stdout emulated from onData,
 * stdin.write → pty.write, kill() delegation, pid passthrough, and
 * exitCode/signalCode backfilled from the pty exit event (null while
 * running). No real pty needed — the live suite owns the real-spawn half.
 * @module tests/pty-as-childprocess
 */

import { describe, it, expect } from "vitest";
import { asChildProcess } from "./helpers/fake-terminals.ts";
import type { IPty } from "@lydell/node-pty";

/** Minimal fake IPty: records writes, exposes the onData/onExit taps. */
function fakePty() {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  const writes: string[] = [];
  let killed = 0;
  const pty: IPty = {
    pid: 4242,
    process: "fake",
    columns: 80,
    rows: 24,
    write: (d: string) => {
      writes.push(d);
    },
    kill: () => {
      killed++;
    },
    onData: (cb) => {
      dataCb = cb;
      return { dispose: () => {} };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose: () => {} };
    },
    resize: () => {},
    clear: () => {},
    pause: () => {},
    resume: () => {},
  } as unknown as IPty;
  return {
    pty,
    writes,
    get killed() {
      return killed;
    },
    emitData: (d: string) => dataCb?.(d),
    emitExit: (e: { exitCode: number; signal?: number }) => exitCb?.(e),
  };
}

describe("asChildProcess (#51)", () => {
  it("presents the ChildProcess shape the fake seam depends on", () => {
    const f = fakePty();
    const child = asChildProcess(f.pty);
    expect(child.pid).toBe(4242);
    expect(child.stdout).toBeTruthy();
    expect(typeof child.stdout!.on).toBe("function");
    expect(child.stdin).toBeTruthy();
    expect(typeof child.stdin!.write).toBe("function");
    expect(typeof child.kill).toBe("function");
  });

  it("emulates stdout from onData and delegates stdin.write to pty.write", () => {
    const f = fakePty();
    const child = asChildProcess(f.pty);
    const seen: string[] = [];
    child.stdout!.on("data", (d) => seen.push(d.toString()));
    f.emitData("hello ");
    // #51: conpty Enter semantics — the seam's "\n" submit becomes "\r".
    child.stdin!.write("echo hi\n");
    expect(seen.join("")).toBe("hello ");
    expect(f.writes).toEqual(["echo hi\r"]);
  });

  it("reports running (exitCode/signalCode null) then backfills from the exit event", async () => {
    const f = fakePty();
    const child = asChildProcess(f.pty);
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);
    const exited = new Promise((resolve) => child.on("exit", resolve));
    f.emitExit({ exitCode: 0 });
    await exited;
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBe(null);
  });

  it("backfills signalCode to the ChildProcess string contract, not the pty number", async () => {
    const f = fakePty();
    const child = asChildProcess(f.pty);
    const exitArgs: unknown[] = [];
    child.on("exit", (...a: unknown[]) => exitArgs.push(...a));
    f.emitExit({ exitCode: 1, signal: 1 });
    await new Promise((r) => setTimeout(r, 20));
    // ChildProcess.signalCode is a string like "SIGHUP"; node-pty's exit
    // event carries the raw number.
    expect(child.signalCode).toBe("SIGHUP");
    expect(exitArgs).toEqual([1, "SIGHUP"]);
  });

  it("kill() delegates to the pty and the exited status lands for the settle fallback", async () => {
    const f = fakePty();
    const child = asChildProcess(f.pty);
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill();
    expect(f.killed).toBe(1);
    f.emitExit({ exitCode: 1, signal: 15 });
    await exited;
    expect(child.exitCode).toBe(1);
    expect(child.signalCode).toBe("SIGTERM");
  });
});

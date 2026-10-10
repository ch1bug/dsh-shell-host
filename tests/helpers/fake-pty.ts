/**
 * Shared fake-PTY harness for the self-managed session core (#61): the
 * @lydell/node-pty IPty surface (onData / onExit taps, write, kill, pid)
 * faked in-process so the unit lane stays hermetic — no ConPTY needed. The
 * REAL node-pty spawn is the machine lane's business (ssh-pty-live,
 * terminal-machine), exactly as the old seam split ran. Pure test
 * infrastructure — the only src/ import is the plugin entry (apply).
 * @module tests/helpers/fake-pty
 */

import type { IPty } from "@lydell/node-pty";
import { apply } from "../../src/pty/index.ts";
import type { SessionCore, CoreSpawnSpec } from "../../src/pty/session-core.ts";

export const terr = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Harness controls exposed alongside the fake IPty. */
export interface FakePtyHandle {
  pty: IPty;
  /** Everything written into the pty, in order. */
  writes: string[];
  /** Simulate process output (byte stream into the core's buffer). */
  emitData: (d: string) => void;
  /** Simulate process exit. */
  emitExit: (e: { exitCode: number; signal?: number }) => void;
  readonly killed: number;
}

/** Minimal fake IPty: records writes, exposes the onData/onExit taps. */
export function fakePty(pid = 4242): FakePtyHandle {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  const writes: string[] = [];
  let killed = 0;
  const pty: IPty = {
    pid,
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
    emitData: (d) => dataCb?.(d),
    emitExit: (e) => exitCb?.(e),
  };
}

/** The spawn spec the core hands its injected spawner (#61: command text +
 * additive cwd/env — re-exported from the core's single definition). */
export type { CoreSpawnSpec };

/** A line-discipline echo fake: every write comes back as a complete line
 * (prefix + the written bytes, CR stripped), and kill surfaces the exit
 * event — the real pty behaviors the core's settle/close paths rely on.
 * `prefix` lets a suite pose as a specific remote (e.g. ssh's "ECHO:"). */
export function echoFakePty(prefix = "") {
  const h = fakePty();
  const rawWrite = h.pty.write.bind(h.pty);
  (h.pty as any).write = (d: string) => {
    rawWrite(d);
    setTimeout(() => h.emitData(prefix + d.replace(/\r$/, "") + "\r\n"), 5);
  };
  (h.pty as any).kill = () => setTimeout(() => h.emitExit({ exitCode: 0 }), 5);
  return h;
}

/** Boot the pty plugin over an injected fake spawner. Returns the registered
 * tools, the provided `pty` service (the core), and every spawn spec the
 * core handed out — the suite-visible surface the old FakeTerminals booted
 * against. */
export function bootPlugin(opts?: {
  spawnPty?: (spec: CoreSpawnSpec) => FakePtyHandle | IPty;
  config?: unknown;
}) {
  const provided = new Map<string, unknown>();
  const registered: any[] = [];
  const effects: Array<{ label: string; dispose: () => Promise<void> }> = [];
  const ctx = {
    provide: (name: string, value: unknown) => provided.set(name, value),
    effect: (fn: () => () => Promise<void>, label: string) => effects.push({ label, dispose: fn() }),
    tools: { register: (t: unknown) => registered.push(t) },
  };
  apply(ctx as any, opts?.config ?? {}, {
    // The suites' spawners hand out FakePtyHandles; unwrap to the IPty-like
    // the core drives (a raw PtyLike passes through untouched).
    spawnPty: ((spec: CoreSpawnSpec) => {
      const result = opts?.spawnPty?.(spec)
      if (result === undefined) throw new Error('bootPlugin: no spawner provided')
      return 'pty' in result ? result.pty : (result as never)
    }) as never,
  });
  const tool = (name: string) => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  const core = provided.get("pty") as SessionCore;
  return { registered, tool, core, provided, effects };
}

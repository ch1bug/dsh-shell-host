/**
 * Shared fake-seam harness for the terminals-facing suites (#48): the same
 * owner-scoped registry shape (sessions map / spawn / read / startSend /
 * kill, line-cursor read contract) that pty-session.spec.ts established as
 * the reference fake, extracted so ssh-pty.spec.ts, ssh-pty-live.spec.ts and
 * the pty core tests stop hand-rolling near-copies. The live variant's
 * real-child_process spawn difference enters as the `spawnChild` /
 * `killChild` parameters, not a fork. Pure test infrastructure — the only
 * src/ import is the plugin entry (apply), which the consuming suites
 * already depended on.
 * @module tests/helpers/fake-terminals
 */

import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import type { IPty } from "@lydell/node-pty";
import { apply } from "../../src/pty/index.ts";

export const terr = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Present an IPty (the live suite's @lydell/node-pty spawn, #51) as the
 * ChildProcess-shaped object the FakeSession contract expects — the helper's
 * ChildProcess contract itself is unchanged. `stdout` is emulated from the
 * pty's onData, `stdin.write` delegates to `write()`, `kill()` delegates to
 * `kill()`, `pid` passes through, and `exitCode`/`signalCode` are backfilled
 * from the pty exit event (null while running), so status()/close() and the
 * echo-seen settle fallback see the same dead-session path a real child
 * gives them.
 */
export function asChildProcess(pty: IPty): ChildProcess {
  // ChildProcess's lifecycle fields are readonly in @types/node, so the
  // mutable surface is typed locally and the finished object is cast once.
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    exitCode: number | null;
    signalCode: number | null;
    stdout: unknown;
    stdin: { write: (d: string) => void };
    kill: () => boolean;
  };
  child.pid = pty.pid;
  child.exitCode = null;
  child.signalCode = null;
  const stdout = new EventEmitter();
  child.stdout = stdout;
  child.stdin = {
    // conpty Enter semantics (#51): the fake seam submits with "\n"; a
    // conpty-hosted shell only commits a line on "\r" (a bare "\n" echoes
    // but never executes — verified by the pty-probe run).
    write: (d: string) => pty.write(d.replace(/\n/g, "\r")),
  };
  child.kill = () => {
    // Tolerate the already-dead pty: FakeTerminals.kill → close() may reach
    // the pty twice (killChild then the re-kill), and node-pty's ConPTY close
    // can throw on an exited session.
    try {
      pty.kill();
    } catch {}
    return true;
  };
  const SIGNAL_NAMES: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 9: "SIGKILL", 15: "SIGTERM" };
  pty.onData((d) => stdout.emit("data", Buffer.from(d)));
  pty.onExit(({ exitCode, signal }) => {
    child.exitCode = exitCode;
    // ChildProcess.signalCode is a string ("SIGTERM" et al); node-pty's exit
    // event carries the raw number.
    const signalName = signal === undefined ? null : (SIGNAL_NAMES[signal] ?? `SIG${signal}`);
    child.signalCode = signalName;
    // Node's exit event is (code, signal) with BOTH filled from the pty's
    // own accounting — a normal non-zero exit stays (exitCode, null) like a
    // real child; only an actual signal fills the second slot.
    child.emit("exit", exitCode, signalName);
  });
  return child as unknown as ChildProcess;
}

/** The read contract every fake shares: `offset` counts back from the NEWEST
 * retained line (0 = newest); lineBegin/lineEnd are absolute indices for the
 * plugin's cursor bookkeeping. Complete lines only. */
export function lineCursorRead(text: string, req?: { offset?: number; count?: number }) {
  const { offset = 0, count = 200 } = req ?? {};
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const start = Math.max(0, total - Math.min(offset, total));
  const end = Math.min(total, start + count);
  return {
    text: lines.slice(start, end).join("\n") + (end > start ? "\n" : ""),
    totalLines: total,
    lineBegin: total - start,
    lineEnd: total - start + (end - start),
    truncated: end < total,
  };
}

export interface FakeSessionOptions {
  /** The seam difference: what "remote terminal" this fake session runs
   * (a node echo script, the real ssh client inside a local shell, ...). */
  spawnChild: () => ChildProcess;
  /** Text present before any send (banner / motd). */
  initialText?: string;
  /** A send's done() settles once THIS send's text is echoed back — a dead
   * session never echoes, so the fallback settles with the exited status. */
  settleTimeoutMs?: number;
}

export class FakeSession {
  id: string;
  owner: unknown;
  sentLog: string[] = [];
  text: string;
  child: ChildProcess;
  exitPromise: Promise<unknown>;
  active: { readOutput: () => { delta: string }; done: Promise<unknown> } | null = null;
  pid?: number;
  private opts: FakeSessionOptions;

  constructor(spec: { sessionId: string; owner: unknown }, opts: FakeSessionOptions) {
    this.id = spec.sessionId;
    this.owner = spec.owner;
    this.opts = opts;
    this.text = opts.initialText ?? "";
    this.child = opts.spawnChild();
    this.child.stdout!.on("data", (d) => {
      this.text += d.toString();
    });
    this.exitPromise = once(this.child, "exit");
    this.exitPromise.catch(() => {});
    this.active = null;
  }

  status() {
    if (this.child.exitCode === null && this.child.signalCode === null) return { kind: "running" };
    return { kind: "exited", exitCode: this.child.exitCode, signal: this.child.signalCode };
  }

  startSend(request: { text: string; submit?: boolean }) {
    if (this.active) throw terr("SEND_ACTIVE", "concurrent send");
    const baseLen = this.text.length;
    const payload = request.text + (request.submit ? "\n" : "");
    this.sentLog.push(payload);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin!.write(payload);
    }
    let delta = "";
    const op = {
      readOutput: () => ({ delta, truncated: false }),
      cancel: () => false,
      done: new Promise((resolve) => {
        const settle = () => {
          this.active = null;
          delta = this.text.slice(baseLen);
          resolve({ viewport: "", waitReason: "inferred_idle", sessionStatus: this.status(), truncated: false });
        };
        const poll = setInterval(() => {
          if (this.text.slice(baseLen).includes(request.text)) {
            clearInterval(poll);
            settle();
          }
        }, 10);
        setTimeout(() => {
          clearInterval(poll);
          settle();
        }, this.opts.settleTimeoutMs ?? 2000);
      }),
    };
    this.active = op;
    return op;
  }

  read(req?: { offset?: number; count?: number }) {
    return lineCursorRead(this.text, req);
  }

  /** Kill and wait for the exit — the registry-level close contract. */
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
      await this.exitPromise;
    }
  }
}

export interface FakeTerminalsOptions {
  idPrefix?: string;
  /** Per-session child factory (the live variant's real spawn parameter). */
  spawnChild: () => ChildProcess;
  /** Extra per-session construction (initialText etc.). */
  session?: Partial<FakeSessionOptions>;
  /** How this fake kills a session's child — win32 tree-kill for the live
   * cmd.exe wrapper, plain signal for everything else. */
  killChild?: (child: ChildProcess) => void | Promise<void>;
}

export class FakeTerminals {
  sessions = new Map<string, FakeSession>();
  nextId = 1;
  killedWith: Array<{ owner: unknown; id: string; reason: string }> = [];
  constructor(private opts: FakeTerminalsOptions) {}

  async spawn(owner: unknown, _spec: any) {
    const id = `${this.opts.idPrefix ?? "sess"}-${this.nextId++}`;
    const s = new FakeSession({ sessionId: id, owner }, { spawnChild: this.opts.spawnChild, ...this.opts.session });
    // Real child pid when available (the live variant's process is real);
    // synthetic otherwise, mirroring the original ssh-pty fake.
    s.pid = s.child.pid ?? 10000 + this.nextId;
    this.sessions.set(id, s);
    return { sessionId: id, pid: s.pid };
  }
  read(owner: unknown, id: string, req: any) {
    return this.assertSession(id).read(req);
  }
  startSend(owner: unknown, id: string, request: any) {
    return this.assertSession(id).startSend(request);
  }
  async kill(owner: unknown, id: string, reason: string) {
    const s = this.assertSession(id);
    this.killedWith.push({ owner, id, reason });
    if (s.child.exitCode === null && s.child.signalCode === null) {
      // killChild handles tree-style kills (win32 taskkill); close() then
      // waits for the exit, re-killing harmlessly if the signal hasn't
      // landed yet.
      await this.opts.killChild?.(s.child);
    }
    await s.close();
    this.sessions.delete(id);
    return true;
  }
  private assertSession(id: string): FakeSession {
    const s = this.sessions.get(id);
    if (!s) throw terr("NO_SESSION", `no session ${id}`);
    return s;
  }
}

/** Harness: boot the ssh plugin over a fake terminals registry, surface the
 * registered tools' execute fns. */
export function bootSsh(terminals: FakeTerminals) {
  const registered: any[] = [];
  const ctx = {
    provide: () => {},
    effect: () => () => Promise.resolve(),
    terminals,
    tools: { register: (t: unknown) => registered.push(t) },
  };
  apply(ctx as any, {});
  const tool = (name: string) => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  return { terminals, registered, tool };
}

/**
 * #186 (ADR-0020): the sentinel-wrapped command output — marker module and
 * filtered-view guard spec. The grill ruling pinned here, point by point:
 *
 *  - Q3 sentinel format: a random per-session payload inside an OSC
 *    private-sequence envelope; the CLOSE sentinel is trusted only when
 *    paired with THIS session's open (enforced structurally — the scanner
 *    only recognizes the session's own payload).
 *  - Q4 views: the core keeps raw + filtered; tail/send reads consume the
 *    filtered view by default; the page vocabulary is #185's
 *    `{text, offset, limit, totalLines, truncated}` verbatim, scoped to the
 *    filtered view.
 *  - Q2 coexistence: the #177 heuristic stays untouched (raw face), and
 *    lines it strips never reach the buffer, so the filtered view rides the
 *    same protection.
 *
 * The MIRROR phase deserves its own sentence: before the session's first
 * trusted OPEN, banner/prompt/echo cannot be told apart from command output,
 * so the filtered view mirrors raw (the Q2 fallback — nothing is filtered
 * out until a marker proves the stream is armed). The echo of the FIRST
 * armed command therefore still lands in the view (it completes before the
 * PS0 open of that same line); every LATER command's echo is out-of-segment
 * and filtered. The expectations below spell this out per case.
 *
 * The unit lane drives the fake PTY with an injected fixed payload; the real
 * bash/ConPTY sentinel passthrough is the machine lane's business (the
 * pty-shell-machine cases and the .scratch/verify186/ live probe).
 * @module tests/pty-markers
 */

import { describe, it, expect } from "vitest";
import { bootPlugin, fakePty, echoFakePty, type FakePtyHandle } from "./helpers/fake-pty.ts";
import {
  MarkerScanner,
  buildMarkerOpen,
  buildMarkerClose,
  buildBashMarkerSetup,
  bashMarkerDialect,
  sshBashShellDialect,
} from "../src/pty/marker-wrapper.ts";
import { createSessionCore, type SessionCoreConfig } from "../src/pty/session-core.ts";

const agent = { name: "a" };
/** The unit lane's pinned payload (injected through the core's seam). */
const P = "0123456789abcdef";
const OPEN = buildMarkerOpen(P);
const CLOSE = buildMarkerClose(P);
const FOREIGN_P = "ffffffffffffffff";
const FOREIGN_OPEN = buildMarkerOpen(FOREIGN_P);
const FOREIGN_CLOSE = buildMarkerClose(FOREIGN_P);

const FAST: Partial<SessionCoreConfig> = { settleQuietMs: 20, settleTickMs: 5, settleTimeoutMs: 300 };

/** Boot one marker core with a fixed payload and a drivable fake pty. */
async function bootMarker(opts?: { scrollbackLines?: number; noMarker?: boolean }) {
  const spawned: FakePtyHandle[] = [];
  const core = createSessionCore(
    { ...FAST, scrollbackLines: opts?.scrollbackLines } as SessionCoreConfig,
    {
      spawnPty: () => {
        const handle = fakePty(10000 + spawned.length + 1);
        spawned.push(handle);
        return handle.pty;
      },
      randomPayload: () => P,
    },
  );
  const spec = opts?.noMarker === true
    ? { command: "bash --login -i", shell: true }
    : { command: "bash --login -i", shell: true, marker: "bash" as const };
  const opened = await core.open(agent, spec);
  return { core, opened, handle: spawned[0], handles: spawned };
}

/** Drive a write-shaped bash output burst through the fake pty, the way a
 * real interactive session produces it: the echoed input line, then the
 * PS0 open sentinel, the command's own output, the PROMPT_COMMAND close
 * sentinel, then the prompt fragment (which stays pending — no newline). */
function bashBurst(handle: FakePtyHandle, echoedLine: string, outputLines: string[], prompt = "$ "): void {
  const parts = [`${echoedLine}\r\n`, OPEN, ...outputLines.map((l) => `${l}\r\n`), CLOSE, prompt];
  handle.emitData(parts.join(""));
}

describe("MarkerScanner (#186 Q3: payload-scoped trust, torn carry)", () => {
  it("recognizes only THIS session's payload — a foreign open/close flows through as text", () => {
    const s = new MarkerScanner(P);
    const tokens = s.push(`x ${FOREIGN_OPEN} mid ${FOREIGN_CLOSE} y`);
    const text = tokens.filter((t) => t.kind === "text").map((t) => (t as { kind: "text"; text: string }).text).join("");
    // The foreign sentinels are NOT events and NOT stripped: the bytes pass
    // (the sanitizer downstream strips them like any other OSC).
    expect(tokens.some((t) => t.kind === "open" || t.kind === "close")).toBe(false);
    expect(text).toBe(`x ${FOREIGN_OPEN} mid ${FOREIGN_CLOSE} y`);
  });

  it("emits open/close events in stream order for this session's payload (BEL and ST terminators)", () => {
    const s = new MarkerScanner(P);
    const tokens = s.push(`a${OPEN}b${CLOSE}c`);
    expect(tokens.map((t) => t.kind)).toEqual(["text", "open", "text", "close", "text"]);
    // ST-terminated spellings count too.
    const st = new MarkerScanner(P);
    const stTokens = st.push(`a\x1b]133;C;${P}\x1b\\b\x1b]133;D;${P}\x1b\\c`);
    expect(stTokens.map((t) => t.kind)).toEqual(["text", "open", "text", "close", "text"]);
  });

  it("carries a torn sentinel across chunks (open split mid-payload, close split at the terminator)", () => {
    const s = new MarkerScanner(P);
    // The open sentinel torn right inside the payload.
    const t1 = s.push(`out\x1b]133;C;01234`);
    expect(t1.every((t) => t.kind === "text")).toBe(true);
    const t2 = s.push(`56789abcdef\x07IN\r\n`);
    const kinds = t2.map((t) => t.kind);
    expect(kinds[0]).toBe("open");
    // The rest of the chunk flows after the event.
    const restText = t2.filter((t) => t.kind === "text").map((t) => (t as any).text).join("");
    expect(restText).toBe("IN\r\n");
    // A close torn exactly at the terminator byte.
    const t3 = s.push(`${CLOSE.slice(0, CLOSE.length - 1)}`);
    expect(t3.every((t) => t.kind === "text")).toBe(true);
    const t4 = s.push(`\x07after`);
    expect(t4.map((t) => t.kind)).toEqual(["close", "text"]);
  });

  it("never loses printable bytes: text tokens concatenate to the chunk minus our own sentinels", () => {
    const s = new MarkerScanner(P);
    const chunk = `head\r\n${OPEN}body ${CLOSE}\r\ntail \x1b[6;1Hprompt`;
    const tokens = s.push(chunk);
    const text = tokens.filter((t) => t.kind === "text").map((t) => (t as any).text).join("");
    expect(text).toBe("head\r\nbody \r\ntail \x1b[6;1Hprompt");
  });

  it("demotes an over-long carry to text (a hostile stream cannot wedge the scanner)", () => {
    const s = new MarkerScanner(P);
    // A sentinel-shaped prefix that keeps growing past any sentinel length:
    // it can never complete, so it must come out as text.
    const first = s.push(`\x1b]133;C;${P}` + "Z".repeat(200));
    const text = first.filter((t) => t.kind === "text").map((t) => (t as any).text).join("");
    expect(text).toContain("ZZZ");
    // The scanner still works afterwards.
    const second = s.push(`a${CLOSE}b`);
    expect(second.map((t) => t.kind)).toEqual(["text", "close", "text"]);
  });
});

describe("bash marker wiring (#186 Q1: setup line, dialect detection)", () => {
  it("buildBashMarkerSetup sets PS0 (open) and PREPENDS to PROMPT_COMMAND (close) in bash syntax", () => {
    const setup = buildBashMarkerSetup(P);
    // The open sentinel rides PS0 (prompt-expanded \e / \a), the close rides
    // PROMPT_COMMAND, and the pre-existing hook is appended by BASH syntax —
    // not clobbered.
    expect(setup).toBe(
      `PS0='\\e]133;C;${P}\\a'; ` +
      `PROMPT_COMMAND='printf "\\e]133;D;${P}\\a"'"\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`,
    );
    // No real ESC byte travels in the line: the echo cannot trip the scanner.
    expect(setup.includes("\x1b")).toBe(false);
  });

  it("bashMarkerDialect: top-level bash only — paths, .exe, and non-bash wrappers", () => {
    expect(bashMarkerDialect("bash --login -i")).toBe(true);
    expect(bashMarkerDialect("D:\\msys64\\usr\\bin\\bash.exe --login -i")).toBe(true);
    expect(bashMarkerDialect("/usr/bin/bash")).toBe(true);
    expect(bashMarkerDialect('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i')).toBe(true);
    // A spaced path WITHOUT quotes parses to a different argv[0] (the same
    // tokenization the real spawn applies — such a line would not spawn
    // bash.exe either), so it is not a bash dialect.
    expect(bashMarkerDialect("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(false);
    // Wrapper executables stay outside the v1 matrix (the Q1 ruling: bash
    // only; wsl-hosted bash is a separate decision).
    expect(bashMarkerDialect("wsl.exe -d distro -e bash --login -i")).toBe(false);
    expect(bashMarkerDialect("pwsh -NoLogo")).toBe(false);
    expect(bashMarkerDialect("cmd.exe /d /c echo hi")).toBe(false);
    // `sh` is deliberately not trusted (a POSIX sh may be dash: no PS0, no
    // PROMPT_COMMAND — segments would dangle).
    expect(bashMarkerDialect("/bin/sh -c echo hi")).toBe(false);
    expect(bashMarkerDialect("")).toBe(false);
  });

  it("sshBashShellDialect: the DECLARED remote shell text only", () => {
    expect(sshBashShellDialect("bash --login")).toBe(true);
    expect(sshBashShellDialect("/usr/bin/bash -l")).toBe(true);
    expect(sshBashShellDialect("zsh --login")).toBe(false);
    expect(sshBashShellDialect("fish")).toBe(false);
    expect(sshBashShellDialect("")).toBe(false);
  });
});

describe("filtered view + raw view (#186 Q4)", () => {
  it("arms the session by writing the setup line after the settle; the payload never appears on the result", async () => {
    const { core, opened, handle } = await bootMarker();
    // The setup line is the FIRST write, carries the sentinel wiring, and
    // ends with the submit CR.
    expect(handle.writes.length).toBe(1);
    expect(handle.writes[0]).toBe(buildBashMarkerSetup(P) + "\r");
    // Session-private payload: the payload leaks nowhere on the result.
    expect(JSON.stringify(opened)).not.toContain(P);
    // The arming observability face (review round): a delivered write
    // reports markerArmed: true on the open result.
    expect(opened.markerArmed).toBe(true);
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("a FAILED arming write is observable, not swallowed: markerArmed: false on the open result (review round)", async () => {
    const core = createSessionCore({ ...FAST } as SessionCoreConfig, {
      spawnPty: () => ({
        pid: 4242,
        // The session died between the settle and the arming write.
        write: () => { throw new Error("ConPTY dead"); },
        kill: () => {},
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
      }),
      randomPayload: () => P,
    });
    const opened = await core.open(agent, { command: "bash --login -i", shell: true, marker: "bash" });
    expect(opened.markerArmed).toBe(false);
    // Reads stay on the raw face (no marker armed — one view).
    const page = core.tail(agent, opened.sessionId, 50);
    expect(page.limit).toBeGreaterThan(0);
  });

  it("mirrors raw until the first trusted open (banner and the first command's echo pass), then filters", async () => {
    const { core, opened, handle } = await bootMarker();
    // Mirror phase: banner before any sentinel — the filtered tail must
    // carry it (nothing is filtered out before a marker is ever seen; the
    // Q2 fallback). The prompt fragment stays pending (no newline).
    handle.emitData("Welcome banner\r\n$ ");
    const mirror = core.tail(agent, opened.sessionId, 50);
    expect(mirror.text).toBe("Welcome banner\n");
    expect(mirror.totalLines).toBe(1);
    expect(mirror.truncated).toBe(false);
    // The FIRST burst's echo completes before its own PS0 open — mirror
    // phase still — so it passes too. The burst's trailing prompt fragment
    // stays pending and the NEXT echo completes on top of it — exactly what
    // a real bash line looks like ("$ echo hello"), which is why the line
    // carries the prompt prefix here.
    bashBurst(handle, "echo hello", ["hello"]);
    const page = core.tail(agent, opened.sessionId, 50);
    expect(page.text).toBe("$ echo hello\nhello\n");
    expect(page.totalLines).toBe(3); // banner + first echo (with prompt) + the output line
    expect(page.offset).toBe(2);
    expect(page.truncated).toBe(false);
    // The SECOND burst's echo is out-of-segment and filtered; the prompt
    // fragments after each close never enter.
    bashBurst(handle, "echo two", ["two"]);
    const page2 = core.tail(agent, opened.sessionId, 50);
    expect(page2.text).toBe("two\n");
    expect(page2.totalLines).toBe(4);
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("trusts a close only when paired with this session's open: a foreign close never closes the segment", async () => {
    const { core, opened, handle } = await bootMarker();
    bashBurst(handle, "echo one", ["one"]);
    core.tail(agent, opened.sessionId, 50); // drain [echo one, one]
    // The next burst's close is FOREIGN (another session's payload leaked
    // into the stream, or a generic OSC-133 emitter): the segment it claims
    // to close must stay OPEN — the following output lines stay in view.
    // Note the failure direction: an untrusted close UNDER-filters (output
    // keeps flowing into the view), it never eats data.
    handle.emitData(`echo two\r\n${OPEN}two\r\n${FOREIGN_CLOSE}`);
    handle.emitData(`still-output\r\n`);
    const page = core.tail(agent, opened.sessionId, 50);
    expect(page.text).toBe("two\nstill-output\n");
    // And a foreign OPEN never opens one: drain this still-open segment, let
    // OUR real close land (paired), and then a foreign open on top of a
    // closed state starts nothing — the ghost line stays out of the view.
    core.tail(agent, opened.sessionId, 50);
    handle.emitData(`${CLOSE}`);
    handle.emitData(`prompt\r\n${FOREIGN_OPEN}ghost\r\n`);
    const page2 = core.tail(agent, opened.sessionId, 50);
    expect(page2.text).toBe(""); // armed + closed: the prompt line and the ghost are out-of-segment
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("an unpaired real close (before any open) is ignored", async () => {
    const { core, opened, handle } = await bootMarker();
    // A stray close before the first open (a prompt fired before our setup
    // armed the hooks): nothing to close — ignored.
    handle.emitData(`$ ${CLOSE}\r\n`);
    const page = core.tail(agent, opened.sessionId, 50);
    expect(page.totalLines).toBe(1);
    // The next open still works (the "$" line was already paged above).
    bashBurst(handle, "echo ok", ["ok"]);
    const page2 = core.tail(agent, opened.sessionId, 50);
    expect(page2.text).toBe("echo ok\nok\n");
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("a close arriving while already closed is a no-op (repeated prompts never corrupt the view)", async () => {
    const { core, opened, handle } = await bootMarker();
    bashBurst(handle, "echo one", ["one"]);
    bashBurst(handle, "echo two", ["two"]);
    const page = core.tail(agent, opened.sessionId, 50);
    // Two independent open..close pairs — the second close (already closed)
    // must not have eaten anything. The second echo is filtered (armed).
    expect(page.text).toBe("echo one\none\ntwo\n");
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("a torn sentinel split across PTY chunks still frames the segment (ConPTY chops anywhere)", async () => {
    const { core, opened, handle } = await bootMarker();
    handle.emitData(`echo hi\r\n`);
    handle.emitData(`${OPEN.slice(0, 6)}`); // ESC ] 133 ;
    handle.emitData(`${OPEN.slice(6)}hi\r\n`); // the rest + the command output
    handle.emitData(`${CLOSE.slice(0, 10)}`);
    handle.emitData(`${CLOSE.slice(10)}$ `);
    const page = core.tail(agent, opened.sessionId, 50);
    // Mirror phase carried the echo; the armed phase carried only the output.
    expect(page.text).toBe("echo hi\nhi\n");
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("the page vocabulary stays #185's, scoped to the filtered view: out-of-view lines neither count nor page", async () => {
    const { core, opened, handle } = await bootMarker();
    handle.emitData("banner\r\n");
    bashBurst(handle, "echo one", ["one"]);
    bashBurst(handle, "echo two", ["two"]);
    // 5 raw complete lines (banner, echo one, one, echo two, two) — but the
    // filtered view holds 4 (banner, the first echo, one, two): the second
    // echo and both prompt fragments stay out.
    const page = core.tail(agent, opened.sessionId, 2);
    expect(page.text).toBe("banner\necho one\n");
    expect(page.offset).toBe(1);
    expect(page.totalLines).toBe(4);
    expect(page.truncated).toBe(false);
    const page2 = core.tail(agent, opened.sessionId, 2);
    expect(page2.text).toBe("one\ntwo\n");
    expect(page2.offset).toBe(3);
    expect(page2.totalLines).toBe(4);
    // Empty page keeps its cursor line (#185 kept-even-when-empty).
    const page3 = core.tail(agent, opened.sessionId, 2);
    expect(page3.text).toBe("");
    expect(page3.offset).toBe(5);
    expect(page3.totalLines).toBe(4);
    expect(page3.truncated).toBe(false);
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("#181 regression in the filtered view: a 2000-line in-segment backlog drains completely, nothing skipped", async () => {
    const { core, opened, handle } = await bootMarker();
    bashBurst(handle, "echo start", ["start"]); // arm first
    core.tail(agent, opened.sessionId, 10);
    // 2000 fresh in-segment lines in one burst.
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
    handle.emitData(`big\r\n${OPEN}${lines.map((l) => l + "\r\n").join("")}${CLOSE}`);
    const pages: string[] = [];
    for (let page = 0; page < 40; page += 1) {
      const p = core.tail(agent, opened.sessionId, 50);
      if (p.text === "") break;
      pages.push(p.text);
      expect(p.truncated, `page ${page} must not flag truncation for a paged backlog`).toBe(false);
    }
    const text = pages.join("");
    expect(text).toContain("line-0000\n");
    expect(text).toContain("line-1000\n");
    expect(text).toContain("line-1999\n");
    expect(text.split("\n").filter((l) => l.startsWith("line-")).length).toBe(2000);
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("scrollback-capped filtered lines are REAL loss: truncated flags them in the filtered coordinate", async () => {
    const { core, opened, handle } = await bootMarker({ scrollbackLines: 10 });
    bashBurst(handle, "arm", ["arm"]);
    core.tail(agent, opened.sessionId, 10); // drain [echo arm, arm]
    // 20 in-segment lines through a 10-line scrollback: in-view lines are
    // dropped before the cursor reaches them.
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    handle.emitData(`x\r\n${OPEN}${lines.map((l) => l + "\r\n").join("")}${CLOSE}`);
    const page = core.tail(agent, opened.sessionId, 50);
    // The absolute coordinate matches the raw construction (drop base +
    // survivors = 12 + 10; the interleaved "x" echo line is out-of-segment
    // and never counted): a scrollback drop moves the base, never renumbers
    // — that is what the #185 offset semantics need.
    expect(page.totalLines).toBe(22);
    expect(page.truncated).toBe(true);
    expect(page.text).not.toContain("l0\n");
    expect(page.text).toContain("l19\n");
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("an unterminated output tail produced BEFORE the close survives the delta; only post-close prompt residue is dropped (review round: the whole-tail drop ate `printf abc`)", async () => {
    const { core, opened, handle } = await bootMarker();
    bashBurst(handle, "arm", ["arm"]); // arm + close
    core.tail(agent, opened.sessionId, 10); // drain
    // `printf abc`: the output has NO trailing newline — it sits in pending
    // when the close lands. The close records the pending boundary; the
    // delta must deliver the boundary-prior bytes (the command's own tail)
    // and drop only the post-close prompt fragment.
    const pending = core.send(agent, opened.sessionId, { data: "printf abc" });
    handle.emitData(`printf abc\r\n${OPEN}abc${CLOSE}$ `);
    const result = await pending;
    expect(result.delta).toBe("abc");
    // Same shape without a post-close prompt fragment: the tail still lands.
    const pending2 = core.send(agent, opened.sessionId, { data: "printf xy" });
    handle.emitData(`printf xy\r\n${OPEN}xy${CLOSE}`);
    const result2 = await pending2;
    expect(result2.delta).toBe("xy");
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("a close from an EARLIER send window does not leak its boundary into a later pending-tail decision", async () => {
    const { core, opened, handle } = await bootMarker();
    bashBurst(handle, "arm", ["arm"]); // arm + close
    core.tail(agent, opened.sessionId, 10);
    // Window A: command + output + close; the prompt fragment grows pending
    // past the close boundary.
    const a = core.send(agent, opened.sessionId, { data: "echo one" });
    handle.emitData(`echo one\r\n${OPEN}one\r\n${CLOSE}$ `);
    expect((await a).delta).toBe("one\n");
    // Window B: only an out-of-segment partial line accrues (echo typing
    // residue) — the stale boundary must not resurrect it.
    const b = core.send(agent, opened.sessionId, { data: "" });
    handle.emitData("half-typed");
    expect((await b).delta).toBe("");
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("send deltas are filtered reads: the echoed input stays out, the command's output comes through", async () => {
    const { core, opened, handle } = await bootMarker();
    bashBurst(handle, "arm", ["arm"]); // arm
    core.tail(agent, opened.sessionId, 10); // drain
    // The send itself; the burst plays the echo/output/closer while the
    // settle window is still open. The trailing prompt fragment parked in
    // pending is OUT-of-segment at settle end (armed, closed) and is
    // dropped — the live-measured delta no longer ends with a bare "$ ".
    const pending = core.send(agent, opened.sessionId, { data: "echo hello" });
    handle.emitData(`echo hello\r\n${OPEN}hello\r\n${CLOSE}$ `);
    const result = await pending;
    expect(result.delta).toBe("hello\n");
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("send deltas keep a mid-output pending tail (open segment) and keep it in the mirror phase", async () => {
    const { core, opened, handle } = await bootMarker();
    // Mirror phase: an incomplete line at settle end still rides the delta.
    const mirrorSend = core.send(agent, opened.sessionId, { data: "echo partial" });
    handle.emitData(`echo partial\r\n${OPEN}partial-output`); // no close yet
    const mirror = await mirrorSend;
    // Mirror phase = raw semantics: the echo line passes AND the pending
    // tail (still open segment) rides along.
    expect(mirror.delta).toBe("echo partial\npartial-output");
    // Drain; the next burst completes the line and closes.
    core.tail(agent, opened.sessionId, 50);
    handle.emitData(`\r\n${CLOSE}`);
    core.tail(agent, opened.sessionId, 50);
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("view: 'raw' pages the full sanitized stream from an independent raw cursor (the default cursor untouched)", async () => {
    const { core, opened, handle } = await bootMarker();
    bashBurst(handle, "echo one", ["one"]);
    // The default (filtered) cursor pages first: the first echo rides the
    // mirror phase, the output is in-segment, the prompt stays pending.
    const filtered = core.tail(agent, opened.sessionId, 50);
    expect(filtered.text).toBe("echo one\none\n");
    expect(filtered.totalLines).toBe(2);
    // The raw view sees the same complete lines here (the prompt is still
    // pending on BOTH views — line reads are complete-lines-only) but from
    // its own independent cursor.
    const raw1 = core.tail(agent, opened.sessionId, 50, "raw");
    expect(raw1.text).toBe("echo one\none\n");
    expect(raw1.totalLines).toBe(2);
    expect(raw1.offset).toBe(1);
    const raw2 = core.tail(agent, opened.sessionId, 50, "raw");
    expect(raw2.text).toBe("");
    expect(raw2.offset).toBe(3);
    // The filtered cursor did not move (still an empty page).
    expect(core.tail(agent, opened.sessionId, 50).text).toBe("");
    // An unknown spelling is a loud caller error, never folded to a view.
    expect(() => core.tail(agent, opened.sessionId, 5, "flitered" as never)).toThrow(/view must be/);
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("an unknown marker dialect and marker+autoClose are refused loudly before any spawn", async () => {
    const handles: FakePtyHandle[] = [];
    const core = createSessionCore({ ...FAST } as SessionCoreConfig, {
      spawnPty: () => {
        const handle = fakePty(1);
        handles.push(handle);
        return handle.pty;
      },
      randomPayload: () => P,
    });
    await expect(core.open(agent, { command: "bash", shell: true, marker: "zsh" as never })).rejects.toThrow(/only v1 dialect/);
    await expect(core.open(agent, { command: "bash", autoClose: true, marker: "bash" })).rejects.toThrow(/persistent-shell contract/);
    expect(handles.length).toBe(0);
  });

  it("a session WITHOUT a marker keeps the pre-#186 face exactly (one view; sentinel bytes are inert)", async () => {
    const { core, opened, handle } = await bootMarker({ noMarker: true });
    // No setup line is written — nothing is injected.
    expect(handle.writes.length).toBe(0);
    // Sentinel bytes in the stream are inert (the sanitizer strips the OSC;
    // no events fire, nothing is filtered).
    handle.emitData(`echo hi\r\n${OPEN}hi\r\n${CLOSE}$ `);
    const page = core.tail(agent, opened.sessionId, 50);
    expect(page.text).toBe("echo hi\nhi\n$ ".replace("$ ", "")); // "$ " stays pending
    expect(page.totalLines).toBe(2);
    // view: 'raw' is accepted and identical (one view).
    const raw = core.tail(agent, opened.sessionId, 50, "raw");
    expect(raw.text).toBe("");
    expect(raw.offset).toBe(3);
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });

  it("the #177 repaint heuristic still guards the shared buffer: stripped repaint lines never enter the filtered view", async () => {
    const { core, opened, handle } = await bootMarker();
    bashBurst(handle, "arm", ["arm"]);
    core.tail(agent, opened.sessionId, 10); // drain [echo arm, arm]
    // A full-screen repaint frame re-prints the buffer tail (CSI H/J marker
    // + duplicate lines), then fresh output. The heuristic strips the
    // duplicate prefix from the shared buffer; the filtered view (same
    // buffer, flag-gated) never sees them either.
    handle.emitData(`\x1b[H\x1b[Jarm\r\n${OPEN}fresh\r\n${CLOSE}`);
    const page = core.tail(agent, opened.sessionId, 50);
    expect(page.text).toBe("fresh\n");
    handle.emitExit({ exitCode: 0 });
    await core.close(agent, opened.sessionId);
  });
});

describe("tool surface wiring (#186)", () => {
  it("pty_open declares the marker for a top-level bash shellCommand and not otherwise; pty_tail passes view through", async () => {
    const h = bootPlugin({
      config: FAST,
      deps: { randomPayload: () => P },
      spawnPty: () => fakePty(5555),
    });
    const bashOpened = await h.tool("pty_open").execute({ shellCommand: "bash --login -i" }, { agent });
    expect(h.handles[0].writes[0]).toBe(buildBashMarkerSetup(P) + "\r");
    // pty_tail view passthrough: 'raw' reaches the core (raw cursor behavior).
    const raw = await h.tool("pty_tail").execute({ id: bashOpened.sessionId, view: "raw" }, { agent });
    expect(raw.offset).toBe(1);
    expect(raw.limit).toBeGreaterThan(0);
    h.handles[0].emitExit({ exitCode: 0 });
    await h.tool("pty_close").execute({ id: bashOpened.sessionId }, { agent });
    // A non-bash shellCommand carries no marker: no setup write, no arming.
    const pwshOpened = await h.tool("pty_open").execute({ shellCommand: "pwsh -NoLogo" }, { agent });
    expect(h.handles[1].writes.length).toBe(0);
    h.handles[1].emitExit({ exitCode: 0 });
    await h.tool("pty_close").execute({ id: pwshOpened.sessionId }, { agent });
  });

  it("ssh_start declares the marker only for a DECLARED bash remote shell", async () => {
    const h = bootPlugin({
      config: FAST,
      ssh: true,
      deps: { randomPayload: () => P },
      // ssh_start opts into waitForFirstOutput (#189): the fake must produce
      // printable output during the INITIAL settle — a banner right at
      // spawn — or the first-output window runs its full 5s.
      spawnPty: () => {
        const handle = echoFakePty();
        setTimeout(() => handle.emitData("banner\r\n"), 5);
        return handle;
      },
    });
    const bashSession = await h.tool("ssh_start").execute({ host: "h", shell: "bash --login" }, { agent });
    expect(h.handles[0].writes[0]).toBe(buildBashMarkerSetup(P) + "\r");
    // ssh_tail defaults to the filtered view (same core); view passes through.
    const raw = await h.tool("ssh_tail").execute({ id: bashSession.sessionId, view: "raw" }, { agent });
    expect(raw.limit).toBeGreaterThan(0);
    h.handles[0].emitExit({ exitCode: 0 });
    await h.tool("ssh_close").execute({ id: bashSession.sessionId }, { agent });
    const zshSession = await h.tool("ssh_start").execute({ host: "h", shell: "zsh --login" }, { agent });
    expect(h.handles[1].writes.length).toBe(0);
    h.handles[1].emitExit({ exitCode: 0 });
    await h.tool("ssh_close").execute({ id: zshSession.sessionId }, { agent });
  });
});

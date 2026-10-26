/**
 * #160 AC① — the win32 argv ROUND-TRIP, pinned as pure functions (no ConPTY,
 * no process spawn, unit-lane hermetic):
 *
 * The one-shot exec path serializes a command line TWICE before CreateProcess
 * sees it: our tokenizer `parseCommandLine` (src/pty/session-core.ts) splits
 * the caller's `command` string into argv, then node-pty's win32 agent
 * re-serializes that argv into the CreateProcess command line with
 * `argsToCommandLine` (@lydell/node-pty win32-x64, windowsPtyAgent.js). A
 * fidelity loss at either layer changes what the child actually receives —
 * historically invisible (the mid-shape regression lives in
 * pty-oneshot-machine.spec.ts), so these pins are the only mechanical guard.
 *
 * Three named forms (#160):
 *  1. the cmd.exe explicit-wrap spelling (the exact shape the ticket report
 *     observed) — including the quoted final token;
 *  2. tokens containing whitespace MUST be re-quoted by argsToCommandLine
 *     (zero coverage before this spec);
 *  3. backslashes immediately before a quote MUST follow the MSVCRT 2n/2n+1
 *     rule on BOTH layers (zero coverage before this spec).
 *
 * Round-trip contract: parseCommandLine(argsToCommandLine(file, args)) is
 * deep-equal [file, ...args]. If either layer drifts, the round-trip goes red
 * — remove the quoting in argsToCommandLine or break the backslash rule in
 * parseCommandLine and cases below fail.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { parseCommandLine } from "../src/pty/session-core.ts";

// The win32 platform package's exports point at lib/index.js; the serializer
// lives in the agent module beside it. Reach it by file so the pin tracks the
// SAME bytes the real spawn executes (same package closure node-pty's own
// require walks through the optionalDependencies).
const require_ = createRequire(import.meta.url);
// `./package.json` is not exported by "@lydell/node-pty"'s exports map, and
// pnpm hoists the platform package as a SIBLING of `node-pty` (no @lydell
// scope) inside the store's node_modules. So: resolve node-pty's main entry,
// create a require rooted AT that entry, and let Node's own resolution walk
// the sibling link — no hand-built store path in this file.
const nodePtyMain = require_.resolve("@lydell/node-pty");
const ptyRequire = createRequire(nodePtyMain);
// The platform package exports only `./lib/index.js`, so resolve that and
// step sideways to the agent module in the same directory.
const agentJs = path.join(
  path.dirname(ptyRequire.resolve("@lydell/node-pty-win32-x64")),
  "windowsPtyAgent.js",
);
const { argsToCommandLine } = require_(agentJs) as {
  argsToCommandLine: (file: string, args: string[]) => string;
};

/** The two-layer round trip under test. */
const roundTrip = (file: string, args: string[]): string[] =>
  parseCommandLine(argsToCommandLine(file, args));

describe("win32 argv round-trip: parseCommandLine × argsToCommandLine (#160 AC①)", () => {
  it(
    "layer sanity: the two seams are the ones the spawn path actually uses",
    () => {
      // Guards against the pin silently degrading to testing two locals: the
      // upstream agent must export the serializer and our tokenizer must be a
      // real function from session-core.
      expect(typeof argsToCommandLine).toBe("function");
      expect(typeof parseCommandLine).toBe("function");
    },
  );

  it(
    "① cmd.exe explicit-wrap spelling round-trips, quoted final token included",
    () => {
      // The exact shape the #160 report observed (a `.cmd` path token inside
      // the quoted /c argument). String.raw keeps the single literal
      // backslash of a Windows relative path — a plain literal would need
      // `\\` and invites the octal-escape trap on `\1`.
      const command = String.raw`cmd.exe /d /c ".scratch\137-run-frame.cmd"`;
      const argv = parseCommandLine(command);
      expect(argv).toEqual([
        "cmd.exe",
        "/d",
        "/c",
        String.raw`.scratch\137-run-frame.cmd`,
      ]);
      // The spawn-side re-serialization feeds CreateProcess a line whose
      // re-parse is the SAME argv — the byte-level shape is pinned too.
      const line = argsToCommandLine(argv[0], argv.slice(1));
      expect(line).toBe(String.raw`cmd.exe /d /c .scratch\137-run-frame.cmd`);
      expect(roundTrip(argv[0], argv.slice(1))).toEqual(argv);
    },
  );

  it(
    "② tokens with whitespace are re-quoted by argsToCommandLine and survive the round-trip",
    () => {
      const file = "node";
      const args = ["-e", "console.log('a b c')", "two words"];
      const line = argsToCommandLine(file, args);
      // The serializer MUST have added quotes around each whitespace-bearing
      // token (zero coverage before #160)…
      expect(line).toBe(`node -e "console.log('a b c')" "two words"`);
      // …and the round trip hands the child the ORIGINAL tokens, not a split.
      expect(roundTrip(file, args)).toEqual([file, ...args]);
    },
  );

  it(
    "③ backslashes before a quote follow the 2n/2n+1 rule on BOTH layers",
    () => {
      const file = "prog";
      // Token A ends in a literal backslash; token B contains `\"` sequences.
      // (String.raw cannot END in a backslash — `\`` would escape the closing
      // backtick — so the trailing one is appended as a plain literal.)
      const args = [
        String.raw`C:\dir ends with bs` + "\\",
        String.raw`say \"quoted\" tail`,
      ];
      const line = argsToCommandLine(file, args);
      // Serializer side, pinned byte-for-byte: a literal `"` inside a token is
      // emitted as an ODD backslash run + quote (2n+1); the closing quote of
      // the wrapping pair is preceded by an EVEN run (2n) — here the trailing
      // single backslash of A becomes `\\`.
      expect(line).toBe(
        String.raw`prog "C:\dir ends with bs\\" "say \\\"quoted\\\" tail"`,
      );
      expect(roundTrip(file, args)).toEqual([file, ...args]);
    },
  );

  it(
    "③b a trailing backslash before the WRAPPING quote is doubled, never escapes the quote away",
    () => {
      // The classic corruption shape: a quoted token ending in `\` must emit
      // `\\` before the closing quote — a single `\` would escape the closing
      // quote, the tokenizer would swallow the NEXT argument, and the child
      // would silently receive a different argv. (A token without whitespace
      // is not quoted at all, so the whitespace inside matters here.)
      const args = [String.raw`C:\my dir` + "\\"];
      const line = argsToCommandLine("prog", args);
      expect(line).toBe(String.raw`prog "C:\my dir\\"`);
      expect(roundTrip("prog", args)).toEqual(["prog", ...args]);
    },
  );
});

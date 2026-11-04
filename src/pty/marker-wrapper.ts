/**
 * #186 (ADR-0020, Q3): sentinel-wrapped command output — the marker module.
 *
 * Each marker session emits a matched pair of sentinels around every
 * interactive command's OWN output, so consumers can separate "command output"
 * from "echo / banner / redraw residue" by markers instead of text heuristics
 * (the #177 style). The ruling: a random per-session payload inside an OSC
 * private-sequence envelope — the standard shell-integration channel
 * (OSC 133, the FinalTerm numbering every terminal ecosystem reads) carrying a
 * high-entropy per-session payload, so a fixed/forged sequence (cat of
 * binaries, generic OSC-133-emitting programs) cannot open or close a
 * segment: the payload is unguessable per session.
 *
 * Sentinels (BEL terminator; ST accepted on the reading side):
 *   open  = ESC ] 133 ; C ; <payload> BEL   (C = command output STARTS)
 *   close = ESC ] 133 ; D ; <payload> BEL   (D = command output FINISHED)
 *
 * Trust rules (the grill ruling, verbatim): the close sentinel is only
 * trusted when paired with this session's open sentinel — enforced
 * structurally here: {@link MarkerScanner} is constructed with THIS session's
 * payload and only recognizes the two sequences carrying exactly that
 * payload; every other OSC 133 sequence (foreign payload, the standard
 * exit-code-only `133;D;0`, a prompt-emitter's bare marker) passes through as
 * plain text and dies in the sanitizer like any other control sequence.
 *
 * Dialect scope (Q1): bash only, carried to proven status first —
 *  - a session whose top-level process is bash ({@link bashMarkerDialect}),
 *  - an ssh session whose DECLARED remote shell is bash
 *    ({@link sshBashShellDialect}).
 * Wider dialect matrices (cmd/pwsh prompt hooks, wsl-hosted bash, non-bash
 * remote shells) are replication of a proven mechanism and stay undecided.
 *
 * The bash wiring (the injection point, settled here once): the wrapper does
 * NOT touch startup files or the launch command — after the open settle the
 * core writes ONE setup line into the live shell (see
 * {@link buildBashMarkerSetup}) that sets `PS0` (expanded + displayed by
 * interactive bash after reading a line and before executing it → the OPEN
 * sentinel precedes the command's own output) and PREPENDS to
 * `PROMPT_COMMAND` (executed before the next prompt → the CLOSE sentinel
 * follows the output). The setup line travels as ordinary shell text, so its
 * echo carries only the literal two-character `\e` escapes — no real ESC
 * bytes — and cannot trip the scanner. Known declared adversarial limits:
 *  - a program inside the session that reads `$PS0` and printf-expands it can
 *    forge this session's sentinels (same-user threat model, outside the
 *    ADR-0020 envelope: the payload defends against accidental/generic
 *    emission, not a same-privilege forgery that read the variable);
 *  - if the shell's PROMPT_COMMAND hook is later clobbered or the shell is
 *    replaced (`exec zsh`), closes stop arriving and segments stay open —
 *    output keeps flowing into the open segment (filtering degrades to
 *    "everything after the last open", never to data loss; the raw view keeps
 *    everything).
 * @module dsh-shell-host/pty/marker-wrapper
 */

import { randomBytes } from 'node:crypto'
import { parseCommandLine } from './session-core.ts'

/** The OSC private-sequence number this module speaks (FinalTerm shell
 * integration; the sanitizer already knows the `133;D;` prefix from upstream's
 * controlled-bash prompt marker — our sentinels are stripped by OUR scanner
 * before the sanitizer ever sees them, so that tracking stays dormant). */
export const MARKER_OSC_ID = '133'

/** OSC 133's standard sub-commands, reused for their terminal-ecosystem
 * meanings: C = "command output starts", D = "command finished". */
export const MARKER_OPEN_PARAM = 'C'
export const MARKER_CLOSE_PARAM = 'D'

/** Payload entropy: 8 random bytes → 16 hex chars (64 bits). Enough that a
 * payload appearing by accident inside command output is not a realistic
 * event, while keeping the sentinel short on the wire. */
export const MARKER_PAYLOAD_BYTES = 8

/** The default per-session payload generator. Injected through the core's
 * `randomPayload` dep so the unit lane can pin exact sentinel bytes. */
export const defaultRandomPayload = (): string => randomBytes(MARKER_PAYLOAD_BYTES).toString('hex')

/** The open sentinel for one payload (BEL terminator — the form bash's
 * `printf '\e]…\a'` naturally produces). */
export function buildMarkerOpen(payload: string): string {
  return `\x1b]${MARKER_OSC_ID};${MARKER_OPEN_PARAM};${payload}\x07`
}

/** The close sentinel for one payload. */
export function buildMarkerClose(payload: string): string {
  return `\x1b]${MARKER_OSC_ID};${MARKER_CLOSE_PARAM};${payload}\x07`
}

/** The two literal wire sequences a scanner watches for, longest-first. */
const sentinelFor = (payload: string, param: string, terminator: '\x07' | '\x1b\\'): string =>
  `\x1b]${MARKER_OSC_ID};${param};${payload}${terminator}`

/** The bash setup line (#186 Q1 injection point): sets PS0 (open sentinel per
 * interactive line, before the command runs) and PREPENDS our close-sentinel
 * printf to PROMPT_COMMAND (the pre-prompt hook), preserving a scalar or
 * unset hook via the `${PROMPT_COMMAND:+;…}` join. Declared boundary (the
 * review round's array-shape point): bash 5.1+ also allows PROMPT_COMMAND as
 * an ARRAY (`PROMPT_COMMAND+=('hook')` in rcfiles); our SCALAR assignment
 * replaces the array wholesale, so any hook elements beyond element[0] (which
 * the `${PROMPT_COMMAND:+…}` expansion does carry) are lost. The loss
 * direction is the user's own prompt hook degrading — never command-output
 * loss — and the alternative (`PROMPT_COMMAND+=`) breaks the scalar shape
 * (no `;` separator). Stated, not glossed over. Payload chars are hex digits
 * only — no quoting hazard inside either single-quoted literal. The literal
 * `\e` / `\a` escapes are expanded by bash (PS0's prompt expansion; printf's
 * format), never by the shell's input echo, so the line's own echo carries
 * no sentinel bytes. */
export function buildBashMarkerSetup(payload: string): string {
  // The trailing "${PROMPT_COMMAND:+;$PROMPT_COMMAND}" is BASH syntax (expand
  // the pre-existing hook, semicolon-joined), not interpolation — the string
  // is assembled by concatenation so no template engine touches it.
  return (
    `PS0='\\e]${MARKER_OSC_ID};${MARKER_OPEN_PARAM};${payload}\\a'; ` +
    `PROMPT_COMMAND='printf "\\e]${MARKER_OSC_ID};${MARKER_CLOSE_PARAM};${payload}\\a"'"\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"`
  )
}

/** Whether a session-level shell command line is a BASH top-level process
 * (#186 Q1 dialect detection — the pty_open / shell_open opening surfaces
 * call this on their resolved command; declaration over inference, the #119
 * `shell` flag precedent). Matches the interpreter NAME (basename of argv[0]
 * — `bash`, `bash.exe`), deliberately NOT `sh` (a POSIX sh may be dash, which
 * has neither PS0 nor PROMPT_COMMAND and would leave segments dangling), and
 * deliberately NOT wrapper executables (wsl.exe hosting a bash stays outside
 * the v1 matrix: a different decision per the Q1 ruling). */
export function bashMarkerDialect(commandLine: string): boolean {
  const argv = parseCommandLine(commandLine)
  return argv.length > 0 && /(?:^|[\\/])bash(?:\.exe)?$/i.test(argv[0])
}

/** Whether an ssh session's DECLARED remote shell text is bash (#186 Q1: "ssh
 * sessions whose remote shell is bash"). The `shell` parameter is remote shell
 * TEXT (`"bash --login"`); only an explicit declaration arms the marker — an
 * omitted shell leaves the remote login shell unknown, so nothing is injected. */
export function sshBashShellDialect(shellText: string): boolean {
  const first = shellText.trim().split(/\s+/)[0] ?? ''
  return /(?:^|\/)bash(?:\.exe)?$/i.test(first)
}

/** One scanner token: text passes through to the sanitizer; open/close are
 * this session's trusted sentinel events. */
export type MarkerToken = { kind: 'text'; text: string } | { kind: 'open' } | { kind: 'close' }

/** The longest sentinel this module can produce
 * (`\x1b]133;C;` = 8 + 16 hex + 2 for ST = 27 bytes); the torn-carry budget
 * rides on it. */
const MAX_SENTINEL_LENGTH = 8 + MARKER_PAYLOAD_BYTES * 2 + 2

/**
 * Streaming scanner for ONE session's sentinels (its payload is fixed at
 * construction — the trust boundary is exactly this payload). Splits a raw
 * PTY chunk into a token stream: text (with every non-sentinel byte — other
 * control sequences included — preserved verbatim for the sanitizer down the
 * pipe) and this session's own open/close events, in stream order.
 *
 * Torn sentinels (a sequence split across PTY chunks — ConPTY is free to
 * chop anywhere) carry in a bounded buffer the same way the sanitizer carries
 * torn escapes; a carry that grows past {@link MAX_SENTINEL_LENGTH} can no
 * longer be a sentinel of this module, so it is demoted to plain text (the
 * sanitizer handles the bytes; nothing printable is ever lost). The carry is
 * pure tail-prefix state: it only ever holds a strict prefix of one sentinel,
 * so an exit-time flush has nothing printable to deliver and is not needed.
 */
export class MarkerScanner {
  private carry = ''
  private readonly openSeq: readonly [string, string]
  private readonly closeSeq: readonly [string, string]

  constructor(private readonly payload: string) {
    // [BEL form, ST form] per sentinel — both terminators are accepted (a
    // printf may emit either; the reading side is not allowed to care).
    this.openSeq = [sentinelFor(payload, MARKER_OPEN_PARAM, '\x07'), sentinelFor(payload, MARKER_OPEN_PARAM, '\x1b\\')]
    this.closeSeq = [sentinelFor(payload, MARKER_CLOSE_PARAM, '\x07'), sentinelFor(payload, MARKER_CLOSE_PARAM, '\x1b\\')]
  }

  /** Consume one raw PTY chunk.
   * @returns The token stream, in order; text tokens concatenate with
   * previous text tokens to the chunk minus this session's own sentinels. */
  push(chunk: string): MarkerToken[] {
    const buf = this.carry + chunk
    this.carry = ''
    const tokens: MarkerToken[] = []
    let text = ''
    let index = 0
    while (index < buf.length) {
      const escape = buf.indexOf('\x1b', index)
      if (escape < 0) {
        text += buf.slice(index)
        break
      }
      text += buf.slice(index, escape)
      // Exact match first (BEL or ST terminator), then a torn tail.
      const hit = this.matchAt(buf, escape)
      if (hit !== undefined) {
        if (text !== '') {
          tokens.push({ kind: 'text', text })
          text = ''
        }
        tokens.push({ kind: hit.kind })
        index = hit.end
        continue
      }
      const tail = buf.slice(escape)
      if (this.isPrefixOf(tail)) {
        // A possibly-incomplete sentinel: carry the tail and stop — the next
        // chunk completes (or refutes) it. Everything before the escape is
        // already in `text`.
        this.carry = tail
        break
      }
      // A real escape that is not one of ours (CSI, another OSC, a torn
      // foreign sequence): pass the byte through verbatim — the sanitizer
      // owns it.
      text += buf[escape]
      index = escape + 1
    }
    if (text !== '') tokens.push({ kind: 'text', text })
    return tokens
  }

  /** Flush the carry at stream end. The carry only ever holds a strict
   * prefix of one of our sentinels — control bytes, no printable text — so a
   * well-formed stream leaves it empty and a torn one discards nothing
   * printable. Returns whatever remains (for a belt-and-braces caller). */
  flush(): string {
    const rest = this.carry
    this.carry = ''
    return rest
  }

  /** Match one of the four sentinel spellings at `at`; returns the token kind
   * and the index just past the sequence. */
  private matchAt(buf: string, at: number): { kind: 'open' | 'close'; end: number } | undefined {
    for (const [kind, seqs] of [
      ['open', this.openSeq],
      ['close', this.closeSeq],
    ] as const) {
      for (const seq of seqs) {
        if (buf.startsWith(seq, at)) return { kind, end: at + seq.length }
      }
    }
    return undefined
  }

  /** Whether `tail` is a STRICT prefix of one of our sentinels (i.e. it may
   * still be completed by the next chunk). Strictness matters: a complete
   * match was already handled, and a non-prefix tail must flow through. */
  private isPrefixOf(tail: string): boolean {
    if (tail.length >= MAX_SENTINEL_LENGTH) return false
    for (const seq of [...this.openSeq, ...this.closeSeq]) {
      if (tail.length < seq.length && seq.startsWith(tail)) return true
    }
    return false
  }
}

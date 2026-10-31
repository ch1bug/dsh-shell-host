/**
 * #177 (现象二): ConPTY viewport-repaint suppression at the single ingestion
 * point. When a terminal emulator redraws its visible viewport (cursor
 * repositioning / erase sequences followed by a re-print of old screen
 * content), the re-printed TEXT survives #180's sanitizer as printable lines
 * and used to enter the line buffer as if it were fresh output — `pty_send`
 * deltas and `pty_tail` pages replayed the banner and the previous command's
 * echo (#177 现象二: 11,619 B on the wire vs 5,400 B one-shot, 2.15×).
 *
 * Two-signal contract (deliberately conservative — output fidelity first):
 *  1. RAW signal — the chunk carries a full-screen repaint-marker CSI
 *     sequence (cursor HOME or erase-display; see REPAINT_CSI). Ordinary
 *     prompt rendering (parameterized cursor positioning, line-erase) is NOT
 *     a marker — arming on it eats legitimate repeated command output
 *     (measured on the #149 AC2 real-ConPTY lane and the raw-chunk probe).
 *     Scanned on the raw chunk, BEFORE
 *     sanitization. Suppression is STATELESS, per chunk: only the chunk
 *     carrying the marker has its duplicate prefix dropped. A repaint frame
 *     torn across chunks loses protection on its marker-free continuation
 *     chunks (documented limitation — a text-level filter cannot tell a
 *     frame continuation from legitimate output that happens to repeat the
 *     previous command's identical echo/output, which real sessions produce
 *     on every repeated command; the marker-carrying chunk still loses its
 *     re-printed block, which is the bulk of the #177 现象二 cost).
 *  2. TEXT signal — in a marker chunk, the longest leading run of incoming
 *     complete lines that duplicates the trailing lines already in the
 *     buffer is dropped; the rest passes. Without a marker nothing is ever
 *     dropped: legitimate repeated output (e.g. `type f` twice in a row)
 *     must survive untouched.
 *
 * The wiring lives in session-core's `append` — stateless, no per-session
 * arming (an armed state that survives an all-duplicates chunk necessarily
 * eats the NEXT identical command's output; measured on the #149 AC2 real
 * ConPTY lane, batch N #177).
 * @module src/pty/repaint-suppress
 */

/** A repaint frame can re-print at most the visible viewport; the dedupe
 * window only needs to cover that. Generous bound, ratcheted in tests. */
export const REPAINT_WINDOW_LINES = 500

/** CSI sequences that HOME the cursor or erase the whole display — the
 * structural signature of a ConPTY full-screen repaint frame's start
 * (`\x1b[H\x1b[J` measured on the real #177 reproduction). Parameterized
 * cursor positioning (`\x1b[6;1H`, measured on every msys2 bash prompt line)
 * and line-erase (`\x1b[K`) are deliberately excluded: interactive prompts
 * render those on every command, and arming on them eats legitimate
 * repeated command output (measured on the #149 AC2 real-ConPTY lane). */
const REPAINT_CSI = /\x1b\[(?:[01]?;?[01]?[Hf]|[012]?J)/

/** Whether one raw chunk carries a repaint marker.
 * @param chunk - raw (pre-sanitization) terminal data. */
export function hasRepaintMarker(chunk: string): boolean {
  return REPAINT_CSI.test(chunk)
}

/**
 * Drop the longest prefix of `incoming` that duplicates the trailing lines
 * of `existing` (the re-printed part of a repaint frame); keep the rest.
 * @param existing - lines already retained in the session buffer.
 * @param incoming - complete lines produced by this chunk.
 * @param windowLines - dedupe window bound (viewport-sized).
 * @returns The lines to actually append.
 */
export function stripRepaintPrefix(
  existing: readonly string[],
  incoming: readonly string[],
  windowLines: number = REPAINT_WINDOW_LINES,
): readonly string[] {
  const max = Math.min(incoming.length, existing.length, windowLines)
  for (let k = max; k > 0; k -= 1) {
    let match = true
    for (let i = 0; i < k; i += 1) {
      if (existing[existing.length - k + i] !== incoming[i]) {
        match = false
        break
      }
    }
    if (match) return incoming.slice(k)
  }
  return incoming
}

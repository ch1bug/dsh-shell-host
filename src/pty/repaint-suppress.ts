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
 *  1. RAW signal — the chunk carries a repaint-marker CSI sequence (final
 *     byte H/f/J/K: cursor home/position, erase display/line). Scanned on
 *     the raw chunk, BEFORE sanitization; a marker torn across chunks may be
 *     missed (documented limitation — the sanitizer's own state machine is a
 *     verbatim vendored face this module deliberately does not extend).
 *  2. TEXT signal — only while armed (marker seen, see `append` wiring),
 *     the longest leading run of incoming complete lines that duplicates the
 *     trailing lines already in the buffer is dropped; the rest passes.
 *     Without a marker nothing is ever dropped: legitimate repeated output
 *     (e.g. `type f` twice in a row) must survive untouched.
 *
 * Arming/disarming lives in session-core's `append`: a marker arms the
 * session; the frame disarms itself on the first append whose incoming
 * lines carry NO duplicate prefix (fresh output = frame over / false alarm).
 * @module src/pty/repaint-suppress
 */

/** A repaint frame can re-print at most the visible viewport; the dedupe
 * window only needs to cover that. Generous bound, ratcheted in tests. */
export const REPAINT_WINDOW_LINES = 500

/** CSI sequences that reposition the cursor or erase the display/line —
 * the structural signature of a ConPTY repaint frame's start. */
const REPAINT_CSI = /\x1b\[[0-9;?]*[HfJK]/

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

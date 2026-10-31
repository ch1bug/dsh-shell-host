# ADR-0019: sanitized terminal buffer (contract A) with a vendored sanitizer

Date: 2026-10-31
Status: Accepted
Ticket: #180 (batch N)

## Context

The persistent-session output face carries raw ConPTY bytes: banners, command
echo, VT/CSI control sequences and viewport redraw frames all enter the line
buffer and reach the model through `pty_open`'s `initialOutput`, `pty_send`'s
delta and `pty_tail`'s pages (#177 measured ~2.15× wire cost vs the official
one-shot face on medium output, ~35× on small commands).

The official persistent-tools stack
(`tool-bash-persistent` + `terminal-bash`'s `TerminalSanitizer`, anchor
`dsh-v0.2.1-rc.2`) solves this by sanitizing at ingestion: a streaming state
machine strips CSI/OSC/short escapes (with cross-chunk carry) before the
line buffer.

The #180 grill ruling (2026-10-30) adopted **contract A**: the session
buffer changes from raw bytes to sanitized lines, for EVERY session kind
(persistent, one-shot, shell, ssh, remote) — no dual semantics. The spill
mechanism (host-side inline truncation + spill file + `read {offset, limit}`
pagination) stays untouched — #177 already proved it loses no data.

## Decision

1. **Sanitize at the single ingestion point.** `session-core`'s `append`
   runs every raw chunk through a per-session streaming sanitizer before
   line splitting; the sanitizer's trailing printable fragment is flushed
   on process exit. Because `terminal` (`shell_open`), `ssh` and `remote`
   all open sessions through the same core, one change covers every
   session kind. The buffer's byte-fidelity semantics are dropped
   deliberately: a line-oriented, printable-text contract from here on
   (progress-bar `CR` redraws become line breaks; control sequences vanish).
   One upstream-faithful edge: an exit-time flush carrying a trailing `CR`
   yields a bare newline — one empty buffer line, harmless and kept for
   verbatim fidelity with the upstream semantics.
2. **The sanitizer is a vendored verbatim copy, adopted as our own
   implementation.** The ruling's original premise — reuse
   `@deepseek-ai/dsh-terminal-bash`'s published `TerminalSanitizer` export —
   proved false on every published version (0.2.1-rc.2, 0.2.1-rc.5,
   0.2.2-alpha.2): the class is bundled internally but not exported, and
   the exports map admits no subpath, while loading the root module drags a
   six-package peer closure. Per the 2026-10-31 human ruling, the upstream
   `sanitize.ts` is copied verbatim into
   `src/pty/terminal-sanitizer.ts` (MIT; provenance, anchor commit and file
   hash recorded in the file header), is MAINTAINED HERE FIRST, and carries
   **no** commitment to switch back to a dependency; no upstream issue is
   filed. The pending-escape carry is bounded (`DEFAULT_SANITIZER_PENDING_
   BYTES`, 64 KiB).
3. **No new npm dependency.** Package.json is unchanged by this decision;
   the dependency-addition route was tried, measured (six pinned packages)
   and reverted.

## Consequences

- Tests that assert raw-byte behavior on the pty face are rebaselined onto
  printable text (the machine lane's byte measurements keep running; they
  now measure sanitized output — the #149 AC2 noise comparison reads
  strictly smaller numbers than before).
- When the release anchor (ADR-0005) moves, the vendored file is re-diffed
  against the new anchor's source; the header hash is the check.
- `spill` / truncation semantics are untouched by design.

# ADR-0020: marker-wrapped command output (sentinel-wrapped filtered view)

Date: 2026-11-02
Status: Accepted (design; implementation follows #186)
Ticket: #186 (grill ruling, this session)

## Context

Layer 1 (ADR-0019) sanitizes control sequences at ingestion; repaint
suppression (087976c) suppresses full-screen redraw residue — but by its own
declared limitation it cannot protect marker-free torn frames. The #180
three-layer reference design's layer 2 is sentinel wrapping: the shell emits
open/close sentinels around each command's own output, so consumers can
separate "command output" from "echo / banner / redraw residue" by markers
instead of text-layer heuristics (the #177 style).

The #186 grill ruled the scope question-by-question (2026-11-02, five
decisions; the ordering decision's precondition — "#181's root cause is
stream mixing" — is recorded in the ticket and the ordering reverts to the
grill if the premise fails).

## Decision

1. **Dialect scope: bash only first** (Q1). One dialect — bash, including
   ssh sessions whose remote shell is bash — carries the mechanism to
   proven status (injection point, sentinel lifecycle, adversarial face).
   Wider dialect matrices (cmd/pwsh prompt hooks, non-bash remote shells)
   are replication of a proven mechanism and are decided later, not in
   this design.
2. **Coexistence with repaint-suppress; retirement is a separate ticket**
   (Q2). Marker-based filtering takes precedence where markers are present
   and trustworthy; the text heuristics stay as the fallback so non-bash
   dialects do not regress to unprotected. Retiring the heuristics (and
   revisiting the #177 regression surface) is deliberately deferred to a
   separate future ticket.
3. **Sentinel format: random payload inside an OSC private-sequence
   envelope** (Q3). Each session generates a high-entropy per-session
   payload; open/close sentinels are emitted as a matched pair inside an
   OSC private sequence. This combines the standard shell-integration
   channel (terminal-ecosystem compatibility) with per-session
   unguessability: a fixed sequence alone would be forgeable by user
   output (cat of binaries, OSC-133-emitting programs), which the random
   payload directly addresses; the close sentinel is only trusted when
   paired with this session's open sentinel.
4. **Filtered view lives in the core; vocabulary reuses #185's shape**
   (Q4). `session-core` maintains two views: raw (the ADR-0019 contract —
   sanitized lines, spill retention — untouched) and filtered (sentinel
   splitting). `pty_tail`/`read` consume the filtered view by default;
   evidence faces that need raw name it explicitly. The filtered page
   reuses the #185 pagination vocabulary verbatim
   (`{text, offset, limit, totalLines, truncated}`), with offset/totalLines
   semantics scoped to the filtered view — no second vocabulary.

## Consequences

- Consumers get precise output framing without text heuristics on bash
  faces; torn-frame residue that heuristics cannot see becomes filterable.
- Raw-view faces (sanitizer, spill, evidence) keep their ADR-0019
  contract; the filtered view is additive.
- The heuristic retirement question is open by design; a follow-up ticket
  will take it with the #177 regression surface.
- Implementation ticket: #186 (implementation precedes #181 per Q5, whose
  premise is recorded above).

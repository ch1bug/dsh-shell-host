# ADR-0005: module release tags anchor to the official DSH version

Date: 2026-10-03
Status: Accepted

## Context

The dsh-shell module family (dsh-shell-host, dsh-shell-remote) forks its type
vocabulary from the official DeepSeek Harness (DSH) seam packages. DSH ships
tagged releases such as `dsh-v0.2.0-rc.2`. Users on different DSH versions
need to know which module version is compatible with which DSH baseline;
independent per-repo semver drifts and hides that mapping.

## Decision

1. Every release tag of a dsh-shell module is
   **`dsh-v<official-dsh-version>-r<module-revision>`** — e.g.
   `dsh-v0.2.0-rc.2-r1`. The tag shares the official release's prefix so
   tags of the whole family sort together in git.
2. `<official-dsh-version>` is the DSH release the module's seam types are
   currently anchored to. Bumping the anchor is a deliberate act that lands
   with (or after) the corresponding seam-type sync; it resets
   `<module-revision>` to 1.
3. `<module-revision>` increments by 1 on every module release that does not
   change the anchor.
4. `package.json` `version` mirrors the tag without the `dsh-` prefix
   (`0.2.0-rc.2-r1`); the authoritative join key is the git tag.
5. Compatibility contract: a module tagged `-r<N>` against anchor X is built
   and verified against X's seam types; no claim is made about other
   anchors.
6. **(2026-10-17) The admission gate and the certified anchor are separate.**
   A module declares `engines.dsh` as a **range** over the release line it
   tolerates (`~0.2.1-rc.1` today). Because a plugin's own `engines.dsh`
   decides alone, DSH `peerDependencies` no longer gate admission, so
   intermediate releases inside that line install and boot without a
   per-release landing. The exact pins (the `dsh-tools` dependency and the
   peer set) and the release tag still name the single version the module was
   actually built and verified against.

   Rationale (measured 2026-10-17): the desktop follows the `next` channel
   and moved `0.2.1-rc.1 → 0.2.1-rc.2` within hours; that delta changed
   version numbers only — no `src/` change across the seam packages and an
   identical `dsh-tools` peer set. Exact-pin admission turned every such
   release into a user-visible outage (the bundle is skipped whole at profile
   load), which the range removes.

7. **(2026-10-20) A justified exception to the "direct `dsh-tools` peers only"
   set (`#107`): `@deepseek-ai/dsh-jobs` and `@deepseek-ai/dsh-tool-jobs`,
   both pinned `0.2.1-rc.2`.**

   Neither package is a direct peer of `dsh-tools`, so decision 6's certified
   set — the `dsh-tools` dependency plus the direct peer set — does not admit
   them by itself. The exception is recorded here rather than silently
   appended because the set is what a release claims to be verified against.

   - **What it buys** (`#120`): `run_in_background` on `pty_send` /
     `ssh_send`. The work is WIRING, not a new surface: the desktop host
     already ships this stack (`dsh-jobs` / `dsh-jobs-local` /
     `dsh-tool-jobs` are in `app.asar`), and the alternative designs were
     rejected in the ticket's grill (not integrating contradicts an existing
     host capability; writing our own controller reimplements
     `dsh-tool-jobs`).
   - **They are a PAIR**: `dsh-jobs.start` refuses work while no attached job
     controller serves the owner, and the controller lives in `dsh-tool-jobs`.
     Declaring the registry alone would be a path that can only fail loudly —
     so the missing-service error names BOTH packages and never downgrades to
     a foreground send.
   - **Cost, stated**: one more known-missing peer shows up in
     `pnpm peers check` (`dsh-output-retention`, a peer of `dsh-tool-jobs`).
     Like the pre-existing `dsh-fs` / `dsh-session-projection` entries it is a
     peer-of-a-peer and is accepted, not chased (`docs/dev-environment.md`
     §4.4).

   Only this pair is admitted. A third package outside the `dsh-tools` direct
   peer set needs its own dated decision here, with the same shape: what it
   buys, why wiring beats building, and what it costs.

## Consequences

- The compatibility matrix (DSH version × module version) is readable
  directly from tag names — no CHANGELOG archaeology.
- `-rN` suffixes are NOT semver pre-releases; tooling that sorts tags must
  treat `dsh-vA-rN` as opaque strings ordered by N within one anchor.
- Anchoring is follow-the-official, not automatic: a new DSH release does
  not force a module release until someone syncs the seam types and bumps
  the anchor.

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

## Consequences

- The compatibility matrix (DSH version × module version) is readable
  directly from tag names — no CHANGELOG archaeology.
- `-rN` suffixes are NOT semver pre-releases; tooling that sorts tags must
  treat `dsh-vA-rN` as opaque strings ordered by N within one anchor.
- Anchoring is follow-the-official, not automatic: a new DSH release does
  not force a module release until someone syncs the seam types and bumps
  the anchor.

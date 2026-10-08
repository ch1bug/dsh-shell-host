# ADR-0007: shell-host absorbs the shell-execution domain — single package, multi entry

- Status: Accepted (grilled consensus, 2026-10-03; batch 4 decision-first
  ticket #27, recorded 2026-10-08)
- Deciders: human (grill session 2026-10-03)
- Context: #27, batch 4 (#28 `./pty` → #29 `./remote` → #30 `./wsl` →
  #31 archive), ADR-0004 (remote in its own repo), ADR-0005 (release-tag
  anchoring), ADR-0006 (ssh registry entry, route B), ADR-0003
  (multi-backend registry), CONTEXT.md D9/D10
- Precedent: mimo-agent-tools absorbing voice-mimo's `./client` + `./mimo`
  entries

## Decision

**dsh-shell-host becomes the shell-execution-domain monolith**: one
package, multiple entry points —

- `./host` — the existing executor package (registry, backends, plugin
  shell), unchanged.
- `./pty` — absorbed from dsh-pty-session: persistent/interactive shell
  sessions (local or ssh).
- `./remote` — absorbed from dsh-shell-remote: one-shot remote execution
  over system OpenSSH.
- `./wsl` — the plugin-layer WSL bridge entry (see form below).

Each entry keeps its **own settings namespace** — sharing a package does
not merge config surfaces (precedent: mimo-agent-tools' `./client` and
`./mimo` stay separate namespaces).

### Which ADR-0004 decisions this supersedes

ADR-0004 decision 2 is revised: "remote execution is a separate
repository (`dsh-shell-remote`)… no cross-registration in either
direction" — the **separate-repo** half is superseded; dsh-shell-remote
merges into dsh-shell-host as the `./remote` entry. What does NOT change:

- **`./remote` is NOT a registry backend.** It keeps its own seam and its
  own entry: the `backend` config single-select (ADR-0003/ADR-0006) never
  points at it. This is distinct from ADR-0006's `ssh` registry entry —
  that was route B's thin transport folded into the local one-shot
  registry, and it stands. The remote one-shot world and the local
  registry remain separate layers; #16's boundary conclusion is unchanged
  in substance — only its address moves into this package.
- ADR-0004 decision 1 (staged thin transport first) — unchanged, absorbed
  as-is.
- ADR-0004 decision 3 (system OpenSSH; ssh library behind revisit) —
  unchanged, absorbed as-is.
- ADR-0004 decision 4 (D8 field-identical contract; remote path
  semantics; loud spill rejection) — unchanged, absorbed as-is.
- ADR-0004 decision 5 (persistent sessions live in the pty-session world)
  — the *ownership* conclusion is unchanged; only the home moves from the
  dsh-pty-session repo to the `./pty` entry of this package.

### Entry form differences (declared, not flattened)

`./wsl` is a **plugin-layer entry**, categorically different from the
executor entries `./host`/`./pty`/`./remote`:

- executor entries produce executor semantics (one-shot / persistent
  execution worlds);
- `./wsl` is a plugin entry built on `defineTool` + `ctx.tools` and
  depends on `@deepseek-ai/dsh-tools` — it registers tools, not
  execution backends.

The dependency boundary is explicit: `./wsl` depends on the dsh plugin
tool seam; executor entries do not. Redundancy check conclusion: `./wsl`
and the existing `src/wsl-bridge.ts` (pure path mapping inside the wsl
backend, ADR-0003 decision 5) are **two layers, not one** — the plugin
entry and the in-backend bridge are deliberately not merged.

### Release anchoring

Post-merge releases follow ADR-0005 as one package: the three source
repos are all anchored at **`dsh-v0.2.1-alpha.1-r1`**, and the merged
package carries that anchor forward (next release = `-r2` or an anchor
bump, per ADR-0005 rules).

**DELIBERATE amendment (#35, decided 2026-10-08): the merged package
does NOT carry the alpha.1-r1 anchor as its package version.** The
package version stays on the DSH lane it actually consumes (npm dist
`0.2.0-rc.2` series, currently `0.2.0-rc.2-r1`), and the D8 conformance
canary derives its anchor from this package.json — the runtime truth.
Reason: #18 locked the desktop daily-driver on the stable `rc.2` lane;
a version bump to an alpha.1-equivalent anchor would reintroduce the
incompatible-peer warning that #18's interim fix removed. The source
repos' `dsh-v0.2.1-alpha.1-r1` provenance anchor stays recorded in
ADR-0005 and the entry headers; the "carry forward" obligation is
discharged by this note, not by the version field. **Revisit trigger:
when the next RC (or the alpha.1 promotion) lands, re-derive the
package version + canary anchor from that lane in one move** (the #18
tracker's three-step upgrade covers the same event). Known risk riding
with this lane choice (#36 finding): upstream `@deepseek-ai/*` alpha
copies (schemastery 3.18.5-alpha.1, cosmokit 1.8.6-alpha.1) nest inside
node_modules via dsh-tools' hard dependency — declaration emit is
collapsed with `preserveSymlinks` (build lane only); the upstream type
surface itself is out of this repo's control.

## Nature of the change

**Pure move.** Absorbing the three repos (`./pty`, `./remote`, `./wsl`)
is a relocation with zero behavior change: code moves, tests move, no
API, contract, or semantics change. The only deliberate deltas are the
addresses (entries) and the settings namespaces living in one package.

## Consequences

- Three repos (dsh-pty-session, dsh-shell-remote, dsh-wsl-bridge) become
  archival after #28–#30 land; #31 (human-owned) handles archiving and
  deprecation READMEs.
- One release train, one anchor (ADR-0005); tag names no longer
  distinguish per-repo modules within the shell-execution domain.
- Settings namespaces stay per-entry; users configure `./host`,
  `./pty`, `./remote`, `./wsl` surfaces independently.
- CONTEXT.md's three-repo vocabulary (D10) describes the pre-merge
  world; the glossary's entry term now covers this ADR.

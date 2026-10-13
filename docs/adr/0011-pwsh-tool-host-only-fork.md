# ADR-0011: Host-only fork of the platform pwsh tool (same-name takeover)

- Status: Accepted (issue #63 deliverable)
- Date: 2026-10-10
- Deciders: human (route A "host-only fork" over route B "upstream PR", 2026-10-10, recorded in the #63 triage comment)
- Context: issue #63; ADR-0002 (the fork precedent this decision copies); ADR-0007 (plugin-layer vs executor-layer entry forms); ADR-0010 (the own-channel world the one-shot execution rides beside)

## Context

The platform `@deepseek-ai/dsh-tool-pwsh` (base-bundle row `tool-pwsh`) asks its
executor for a bare `pwsh`; when PowerShell 7 is absent the deployment falls
back to BASH, so the model's `pwsh` tool — advertised as PowerShell dialect —
runs bash. Verified upstream fact (issue #63 reproduction): a Windows machine
with only Windows PowerShell 5.1 gets bash. This repo's own two layers are
already correct: the backends pwsh descriptor (`src/backends.ts` #3, D7 phase
1.5) probes `pwsh.exe → powershell.exe` and fails loudly naming every probe
point, and the launcher layer's `powershell` preset points at `powershell.exe`
— the defect is only the platform TOOL row.

## Decision

Ship a **host-only fork** of the tool inside this package (`src/pwsh.ts`,
exported as `dsh-shell-host/pwsh`), **in-bundle only — an upstream PR is
explicitly NOT pursued** (route B reserved for the maintainer's call; human
decision 2026-10-10). The fork registers the SAME tool name (`pwsh`,
defineTool + ctx.tools, the ADR-0007 plugin-layer entry form) and a
cordis.patch.yml insert row owning the loader id `tool-pwsh` — the
permission-presets takeover mechanism (ADR-0002 Option-A amendment: same-id
later row, loader last-wins), so the upstream module never composes on win32.

1. **The one semantic delta is executable resolution**: the ordered
   `pwsh.exe → powershell.exe` probe (`pwshProbedLocations` + `spawnableExists`,
   the same candidate list the backends descriptor uses), with a loud
   double-absence failure naming every probe point — never a bash fallback.
   With only 5.1 present, PowerShell syntax executes normally through
   `powershell.exe -Command` with the descriptor's UTF-8 output preamble.
2. **Layer separation holds (ADR-0007 red line)**: one-shot execution rides
   `ctx.subprocess` directly (a one-shot command is not a PTY-world problem);
   the backends pwsh descriptor is the executor layer and is NOT touched,
   imported, or merged — the two planes coexist.
3. **Scope parity is deliberately narrow**: foreground one-shot execution with
   kill-on-timeout, bounded output + spill notes, bash-tool rendering story.
   No background jobs, no sandbox escalation surface, no systemPrompt section —
   re-introduced only when a ticket needs them.
4. **Platform gating mirrors the base row verbatim** (`disabled: !!js
   process.platform !== 'win32'`): on POSIX the platform row was already
   disabled; the takeover must not flip it on.

## Consequences

- On a PowerShell-less Windows machine the `pwsh` tool now fails LOUDLY with
  the full probe list instead of silently running bash — the model can react
  to a real diagnosis instead of a wrong dialect.
- A second permanent drift surface joins ADR-0002's: the fork is a narrow-scope
  re-implementation of upstream `packages/shell/tool-pwsh` at the pinned tag;
  every DSH bump re-diffs against upstream for surface changes (tool name,
  argument schema, rendering story). The drift alarms are the acceptance tests
  (`tests/pwsh-tool.spec.ts` patch pins + behavior pins) and the machine lane
  (`tests/pwsh-tool-machine.spec.ts`, the real 5.1 fallback with UTF-8 output).
- Upstream tool features this fork does not carry (background jobs, sandbox
  escalation, system-prompt section) are NOT regressions to file against the
  fork — they are the documented narrow scope; a ticket opens if a deployment
  needs one.

## Amendment (issue #72, 2026-10-13): the fork is the narrow component — default enabled

Human ruling (expectation 4+3): the fork ships as an **independent narrow
component** — default `enabled` (win32-only, the base row's gating verbatim),
covering ONLY the `pwsh` tool's executable probe chain
(`pwsh.exe → powershell.exe`, no `*bash*` candidate ever), never `ctx.shell`
— the #23 AC7 opt-in contract governs the shell seam and is not engaged. The
`enabled` config key (default true) opts a deployment out: false unregisters
the tool entirely; because the loader row replaces the platform row, opting
out NEVER reintroduces the bash fallback.

Two evidence notes recorded for the record:

1. The ruling framed this as narrowing the scope from "whole-row takeover";
   in this repo the fork already was that narrow (it never touched
   `ctx.shell`), and the `tool-pwsh` row has been enabled on win32 since the
   original commit (c6ffc25) — including the shipped `0.2.0-rc.2-r1` tgz.
   The #72 report's premise ("the takeover row defaults to disabled") does
   not match the artifact evidence; the deployed 44.0.0 bash-fallback
   observation remains unexplained by it (tracked on #72).
2. Deliverables under this amendment: the `enabled` toggle, the
   no-bash-candidate regression pins, the ctx.shell-untouched pin, the
   README "default behavior + bypass" section, and this ADR note.

### Verification record (#72 AC)

- **configForms toggle**: the row's settings form is the settings-controller's
  per-row derivation (namespace = row id, a GLOSSARY-verified implementation
  fact from #23/#55); the entry's `Config` static carries
  `enabled: z.boolean().default(true)`, which renders as the default-on
  toggle. No bespoke client code is added — the `shell-host` card is bespoke
  only because it predates nothing; it customizes layout, not existence.
  Live Plugins-page rendering of the `tool-pwsh` toggle is pending desktop
  verification (noted on #72).
- **Narrow component + full-seam row coexistence**: structural, pinned by
  tests — the shell-host executor row registers NO tools and only provides
  `ctx.shell`; the narrow row registers the `pwsh` tool and is pinned to
  never touch `ctx.shell` (the sentinel-identity pin). The two rows share no
  service and no config namespace (`shell-host` vs `tool-pwsh`), so
  co-enabling cannot conflict; the single-takeover-row yml pin guarantees
  the `pwsh` tool has exactly one owner.
- **AC3 (missing pwsh.exe resolves powershell.exe)**: covered by the #63
  ordered-probe tests (PATH hit, install-root win, 5.1 fallback) plus the
  real-5.1 machine lane (`tests/pwsh-tool-machine.spec.ts`); the #72 pin adds
  the no-`*bash*`-candidate invariant over the whole chain.
- **npm-lane (human-required 2026-10-13)**: after `pnpm build`, the BUILT
  `lib/pwsh.js` re-passes all six behavioral checks in plain Node
  (`.scratch/verify-72-npm.mjs`: default-on registration, `enabled: false`
  opt-out, missing-pwsh.exe → powershell.exe argv, loud double-absence probe
  list, no bash candidate in the probe list — advisory prose aside,
  ctx.shell sentinel identity), and a fresh `pnpm pack` carries the
  `tool-pwsh` row (win32 gating verbatim) plus the `enabled` schema in
  `lib/pwsh.js`; `scripts/verify-pack.mjs` green (all 16 export entries
  packed and importable).
- **Opt-out semantics** (Brief AC "回到上游现状" — recorded deviation):
  `enabled: false` unregisters the tool entirely. Restoring upstream behavior
  is impossible without un-replacing the platform row, and re-teaching a bash
  fallback is the bug this component exists to kill — so opt-out = tool
  offline, never bash. Deviation flagged to the maintainer on #72.

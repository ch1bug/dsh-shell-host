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

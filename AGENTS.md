# AGENTS.md

This workspace is a DSH bundle repo (`dsh-bash-msys`) built with the Matt
Pocock AI-coding workflow. Route work through the flow skills (grill →
to-spec → to-tickets → implement).

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`ch1bug/dsh-bash-msys`), operated via the `gh`
CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

## Project context

Read `CONTEXT.md` first — it carries the verified upstream facts and the
grill-locked decisions (D1–D7) this repo is built on.

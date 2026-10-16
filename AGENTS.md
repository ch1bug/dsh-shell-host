# AGENTS.md

This workspace is a DSH bundle repo (`dsh-shell-host`) built with the Matt
Pocock AI-coding workflow. Route work through the flow skills (grill →
to-spec → to-tickets → implement).

**Package posture (ADR-0012/0013, 2026-10-16): tools-only plugin.** The shell
executor world is gone — no `ctx.shell` provider, no backends, no upstream
loader-row takeover. Entries: `./pty` (persistent PTY sessions), `./terminal`
(`shell_open` launcher presets), `./wsl` (WSL bridge tools). Remote one-shot
belongs to the standalone `dsh-shell-remote` plugin (route C).

## Agent skills

Engineering skills (v1.3.1, vendored editable copy from
`github.com/mattpocock/skills`) live in `.claude/skills/<skill-name>/SKILL.md` —
read one directly before running that workflow.

### Issue tracker

Issues live in GitHub Issues (`ch1bug/dsh-shell-host`), operated via the `gh`
CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

### Profile install & debugging

Plugin not found / composition errors / how this repo reaches a live DSH
profile (symlink, registration records, restart semantics): see
`docs/agents/profile-install.md`. Install only via the plugin manager — a
hand-made node_modules symlink is not a registration.

## Project context

Read `GLOSSARY.md` first — it carries the verified upstream facts and the
grill-locked decisions (D1–D8) this repo is built on.

## Build & verify

```bash
pnpm typecheck   # one facade: tsconfig.json (source paths)
pnpm build       # tsc -p tsconfig.build.json (declarations, lib/types/*.d.ts) → tsdown (lib/*.js)
pnpm test        # typecheck (tests-inclusive) then vitest unit + machine; ssh-pty-live cases skip without DSH_SSH_LIVE_HOST

No CI (maintainer decision 2026-09-30): verification is local (typecheck/test + issue evidence). Do not propose adding ci.yml.
```

Verification layering, evidence discipline, and the loud-skip / failure-attribution
rules (synced with the adjacent matt workspace):
see `docs/agents/TESTING.md`.

Gotchas (learned the hard way):

- `!!js` values inside `cordis.patch.yml` that contain a colon-space (`: `)
  must be block scalars (`!!js >-`) — colon-space breaks YAML plain-scalar
  parsing. Colon-free inline expressions (the platform guards) are fine;
  upstream base uses them verbatim.
- Launcher argv/prefix constants (`*_INTERACTIVE_ARGV`, `msys2PathPrefix`,
  `parseWslDistroList`) live in `src/launchers.ts` (ADR-0013) — do not
  recreate a second argv table.
- Never mount a loader row that takes over an upstream row id (ADR-0012) or
  reintroduce an executor/ctx.shell provider (ADR-0013).

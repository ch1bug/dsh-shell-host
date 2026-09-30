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
grill-locked decisions (D1–D8) this repo is built on.

## Build & verify

```bash
pnpm typecheck   # two facades: tsconfig.json (host, source paths) + tsconfig.client.json (client, built d.ts paths)
pnpm build       # tsc -b (upstream deps) → tsc -p tsconfig.build.json (host declarations) → tsdown (lib/index.js + lib/client.js)
pnpm test        # vitest unit loop; MSYS-dependent cases skip when C:\msys64 is absent
pnpm test:e2e    # the T5 engine-side E2E checklist; needs a real MSYS2 (C:\msys64), DSH_MSYS_ROOT overrides
```

Gotchas (learned the hard way):

- The client half is bundled by tsdown straight from `src/client/*.tsx` — the
  client facade is noEmit-only. An emit lane over the upstream source paths
  map cannot close (rootDir + ambient CSS-module declarations live in each
  upstream package's own tsconfig).
- `!!js` values inside `cordis.patch.yml` that contain a colon-space (`: `)
  must be block scalars (`!!js >-`) — colon-space breaks YAML plain-scalar
  parsing. Colon-free inline expressions (the platform guards) are fine;
  upstream base uses them verbatim.
- `pacman -Q` alone costs ~4s on Windows; don't tighten the e2e timeouts.

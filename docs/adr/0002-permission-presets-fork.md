# ADR-0002: Host-only fork of permission-presets over the non-confining executor

- Status: Accepted (issue #10 deliverable)
- Date: 2026-09-30
- Deciders: human (path decision "in-bundle fork only, no upstream PR", triage 2026-09-30); fork shape "host-side only"
- Context: `CONTEXT.md` D8 + its regression note; ADR-0001 T5/D8 amendment §4(b); issue #10

## Context

D8's host-plane replacement makes the MSYS2 executor (which never confines and
therefore reports `sandboxMode === undefined`) the host `ctx.shell` on win32.
The upstream `@deepseek-ai/dsh-permission-presets` plugin treats that posture
as a hard misconfiguration and throws at composition, so the
`permissionPresets` host service never starts. The stock client UI row
(`dsh-client-ui-permission-presets`) injects the remote service BY NAME, so
all three permission surfaces — the `/permission` command, the settings-page
PermissionRow, and the conversation-input permission selector — go dark.

## Decision

Ship a **host-side fork** of the plugin inside this package
(`src/permission-presets.ts`, exported as `dsh-bash-msys/permission-presets`),
**in-bundle only — an upstream PR is explicitly NOT pursued** (human decision
2026-09-30; permanent drift surface accepted).

1. **Identity is the contract.** The fork registers the same Cordis service key
   (`permissionPresets`), the same Typert wire namespace (`typertRemote`), the
   same `/permission` command definition id
   (`@deepseek-ai/dsh-permission-presets`), the same `permission/preset`
   session event, and the same `permissions` projection unit (state shape and
   view shape identical). The STOCK client UI therefore composes against the
   fork with zero client-side changes — no client code is forked or patched.
2. **Semantics: presets stay knob bundles, but the sandbox knob is the file
   policy.** The empty-log sandbox fallback is `ctx.sandboxPolicy.defaultMode`
   (the same knob `sandbox/mode` writes through), NOT
   `ctx.shell.sandboxMode`. The fork neither imports nor reads the shell seam;
   no code path claims process confinement. Switching a preset still writes
   BOTH knobs (`sandbox/mode` + `approval/policy`) through their canonical
   setters, so execution, the file sandbox, and any confining backend all
   observe the change.
3. **Mount shape follows the repo's patch discipline:** disable the base
   `permission` row on win32 (with the `name:` validation guard
   `'@deepseek-ai/dsh-permission-presets'`), insert the fork row
   (`permission-msys`, name `dsh-bash-msys/permission-presets`) carrying the
   base bundle's 3-preset table verbatim. Both rows are dormant on POSIX,
   where the upstream plugin keeps composing over the confining base executor.
4. **Drift management:** the fork is a minimal delta of upstream
   `packages/interaction/permission-presets/src/index.ts` at the pinned tag
   (`dsh-v0.2.0-rc.2`). Every upstream bump re-diffs this file; the delta is
   exactly: (a) no sandboxMode guard, (b) `sandboxPolicy` replaces `shell` in
   `inject` and in the two fallback reads (upstream's side-effect type
   import of `dsh-shell` removed with it), (c) the fork's own header docs,
   (d) upstream's `./types.ts` module is INLINED (PresetOption /
   PermissionCatalog / PermissionSelection + the cordis Events and
   SessionProjectionMap declare-blocks live in the fork file; the
   `export type *` re-export is dropped), and (e) the `dsh-settings`
   type import points at the sibling checkout's BUILT declaration (see
   Consequences). Anything beyond this list on a re-diff is unreviewed drift.
   Acceptance tests pin the identity, the write-through, and the patch shape
   (`tests/permission-presets.spec.ts`).

## Option-A amendment (2026-09-30, human decision — supersedes the mount shape in Decision §3)

- **Option-A amendment (2026-09-30, human decision on the settings-row
  blocker):** the stock settings PermissionRow binds the **loader entry id**
  `'permission'` (settings namespace = `entry.options.id`; the client row
  hard-codes ns `'permission'`), not the service identity — so the Brief's
  original "disable base row + insert under a new id" shape cannot revive the
  settings row, on any mechanism (patch ops cannot rewrite a row's `name`,
  `!!js` does not evaluate `name`, and a same-id insert replaces the earlier
  row's options entirely). Decision: the fork insert row **owns the id
  `permission`** and composes on BOTH platforms; the upstream module never
  composes in this deployment. This supersedes the Brief's "fork dormant on
  POSIX" acceptance line — behaviorally lossless because upstream's confining
  executors derive `sandboxMode` from `ctx.sandboxPolicy.defaultMode`
  themselves (bash-sandbox/pwsh-sandbox src), making the fork's fallback
  value-identical over confining executors. The replacement mechanism is
  loader same-id last-wins (`group.update` newMap + `Entry.update
  create:true`); the patch-shape tests pin the id, the absent platform guard,
  and the verbatim base table.

## Consequences

- The three permission UI surfaces revive on win32 with the stock client —
  verified locally by composition tests; real-session confirmation is the
  issue's embedded human checkpoint.
- Upstream changes to the service identity (service key, wire namespace,
  command definition id, event/projection shapes) now also constrain this
  fork: the drift alarm is the identity assertions in the acceptance suite
  plus the re-diff discipline above.
- **Live-finding amendment (2026-09-30, first human checkpoint failed and was
  diagnosed):** tsdown's oxc transformer passes the `@Remote('catalog')`
  decorator through to the host lib, where Node rejects it as a syntax error
  at import — the fork row composed but the plugin never activated, leaving
  all three UI surfaces dark with no visible error. Fix: tsdown-plugin.ts
  lowers standard decorators with TypeScript before bundling (the same
  transform as vitest.config.ts); tests/built-artifact.spec.ts guards the
  built artifact's importability.
- The fork accepts `zod@4.4.3` (upstream's own pin) as a runtime dependency —
  a newer minor (4.6.x) produced type-instantiation failures at the
  projection `register` call, so the pin is deliberate.
- `dsh-settings` types are ingested from the upstream package's BUILT
  declaration rather than the source paths facade: the source chain
  settings → config-editor → hmr does not compile under this repo's relaxed
  single-program flags (runtime import is type-only and stripped).

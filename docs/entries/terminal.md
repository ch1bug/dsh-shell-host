> Extracted from the README (issue #55, ADR-0008; registration surface ADR-0018). Back to the [README](../../README.md). 中文版：[terminal_zh.md](terminal_zh.md)。

## The `./terminal` entry (issue #55, ADR-0008)

`src/terminal/` is the launcher layer's plugin entry: ONE tool,
`shell_open(preset, cwd?, env?, idleTimeoutMs?)`. It resolves a launcher preset through the
#54 layer (`src/launchers.ts` — declarative argv/prefix tables + detect scans +
custom presets from its settings namespace) and opens it on the `./pty`
entry's session core. The returned sessionId IS a core session id:
everything afterwards goes through the existing `pty_send` / `pty_tail` /
`pty_close` — no second tool family (ADR-0008 decision 5, no Middle Man).
Unknown ids fail loudly listing every serviceable preset; uninstalled
environments fail loudly naming every probe point. The entry's settings
namespace (`terminal`) carries the custom-preset data channel (the #54
shape; the CRUD UI is a later ticket reading the same data); the built-in
preset table is read-only, surfaced live by the unknown-id error.

**Division of labor (#149)**: `shell_open` is the **preset surface** — launcher
preset + preset environment (`MSYSTEM` / `CHERE_INVOKING` / PATH prefix);
`pty_open({ shellCommand })` is the **bare-declaration surface** — one command,
zero vocabulary, **no** preset-environment injection. This package does **not
copy** the preset table and does **not add** preset ids (ADR-0008's single
source stands); use the former for a preset environment, the latter for one
arbitrary interpreter.

### Override rules / concurrency cap / idle timeout (#56 ruling)

- **Preset provenance**: the `shell_open` result carries loud fields
  `source: 'builtin'|'custom'` and `overrode: true|false` (true only when a
  custom preset actually replaces an existing built-in view; shadowing an
  uninstalled built-in does not count as an override). The result also carries
  `executable` (the matched candidate) / `probed` (all candidate probe points) /
  `cwd` (the value actually in effect); it does not return the full env (once
  merged it is the whole PATH, nothing incremental) and does not repeat argv
  (`command` already contains it). The decision single source is
  `resolveLauncherDetailed` (`src/launchers.ts`).
  ⚠️ Since #105, **same-id overrides are blocked at the registration gate**
  (see the section below) — through the legitimate registration channel
  `overrode` can no longer be true; the field remains as a provenance fact.
- **Concurrent soft cap (core-derived since #61/#62)**: the count comes from the
  pty core's **registry** (owner attribution, released on `pty_close`; plugin
  dispose reclaims everything) — re-mounting the entry can no longer reset the
  count to zero (the seam-era root cause of #62 vanished with the seam). The
  default cap is 8, configurable via the settings namespace
  `terminal.maxSessions` (same default as the pty core's identically named
  setting); over the cap `shell_open` fails loudly, listing the current session
  count and every session id. There is no default idle timeout — the persistent
  terminal (long-lived watcher/REPL) is this layer's selling point;
  `idleTimeoutMs` (optional, per-session) is enforced by the pty core's
  watcher: with no **new output** for that duration the session auto-closes
  (#56 ruling: there is no reliable idle criterion, hence opt-in and
  output-defined).
- **Per-session idle timeout**: the optional `shell_open(preset, idleTimeoutMs)`
  parameter — when the caller explicitly opts in, that session auto-`pty_close`s
  after **no new output** for `idleTimeoutMs` milliseconds (idle criterion = the
  output line count no longer grows; new output resets the timer). Sessions
  opened without the parameter are never idle-reclaimed.

### Custom shell registration surface (#105/#170, ADR-0018)

The `custom` channel hands one **executable path + argv + env + PATH prefix**
to `shell_open` — the registration surface is itself an attack surface, hence
the registration gate (`src/terminal/register.ts`):

- **Authoritative storage (since #170): the custom.d file family**. Each custom
  preset is one JSON file (`<customDir>/<id>.json`, the file name must equal
  the entry id); the directory is given by the terminal row setting `customDir`
  (absolute path), defaulting to `<DSH_HOME or the user home directory>/.dsh/custom.d`.
  **The `config.custom` array written in a patch row is no longer authoritative**:
  since #170, mounting ignores hand-written legacy entries (legacy = an array
  entry with no corresponding file records an audit event); since #169 the
  `custom` field is defined as the **config-page write channel** (volatile +
  transport semantics) — the array the page saves is materialized into the file
  family by the host half, and what remains in the patch is only the
  materialized transport residue (one-time migration below).
- **Writers**: written only by **humans** — by editing the custom.d files
  directly, or via the **config page** (#169, the human's GUI, not an agent
  write port); the tool surface has no registration write port at all
  (`terminal_list` is a pure read-only surface, locked by guard tests).
- **Registration gate (mount time, per-entry disable)**: each entry passes
  through a validation matrix — id non-empty and charset-locked, no duplicates
  within the file family, **overriding a built-in id forbidden**; local
  executable candidates must be an absolute path + contain a path separator
  (bare names rejected — PATH resolution can be hijacked by a renamed
  binary) + no quotes or shell metacharacters + exists and is not a directory;
  spaces are allowed (legitimate Windows install paths; spawn uses an argv
  array); ssh rows must have a host; `cwd` if declared must be absolute; the
  `base` inheritance source must be a built-in id or an earlier-accepted custom
  id. A failed validation **disables only that entry** (`terminal_list` renders
  `disabled` + the original reason text); the remaining entries mount as
  usual; after fixing the file, **the next mount admits it automatically**
  (no command needed).
- **Registration audit ledger (#170)**: `<customDir>/audit.jsonl`, an
  append-only JSONL — registered / disabled / enabled / changed / ignored /
  removed events persist with the profile; materializations initiated by the
  config page record `changed` / `removed` (with `origin: 'config-page'`).
  Every time `shell_open` starts a custom preset, the matched executable's
  content hash is compared against the ledger baseline; on mismatch the result
  carries a **warning field** for that run (not blocking — blocking authority
  belongs to the #102 permission gate; matching hash or no ledger record means
  no warning). The baseline records only first registration; later changes are
  observed as `changed` events, never touching the baseline.
- **Config page (#169, ADR-0013 revision)**: the package ships its own browser
  half (`dsh.client` `{platform:'web'}` + the `./client` export →
  `lib/client.js`; React rides the host baseline module table,
  `dsh.client.external` left empty) and registers a
  `plugins.row.config` config page (key `dsh-shell-host#terminal`) on the
  terminal row of the plugin manager: create/edit/delete custom presets with a
  live preview of the full launch command; **saving** = via the host
  `settings.mutate`, writing the volatile `custom` field on the terminal row's
  user layer (optimistic locking; on conflict it prompts refresh-and-retry);
  the host half listens for the volatile update and materializes the array
  into the custom.d files — the file family remains the single authority, and
  a save takes effect immediately (the next `shell_open` needs no
  restart/remount). The browser half hangs on the package's single row; when
  the bundle later splits into multiple rows the page closes with the root
  row. **Built-in presets are not listed in the page** (the browser surface has
  no launcher-table channel; `terminal_list` is the agent surface) — the page
  manages only the custom surface.

**One-time migration (patch row → custom.d)**: take each object out of the
terminal row's `config.custom` array and write it out one by one as
`<customDir>/<id>.json` (UTF-8, content = that object verbatim), then delete
the `custom` array from the patch row (or re-save once via the #169 config
page — a page save materializes these entries into files). Before the profile
restarts, the old form is merely ignored (with an audit event as a reminder);
no configuration is lost.

```js
import * as terminal from 'dsh-shell-host/terminal' // { name, inject, apply }
```

Mount it via the bundle patch (`cordis.patch.yml`, row id `terminal`, name
`dsh-shell-host/terminal`). It needs the `pty` service — mount `./pty`
alongside (the patch order does not matter; both rows are plugin-layer).

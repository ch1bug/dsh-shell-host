# Research: how to install a plugin into dsh the built-in way

Primary source: dsh checkout at `<old-work>\deepseek-harness`, tag `dsh-v0.2.0-rc.2`.
All paths below are relative to that checkout unless absolute. Line numbers are approximate (≈).

## TL;DR

1. dsh has **no marketplace/registry of its own** — the "official" install path is **pnpm into a profile**: `dsh plugin --profile <name> add <package-or-git-spec>` runs `pnpm add` inside `$DSH_HOME/profiles/<name>` (`apps/cli/reference/README.md:81`).
2. A profile is a directory `$DSH_HOME/profiles/<name>` (`~/.dsh/profiles/<name>`) holding a `package.json` with the manifest key `dsh.profile.bundles` (ordered bundle list) and a user `cordis.patch.yml` (`packages/boot/app-boot/src/profile.ts:5-14`).
3. An installable plugin is just an npm (or git/tarball/local-path) package whose `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; after install, dsh reconciles `dsh.profile.bundles` so the bundle's patch layer joins the composition (`apps/cli/reference/README.md:81`, `packages/boot/plugin-manager/src/operations.ts:77`).
4. In the Web/Desktop app, the sidebar **Plugins** page (`packages/client/ui-plugin-manager`) drives the same operations through `@deepseek-ai/dsh-plugin-manager` (`packages/boot/plugin-manager/README.md:31`); discovery = `pnpm view` against npm + npmmirror fallback, no curated index.
5. dsh-shell-host **already has the right manifest shape** (`dsh.bundle.patch`, `dsh.client`, peers). To ship it the official way: drop `"private": true`, publish to npm (any scope — `@deepseek-ai` is NOT required), and users install with `dsh plugin --profile <name> add dsh-shell-host`. Discovery aid: tag the GitHub repo with the `dsh-plugin` topic (`CONTRIBUTING.md:15`).

---

## 1. Plugin loading mechanics

- **Profiles.** Every surface boots a *profile*: a directory under `$DSH_HOME/profiles/<name>`; `$DSH_HOME` defaults to `~/.dsh`, overridable via the `DSH_HOME` env var (`packages/util/home-paths/src/index.ts:14-20`). A profile contains:
  - `package.json` — pnpm-managed plugin dependencies plus the profile manifest `dsh.profile.bundles` (ordered list of bundle package names);
  - `cordis.patch.yml` — the user's own patch layer, applied after every bundle layer;
  - `pnpm-lock.yaml`, `node_modules/`, optional `compatibility.json` (version exemptions), `.plugin-manager/` (op logs).
  Source: `packages/boot/app-boot/src/profile.ts:5-14`, `packages/boot/plugin-manager/README.md:63-65`.
- **Composition order** (later layers win per row, replacing whole `config` values, no deep merge): each bundle patch in `dsh.profile.bundles` order → profile `cordis.patch.yml` → home-level `$DSH_HOME/cordis.patch.yml` → `--patch <path>` overlays in argv order (`apps/cli/reference/README.md:9`).
- **Bundle declaration.** A bundle is an npm package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — one file or an ordered list; parsed by `bundlePatchFiles()` in `packages/boot/app-boot/src/profile.ts:58-64`.
- **Loader.** Under the hood it's Cordis `@cordisjs/plugin-loader` + `plugin-include` (vendored under `vendor/include`, `vendor/hmr`); dsh's fork lives as `@deepseek-ai/cordis-plugin-loader` / `cordis-plugin-include` (imports at `profile.ts:27-28`). Entry rows are `- id: ... name: <module>` YAML rows with optional `config`, `disabled`, `group`; `!!js` expressions allowed under `config`/`disabled` (`AGENTS.md:127`, `apps/cli/reference/README.md:60`).
- **Module resolution (two-anchor).** A plugin name resolves first from the dsh installation (launcher's own package), then from the profile's `node_modules`; pnpm-managed profile entries win for selected bundles (`packages/boot/app-boot/src/profile.ts:16-20`).
- **Auto-initialized profiles.** `web`, `headless`, `sdk`, `sdk-minimal`, `acp` auto-initialize from shipped templates; any other missing profile errors with a hint to run `dsh plugin --profile <name> add <package>` (`apps/cli/reference/README.md:13`).
- **HMR.** With `dsh-hmr` enabled in the composed YAML, edits to profile/home patch layers apply live; without it, restart needed (`apps/cli/reference/README.md:9,119`).

## 2. The built-in install/market tooling

There is **no Koishi-style `market` registry.json**. "Official" tooling = CLI plugin command + Web UI, both backed by pnpm:

- **CLI: `dsh plugin --profile <name> <pnpm args...>`** (`apps/cli/src/plugin.ts`, spec in `apps/cli/reference/README.md:81-101`):
  - Initializes the profile when missing (shipped template, or `@deepseek-ai/dsh-base` alone for other names);
  - Forwards args verbatim to **pnpm** with the profile directory as cwd — `add`, `remove`, `why`, `update`, all verbs; pnpm must be on PATH (Desktop uses its bundled pnpm);
  - Relative specs (`.`, `../plugin`, `file:`, `link:`) anchor to the *invoking* directory first, so `add .` from a plugin checkout installs that checkout;
  - After each successful run it reconciles `dsh.profile.bundles`: dependencies whose manifest declares `dsh.bundle.patch` join the layer stack; bundle-less deps stay plain with a one-time warning; removed deps leave the stack;
  - Git-hosted plugins that ship sources build via `prepare`, which pnpm ≥10 blocks until the user copies the printed `allowBuilds` key into the profile's `pnpm-workspace.yaml` and re-runs (`README.md:101`);
  - Version-exemption subcommands: `version-exemptions`, `allow-version <pkg@ver> --dsh-version <runtime> --accept-risk`, `revoke-version ...` (`packages/boot/plugin-manager/README.md:69`).
  - Documented examples: `dsh plugin --profile tui add github:deepseek-harness/turtle-ui` / `remove turtle-ui` (`apps/cli/reference/README.md:96-97`).
- **Web UI**: sidebar **Plugins** page = `@deepseek-ai/dsh-client-ui-plugin-manager` over the `@deepseek-ai/dsh-plugin-manager` service (`packages/boot/plugin-manager/README.md:31`). Capabilities:
  - `inspect(spec)` — pre-install read via `pnpm view` (registry spec), `package.json` read (absolute path), or form+host answer (git/tarball); reports name/version/description/`isBundle`/registry or a `problem` code (`README.md:46`);
  - `installBundle` — GitHub specs pre-checked with `git ls-remote` (5 s default), then `pnpm add --registry ...`; registry plan = configured `registry` then `fallbackRegistries` (default `['https://registry.npmmirror.com/']`) while unreachable/not-found; failed/cancelled runs restore `package.json` + `pnpm-lock.yaml` snapshots (`README.md:48-54`, registry logic in `packages/boot/plugin-manager/src/registry.ts:14-76`, `OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'`);
  - `plugin_manager` agent tool exposes the same ops (Creator mode; `danger-full-access` or per-call approval) (`README.md:31`);
  - pnpm-11 build-script blocking surfaces as `pendingBuilds` with an "Allow these scripts and retry" action (`README.md:58`).
- **Desktop**: `dsh plugin --profile desktop add/list/remove <pkg>` via the Desktop-installed bundled command (npm dsh cannot mutate the desktop profile; Electron owns `$DSH_HOME/profiles/desktop` under a single-instance lock) (`apps/desktop/README.md:89-97`). The desktop Plugins page uses the same shared plugin manager with bundled pnpm (`apps/desktop/README.md:124-127`).
- Installed plugins land in the **profile's `node_modules`** (per-profile, never shared between CLI/Desktop; `apps/desktop/README.md:78`).

## 3. Required package shape

- `package.json`:
  - `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — mandatory for the package to act as a *bundle* (contribute a config layer). String or ordered list of files (`packages/boot/app-boot/src/profile.ts:9-11,58-64`). Without it the dep installs but is "not a bundle" (`packages/boot/plugin-manager/src/operations.ts:77`).
  - Ordinary `main`/`exports` fields for host-plugin modules referenced by name from patch rows (relative `./local.js` names in inserted rows resolve beside the patch file — `apps/cli/reference/README.md:51`). Client UI code uses the `dsh.client` section (see `dsh-shell-host`'s own manifest for a working example: `inject` list of client packages + `platform`).
  - `peerDependencies` on `@deepseek-ai/dsh` or any `@deepseek-ai/dsh-*` are checked against the running dsh version at install time and startup; `workspace:^|~|*` ranges are treated as the runtime version; incompatible peers reject the install unless the user grants an exact-version exemption in the profile's `compatibility.json` (`packages/boot/app-boot/src/plugin-compatibility.ts:52-87`, `packages/boot/plugin-manager/README.md:60-69`).
  - `description` becomes the bundle one-liner in the Plugins page (`packages/boot/plugin-manager/README.md:44`).
- **Install spec forms accepted**: npm registry name (optionally versioned), `github:owner/repo` / git URL, tarball, absolute local path, relative `.`/`file:`/`link:` (anchored to cwd for the CLI) (`apps/cli/reference/README.md:81`, `packages/boot/plugin-manager/README.md:46-48`).
- **No scope restriction**: nothing in the checkout restricts installs to `@deepseek-ai/*`; the examples install external names (`turtle-ui` from GitHub). Registries are a configurable ordered set (npm + npmmirror by default; private registries asked alone) (`packages/boot/plugin-manager/src/registry.ts:54-76`).
- **No curated market index**: community discovery is the GitHub topic `dsh-plugin` (`CONTRIBUTING.md:14-15`).
- `cordis.patch.yml` uses the Cordis entry-list patch dialect: rows `- id: ...  name: <module>  config: {...}` with `disabled`, `group`, `insert:`; `!!js` expressions allowed under `config`/`disabled` only (`apps/cli/reference/README.md:60`, `AGENTS.md:127`).

## 4. What this means for dsh-shell-host

`<old-work>\dsh-shell-host\package.json` **already declares** `dsh.bundle.patch: ./cordis.patch.yml`, `dsh.client` (inject list + `platform: web`), `main`/`exports` to `lib/`, and pinned `@deepseek-ai/dsh-*` peers at `0.2.0-rc.2`. So the official path needs almost nothing structural:

**Recommended path (publish to npm):**
1. Remove `"private": true`, keep `version` semver-clean; ensure `prepare`/build output (`lib/`) is either committed or built via `prepare` (note pnpm ≥10 build-script approval friction — shipping a built tarball avoids it, `apps/cli/reference/README.md:101`).
2. `npm publish` — unscoped or any scope works; no registry gate beyond the default npm/npmmirror plan.
3. Users install: `dsh plugin --profile web add dsh-shell-host` (or via the Web Plugins page / `plugin_manager` tool). dsh reconciles `dsh.profile.bundles` and the bundle's `cordis.patch.yml` joins the stack.
4. Discovery: GitHub repo topic `dsh-plugin` + README (the only official discovery mechanism).
5. Peer pins `0.2.0-rc.2` must satisfy the user's runtime or the install is refused — track dsh releases, and expect users on other versions to need `allow-version`.

**Alternatives (current approach and their trade-offs):**
- **Local checkout link (what the repo does today via the desktop profile)**: `dsh plugin --profile desktop add link:../dsh-shell-host` (or `add .` from inside the checkout). Pros: live edits, no publish. Cons: per-machine, no distribution, Desktop profile is only mutable through the Desktop-bundled command while the app is quit (`apps/desktop/README.md:91`).
- **Git spec**: `dsh plugin --profile <name> add github:<owner>/dsh-shell-host` — publishable without npm; costs the `prepare`-build approval step unless you publish built tarballs to GitHub releases and users install the tarball URL.
- **Tarball**: install from a release-artifact URL; no build-script approval needed, but no clean upgrade path (re-add per version).

**Caveats specific to this plugin**: it forks/replaces built-in host plugins (platform shell executor + permission-presets fork) — its patch rows will disable/override built-in rows; the Plugins page shows such overrides (`packages/boot/plugin-manager/README.md:40,54`). Client-UI injection (`dsh.client`) requires the built client bundle to be resolvable; git/tarball source installs that need a client build step will hit the pnpm build-approval flow.

## 5. Profiles × plugin installation

- Installing a plugin IS a profile operation: the package goes into `$DSH_HOME/profiles/<name>/{package.json,node_modules}`, and activation is recorded by appending the package name to `dsh.profile.bundles` in that profile's `package.json` (`packages/boot/plugin-manager/README.md:40`; `apps/desktop/README.md:97` — "Its `dependencies` contains packages installed by pnpm; `dsh.profile.bundles` contains the built-in bundles followed by enabled plugins").
- The current "desktop profile link" deployment means: the `desktop` profile's pnpm graph links to the dsh-shell-host checkout, and its `dsh.profile.bundles` names `dsh-shell-host`. Dev profiles use filesystem links; packaged Desktop uses runtime resolution without links (`apps/desktop/README.md:97,159`).
- The `desktop` profile name is reserved for Electron; the npm CLI refuses plugin-management against it — only the Desktop-installed bundled `dsh` command may manage it, and only while the app is quit (`apps/cli/README.zh.md:18`, `apps/desktop/README.md:89-91`).
- A bundle toggle (enable/disable) edits `dsh.profile.bundles`; a row toggle edits `disabled` in the profile's `cordis.patch.yml` (`packages/boot/plugin-manager/README.md:40`).

## 6. Open questions / gaps

- **Client-bundle packaging for distribution**: the checkout documents `dsh.client.inject` for first-party packages but I did not find a full spec for how a *third-party* package's client UI bundle is built/located at runtime (dsh-shell-host already solved this locally via its tsdown client build; whether the published-package path resolves the same way for external installs was not verified end-to-end in source).
- **No official market/registry**: confirmed absent; nothing to submit a `registry.json` entry to. The `dsh-plugin` GitHub topic is the only sanctioned discovery channel.
- **Exact peer-version policy across dsh releases** (how strictly `0.2.0-rc.2` pins will reject future runtimes) is implemented in `plugin-compatibility.ts` but the release/policy intent isn't documented beyond the exemption mechanism.

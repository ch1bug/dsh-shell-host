# Profile install & registration (Windows desktop)

How `dsh-shell-host` reaches a live DSH profile, and where to look when the
plugin "isn't found" or errors at composition. Environment facts, not code.

## Layout

- Profile root: `C:\Users\<user>\.dsh\profiles\desktop`
- Plugin install face: `<profile>\node_modules\<pkg>` — for this repo a
  **symlink** to the working checkout (`<repo>`), so `pnpm build`
  here is live after a profile restart.
- Profile state files (the registration truth):
  - `<profile>\package.json` — `dependencies` must carry the plugin
    (`"dsh-shell-host": "link:<repo>"`), AND
  - `<profile>\package.json` `dsh.profile.bundles` must list the bundle name.
- Bundle patch: the plugin's own `cordis.patch.yml`, applied by the loader at
  composition.

## The registration rule (learned 2026-10-16)

A symlink dropped into `<profile>\node_modules` by hand is **NOT an
installation**: without the two `package.json` records above the loader never
composes the plugin — symptom: "未发现插件" / no components on the Plugins
page. Always install through the plugin manager
(`plugin_manager install_bundle <path>`), which writes both records and runs
pnpm; never hand-edit `node_modules` as the registration step.

## Diagnosis entry points

- Install operations log: `<profile>\.plugin-manager\logs\operation-*\pnpm.log`
  (only covers pnpm-stage problems; composition errors are NOT here).
- After a patch/composition change: **restart the profile** — the host
  composes once at startup; symlink retargeting is not hot.
- Verify the built artifact loads in plain Node before blaming the loader:
  `node -e "import('file:///<repo>/lib/pty/index.js').then(m => console.log(Object.keys(m)))"`.

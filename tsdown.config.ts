import { defineConfig } from 'tsdown'
import ts from 'typescript'
// #10 live finding: oxc passes @Remote(...) through to the host lib where
// Node 24 rejects it at import; lower standard decorators with TypeScript
// (the same transform as vitest.config.ts). See tsdown-plugin.ts.
import { standardDecoratorLoweringPlugin } from './tsdown-plugin.ts'

/**
 * The loader module table rows this client bundle may require: the platform
 * baseline (packages/client/web/src/platform.ts `PLATFORM_MODULES`) entries we
 * import at runtime. Everything else must inline — our sources import nothing
 * else, so the bundle is a single closure over the table.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// Bundles src/index.ts to lib/index.js — the runtime face of the package,
// mirroring upstream packaging (@deepseek-ai/* stays external; only this
// package's own code is inlined). clean stays OFF because tsc's declaration
// emit (lib/types/) shares the outDir root.
const lib = defineConfig({
  plugins: [standardDecoratorLoweringPlugin()],
  // #10: two entries — the executor and the permission-presets fork (the
  // loader composes the fork under dsh-shell-host/permission-presets).
  // #28 (ADR-0007): the pty entry joins — lib/pty/index.js behind the
  // dsh-shell-host/pty export.
  // #29 (ADR-0007): the remote entry joins — lib/remote/index.js behind the
  // dsh-shell-host/remote export (NOT a registry backend, ADR-0007).
  // #30 (ADR-0007): the wsl entry joins — lib/wsl-plugin/index.js behind the
  // dsh-shell-host/wsl export. Plugin-LAYER entry (defineTool + ctx.tools):
  // registers model tools, not execution backends (ADR-0007 "Entry form
  // differences"; named wsl-plugin to avoid src/wsl-bridge.ts, ADR-0003
  // decision 5's in-backend mapping layer — two layers, not one).
  // #55 (ADR-0008): the terminal entry joins — lib/terminal/index.js behind
  // the dsh-shell-host/terminal export. Plugin-LAYER entry: the launcher
  // preset surface (shell_open) over the pty session core.
  entry: ['src/index.ts', 'src/permission-presets.ts', 'src/pty/index.ts', 'src/remote/index.ts', 'src/wsl-plugin/index.ts', 'src/terminal/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//] },
})

/**
 * Bundles the tsc-emitted client entry (lib/types/client/index.js) to
 * lib/client.js — the browser face the Web loader serves under
 * /plugins/dsh-shell-host/client.js. The artifact is the closure-factory shape
 * the loader's module table consumes (same contract as every UI plugin's
 * client bundle): the factory receives the table's `require` and returns the
 * module exports, so the platform rows above stay requires and this package's
 * own code inlines.
 */
const client = defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: false,
  external: CLIENT_EXTERNALS,
  inputOptions: {
    resolve: { conditionNames: ['production', 'browser', 'import', 'module', 'default'] },
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // Closure-factory handoff consumed by the client module loader
    // (window.__ModuleLoader__), mirroring the shared tsdown.client preset.
    banner: `window.__ModuleLoader__.load({ id: 'dsh-shell-host', factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})

export default [lib, client]

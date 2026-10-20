import { defineConfig } from 'tsdown'
import ts from 'typescript'
// Live finding (#10): oxc passes @Remote(...) through to the host lib where
// Node 24 rejects it at import; lower standard decorators with TypeScript
// (the same transform as vitest.config.ts). See tsdown-plugin.ts.
import { standardDecoratorLoweringPlugin } from './tsdown-plugin.ts'

// Bundles the plugin-layer entries to lib/ — the runtime face of the package
// (ADR-0013: tools-only; @deepseek-ai/* stays external; only this package's
// own code is inlined). clean stays OFF because tsc's declaration emit
// (lib/types/) shares the outDir root.
const lib = defineConfig({
  plugins: [standardDecoratorLoweringPlugin()],
  // ADR-0013: tools-only plugin — the executor world (src/index.ts, core/,
  // backends*, client settings card) and the remote entry are gone. Four
  // plugin-layer entries remain:
  // #28/#55 (ADR-0007/0008): pty session core + terminal launcher presets.
  // #136: the ssh family is its OWN entry (`./ssh`) — `./pty` is the session
  // core only; both read the one composition (`src/ssh/compose.ts`).
  // #30 (ADR-0007): the wsl entry — lib/wsl-plugin/index.js behind the
  // dsh-shell-host/wsl export. Plugin-LAYER entry (defineTool + ctx.tools):
  // registers model tools, not execution backends.
  entry: ['src/pty/index.ts', 'src/wsl-plugin/index.ts', 'src/terminal/index.ts', 'src/ssh/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  outExtensions: () => ({ js: '.js' }),
  // #61: the self-managed pty core's native dependency must stay a runtime
  // require, never inlined by oxc (native .node binding).
  deps: { neverBundle: [/^@deepseek-ai\//, /^@lydell\/node-pty$/] },
})

export default [lib]

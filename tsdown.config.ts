import { defineConfig } from 'tsdown'

// Bundles src/index.ts to lib/index.js — the runtime face of the package,
// mirroring upstream packaging (@deepseek-ai/* stays external; only this
// package's own code is inlined). clean stays OFF because tsc's declaration
// emit (lib/types/) shares the outDir root.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//] },
})

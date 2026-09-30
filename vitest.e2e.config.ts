import { defineConfig } from 'vitest/config'
import { testAliases } from './vitest.config.ts'

// The EXPLICIT end-to-end lane: `pnpm test:e2e`. Spec #1's testing decision
// keeps end-to-end acceptance OUT of the unit loop (vitest.config.ts); this
// config runs only the T5 engine-side checklist, which self-skips when no
// MSYS2 install is found (DSH_MSYS_ROOT overrides the probe).
export default defineConfig({
  resolve: {
    alias: testAliases,
  },
  test: {
    environment: 'node',
    include: ['tests/_e2e-smoke.spec.ts'],
    passWithNoTests: true,
  },
})

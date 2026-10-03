import { defineConfig } from 'vitest/config'

// The EXPLICIT end-to-end lane: `pnpm test:e2e`. Spec #1's testing decision
// keeps end-to-end acceptance OUT of the unit loop (vitest.config.ts); this
// config runs only the T5 engine-side checklist, which self-skips when no
// MSYS2 install is found (DSH_MSYS_ROOT overrides the probe).
// ADR-0005 anchor bump: no alias table — @deepseek-ai/* resolves through
// node_modules (see vitest.config.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/_e2e-smoke.spec.ts'],
    passWithNoTests: true,
  },
})

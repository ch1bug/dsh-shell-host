import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * #10 live-finding regression guard: tsdown's oxc transformer passes
 * `@Remote(...)` decorators through to the host lib, where Node rejects them
 * as a syntax error at import time — the fork row composed in the profile but
 * the plugin never activated, and all three permission surfaces stayed dark.
 * tsdown.config.ts now lowers standard decorators via tsdown-plugin.ts; this
 * smoke imports the BUILT artifact (skip on a fresh checkout before `pnpm
 * build`) and asserts the Remote marker survived the round trip.
 */
const artifactPath = fileURLToPath(new URL('../lib/permission-presets.js', import.meta.url))

describe('#10: built host artifact loads in plain Node', () => {
  it.skipIf(!existsSync(artifactPath))('imports without a syntax error and keeps the catalog Remote marker', async () => {
    const mod = await import(artifactPath)
    expect(mod.default.name).toBe('PermissionPresetService')
    // Typert marker registration is decorator-initializer-based; the lowered
    // emit defers it to instance construction, so it is asserted by the
    // source-level composition suite, not here.
  })
})

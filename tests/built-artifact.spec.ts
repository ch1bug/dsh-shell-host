import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Live-finding regression guard (originally #10): tsdown's oxc transformer
 * passed `@Remote(...)` decorators through to the host lib, where Node
 * rejected them as a syntax error at import time — the row composed in the
 * profile but the plugin never activated. tsdown.config.ts now lowers
 * standard decorators via tsdown-plugin.ts; this smoke imports the BUILT pty
 * artifact (skip on a fresh checkout before `node --run build`) and asserts it
 * loads in plain Node.
 */
const artifactPath = fileURLToPath(new URL('../lib/pty/index.js', import.meta.url))

describe('built pty artifact loads in plain Node', () => {
  it.skipIf(!existsSync(artifactPath))('imports without a syntax error and exposes the plugin apply', async () => {
    const mod = await import(artifactPath)
    expect(typeof mod.apply).toBe('function')
  })
})

/**
 * The `ssh` backend (issue #23, AC6/AC9): descriptor shape, host splicing,
 * and the loud empty-host failure — all through the public registry boundary
 * (the msys2 suite's explicit-config pattern; no real ssh is spawned here).
 */
import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { registeredBackendIds, resolveBackend } from '../src/backends.ts'
import type { Config } from '../src/index.ts'

function config(overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const schema = z.object({
    backend: z.string().default('ssh').volatile(),
    sshHost: z.string().volatile(),
    bashPath: z.string().volatile(),
    msysRoot: z.string().volatile(),
    subsystem: z.string().default('UCRT64').volatile(),
    wslDistro: z.string().volatile(),
  })
  return schema(overrides as Parameters<typeof schema>[0]) as unknown as Config
}

describe('ssh backend (issue #23 AC6/AC9)', () => {
  it('is registered among the routable backend ids', () => {
    expect(registeredBackendIds()).toContain('ssh')
  })

  it('declares the transport contract: bare ssh launcher + host-spliced one-shot with a -- guard', () => {
    const backend = resolveBackend(config({ sshHost: 'ci.example.com' }))
    expect(backend.id).toBe('ssh')
    expect(backend.executable).toEqual(['ssh'])
    expect(backend.argv.oneShot).toEqual(['ci.example.com', '--', 'bash', '-c', '{command}'])
    expect(backend.argv.interactive).toEqual(['-t', 'ci.example.com', 'bash', '--login', '-i'])
  })

  it('carries the specific section under the owning id (ADR-0003 decision 4 shape)', () => {
    const backend = resolveBackend(config({ sshHost: 'alias' }))
    expect(backend).toHaveProperty('specific', { host: 'alias' })
  })

  it('injects no env and no PATH prefix; path semantics stay remote (identity mapping)', async () => {
    const backend = resolveBackend(config({ sshHost: 'alias' }))
    expect(backend.env).toEqual({})
    expect(backend.pathPrefix).toEqual([])
    await expect(backend.pathMapping.toShell('/remote/path')).resolves.toBe('/remote/path')
    await expect(backend.pathMapping.fromShell('/remote/path')).resolves.toBe('/remote/path')
  })

  it('fails loudly on a missing host (no silent spawn against an unnamed remote)', () => {
    expect(() => resolveBackend(config({}))).toThrow(/ssh.*sshHost/s)
  })

  it('fails loudly on a blank host', () => {
    expect(() => resolveBackend(config({ sshHost: '   ' }))).toThrow(/sshHost/)
  })
})

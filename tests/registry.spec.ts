/**
 * T2 #14: multi-backend registry / runtime switch layer (ADR-0003 decision 1).
 * The registry holds several backend factories simultaneously; `backend` is a
 * single volatile selection resolved at execution time — hot-switchable
 * without remounting the executor (VS Code default-terminal-profile analog).
 * Contract parity with `@deepseek-ai/dsh-bash-local` (D8 red line) is pinned
 * by the existing suites, which must stay green unchanged.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '../src/index.ts'
import { registerBackend, registeredBackendIds, resolveBackend } from '../src/backends.ts'
import { detectPwsh, detectWslExe } from '../src/detect.ts'
import { liveConfig } from './helpers/live-config.ts'

const msysRoot = process.env.DSH_MSYS_ROOT ?? 'C:\\msys64'
const hasMsys2 = existsSync(join(msysRoot, 'usr', 'bin', 'bash.exe'))

describe('T2 #14: the registry layer', () => {
  it('registers plain/msys2/pwsh (plus the reserved wsl entry) simultaneously; resolveBackend consults the registry', async () => {
    // Superset assertion, not exact equality: registry.spec itself registers
    // a test-only backend below (module-global map), so an exact-ids pin here
    // would couple the tests through execution order.
    const ids = registeredBackendIds()
    for (const id of ['msys2', 'plain', 'pwsh', 'wsl']) expect(ids.has(id)).toBe(true)
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { backend: 'pwsh' })
    // Selection is resolved per call from the same config object; only the
    // registry lookup changed — the descriptor shape is untouched (T1 union).
    const pwsh = resolveBackend((ctx.shell as LocalBashExecutor).config)
    expect(pwsh.id).toBe('pwsh')
    await ctx.fiber.dispose()
  })

  it('unknown backend id fails loudly naming every registered id (existing posture)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { backend: 'not-a-backend' })
    const bash = ctx.shell as LocalBashExecutor
    expect(() => bash.resolve({ command: 'true' })).toThrow(/not-a-backend/)
    expect(() => bash.resolve({ command: 'true' })).toThrow(/plain.*msys2.*pwsh/s)
    await ctx.fiber.dispose()
  })

  // T3 #15 (ADR-0003 Consequences): the reserved-id loud rejection is replaced
  // by real descriptor behavior. Live coverage of the resolved wsl descriptor
  // lives in wsl-backend.spec.ts; this registry-lane test pins that selecting
  // 'wsl' through the executor boundary either resolves the real backend or
  // fails loudly naming the probe points — never the old reserved rejection.
  const hasWslExe = detectWslExe() !== undefined
  it.skipIf(!hasWslExe)("the 'wsl' entry resolves a real descriptor (T3 replaces the reserved rejection)", async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { backend: 'wsl' })
    const bash = ctx.shell as LocalBashExecutor
    expect(resolveBackend(bash.config).id).toBe('wsl')
    expect(() => bash.resolve({ command: 'true' })).not.toThrow(/reserved/)
    await ctx.fiber.dispose()
  })
  it.skipIf(hasWslExe)("selecting 'wsl' without a WSL install fails loudly naming the probe points", async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { backend: 'wsl' })
    const bash = ctx.shell as LocalBashExecutor
    expect(() => bash.resolve({ command: 'true' })).toThrow(/found no WSL/)
    expect(() => bash.resolve({ command: 'true' })).toThrow(/System32\\wsl\.exe/)
    await ctx.fiber.dispose()
  })

  it('registerBackend is additive and the new id enters the loud enumeration', async () => {
    const sentinel = {
      id: 'test-only',
      executable: ['definitely-not-on-path'],
      argv: { oneShot: ['-c', '{command}'], interactive: [] },
      env: {},
      pathPrefix: [],
      pathMapping: { toShell: async (p: string) => p, fromShell: async (p: string) => p },
    }
    registerBackend('test-only', () => sentinel)
    expect(registeredBackendIds().has('test-only')).toBe(true)
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { backend: 'test-only' })
    const bash = ctx.shell as LocalBashExecutor
    // The registry resolves the added id; the descriptor is the factory's own.
    expect(resolveBackend(bash.config).id).toBe('test-only')
    // Unknown-id errors enumerate the registry contents including the addition.
    expect(() => resolveBackend({ backend: { get: () => 'nope' } } as never)).toThrow(/test-only/)
    await ctx.fiber.dispose()
  })
})

const pwshExe = detectPwsh()
const hasPwsh = pwshExe !== undefined

describe('T2 #14: runtime hot switch on an msys-less host (pwsh→plain lane)', () => {
  // AC1's "integration test per backend" must not depend on an MSYS2 install:
  // hosts with PowerShell but no MSYS2 still prove the volatile switch on the
  // backends they can run.
  it.skipIf(!hasPwsh)('switching pwsh→plain changes executor behavior without remounting', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const live = await liveConfig(ctx, LocalBashExecutor, { backend: 'pwsh', graceMs: 200 })
    const bash = ctx.shell as LocalBashExecutor
    const fiberBefore = live.fiber
    const viaPwsh = await (await bash.execute(bash.resolve({ command: "Write-Output \"pwsh-$($PSVersionTable.PSEdition)\"" }))).result()
    expect(viaPwsh.stdout.text.trim()).toBe('pwsh-Core')

    await live.update({ backend: 'plain' })
    expect(live.fiber === fiberBefore).toBe(true)
    const viaPlain = await (await bash.execute(bash.resolve({ command: 'uname -s' }))).result()
    expect(viaPlain.exitCode).toBe(0)
    expect(viaPlain.stdout.text.trim()).toMatch(/_NT/)
  }, 30000)
})

describe('T2 #14: runtime hot switch (integration, public boundary)', () => {
  it.skipIf(!hasMsys2)('changing backend at runtime changes executor behavior without remounting', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const live = await liveConfig(ctx, LocalBashExecutor, { backend: 'msys2', msysRoot, graceMs: 200 })
    const bash = ctx.shell as LocalBashExecutor
    const fiberBefore = live.fiber

    // msys2: uname reports an MSYS2-family kernel and $MSYSTEM is injected.
    const viaMsys2 = await (await bash.execute(bash.resolve({ command: 'uname -s; echo $MSYSTEM' }))).result()
    expect(viaMsys2.exitCode).toBe(0)
    expect(viaMsys2.stdout.text.trim()).toMatch(/_NT.*\r?\nUCRT64$/)

    // Hot-switch to pwsh: same fiber (no restart), PowerShell semantics next.
    await live.update({ backend: 'pwsh' })
    expect(live.fiber === fiberBefore).toBe(true)
    const viaPwsh = await (await bash.execute(bash.resolve({ command: "Write-Output \"pwsh-$($PSVersionTable.PSEdition)\"" }))).result()
    expect(viaPwsh.exitCode).toBe(0)
    expect(viaPwsh.stdout.text.trim()).toBe('pwsh-Core')

    // Hot-switch back to msys2: the volatile selection keeps flipping.
    await live.update({ backend: 'msys2' })
    expect(live.fiber === fiberBefore).toBe(true)
    const backToMsys2 = await (await bash.execute(bash.resolve({ command: 'uname -s' }))).result()
    expect(backToMsys2.exitCode).toBe(0)
    expect(backToMsys2.stdout.text.trim()).toMatch(/_NT/)

    // Hot-switch to plain (detected bash, no MSYS injection): the third
    // backend. MSYSTEM is NOT asserted absent — the harness itself runs under
    // MSYS2, so the caller env legitimately carries it (inheritance, not
    // injection; see the pwsh no-injection note in descriptor.spec).
    await live.update({ backend: 'plain' })
    expect(live.fiber === fiberBefore).toBe(true)
    const viaPlain = await (await bash.execute(bash.resolve({ command: 'uname -s' }))).result()
    expect(viaPlain.exitCode).toBe(0)
    expect(viaPlain.stdout.text.trim()).toMatch(/_NT/)
  }, 30000)

  it.skipIf(!hasMsys2)('a bad backend id after a hot switch fails the next command, not the profile write', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const live = await liveConfig(ctx, LocalBashExecutor, { backend: 'msys2', msysRoot, graceMs: 200 })
    const bash = ctx.shell as LocalBashExecutor
    await live.update({ backend: 'not-a-backend' })
    // The volatile write lands; the loud rejection happens at the executor's
    // first stop (resolve), the existing misconfiguration posture.
    expect(() => bash.resolve({ command: 'true' })).toThrow(/not-a-backend/)
  })
})

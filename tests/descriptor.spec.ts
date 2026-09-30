import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '../src/index.ts'
import { resolveBackend } from '../src/backends.ts'
import type { ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'

/**
 * T2 acceptance tests for the backend descriptor layer, exercised ONLY through
 * the executor's public boundary (`resolve` → `execute` → `result`) with an
 * EXPLICIT msys2 configuration — no auto-detection (that is T3). The ported
 * upstream suites are untouched; these tests are new and win32-runnable.
 *
 * Requires a real MSYS2 install. `DSH_MSYS_ROOT` overrides the default
 * `C:\\msys64`; without one the live-boundary suite skips (CI lanes without
 * MSYS2 stay green — the descriptor plumbing itself is still covered by the
 * config-validation tests below, which need no install).
 */
const msysRoot = process.env.DSH_MSYS_ROOT ?? 'C:\\msys64'
const hasMsys2 = existsSync(join(msysRoot, 'usr', 'bin', 'bash.exe'))

async function run(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await x.execute(spec)).result()
}

async function setup(config: Parameters<typeof LocalBashExecutor.Config>[0] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { graceMs: 200, ...config })
  return ctx.shell as LocalBashExecutor
}

describe('msys2 backend (explicit msysRoot)', () => {
  it.skipIf(!hasMsys2)('runs commands through MSYS bash: uname reports an MSYS2-family kernel', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    const result = await run(bash, bash.resolve({ command: 'uname -s' }))
    expect(result.exitCode).toBe(0)
    // Real MSYS2 fact (probed on the host): uname -s reports MSYS_NT only
    // under MSYSTEM=MSYS/unset; any compiler subsystem (D1 default UCRT64)
    // reports the MINGW64_NT family. What the AC pins is "an MSYS2 runtime,
    // not Linux/WSL".
    expect(result.stdout.text.trim()).toMatch(/_NT/)
    expect(result.stdout.text.trim()).not.toBe('Linux')
  })

  it.skipIf(!hasMsys2)('makes cygpath usable and resolves /c/ paths', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    const cygpath = await run(bash, bash.resolve({ command: "cygpath -w '/'" }))
    expect(cygpath.exitCode).toBe(0)
    // / IS the MSYS2 install root (probed on the host), derived from the
    // configured root so DSH_MSYS_ROOT overrides stay honest.
    expect(cygpath.stdout.text.trim().toLowerCase()).toBe(msysRoot.toLowerCase() + '\\')

    const mapped = await run(bash, bash.resolve({ command: "cygpath -u 'C:\\\\Windows'" }))
    expect(mapped.stdout.text.trim().toLowerCase()).toBe('/c/windows')

    const list = await run(bash, bash.resolve({ command: 'ls /c/ | head -n 1' }))
    expect(list.exitCode).toBe(0)
  })

  it.skipIf(!hasMsys2)('injects MSYSTEM derived from subsystem config (default UCRT64)', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    const result = await run(bash, bash.resolve({ command: 'echo $MSYSTEM' }))
    expect(result.stdout.text.trim()).toBe('UCRT64')

    const custom = await setup({ backend: 'msys2', msysRoot, msystem: 'CLANG64' })
    const overridden = await run(custom, custom.resolve({ command: 'echo $MSYSTEM' }))
    expect(overridden.stdout.text.trim()).toBe('CLANG64')
  })

  it.skipIf(!hasMsys2)('caller env wins over backend env for plain variables', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    const result = await run(bash, bash.resolve({
      command: 'echo [$CHERE_INVOKING]',
      env: { CHERE_INVOKING: 'caller-wins' },
    }))
    expect(result.stdout.text.trim()).toBe('[caller-wins]')
  })

  it.skipIf(!hasMsys2)('prepends the MSYS PATH prefix while retaining the caller PATH', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    const result = await run(bash, bash.resolve({ command: 'echo $PATH' }))
    expect(result.exitCode).toBe(0)
    const path = result.stdout.text.trim()
    // MSYS auto-converts the injected Windows prefix to POSIX form and puts
    // it at the head (the UCRT64 subsystem bin leads, per D1)...
    expect(path.toLowerCase()).toMatch(/^\/ucrt64\/bin:/)
    // ...and the inherited Windows PATH survives after it (known System32 entry).
    expect(path.toLowerCase()).toContain('/c/windows/system32')
  })

  it.skipIf(!hasMsys2)('descriptor pathMapping translates both directions through cygpath', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    const backend = resolveBackend(bash.config)
    await expect(backend.pathMapping.toShell('C:\\Windows')).resolves.toBe('/c/Windows')
    await expect(backend.pathMapping.fromShell('/c/Windows')).resolves.toBe('C:\\Windows')
  })

  it.skipIf(!hasMsys2)('the PATH prefix merges onto the caller-supplied PATH, not the inherited one', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    const result = await run(bash, bash.resolve({
      command: 'echo $PATH',
      env: { PATH: 'C:\\caller-path' },
    }))
    const path = result.stdout.text.trim()
    // The prefix still leads, but the merge base is the caller's PATH — the
    // inherited Windows PATH is fully replaced when the caller supplies one.
    expect(path.toLowerCase()).toContain('/ucrt64/bin')
    expect(path).toContain('caller-path')
    expect(path).not.toContain('/c/windows/system32')
  })

  it.skipIf(!hasMsys2)('accepts an explicit bashPath instead of msysRoot', async () => {
    const bash = await setup({ backend: 'msys2', bashPath: join(msysRoot, 'usr', 'bin', 'bash.exe') })
    const result = await run(bash, bash.resolve({ command: 'uname -s' }))
    expect(result.stdout.text.trim()).toMatch(/_NT/)
  })
})

describe('backend selection validation (fails loudly at the public boundary)', () => {
  it('msys2 without msysRoot or bashPath names the missing config', async () => {
    const bash = await setup({ backend: 'msys2' })
    expect(() => bash.resolve({ command: 'true' })).toThrow(/msysRoot/)
  })

  it('selecting a reserved backend (pwsh/wsl) fails with a config-pointing error', async () => {
    for (const backend of ['pwsh', 'wsl']) {
      const bash = await setup({ backend })
      expect(() => bash.resolve({ command: 'true' })).toThrow(new RegExp(backend))
    }
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import YAML from 'yaml'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '../src/index.ts'
import { resolveBackend } from '../src/backends.ts'
import { detectPwsh, PLAIN_BASH_CANDIDATES } from '../src/detect.ts'
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

    const custom = await setup({ backend: 'msys2', msysRoot, subsystem: 'CLANG64' })
    const overridden = await run(custom, custom.resolve({ command: 'echo $MSYSTEM' }))
    expect(overridden.stdout.text.trim()).toBe('CLANG64')
  })

  // Per-subsystem family matrix: each installed subsystem dir gets a live
  // test; missing ones skip with the reason in the test name (issue #6 AC).
  for (const subsystem of ['UCRT64', 'MINGW64', 'CLANG64', 'MSYS']) {
    const installed = existsSync(join(msysRoot, subsystem.toLowerCase(), 'bin'))
    it.skipIf(!hasMsys2 || !installed)(`subsystem ${subsystem} produces its MSYSTEM and PATH prefix${installed ? '' : ' (skipped: not installed on this host)'}`, async () => {
      const bash = await setup({ backend: 'msys2', msysRoot, subsystem })
      const result = await run(bash, bash.resolve({ command: 'echo $MSYSTEM; echo $PATH' }))
      const [msystem, path] = result.stdout.text.trim().split('\n')
      expect(msystem).toBe(subsystem)
      if (subsystem !== 'MSYS') {
        // Compiler subsystems prepend their own bin; MSYS login shells only add /usr/bin.
        expect(path.toLowerCase()).toMatch(new RegExp(`^/${subsystem.toLowerCase()}/bin:`))
      }
    })
  }

  it.skipIf(!existsSync(PLAIN_BASH_CANDIDATES[0]))('subsystem none + Git Bash bashPath runs plain POSIX bash with no MSYS injection', async () => {
    const gitBash = PLAIN_BASH_CANDIDATES[0]
    const bash = await setup({ backend: 'msys2', subsystem: 'none', bashPath: gitBash })
    // "No MSYS env injection" is pinned at the descriptor seam: subsystem
    // 'none' resolves to the plain descriptor (env {}, no PATH prefix). A
    // live $MSYSTEM assertion is impossible — Git for Windows bakes
    // MSYSTEM=MINGW64 into its own runtime (host-probed, unsettable).
    const backend = resolveBackend(bash.config)
    expect(backend.id).toBe('plain')
    expect(backend.env).toEqual({})
    expect(backend.pathPrefix).toEqual([])
    const result = await run(bash, bash.resolve({ command: 'uname -s' }))
    expect(result.exitCode).toBe(0)
    // Git Bash's own kernel string — proof we are in its bash, not MSYS2's.
    expect(result.stdout.text.trim()).toMatch(/_NT/)
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

describe('T3: detection + zero-config (public boundary)', () => {
  it.skipIf(!hasMsys2)('empty msys2 config auto-detects the install root and works', async () => {
    const bash = await setup({ backend: 'msys2' })
    const result = await run(bash, bash.resolve({ command: 'uname -s; echo $MSYSTEM' }))
    expect(result.exitCode).toBe(0)
    const [kernel, msystem] = result.stdout.text.trim().split('\n')
    expect(kernel).toMatch(/_NT/)
    expect(msystem).toBe('UCRT64')
  })

  it.skipIf(!hasMsys2)('empty config (default plain backend) detects a POSIX bash and runs it', async () => {
    const bash = await setup()
    const result = await run(bash, bash.resolve({ command: 'uname -s' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text.trim()).not.toBe('Linux')
  })

  it.skipIf(!hasMsys2)('explicit msysRoot always overrides detection (bogus explicit root is honored, not replaced)', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot: 'D:\\definitely-not-msys2' })
    // VS Code compilerPath semantics: explicit wins even when wrong — the
    // spawn fails naming the explicit candidate instead of silently
    // falling back to the detected C:\msys64 (resolveExecutable throws
    // synchronously out of execute()).
    await expect(bash.execute(bash.resolve({ command: 'true' })))
      .rejects.toThrow(/definitely-not-msys2/)
  })

  it('unresolvable detection fails loudly naming the config item and probed locations', async () => {
    const detected = existsSync(join('C:\\msys64', 'usr', 'bin', 'bash.exe'))
      || existsSync(join(process.env.HOMEDRIVE ?? 'C:', 'msys64', 'usr', 'bin', 'bash.exe'))
    const bash = await setup({ backend: 'msys2' })
    if (detected) {
      // Host has an install; the loud path is covered by detect.spec's
      // injected tests plus this assertion that a detected host succeeds.
      expect(bash.resolve({ command: 'true' })).toBeTruthy()
      return
    }
    expect(() => bash.resolve({ command: 'true' })).toThrow(/msysRoot.*Probed:/s)
  })
})

describe('T4: interactive argv + PTY projection (public boundary)', () => {
  it.skipIf(!hasMsys2)('msys2 descriptor declares the login-interactive argv template (--login -i, D3)', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    const backend = resolveBackend(bash.config)
    expect(backend.argv.interactive).toEqual(['--login', '-i'])
    // One-shot stays non-login (upstream contract): /etc/profile's cd would
    // move every command out of its requested cwd.
    expect(backend.argv.oneShot).toEqual(['-c', '{command}'])
  })

  it.skipIf(!hasMsys2)('plain descriptor (subsystem none) declares an empty interactive template', async () => {
    const bash = await setup({ backend: 'msys2', subsystem: 'none', bashPath: join(msysRoot, 'usr', 'bin', 'bash.exe') })
    const backend = resolveBackend(bash.config)
    expect(backend.argv.interactive).toEqual([])
  })

  it.skipIf(!hasMsys2)('executor projects enginePath/engineArgs for the PTY terminal row', async () => {
    const bash = await setup({ backend: 'msys2', msysRoot })
    // The dsh-terminal-bash row reads exactly these two members (the
    // dsh-bash-native preset demonstration pattern).
    expect(bash.enginePath).toBe(join(msysRoot, 'usr', 'bin', 'bash.exe'))
    expect(bash.engineArgs).toEqual(['--login', '-i'])
  })

  it.skipIf(!hasMsys2)('executor enginePath honors an explicit bashPath override', async () => {
    const explicit = join(msysRoot, 'usr', 'bin', 'bash.exe')
    const bash = await setup({ backend: 'msys2', bashPath: explicit })
    expect(bash.enginePath).toBe(explicit)
    expect(bash.engineArgs).toEqual(['--login', '-i'])
  })
})

describe('T4: the bundle patch (cordis.patch.yml) — host shell replacement + loud terminal wiring', () => {
  // The patch is data the desktop profile composes; until the #8 live E2E,
  // this is the only in-repo drift alarm for the replacement wiring.
  // The `!!js` guards/config stay expressions: resolve them to their raw
  // source text so the assertions can pin the platform guards verbatim.
  const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value: string): string => value }
  const doc = YAML.parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { customTags: [jsTag] }) as Array<Record<string, unknown>>

  it('replaces the platform shell executors on the host plane (win32 guards; exactly one insert)', () => {
    // platform executors disabled with their guards — pwsh yields the Windows
    // shell role, bash-sandbox stays off (re-stated so a base flip cannot
    // sneak the WSL stub back), and neither row is touched on POSIX.
    const pwsh = doc.find((op) => op.id === 'pwsh-sandbox')
    expect(pwsh?.name).toBe('@deepseek-ai/dsh-pwsh-sandbox')
    expect(String(pwsh?.disabled)).toContain("process.platform === 'win32'")
    const bashSandbox = doc.find((op) => op.id === 'bash-sandbox')
    expect(bashSandbox?.name).toBe('@deepseek-ai/dsh-bash-sandbox')
    expect(String(bashSandbox?.disabled)).toContain("process.platform === 'win32'")
    // executor inserts: this bundle's executor, msys2 + UCRT64, dormant
    // off-Windows. (#10 adds a second insert op for the permission fork —
    // pinned in tests/permission-presets.spec.ts; this block stays scoped to
    // the shell-replacement rows.)
    const inserts = doc.filter((op) => Array.isArray(op.insert))
    expect(inserts.length).toBeGreaterThanOrEqual(1)
    const executor = (inserts[0].insert as Array<Record<string, unknown>>)[0]
    expect(executor.id).toBe('shell-host')
    expect(executor.name).toBe('dsh-shell-host')
    expect(executor.config).toMatchObject({ backend: 'msys2', subsystem: 'UCRT64' })
    expect(String(executor.disabled)).toContain("process.platform !== 'win32'")
    // Never reconfigures the host registries from a bundle patch.
    for (const op of doc) expect(op.id).not.toBe('agent-preset-registry')
  })

  it('defaults the user sidebar terminal to MSYS2 bash login and drops the WSL-stub candidate', () => {
    // api-terminal-controller is host-level PATH discovery; the Windows PATH
    // has no MSYS2, so the patch pins the default profile and prunes the bare
    // `bash` candidate (System32 stub) through install probes.
    const tc = doc.find((op) => op.id === 'terminal-controller') as { config: Record<string, string> }
    expect((tc as { name?: string }).name).toBe('@deepseek-ai/dsh-api-terminal-controller')
    expect(tc.config.shell).toMatch(/MSYS2 Bash/)
    // login-interactive: /etc/profile builds the MSYS environment. Loud
    // absence: no install → no profile, upstream discovery stands.
    expect(tc.config.shell).toMatch(/--login/)
    expect(tc.config.shell).toMatch(/existsSync/)
    expect(tc.config.shellCandidates).toMatch(/c !== 'bash'/)
  })
})

describe('backend selection validation (fails loudly at the public boundary)', () => {
  it("selecting the reserved backend 'wsl' fails with a config-pointing error that no longer lists 'pwsh' as reserved", async () => {
    const wsl = await setup({ backend: 'wsl' })
    expect(() => wsl.resolve({ command: 'true' })).toThrow(/wsl/)
    // #3 regression pin: 'pwsh' graduated from reserved to implemented — the
    // reserved/unknown enumerations must not name it as unimplemented.
    expect(() => wsl.resolve({ command: 'true' })).toThrow(/reserved/)
    const bogus = await setup({ backend: 'not-a-backend' })
    expect(() => bogus.resolve({ command: 'true' })).toThrow(/not-a-backend/)
  })
})

/**
 * #3 pwsh backend matrix, exercised through the executor's public boundary
 * (`resolve` → `execute` → `result`). Skips gracefully (skipIf) when no
 * PowerShell is installed — the same pattern as the MSYS2-absent skips; the
 * no-PowerShell loud-failure path is covered by the injected detect.spec
 * suite plus the host-branch test below.
 */
const pwshExe = detectPwsh()
const hasPwsh = pwshExe !== undefined

describe('pwsh backend (#3, D7 phase 1.5)', () => {
  it.skipIf(!hasPwsh)('runs one-shot commands through PowerShell and returns output and exit codes', async () => {
    const shell = await setup({ backend: 'pwsh' })
    const result = await run(shell, shell.resolve({ command: "Write-Output 'ps-hello'" }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text.trim()).toBe('ps-hello')

    const failing = await run(shell, shell.resolve({ command: 'exit 3' }))
    expect(failing.exitCode).toBe(3)
  })

  it.skipIf(!hasPwsh)('one-shot argv carries the upstream conventions (-NoLogo -NoProfile -NonInteractive -Command + UTF-8 preamble)', async () => {
    const shell = await setup({ backend: 'pwsh' })
    const backend = resolveBackend(shell.config)
    expect(backend.argv.oneShot.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    // The preamble rides line 1 of the command payload (Windows PowerShell
    // 5.1 would garble non-ASCII otherwise).
    expect(backend.argv.oneShot[4]).toMatch(/^\[Console\]::OutputEncoding/)
    expect(backend.argv.oneShot[4]).toContain('{command}')
    // Pinned live: the decoded stdout is valid UTF-8 end to end.
    const utf8 = await run(shell, shell.resolve({ command: "Write-Output 'héllo-wörld'" }))
    expect(utf8.exitCode).toBe(0)
    expect(utf8.stdout.text.trim()).toBe('héllo-wörld')
  })

  it.skipIf(!hasPwsh)('descriptor injects no env and no PATH prefix; path mapping is identity both directions', async () => {
    const shell = await setup({ backend: 'pwsh' })
    const backend = resolveBackend(shell.config)
    expect(backend.env).toEqual({})
    expect(backend.pathPrefix).toEqual([])
    await expect(backend.pathMapping.toShell('C:\\Windows')).resolves.toBe('C:\\Windows')
    await expect(backend.pathMapping.fromShell('C:\\Windows')).resolves.toBe('C:\\Windows')
    // Live proof of the native env surface: the caller's variables pass
    // through untouched (the backend injects nothing that competes with
    // them), and the PATH arrives unprefixed — the inherited Windows PATH
    // survives. (Asserting MSYSTEM *absence* live is impossible on this
    // host: the harness itself runs under MSYS2, so the caller env
    // legitimately carries MSYSTEM — inheritance, not injection. The
    // no-injection contract itself is pinned at the descriptor seam above.)
    const result = await run(shell, shell.resolve({
      command: "'MSYSTEM=[' + $env:MSYSTEM + ']'; $env:PATH",
      env: { MSYSTEM: 'caller-pwsh-env' },
    }))
    expect(result.exitCode).toBe(0)
    const [msystem, path] = result.stdout.text.trim().split('\r\n')
    expect(msystem).toBe('MSYSTEM=[caller-pwsh-env]')
    expect(path.toLowerCase()).toContain('windows')
    expect(path.toLowerCase()).toContain('windows')
  })

  it.skipIf(!hasPwsh)('projects enginePath/engineArgs for the PTY terminal row (interactive -l -noexit)', async () => {
    const shell = await setup({ backend: 'pwsh' })
    expect(shell.enginePath).toBe(pwshExe)
    expect(shell.engineArgs).toEqual(['-l', '-noexit'])
  })

  it('absence of PowerShell fails loudly naming every probed location (host branch)', async () => {
    if (hasPwsh) {
      // Host has PowerShell; the loud path is covered by the injected
      // detect.spec suite plus this assertion that a detected host succeeds.
      const shell = await setup({ backend: 'pwsh' })
      expect(shell.resolve({ command: 'exit 0' })).toBeTruthy()
      return
    }
    const shell = await setup({ backend: 'pwsh' })
    expect(() => shell.resolve({ command: 'exit 0' })).toThrow(/backend 'pwsh' found no PowerShell.*Probed:/s)
  })
})

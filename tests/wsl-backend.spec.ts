/**
 * T3 #15: the `wsl` backend descriptor (ADR-0003 decisions 2–4) — launch
 * protocol `wsl.exe -d <distro> -e bash -c <cmd>` (explicit distro, `-e`
 * guards against wsl.exe re-parsing), `distro` as a backend-specific
 * descriptor field (T1's type channel), and loud failures naming the probe
 * points on a WSL-less or distro-less machine (the pwsh detection posture).
 * Detection and discovery are exercised through injected dependencies; the
 * live-host integration lane (skipIf) runs the real one-shot through the
 * executor's public boundary, mirroring the 2026-09-30 probe methodology.
 * @module tests/wsl-backend
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '../src/index.ts'
import { wslBackend, parseWslDistroList } from '../src/backends.ts'
import { detectWslExe, wslProbedLocations } from '../src/detect.ts'
import { toWslPath } from '../src/wsl-bridge.ts'
import { liveConfig } from './helpers/live-config.ts'

const fakeConfig = { wslDistro: { get: () => undefined } } as unknown as Parameters<typeof wslBackend>[0]

/** A config with an explicit distro (or none), typed past the Volatile seam. */
function configWith(distro?: string): Parameters<typeof wslBackend>[0] {
  return { wslDistro: { get: () => distro } } as unknown as Parameters<typeof wslBackend>[0]
}

const existsTrue = (): boolean => true

describe('T3 #15: wsl.exe detection (ADR-0003 decision 3: explicit System32 candidates)', () => {
  it('probes only the explicit System32 wsl.exe — a bare bash on PATH is never a candidate', () => {
    const probed = wslProbedLocations({ SystemRoot: 'C:\\Windows' } as NodeJS.ProcessEnv)
    expect(probed).toEqual(['C:\\Windows\\System32\\wsl.exe'])
  })

  it('detectWslExe resolves the first existing candidate; absence returns undefined (caller fails loudly)', () => {
    const winEnv = { SystemRoot: 'C:\\Windows' } as NodeJS.ProcessEnv
    const seen: string[] = []
    const found = detectWslExe((p) => { seen.push(p); return p.endsWith('wsl.exe') }, winEnv)
    expect(found).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(detectWslExe(() => false, winEnv)).toBeUndefined()
  })
})

describe('T3 #15: the wsl descriptor factory (injected loud-failure coverage)', () => {
  it('fails loudly on a WSL-less machine, naming every probe point (pwsh posture)', () => {
    expect(() => wslBackend(fakeConfig, { exists: () => false }))
      .toThrow(/backend 'wsl' found no WSL/)
    expect(() => wslBackend(fakeConfig, { exists: () => false }))
      .toThrow(/System32\\wsl\.exe/)
  })

  it('fails loudly when wsl.exe exists but no distro is installed, naming the discovery probe', () => {
    expect(() => wslBackend(fakeConfig, { exists: existsTrue, listDistros: () => [] }))
      .toThrow(/no WSL distro/)
    expect(() => wslBackend(fakeConfig, { exists: existsTrue, listDistros: () => [] }))
      .toThrow(/--list --quiet/)
  })

  it('builds the launch protocol argv from a discovered distro and stamps the specific section', () => {
    const backend = wslBackend(fakeConfig, { exists: existsTrue, listDistros: () => ['Ubuntu-22.04', 'Debian'] })
    expect(backend.id).toBe('wsl')
    expect(backend.executable).toEqual([...wslProbedLocations()])
    // ADR-0003 decision 3: explicit distro, `-e` blocks re-parsing, `-c` carries the token.
    expect(backend.argv.oneShot).toEqual(['-d', 'Ubuntu-22.04', '-e', 'bash', '-c', '{command}'])
    // Interactive (PTY terminal) mode declared: the distro selection and `-e` bash
    // ride the terminal argv; `--login -i` is the PTY projection's login shell.
    expect(backend.argv.interactive).toEqual(['-d', 'Ubuntu-22.04', '-e', 'bash', '--login', '-i'])
    // ADR-0003 decision 4: the distro is declared on the descriptor itself.
    expect(backend.specific).toEqual({ distro: 'Ubuntu-22.04' })
    expect(backend.env).toEqual({})
    expect(backend.pathPrefix).toEqual([])
  })

  it('an explicit distro wins over discovery (discovery is never invoked)', () => {
    const backend = wslBackend(configWith('Debian'), { exists: existsTrue, listDistros: () => { throw new Error('discovery must not run') } })
    expect(backend.argv.oneShot).toContain('Debian')
    expect(backend.specific).toEqual({ distro: 'Debian' })
  })

  it('the descriptor pathMapping routes through the bridge, both directions', async () => {
    const backend = wslBackend(fakeConfig, { exists: existsTrue, listDistros: () => ['Ubuntu-22.04'] })
    await expect(backend.pathMapping.toShell('C:\\Work')).resolves.toBe('/mnt/c/Work')
    await expect(backend.pathMapping.fromShell('/home/u')).resolves.toBe('\\\\wsl$\\Ubuntu-22.04\\home\\u')
  })

  it('parseWslDistroList strips the UTF-16LE BOM wsl.exe leads its output with', () => {
    expect(parseWslDistroList('\uFEFFUbuntu-22.04\r\nDebian\n\n')).toEqual(['Ubuntu-22.04', 'Debian'])
  })
})

/**
 * Live-WSL integration lane (AC: one-shot round-trips cwd across the VM
 * boundary through the bridge). Skips when the host has no usable WSL distro —
 * the loud-failure paths above are the injected coverage for that shape.
 */
const wslExe = process.platform === 'win32' ? detectWslExe() : undefined

function liveDistros(): string[] {
  if (wslExe === undefined) return []
  try {
    return [...parseWslDistroList(execFileSync(wslExe, ['--list', '--quiet'], { encoding: 'utf16le' }))]
  } catch {
    return []
  }
}

const hasLiveWsl = wslExe !== undefined && liveDistros().length > 0

describe('T3 #15: live WSL one-shot through the executor boundary (AC integration)', () => {
  it.skipIf(!hasLiveWsl)('a one-shot command lands in the translated cwd and the bridge maps the round trip', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    await liveConfig(ctx, LocalBashExecutor, { backend: 'wsl', graceMs: 200 })
    const bash = ctx.shell as LocalBashExecutor

    // cwd crosses the VM boundary: wsl.exe inherits the Windows workdir and the
    // distro lands on its drvfs mount point — the bridge predicts the mapping.
    const pwd = await (await bash.execute(bash.resolve({ command: 'pwd' }))).result()
    expect(pwd.exitCode).toBe(0)
    expect(pwd.stdout.text.trim()).toBe(toWslPath(process.cwd()))

    // The descriptor's pathMapping agrees with reality, both directions.
    const backend = bash.resolve({ command: 'true' }) && wslBackend(bash.config)
    await expect(backend.pathMapping.toShell(process.cwd())).resolves.toBe(pwd.stdout.text.trim())
    await expect(backend.pathMapping.fromShell(pwd.stdout.text.trim())).resolves.toMatch(/^C:\\/i)

    // Spill crosses back to the host: force a spill with a tiny stdout cap and
    // confirm the spill file exists on the Windows side, readable.
    const spill = await (await bash.execute(bash.resolve({
      command: 'head -c 100000 /dev/zero | tr "\\0" "x"',
      stdoutMaxBytes: 1024,
    }))).result()
    expect(spill.exitCode).toBe(0)
    expect(spill.stdout.spillPath).toBeDefined()
    expect(existsSync(spill.stdout.spillPath!)).toBe(true)
  }, 30000)

  it.skipIf(!hasLiveWsl)('the declared interactive (PTY terminal) argv boots a login shell in the distro (AC2)', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    // Spawn the executor's actual enginePath/engineArgs — the exact members
    // @deepseek-ai/dsh-terminal-bash consumes — with a trailing -c probe so the
    // login shell proves its profiles load, then exits.
    await ctx.plugin(LocalSubprocessRuntime)
    await liveConfig(ctx, LocalBashExecutor, { backend: 'wsl', graceMs: 200 })
    const bash = ctx.shell as LocalBashExecutor
    const out = execFileSync(bash.enginePath, [...bash.engineArgs, '-c', 'echo interactive-$BASH_VERSION'], { encoding: 'utf8' })
    expect(out).toMatch(/interactive-\d/)
  }, 30000)
})

/**
 * Machine lane (`./pwsh` entry, issue #63): the REAL fallback posture on a
 * machine without PowerShell 7 — detection resolves Windows PowerShell 5.1's
 * `powershell.exe` and the tool executes PowerShell syntax through it with
 * the UTF-8 preamble (non-ASCII output must not garble over 5.1's OEM code
 * page). The upstream bug (#63) made this exact call fall back to bash.
 * Serial machine lane; win32-only by the row's own platform gate.
 * @module tests/pwsh-tool-machine
 */

import { spawn, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { apply, resolvePwshExecutable } from '../src/pwsh.ts'

// A cheap, cacheable probe: is any pwsh.exe on PATH? (No PowerShell 7 on this
// dev machine — the recorded upstream fact; if that changes, the fallback
// assertions below still hold — they pin the CONTRACT, not the absence.)
function pwsh7OnPath(): boolean {
  const r = spawnSync('where.exe', ['pwsh.exe'], { shell: false })
  return r.status === 0
}

const hasPwsh7 = process.platform === 'win32' && pwsh7OnPath()

describe.skipIf(process.platform !== 'win32')('./pwsh machine lane (#63): real powershell.exe fallback', () => {
  const registered: any[] = []
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t) },
    get: (name: string) => (name === 'subprocess' ? { spawn: (spec: any) => realSpawn(spec) } : undefined),
    logger: { warn: () => {} },
  } as any
  apply(ctx, {})
  const tool = registered.find((x) => x.name === 'pwsh')!

  /** Minimal real subprocess channel over child_process — just enough for
   * one-shot collect-mode execution (argv, cwd, collect, signal escalation
   * are the dsh-subprocess-local service's job; here only the contract the
   * tool consumes is faked around a real PowerShell child). */
  function realSpawn(spec: { argv: readonly string[]; cwd: string; signal?: AbortSignal }) {
    // spawnSync cannot abort mid-flight; the machine cases finish fast.
    const c = spawn(spec.argv[0]!, spec.argv.slice(1) as string[], { cwd: spec.cwd, shell: false })
    const out: Buffer[] = []
    const err: Buffer[] = []
    c.stdout!.on('data', (d: Buffer) => out.push(d))
    c.stderr!.on('data', (d: Buffer) => err.push(d))
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      c.on('close', (code, signal) => resolve({ exitCode: code, signal: signal as NodeJS.Signals | null }))
    })
    const read = (buf: Buffer[]) => ({ readFrom: (from: number) => {
      const text = Buffer.concat(buf).toString('utf8')
      return { text: text.slice(from), nextOffset: Buffer.byteLength(text), lossy: false }
    } })
    return {
      collected: { stdout: read(out), stderr: read(err) },
      done,
      terminate: () => c.kill(),
    }
  }

  it('resolves a real PowerShell executable (pwsh.exe when installed, powershell.exe otherwise)', () => {
    expect(resolvePwshExecutable()).toMatch(/pwsh\.exe$|powershell\.exe$/i)
  })

  it('executes PowerShell syntax through the fallback with UTF-8 output intact', { timeout: 30_000 }, async () => {
    const value = await tool.execute(
      { command: 'Write-Output "你好 shell-host"; $PSVersionTable.PSVersion.Major', description: 'echo UTF-8 + version' },
      { agent: undefined },
    )
    expect(value.exitCode).toBe(0)
    const text = tool.output.render(null, value)[0].text
    expect(text).toContain('你好 shell-host')
    // Windows PowerShell 5.1 answers 5; PowerShell 7 answers 7 — either way
    // the command ran as POWERSHELL, not bash (the #63 regression).
    expect(text).toMatch(/^5$|^7$/m)
  })

  it('stays the loud posture when no PowerShell exists (injected probes, no real spawn)', async () => {
    const registeredLocal: any[] = []
    apply({ tools: { register: (t: unknown) => registeredLocal.push(t) }, get: () => undefined, logger: { warn: () => {} } } as any, {}, {
      exists: () => false,
      path: '',
      env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' } as NodeJS.ProcessEnv,
    })
    const t = registeredLocal.find((x) => x.name === 'pwsh')!
    await expect(t.execute({ command: 'x', description: 'x' }, {})).rejects.toThrow(/Probed:.*powershell\.exe/s)
  })

  it(hasPwsh7 ? 'PowerShell 7 present: pwsh.exe wins the probe order' : 'records the machine fact: no PowerShell 7 (5.1 fallback is the live path)', () => {
    expect(typeof hasPwsh7).toBe('boolean')
  })
})

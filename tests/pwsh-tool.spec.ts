/**
 * `./pwsh` entry (issue #63, A-route host-only fork): the same-name `pwsh`
 * tool takeover of the platform `dsh-tool-pwsh` row. The fork's ONE semantic
 * delta is executable resolution — the ordered `pwsh.exe → powershell.exe`
 * probe (detect.ts's pwshProbedLocations + spawnableExists) with a loud
 * failure naming every probe point when both are absent (the upstream tool
 * silently falls back to bash instead — the #63 bug). One-shot execution
 * rides `ctx.subprocess` directly (NOT the shell seam — the executor layer is
 * a different plane, ADR-0007); the UTF-8 preamble semantics mirror the
 * backends pwsh descriptor. Detection probes are injected, so all postures
 * are pinned without a real PowerShell; the machine lane owns the real
 * powershell.exe fallback (pwsh-tool-machine.spec.ts).
 * @module tests/pwsh-tool
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { apply } from '../src/pwsh.ts'

interface CollectedText { text: string; truncated: boolean; spillPath?: string }
interface FakeSpec {
  argv: readonly string[]
  cwd: string
  stdio: { stdin: unknown; stdout: unknown; stderr: unknown }
  graceMs: number
  signal?: AbortSignal
}

/** Script signature: build the handle from the spawn spec. */
type Script = (spec: FakeSpec) => ReturnType<typeof fakeHandle>

/** A fake subprocess handle that settles with the given outcome and streams. */
function fakeHandle(stdout: CollectedText, stderr: CollectedText, outcome: { exitCode: number | null; signal?: NodeJS.Signals }) {
  const reader = (c: CollectedText) => ({
    readFrom: () => ({ text: c.text, nextOffset: c.text.length, lossy: c.truncated, ...(c.spillPath !== undefined ? { spillPath: c.spillPath } : {}) }),
  })
  return {
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done: Promise.resolve({ exitCode: outcome.exitCode, signal: outcome.signal ?? null }),
    terminate: () => {},
  }
}

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const BASE_ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' } as NodeJS.ProcessEnv

interface Boot {
  tool: () => any
  specs: FakeSpec[]
  /** Script the NEXT spawn's settlement: (stdout, stderr, outcome). */
  settle: (stdout: CollectedText, stderr: CollectedText, outcome: { exitCode: number | null; signal?: NodeJS.Signals }) => void
  /** Script the NEXT spawn to hang forever (timeout tests). */
  hang: () => void
}

/** Boot the fork entry with injected probe facts and a scripted subprocess. */
function boot(exists: (candidate: string) => boolean, config: Record<string, unknown> = {}, path = 'C:\\Windows\\System32'): Boot {
  const specs: FakeSpec[] = []
  let script: Script | undefined
  const registered: any[] = []
  const subprocess = {
    spawn: (spec: FakeSpec) => {
      specs.push(spec)
      if (script === undefined) throw new Error('no scripted handle for this spawn')
      return script(spec)
    },
  }
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t) },
    get: (name: string) => (name === 'subprocess' ? subprocess : undefined),
    logger: { warn: () => {} },
  } as any
  apply(ctx, config, { exists, path, env: BASE_ENV })
  const tool = () => {
    const t = registered.find((x) => x.name === 'pwsh')
    if (t === undefined) throw new Error('tool not registered: pwsh')
    return t
  }
  return {
    tool,
    specs,
    settle: (stdout, stderr, outcome) => { script = () => fakeHandle(stdout, stderr, outcome) },    hang: () => {
      script = (spec: FakeSpec) => {
        // A process that ignores the deadline must still be killed by the
        // subprocess service's escalation — the fake settles done on abort.
        let settleDone!: (outcome: { exitCode: number | null; signal: NodeJS.Signals }) => void
        const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals }>((r) => { settleDone = r })
        spec.signal?.addEventListener('abort', () => settleDone({ exitCode: null, signal: 'SIGTERM' }), { once: true })
        return {
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done,
          terminate: () => {},
        }
      }
    },
  }
}

const exec = { agent: { session: { header: { cwd: 'C:\\work\\ws' } } } }

/** The model-facing text the tool's renderer produces for one execute value. */
function rendered(t: any, value: unknown): string {
  return t.output.render(null, value)[0].text
}

describe('./pwsh (#63): same-name takeover of the platform tool row', () => {
  it('registers the tool named pwsh (the takeover identity — loader row id does the rest)', () => {
    const b = boot(() => true)
    expect(b.tool().name).toBe('pwsh')
  })
})

describe('#63 AC1-2: ordered executable detection pwsh.exe → powershell.exe', () => {
  it('prefers PowerShell 7 pwsh.exe when it exists (install root wins over everything)', async () => {
    const b = boot((candidate) => candidate === PWSH7 || candidate === PS51)
    b.settle({ text: 'ok', truncated: false }, { text: '', truncated: false }, { exitCode: 0 })
    await b.tool().execute({ command: 'Write-Output ok', description: 'echo' }, exec)
    expect(b.specs[0]!.argv[0]).toBe(PWSH7)
  })

  it('takes a PATH pwsh.exe ahead of the 5.1 fallback', async () => {
    const onPath = 'D:\\tools\\pwsh.exe'
    const b = boot((candidate) => candidate === onPath || candidate === PS51, {}, 'C:\\Windows\\System32;D:\\tools')
    b.settle({ text: '', truncated: false }, { text: '', truncated: false }, { exitCode: 0 })
    await b.tool().execute({ command: 'x', description: 'x' }, exec)
    expect(b.specs[0]!.argv[0]).toBe(onPath)
  })

  it('falls back to Windows PowerShell 5.1 powershell.exe when pwsh.exe is absent', async () => {
    const b = boot((candidate) => candidate === PS51)
    b.settle({ text: 'ok', truncated: false }, { text: '', truncated: false }, { exitCode: 0 })
    await b.tool().execute({ command: 'Write-Output ok', description: 'echo' }, exec)
    expect(b.specs[0]!.argv[0]).toBe(PS51)
  })

  it('double absence fails LOUDLY naming every probe point (no silent bash fallback — the #63 bug)', async () => {
    const b = boot(() => false)
    await expect(b.tool().execute({ command: 'x', description: 'x' }, exec))
      .rejects.toThrow(/Probed:/)
    await expect(b.tool().execute({ command: 'x', description: 'x' }, exec))
      .rejects.toThrow(/pwsh\.exe[\s\S]*powershell\.exe/)
  })
})

describe('#63 AC3: one-shot execution over ctx.subprocess (-Command, UTF-8 preamble)', () => {
  it('spawns the resolved executable with -NoLogo -NoProfile -NonInteractive -Command and the UTF-8 preamble on line 1', async () => {
    const b = boot(() => true)
    b.settle({ text: 'hi\n', truncated: false }, { text: '', truncated: false }, { exitCode: 0 })
    await b.tool().execute({ command: 'Write-Output hi', description: 'echo', workdir: 'C:\\tmp' }, exec)
    const spec = b.specs[0]!
    expect(spec.argv).toHaveLength(6)
    expect(spec.argv.slice(1, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    const commandArg = spec.argv[5]!
    expect(commandArg).toContain('[Console]::OutputEncoding')
    expect(commandArg.endsWith('Write-Output hi')).toBe(true)
    expect(spec.cwd).toBe('C:\\tmp')
    expect(spec.graceMs).toBeGreaterThan(0)
  })

  it('renders stdout, a marked [stderr] section, and the exit-code marker; non-zero exits are reported, not errored', async () => {
    const b = boot(() => true)
    b.settle(
      { text: 'partial', truncated: false },
      { text: 'boom\n', truncated: false },
      { exitCode: 2 },
    )
    const value = await b.tool().execute({ command: 'fail', description: 'fail' }, exec)
    const text = rendered(b.tool(), value)
    expect(text).toContain('partial')
    expect(text).toContain('[stderr]\nboom')
    expect(text).toContain('[exit code: 2]')
  })

  it('appends the spill note when a stream was truncated', async () => {
    const b = boot(() => true)
    b.settle(
      { text: 'tail', truncated: true, spillPath: 'C:\\spill\\out.txt' },
      { text: '', truncated: false },
      { exitCode: 0 },
    )
    const value = await b.tool().execute({ command: 'big', description: 'big' }, exec)
    expect(rendered(b.tool(), value)).toContain('[output truncated; full output: C:\\spill\\out.txt]')
  })

  it('timeout kills the command and renders the timed-out marker', async () => {
    const b = boot(() => true, { timeoutMs: 50, maxTimeoutMs: 100 })
    b.hang()
    const value = await b.tool().execute({ command: 'sleep 99', description: 'hang' }, exec)
    expect(rendered(b.tool(), value)).toContain('[timed out after 50ms]')
    expect(b.specs[0]!.signal?.aborted).toBe(true)
  })

  it('a relative workdir resolves against the session header cwd (upstream workdir semantics)', async () => {
    const b = boot(() => true)
    b.settle({ text: '', truncated: false }, { text: '', truncated: false }, { exitCode: 0 })
    await b.tool().execute({ command: 'x', description: 'x', workdir: 'sub' }, exec)
    expect(b.specs[0]!.cwd).toBe(resolve('C:\\work\\ws', 'sub'))
    expect(isAbsolute(b.specs[0]!.cwd)).toBe(true)
  })

  it('empty command or description fails validation; timeoutMs must be positive', async () => {
    const b = boot(() => true)
    b.settle({ text: '', truncated: false }, { text: '', truncated: false }, { exitCode: 0 })
    await expect(b.tool().execute({ command: '  ', description: 'x' }, exec)).rejects.toThrow(/invalid command/)
    await expect(b.tool().execute({ command: 'x', description: '' }, exec)).rejects.toThrow(/invalid description/)
    await expect(b.tool().execute({ command: 'x', description: 'x', timeoutMs: -1 }, exec)).rejects.toThrow(/timeoutMs/)
  })
})

describe('#63: the bundle patch (cordis.patch.yml) — the fork owns the tool-pwsh entry id', () => {
  const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value: string): string => value }
  const doc = YAML.parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { customTags: [jsTag] }) as Array<Record<string, unknown>>

  it('the fork insert owns the tool-pwsh entry id (same-id later row replaces the platform row)', () => {
    const inserts = doc.flatMap((op) => Array.isArray(op.insert) ? op.insert as Array<Record<string, unknown>> : [])
    const fork = inserts.find((row) => row.name === 'dsh-shell-host/pwsh')
    expect(fork).toBeDefined()
    expect(fork?.id).toBe('tool-pwsh')
    // Platform gating mirrors the base row verbatim: win32-only. On POSIX the
    // platform row was already disabled; the takeover must not flip it on.
    expect(fork?.disabled).toBe("process.platform !== 'win32'")
  })

  it('exactly one tool-pwsh id among the fork inserts (no duplicate takeover rows)', () => {
    const inserts = doc.flatMap((op) => Array.isArray(op.insert) ? op.insert as Array<Record<string, unknown>> : [])
    expect(inserts.filter((row) => row.id === 'tool-pwsh')).toHaveLength(1)
  })
})

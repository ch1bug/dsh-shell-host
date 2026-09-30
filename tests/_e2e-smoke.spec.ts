// T5 E2E checklist (engine side) — driven through the executor's public
// boundary against the real C:\msys64 install. This is the EXPLICIT e2e
// lane (`pnpm test:e2e`), honoring spec #1's testing decision that
// end-to-end acceptance stays out of the unit loop; the suite skips when
// no MSYS2 install is found (DSH_MSYS_ROOT overrides the probe).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '../src/index.ts'
import type { ShellExecSpec, ShellExecution, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'

const msysRoot = process.env.DSH_MSYS_ROOT ?? 'C:\\msys64'
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-t5-e2e-spill-'))

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

async function run(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await x.execute(spec)).result()
}

/** Background shorthand: execute with no deadline armed. */
function start(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellExecution> {
  return x.execute({ ...spec, onExpiry: 'none' })
}

/** Poll a handle's consuming readOutput until the accumulated delta contains `expected`. */
async function readUntil(proc: ShellProcess, expected: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let all = ''
  while (Date.now() < deadline) {
    all += proc.readOutput().delta
    if (all.includes(expected)) return all
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
  throw new Error(`expected output never arrived: ${JSON.stringify(expected)}; got ${JSON.stringify(all)}`)
}

async function setup(extra: { maxOutputBytes?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(LocalBashExecutor, { graceMs: 200, backend: 'msys2', msysRoot, ...extra })
  return ctx.shell as LocalBashExecutor
}

describe.skipIf(!existsSync(msysRoot))('T5 E2E checklist (engine side)', () => {
  it('1. uname reports an MSYS2-family kernel', async () => {
    const bash = await setup()
    const r = await run(bash, bash.resolve({ command: 'uname -s' }))
    console.log('uname -s =>', r.stdout.text.trim())
    expect(r.stdout.text.trim()).toMatch(/_NT/)
  })
  // `pacman -Q` costs ~4s on Windows alone (process-spawn overhead over the
  // package list); the 5s default trips under parallel-suite load.
  it('2. pacman -Q works', { timeout: 30_000 }, async () => {
    const bash = await setup()
    const r = await run(bash, bash.resolve({ command: 'pacman -Q' }))
    console.log('pacman -Q exit:', r.exitCode, 'first lines:', r.stdout.text.trim().split('\n').slice(0, 3).join(' | '))
    expect(r.exitCode).toBe(0)
    expect(r.stdout.text).toContain('msys2-runtime')
  })
  it('3. cygpath -w / and /c/ paths resolve', async () => {
    const bash = await setup()
    const w = await run(bash, bash.resolve({ command: "cygpath -w '/'" }))
    console.log("cygpath -w / =>", w.stdout.text.trim())
    expect(w.exitCode).toBe(0)
    const ls = await run(bash, bash.resolve({ command: 'ls /c/ | head -3' }))
    console.log('ls /c/ =>', JSON.stringify(ls.stdout.text.trim()))
    expect(ls.exitCode).toBe(0)
    expect(ls.stdout.text.trim().length).toBeGreaterThan(0)
  })
  it('4. ucrt64 gcc builds a program', { timeout: 30_000 }, async () => {
    const bash = await setup()
    // The UCRT64 toolchain's banner reads "gcc.exe (Rev4, Built by MSYS2
    // project) …" — no UCRT/MinGW token — so the honest probe is WHERE gcc
    // lives: the backend's PATH prefix puts <root>/ucrt64/bin first.
    const w = await run(bash, bash.resolve({ command: 'command -v gcc' }))
    console.log('gcc path =>', w.stdout.text.trim())
    expect(w.stdout.text.trim()).toMatch(/\/ucrt64\/bin\/gcc(\.exe)?$/i)
    const v = await run(bash, bash.resolve({ command: 'gcc --version | head -1' }))
    console.log('gcc =>', v.stdout.text.trim())
    expect(v.stdout.text).toMatch(/^gcc(\.exe)?\s+\(Rev\d+, Built by MSYS2 project\)\s+\d+/)
    const dir = join(msysRoot, 'tmp')
    const c = join(dir, 'dsh_t5_e2e.c')
    const exe = join(dir, 'dsh_t5_e2e.exe')
    // TS `\\n` lands as the two-character C escape `\n` in the source file, so
    // the program prints ok + newline; the trim below expects exactly that.
    writeFileSync(c, '#include <stdio.h>\nint main(void){printf("ok\\n");return 0;}\n')
    try {
      const b = await run(bash, bash.resolve({ command: 'cd /tmp && gcc dsh_t5_e2e.c -o dsh_t5_e2e.exe && ./dsh_t5_e2e.exe' }))
      console.log('build+run =>', JSON.stringify(b.stdout.text.trim()), 'exit', b.exitCode)
      expect(b.exitCode).toBe(0)
      expect(b.stdout.text.trim()).toBe('ok')
    } finally { rmSync(c, { force: true }); rmSync(exe, { force: true }) }
  })
  it('5. UTF-8 round-trips clean', async () => {
    const bash = await setup()
    const r = await run(bash, bash.resolve({ command: "echo '中文—テスト—emoji:✅'" }))
    console.log('utf8 =>', JSON.stringify(r.stdout.text.trim()))
    expect(r.exitCode).toBe(0)
    expect(r.stdout.text).toContain('中文')
    expect(r.stdout.text).toContain('✅')
  })
  it('6. /usr/bin toolchain present (make, awk, sed)', async () => {
    const bash = await setup()
    const r = await run(bash, bash.resolve({ command: 'for t in make awk sed grep; do command -v $t >/dev/null || echo "MISSING:$t"; done; echo done' }))
    expect(r.stdout.text.trim()).toBe('done')
  })
  it('7. background handles start before exit; spill reports the full stream', { timeout: 30_000 }, async () => {
    // #8's checklist item "background jobs + spill behaving": a handle must
    // be readable WHILE the real MSYS2 process runs, and an over-budget
    // stream must spill to a file carrying the full output.
    const bash = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-t5-e2e-'))
    try {
      const proc = await start(bash, bash.resolve({
        command: 'echo ready; while [ ! -f release ]; do sleep 0.05; done; echo done',
        workdir: dir,
      }))
      try {
        await readUntil(proc, 'ready')
        expect(proc.status).toBe('running')
        writeFileSync(join(dir, 'release'), '')
        await proc.done
        expect(proc.status).toBe('completed')
        expect(proc.exitCode).toBe(0)
        expect(proc.readOutput().delta).toBe('done\n')
      } finally {
        if (proc.status === 'running') { proc.kill(); await proc.done }
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
    // Spill: a tight maxOutputBytes budget over the real MSYS2 → the read
    // window goes lossy and the spill file carries the FULL stream.
    const tight = await setup({ maxOutputBytes: 100 })
    const big = await start(tight, tight.resolve({ command: 'for i in $(seq 1 100); do printf "line-%04d\\n" $i; done' }))
    await big.done
    const read = big.readOutput()
    expect(read.lossy).toBe(true)
    expect(read.stdoutSpillPath).toBeDefined()
    expect(readFileSync(read.stdoutSpillPath!, 'utf8')).toContain('line-0100')
  })
})

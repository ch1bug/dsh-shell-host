import { describe, expect, it } from 'vitest'
import { sshDescriptor } from '../src/remote/descriptor.ts'
import { RemoteShellExecutor } from '../src/remote/executor.ts'
import { fakeSshDescriptor } from './helpers/remote-fake-ssh.ts'
import type { ShellExecRequest } from '../src/remote/types.ts'

// Absorbed from dsh-shell-remote tests/executor.spec.ts (issue #29, ADR-0007
// pure move); renamed remote-executor.spec.ts to avoid the host repo's own
// executor.spec.ts (the local registry executor suite).

describe('RemoteShellExecutor.resolve', () => {
  it('expands the transport argv and passes the remote workdir through verbatim', () => {
    const exec = new RemoteShellExecutor('buildhost')
    const spec = exec.resolve({ command: 'echo hi', workdir: '/srv/app', timeoutMs: 5_000 })
    // The transport template shape is fixed; the command slot carries the
    // REMOTE payload wrapped in one extra single-quote layer — ssh joins argv
    // with bare spaces and the REMOTE shell re-splits them, so an unwrapped
    // payload would be torn apart (`bash -c cd -- ...` runs a bare `cd`).
    expect(spec.argv).toEqual(['ssh', 'buildhost', '--', 'bash', '-c', `'cd -- '\\''/srv/app'\\'' && eval '\\''echo hi'\\'''`])
    expect(spec.workdir).toBe('/srv/app')
    expect(spec.timeoutMs).toBe(5_000)
  })

  it('fails loudly on an unusable descriptor before any spawn could exist', () => {
    const exec = new RemoteShellExecutor('', { id: 'ssh', host: '', executable: [], argv: { oneShot: [] } })
    expect(() => exec.resolve({ command: 'x', workdir: '/', timeoutMs: 1 })).toThrow()
  })

  it('fails loudly on a host/descriptor mismatch instead of silently ignoring one', () => {
    expect(() => new RemoteShellExecutor('otherhost', sshDescriptor('buildhost'))).toThrow(/does not match the supplied descriptor/)
  })
})

describe('RemoteShellExecutor.execute (R2 ssh transport)', () => {
  it('runs the one-shot command remotely with the remote workdir, no local path mapping', async () => {
    const exec = new RemoteShellExecutor('buildhost', fakeSshDescriptor('happy'))
    const spec = exec.resolve({ command: 'echo hi', workdir: '/srv/app', timeoutMs: 5_000 })
    const result = await exec.execute(spec)
    // The fixture parses the remote payload `cd -- '/srv/app' && eval 'echo hi'`
    // — the workdir rides the REMOTE side of the transport, never mapped.
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('[cwd=/srv/app] out=echo hi\n')
    expect(result.stdout.truncated).toBe(false)
    expect(result.stderr.text).toBe('')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.signal).toBeNull()
    expect(result.timeoutMs).toBe(5_000)
    expect(result.sandbox).toBeUndefined()
  })

  it('reports a settled result when the ssh transport fails (exit 255 + note on stderr)', async () => {
    const exec = new RemoteShellExecutor('buildhost', fakeSshDescriptor('fail'))
    const spec = exec.resolve({ command: 'echo hi', workdir: '/srv/app', timeoutMs: 5_000 })
    const result = await exec.execute(spec)
    expect(result.exitCode).toBe(255)
    expect(result.stderr.text).toContain('Connection refused')
  })

  it('kills the ssh client on deadline expiry and classifies the run timedOut', async () => {
    const exec = new RemoteShellExecutor('buildhost', fakeSshDescriptor('slow'))
    const spec = exec.resolve({ command: 'sleep 30', workdir: '/srv/app', timeoutMs: 300 })
    const result = await exec.execute(spec)
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.signal).not.toBeNull()
  }, 10_000)

  it('classifies the caller abort as the first cause, not a timeout', async () => {
    const controller = new AbortController()
    const exec = new RemoteShellExecutor('buildhost', fakeSshDescriptor('slow'))
    const spec = exec.resolve({ command: 'sleep 30', workdir: '/srv/app', timeoutMs: 30_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const result = await exec.execute(spec)
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBeNull()
  }, 10_000)
  it('retains the TAIL under the output cap and sets truncated, never a spillPath', async () => {
    const exec = new RemoteShellExecutor('buildhost', fakeSshDescriptor('happy'))
    const spec = exec.resolve({ command: 'echo hi', workdir: '/srv/app', timeoutMs: 5_000, stdoutMaxBytes: 8 })
    const result = await exec.execute(spec)
    expect(result.stdout.truncated).toBe(true)
    // The happy fixture emits `[cwd=/srv/app] out=echo hi\n` — 28 raw bytes;
    // with an 8-byte cap the tail `echo hi\n` survives, the head is dropped.
    expect(result.stdout.text).toBe('echo hi\n')
    expect(result.stdout.spillPath).toBeUndefined()
    expect(result.stderr.truncated).toBe(false)
  })
})

describe('RemoteShellExecutor.execute (spill loudly-reject)', () => {
  it('rejects a spill-shaped request loudly, before any spawn', () => {
    const exec = new RemoteShellExecutor('buildhost')
    const request = { command: 'x', workdir: '/', timeoutMs: 1, spill: '/tmp/out' } as unknown as ShellExecRequest
    expect(() => exec.resolve(request)).toThrow(/spill is a host capability/)
  })
})

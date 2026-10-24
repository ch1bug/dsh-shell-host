import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { detectPlainBash } from '../src/detect.ts'
import { parseCommandLine } from '../src/pty/session-core.ts'
import { createSessionCore, resolveCoreConfig, type CoreSpawnSpec, type SessionCore } from '../src/pty/session-core.ts'
import { openRemoteSession } from '../src/remote/sessions.ts'
import { fakePty } from './helpers/fake-pty.ts'

const owner = {}
const cores: SessionCore[] = []
afterEach(async () => { await Promise.all(cores.splice(0).map((core) => core.dispose())) })
// win32 实测用例需要真 bash 执行组合出的 ssh 命令；缺解释器 loud skip（PASS*），不做硬红。
if (process.platform === 'win32' && !detectPlainBash()) console.warn('!! SKIP (loud) remote-session-launch：win32 缺少 bash 解释器，字面量 cwd/env 实测用例未验证')

function fixture() {
  const handles: ReturnType<typeof fakePty>[] = []
  const specs: CoreSpawnSpec[] = []
  const core = createSessionCore(resolveCoreConfig({ settleQuietMs: 3, settleTickMs: 1, settleTimeoutMs: 10 }), {
    platform: 'linux',
    spawnPty: (spec) => {
      specs.push(spec)
      const handle = fakePty()
      const kill = handle.pty.kill.bind(handle.pty)
      handle.pty.kill = () => { kill(); handle.emitExit({ exitCode: 0 }) }
      handles.push(handle)
      return handle.pty
    },
  })
  cores.push(core)
  return { core, handles, specs }
}

function token(command: string): string {
  const value = command.match(/DSH_REMOTE_READY_[a-f0-9]+/u)?.[0]
  expect(value).toBeDefined()
  return value!
}

const input = { declaration: { host: 'dev@example', root: '/srv/app' }, kind: 'shell', platform: 'linux' as const, timeoutMs: 200 }

describe('remote session launch through the PTY facade', () => {
  it('共享连接必须匹配实测身份，不能把另建连接报告成master的channel', async () => {
    const f = fixture()
    const pending = openRemoteSession(f.core, owner, { ...input, expectedConnection: '192.0.2.1 40001 192.0.2.2 22' })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'REMOTE_SESSION_CONNECTION_MISMATCH' })
    f.handles[0]!.emitData(`${token(f.specs[0]!.command)}|Linux|/bin/sh|192.0.2.1 40002 192.0.2.2 22\r\n`)
    await assertion
    expect(f.core.list(owner)).toEqual([])
    expect(f.handles[0]!.killed).toBe(1)
  })
  it('measures shell facts on its own connection and preserves banners across split marker chunks', async () => {
    const f = fixture()
    const pending = openRemoteSession(f.core, owner, { ...input, kind: 'build', cwd: "/srv/a'b", env: { TASK: "a'$(touch /tmp/no)" }, spawnCwd: '/local', authorizedMode: 'workspace-write' })
    const marker = token(f.specs[0]!.command)
    f.handles[0]!.emitData('login banner\r\n' + marker.slice(0, 12))
    setTimeout(() => f.handles[0]!.emitData(marker.slice(12) + '|Linux|/bin/bash\r\nafter banner\r\n'), 20)
    const opened = await pending
    expect(opened.remoteShell).toEqual({ uname: 'Linux', shell: '/bin/bash' })
    expect(opened.initialOutput).toBe('login banner\nafter banner\n')
    expect(opened.transport.shape).toBe('control-master')
    expect(f.core.list(owner)).toEqual([{ id: opened.sessionId, pid: 4242, status: { kind: 'running' } }])
    expect(f.core.modeOf(owner, opened.sessionId)).toBe('workspace-write')
    expect(f.specs[0]!.cwd).toBe('/local')
    expect(f.specs[0]!.env).toBeUndefined()
    expect(f.handles[0]!.writes).toEqual([])
    expect(f.specs[0]!.command).toContain('ControlMaster=no')
    expect(f.specs[0]!.command).not.toContain('ControlPath=none')
    expect(f.specs[0]!.command).toContain('exec sh -i')
  })

  it.each([
    ['Windows_NT', '/bin/bash', 'REMOTE_NON_POSIX_SHELL'],
    ['Linux', 'C:/pwsh.exe', 'REMOTE_NON_POSIX_SHELL'],
    ['Linux', '', 'REMOTE_SHELL_UNPROBED'],
  ])('refuses unsupported facts %s/%s and reclaims the actual PTY id', async (uname, shell, code) => {
    const f = fixture()
    const pending = openRemoteSession(f.core, owner, input)
    const assertion = expect(pending).rejects.toMatchObject({ code })
    f.handles[0]!.emitData(`${token(f.specs[0]!.command)}|${uname}|${shell}\r\n`)
    await assertion
    expect(f.core.list(owner)).toEqual([])
    expect(f.handles[0]!.killed).toBe(1)
  })

  it('times out rather than trusting a banner containing an unrelated marker', async () => {
    const f = fixture()
    const pending = openRemoteSession(f.core, owner, { ...input, timeoutMs: 25 })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'REMOTE_SESSION_TIMEOUT' })
    f.handles[0]!.emitData('DSH_REMOTE_READY_other|Linux|/bin/sh\r\n')
    await assertion
    expect(f.core.list(owner)).toEqual([])
    expect(f.handles[0]!.writes).toEqual([])
  })

  it('closes an id when aborted while core.open is still settling', async () => {
    const f = fixture()
    const controller = new AbortController()
    const pending = openRemoteSession(f.core, owner, { ...input, signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'REMOTE_SESSION_ABORTED' })
    controller.abort()
    await assertion
    expect(f.core.list(owner)).toEqual([])
    expect(f.handles[0]!.killed).toBe(1)
  })

  it('refuses a session that exited even if its startup buffer contains a valid marker', async () => {
    const f = fixture()
    const pending = openRemoteSession(f.core, owner, input)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'REMOTE_SESSION_EXITED' })
    f.handles[0]!.emitData(`${token(f.specs[0]!.command)}|Linux|/bin/sh\r\n`)
    f.handles[0]!.emitExit({ exitCode: 127 })
    await assertion
    expect(f.core.list(owner)).toEqual([])
  })

  it('opens separate shells, uses the custom master socket, and never inherits remote env locally', async () => {
    const f = fixture()
    for (const kind of ['shell', 'test']) {
      const pending = openRemoteSession(f.core, owner, { ...input, kind, declaration: { ...input.declaration, options: [{ key: 'cOnTrOlPaTh', value: '/tmp/a socket' }, 'ControlPersist=yes'] } })
      const i = f.specs.length - 1
      f.handles[i]!.emitData(`${token(f.specs[i]!.command)}|Darwin|/bin/zsh\r\n`)
      expect((await pending).remoteShell).toEqual({ uname: 'Darwin', shell: '/bin/zsh' })
    }
    expect(f.core.list(owner)).toHaveLength(2)
    expect(f.specs[0]!.command).toContain("ControlPath='/tmp/a socket'")
    expect(f.specs[0]!.command).not.toContain('ControlPersist=yes')
    expect(f.specs[0]!.command).not.toBe(f.specs[1]!.command)
  })

  it.each(['win32', 'linux'] as const)('disables sharing for %s when selected and propagates measured output', async (platform) => {
    const f = fixture()
    const pending = openRemoteSession(f.core, owner, { ...input, platform, declaration: { ...input.declaration, options: ['ControlMaster=no'] } })
    f.handles[0]!.emitData(`before\n${token(f.specs[0]!.command)}|Linux|/bin/sh\nafter\n`)
    const opened = await pending
    expect(opened.transport.shape).toBe('per-session-connection')
    expect(opened.initialOutput).toBe('before\nafter\n')
    expect(f.specs[0]!.command).toContain('ControlPath=none')
  })

  it('validates kind, cwd, env names, and pre-aborted requests before spawning', async () => {
    const f = fixture()
    await expect(openRemoteSession(f.core, owner, { ...input, kind: 'deploy' })).rejects.toMatchObject({ code: 'REMOTE_INVALID_SESSION_KIND' })
    await expect(openRemoteSession(f.core, owner, { ...input, cwd: 'relative' })).rejects.toMatchObject({ code: 'REMOTE_INVALID_PATH' })
    await expect(openRemoteSession(f.core, owner, { ...input, env: { 'A; touch /tmp/no': 'bad' } })).rejects.toMatchObject({ code: 'REMOTE_INVALID_ENV' })
    await expect(openRemoteSession(f.core, owner, { ...input, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'REMOTE_SESSION_ABORTED' })
    expect(f.specs).toEqual([])
  })

  it('bounds startup output without losing cleanup responsibility', async () => {
    const f = fixture()
    const pending = openRemoteSession(f.core, owner, input)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'REMOTE_SESSION_OUTPUT_LIMIT' })
    f.handles[0]!.emitData('x'.repeat(70 * 1024) + '\n')
    await assertion
    expect(f.core.list(owner)).toEqual([])
  })

  it('reports both the original startup failure and a close failure, with the retryable id', async () => {
    const f = fixture()
    const cleanupError = new Error('close failed')
    const adapter = { open: f.core.open, tail: f.core.tail, list: f.core.list, close: async () => { throw cleanupError } }
    const pending = openRemoteSession(adapter, owner, { ...input, timeoutMs: 15 })
    try {
      await pending
      expect.fail('launch must fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      const aggregate = error as AggregateError & { sessionId: string }
      expect(aggregate.errors[0]).toMatchObject({ code: 'REMOTE_SESSION_TIMEOUT' })
      expect(aggregate.errors[1]).toBe(cleanupError)
      expect(f.core.list(owner).map((row) => row.id)).toEqual([aggregate.sessionId])
    }
  })

  it.skipIf(process.platform === 'win32' && !detectPlainBash())('executes the composed remote shell with literal cwd/env values rather than interpreting their shell syntax', async () => {
    const f = fixture()
    const platform = process.platform
    // win32 用仓内统一的 bash 探测（src/detect.ts），缺解释器时 loud skip 而非硬红；
    // posix 直接用 /bin/bash。
    const bash = platform === 'win32' ? detectPlainBash()! : '/bin/bash'
    const root = process.cwd().replace(/\\/gu, '/').replace(/^([A-Za-z]):/u, (_, drive: string) => `/${drive.toLowerCase()}`)
    const value = "value'$(printf INJECTED);$HOME"
    const pending = openRemoteSession(f.core, owner, { ...input, platform, cwd: root, env: { TASK: value }, timeoutMs: 2000 })
    const command = f.specs[0]!.command
    const remote = platform === 'win32'
      ? parseCommandLine(command).at(-1)!
      : `ssh() { /bin/bash -c "\${!#}"; }; ${command}`
    const executed = spawnSync(bash, ['-c', remote], {
      input: 'printf "__REMOTE_VALUE__%s\\n" "$TASK"; printf "__REMOTE_CWD__%s\\n" "$PWD"; exit\n',
      encoding: 'utf8', timeout: 1000, env: { ...process.env, SHELL: '/bin/bash' },
    })
    expect(executed.error).toBeUndefined()
    expect(executed.status, executed.stderr).toBe(0)
    expect(executed.stdout).toContain(`__REMOTE_VALUE__${value}\n`)
    expect(executed.stdout).toContain(`__REMOTE_CWD__${root}\n`)
    // The local MSYS process is not a supported remote POSIX host; its
    // measured rejection proves that these actual bytes reached the PTY.
    const assertion = platform === 'win32'
      ? expect(pending).rejects.toMatchObject({ code: 'REMOTE_NON_POSIX_SHELL' })
      : expect(pending).resolves.toMatchObject({ remoteShell: { shell: '/bin/bash' } })
    f.handles[0]!.emitData(executed.stdout)
    await assertion
  })

  it('rejects malformed runtime env values and cwd with stable errors, before spawning', async () => {
    const f = fixture()
    await expect(openRemoteSession(f.core, owner, { ...input, env: { TASK: 123 } as unknown as Record<string, string> })).rejects.toMatchObject({ code: 'REMOTE_INVALID_ENV' })
    await expect(openRemoteSession(f.core, owner, { ...input, cwd: 42 as unknown as string })).rejects.toMatchObject({ code: 'REMOTE_INVALID_PATH' })
    expect(f.specs).toEqual([])
  })


  it('preserves a bounded burst of more than 512 banner lines while waiting for the marker', async () => {
    const f = fixture()
    const pending = openRemoteSession(f.core, owner, input)
    const marker = token(f.specs[0]!.command)
    f.handles[0]!.emitData('first banner\n')
    const banner = 'banner line\n'.repeat(600)
    setTimeout(() => f.handles[0]!.emitData(`${banner}${marker}|Linux|/bin/sh\nlast banner\n`), 20)
    expect((await pending).initialOutput).toBe(`first banner\n${banner}last banner\n`)
  })

})

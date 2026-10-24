/** #140：从工作区工具到同一PTY注册表的多会话行为。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootPlugin, echoFakePty, type FakePtyHandle } from './helpers/fake-pty.ts'
import { fakeSandboxPolicy } from './helpers/fake-permissions.ts'
import { fakeChannelHarness, frameLoopResponder, posixRemoteExec } from './helpers/fake-channel.ts'
import type { RemoteWorkspaceService } from '../src/remote/service.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function boot(maxSessions = 8, platform: NodeJS.Platform = 'win32', onSessionSpawn?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'remote-sessions-'))
  const harness = fakeChannelHarness({ respond: frameLoopResponder(command => command.startsWith('# dsh-connection\n')
    ? { exitCode: 0, stdout: '192.0.2.1 40001 192.0.2.2 22' }
    : posixRemoteExec(command)) })
  const handles: FakePtyHandle[] = []
  const policy = fakeSandboxPolicy()
  const b = bootPlugin({
    permissions: { sandboxPolicy: policy },
    config: { maxSessions, settleQuietMs: 10, settleTickMs: 2, settleTimeoutMs: 100 },
    spawnPty: (spec) => {
      const handle = echoFakePty('REMOTE:')
      handles.push(handle)
      const marker = spec.command.match(/DSH_REMOTE_READY_[a-f0-9]+/u)?.[0]
      if (marker !== undefined) {
        setTimeout(() => handle.emitData(`${marker}|Linux|/bin/bash${platform === 'linux' ? '|192.0.2.1 40001 192.0.2.2 22' : ''}\r\n`), 1)
        queueMicrotask(() => onSessionSpawn?.())
      }
      return handle
    },
    remote: { anchorRoot: root, keepaliveMs: 0, reconnectMax: 0, requestTimeoutMs: 200 },
    remoteDeps: { spawner: harness.spawner, platform },
  })
  const service = b.provided.get('remote') as RemoteWorkspaceService
  cleanups.push(async () => { await service.dispose(); await b.core.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { ...b, service, harness, handles, policy }
}

describe('#140 工作区会话编排', () => {
  it('POSIX共享master时各shell有独立PTY，归属同连接且禁止无master时偷偷直连', async () => {
    const b = boot(8, 'linux'), owner = {}
    const w = await b.service.open({ host: 'example', root: '/app' })
    const first = await b.service.openSession(w.workspaceId, 'shell', { owner })
    const second = await b.service.openSession(w.workspaceId, 'build', { owner })
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.connectionId).toBe(w.connectionId)
    expect(second.connectionId).toBe(w.connectionId)
    expect(first.transport.shape).toBe('control-master')
    expect(b.specs[0]!.command).not.toContain('ProxyCommand=false')
    expect(b.specs[0]!.command).toContain('SSH_CONNECTION')
  })
  it('入口公开openSession与closeWorkspace，空工作区列表携带空会话列表', async () => {
    const b = boot()
    expect(typeof b.service.openSession).toBe('function')
    expect(typeof b.service.closeWorkspace).toBe('function')
    expect(b.tool('remote_open_session').name).toBe('remote_open_session')
    expect(b.tool('remote_close_workspace').name).toBe('remote_close_workspace')
    const owner = {}
    const w = await b.tool('remote_open').execute({ host: 'example', root: '/app' }, { agent: owner })
    const listed = await b.tool('remote_list').execute({}, { agent: owner })
    expect(listed.workspaces[0]).toMatchObject({ host: 'example', root: '/app', sessions: [] })
    expect(w.workspaceId).toBeTruthy()
  })
  it('同工作区开多条原生PTY id，各自send/tail/close；退出状态来自PTY而非文件连接', async () => {
    const b = boot(), owner = {}
    const w = await b.service.open({ host: 'example', root: '/app', port: 2221, jump: 'jump' })
    const first = await b.tool('remote_open_session').execute({ workspaceId: w.workspaceId, kind: 'shell', cwd: '/app/a', env: { A: 'one' } }, { agent: owner })
    const second = await b.service.openSession(w.workspaceId, 'test', { owner, cwd: '/app/b' })
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(b.core.list(owner).map(row => row.id)).toEqual([first.sessionId, second.sessionId])
    expect(b.service.list(owner)[0]?.sessions.map(row => [row.id, row.kind, row.cwd, row.status.kind])).toEqual([
      [first.sessionId, 'shell', '/app/a', 'running'], [second.sessionId, 'test', '/app/b', 'running'],
    ])
    expect(first.connectionId).not.toBe(second.connectionId)
    expect((await b.tool('pty_send').execute({ id: first.sessionId, data: 'pwd' }, { agent: owner })).delta).toContain('REMOTE:pwd')
    await expect(b.tool('pty_tail').execute({ id: first.sessionId }, { agent: {} })).rejects.toMatchObject({ code: 'NO_SESSION' })
    await b.tool('pty_close').execute({ id: first.sessionId }, { agent: owner })
    expect(b.service.list(owner)[0]?.sessions.map(row => row.id)).toEqual([second.sessionId])
    expect(b.specs[0]?.command).toContain('-p 2221')
    expect(b.specs[0]?.command).toContain('-J jump')
  })
  it('退出状态由PTY派生，工具列表不泄露其他owner会话', async () => {
    const b = boot(), owner = {}, foreign = {}
    const w = await b.service.open({ host: 'example', root: '/app' })
    const opened = await b.service.openSession(w.workspaceId, 'shell', { owner })
    await b.service.openSession(w.workspaceId, 'build', { owner: foreign })
    b.handles[0]!.emitExit({ exitCode: 7 })
    const listed = await b.tool('remote_status').execute({ workspaceId: w.workspaceId }, { agent: owner })
    expect(listed.workspaces[0].state).toBe('ready')
    expect(listed.workspaces[0].sessions).toHaveLength(1)
    expect(listed.workspaces[0].sessions[0]).toMatchObject({ id: opened.sessionId, status: { kind: 'exited', exitCode: 7 }, reconnectPolicy: 'manual', transport: { shape: 'per-session-connection' } })
    expect(listed.workspaces[0].sessions[0].connectionId).not.toBe(listed.workspaces[0].connectionId)
    const again = await b.tool('remote_open').execute({ host: 'example', root: '/app' }, { agent: {} })
    expect(again.sessions).toEqual([])
  })
  it('PTY软上限跨本地/工作区共享，已退出但未关闭仍占slot；超限列出当前会话', async () => {
    const b = boot(2), owner = {}
    const w = await b.service.open({ host: 'example', root: '/app' })
    const local = await b.tool('pty_open').execute({ command: 'local' }, { agent: owner })
    const remote = await b.service.openSession(w.workspaceId, 'build', { owner })
    b.handles[1]!.emitExit({ exitCode: 0 })
    await expect(b.service.openSession(w.workspaceId, 'test', { owner })).rejects.toThrow(/pty-\d/u)
    expect(b.core.list(owner).map(row => row.id)).toEqual([local.sessionId, remote.sessionId])
    expect(b.specs).toHaveLength(2)
    await b.tool('pty_close').execute({ id: remote.sessionId }, { agent: owner })
    const next = await b.service.openSession(w.workspaceId, 'test', { owner })
    expect(next.sessionId).not.toBe(remote.sessionId)
  })
  it('closeWorkspace整批回收所有owner的id，保留其他工作区和本地PTY；可重新打开', async () => {
    const b = boot(), owner = {}, other = {}
    const a = await b.service.open({ host: 'example', root: '/a' })
    const z = await b.service.open({ host: 'example', root: '/z' })
    const local = await b.tool('pty_open').execute({ command: 'local' }, { agent: owner })
    const first = await b.service.openSession(a.workspaceId, 'shell', { owner })
    const second = await b.service.openSession(a.workspaceId, 'build', { owner: other })
    const survivor = await b.service.openSession(z.workspaceId, 'test', { owner })
    const closed = await b.tool('remote_close_workspace').execute({ workspaceId: a.workspaceId }, { agent: owner })
    expect(closed).toEqual({ closed: true, sessionIds: [first.sessionId, second.sessionId] })
    for (const [agent, id] of [[owner, first.sessionId], [other, second.sessionId]] as const) {
      await expect(b.tool('pty_send').execute({ id, data: 'bad' }, { agent })).rejects.toMatchObject({ code: 'NO_SESSION' })
      await expect(b.tool('pty_tail').execute({ id }, { agent })).rejects.toMatchObject({ code: 'NO_SESSION' })
    }
    expect(b.core.list(owner).map(row => row.id)).toEqual([local.sessionId, survivor.sessionId])
    expect(b.harness.last().killed).toBe(0)
    expect(b.service.list()[0]?.channel.users).toBe(1)
    expect(await b.service.closeWorkspace(a.workspaceId)).toEqual({ closed: false, sessionIds: [] })
    await b.service.closeWorkspace(z.workspaceId)
    expect(b.harness.last().killed).toBe(1)
    const reopened = await b.service.open({ host: 'example', root: '/a' })
    expect(reopened.workspaceId).toBe(a.workspaceId)
    expect(reopened.channel.state).toBe('ready')
  })
  it('closeWorkspace等待已排队open并回收其id，后排open不能复活已关闭工作区', async () => {
    const b = boot(), owner = {}
    const w = await b.service.open({ host: 'example', root: '/app' })
    const pending = b.service.openSession(w.workspaceId, 'shell', { owner })
    const closing = b.service.closeWorkspace(w.workspaceId)
    const late = b.service.openSession(w.workspaceId, 'test', { owner })
    const lateRejected = expect(late).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_UNKNOWN' })
    const opened = await pending
    expect((await closing).sessionIds).toEqual([opened.sessionId])
    await lateRejected
    expect(b.core.list(owner)).toEqual([])
    expect(b.service.list()).toEqual([])
  })
  it('dispose发生在core.open探测期间，也必须回收未发布PTY', async () => {
    let disposal: Promise<void> | undefined
    const b = boot(8, 'win32', () => { disposal = b.service.dispose() }), owner = {}
    const w = await b.service.open({ host: 'example', root: '/app' })
    const pending = b.service.openSession(w.workspaceId, 'shell', { owner })
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_CHANNEL_CLOSED' })
    expect(disposal).toBeDefined()
    await disposal
    expect(b.core.list(owner)).toEqual([])
    expect(b.service.list()).toEqual([])
  })
  it('单条close失败时不丢重试责任，不清其他工作区；重试成功后id不可用', async () => {
    const b = boot(), owner = {}
    const w = await b.service.open({ host: 'example', root: '/app' })
    const opened = await b.service.openSession(w.workspaceId, 'shell', { owner })
    const close = b.core.close
    b.core.close = async () => { throw new Error('injected close failure') }
    await expect(b.service.closeWorkspace(w.workspaceId)).rejects.toBeInstanceOf(AggregateError)
    expect(b.service.require(w.workspaceId).sessions.map(row => row.id)).toEqual([opened.sessionId])
    b.core.close = close
    expect((await b.service.closeWorkspace(w.workspaceId)).sessionIds).toEqual([opened.sessionId])
    expect(b.core.list(owner)).toEqual([])
  })
  it('每次open重解析policy，PTY send保留真实grant的降级保护，读和整批收尾仍可用', async () => {
    const b = boot(), owner = {}
    const w = await b.service.open({ host: 'example', root: '/app' })
    const opened = await b.service.openSession(w.workspaceId, 'shell', { owner })
    b.policy.setMode('read-only')
    await expect(b.service.openSession(w.workspaceId, 'test', { owner })).rejects.toMatchObject({ code: 'SANDBOX_DENIED' })
    await expect(b.tool('pty_send').execute({ id: opened.sessionId, data: 'bad' }, { agent: owner })).rejects.toMatchObject({ code: 'SESSION_SANDBOX_DOWNGRADED' })
    expect(b.handles[0]!.writes).toEqual([])
    await b.tool('pty_tail').execute({ id: opened.sessionId }, { agent: owner })
    expect(b.specs).toHaveLength(1)
    expect((await b.service.closeWorkspace(w.workspaceId)).closed).toBe(true)
  })
})

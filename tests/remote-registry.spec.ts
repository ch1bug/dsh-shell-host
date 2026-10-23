/** #137：注册并发、卸载终态、锚点权限与连接身份的公开服务/工具回归。 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootPlugin } from './helpers/fake-pty.ts'
import { fakeChannelHarness } from './helpers/fake-channel.ts'
import { fakeSandboxPolicy } from './helpers/fake-permissions.ts'
import type { RemoteWorkspaceService } from '../src/remote/service.ts'
import { ANCHOR_MARKER_FILE } from '../src/remote/index.ts'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function temp() { const root = mkdtempSync(join(tmpdir(), 'remote-registry-')); roots.push(root); return root }
function boot(root: string, mode: 'workspace-write' | 'danger-full-access' = 'danger-full-access') {
  const harness = fakeChannelHarness()
  const b = bootPlugin({
    permissions: { sandboxPolicy: fakeSandboxPolicy({ mode, workspaceRoot: root }) },
    remote: { anchorRoot: root, reconnectMax: 0, keepaliveMs: 0 },
    remoteDeps: { spawner: harness.spawner, platform: 'win32' },
  })
  const service = b.provided.get('remote') as RemoteWorkspaceService
  cleanups.push(() => service.dispose())
  return { ...b, service, harness }
}

describe('注册的原子性与终态', () => {
  it('各会话使用本次授权的cwd与默认锚点，不复用另一会话的根', async () => {
    const a = temp(); const b = temp(); const harness = fakeChannelHarness()
    const booted = bootPlugin({
      services: { sandboxPolicy: { resolve: (request?: { session?: { cwd: string } }) => ({ mode: 'workspace-write', workspaceRoot: request?.session?.cwd ?? a }) } },
      remote: { keepaliveMs: 0 }, remoteDeps: { spawner: harness.spawner, platform: 'win32' },
    })
    const service = booted.provided.get('remote') as RemoteWorkspaceService; cleanups.push(() => service.dispose())
    await booted.tool('remote_open').execute({ host: 'one', root: '/app' }, { agent: { session: { cwd: a } } })
    const second = await booted.tool('remote_open').execute({ host: 'two', root: '/app' }, { agent: { session: { cwd: b } } })
    expect(harness.handles.map((h) => h.spec.cwd)).toEqual([a, b])
    expect(second.anchor.startsWith(b)).toBe(true)
  })

  it('宿主提供workspaceRegistry时，把锚点登记为普通工作区', async () => {
    const root = temp(); const harness = fakeChannelHarness(); const created: string[] = []
    const b = bootPlugin({
      services: { workspaceRegistry: { create: async (path: string) => { created.push(path); expect(existsSync(join(path, ANCHOR_MARKER_FILE))).toBe(true); return { id: 'host-workspace' } } } },
      remote: { anchorRoot: root, keepaliveMs: 0 }, remoteDeps: { spawner: harness.spawner, platform: 'win32' },
    })
    const service = b.provided.get('remote') as RemoteWorkspaceService; cleanups.push(() => service.dispose())
    const workspace = await service.open({ host: 'example', root: '/app' })
    expect(created).toEqual([workspace.anchor])
  })

  it('并发同一工作区只占一个引用，dispose不遗留连接', async () => {
    const b = boot(temp())
    const decl = { host: 'example', root: '/srv/app' }
    await Promise.all([b.service.open(decl), b.service.open(decl)])
    expect(b.service.list()).toHaveLength(1)
    expect(b.service.list()[0]?.channel.users).toBe(1)
    await b.service.dispose()
    expect(b.harness.last().killed).toBe(1)
  })
  it('同时注册不同身份不能覆盖同一个锚点', async () => {
    const root = temp(); const b = boot(root); const anchor = join(root, 'shared')
    const result = await Promise.allSettled([
      b.service.open({ host: 'example', root: '/a', anchor }),
      b.service.open({ host: 'example', root: '/b', anchor }),
    ])
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(b.service.list()).toHaveLength(1)
  })
  it('注册仍在本地IO时卸载，不得在卸载后spawn', async () => {
    const b = boot(temp())
    const pending = b.service.open({ host: 'example', root: '/app' })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'REMOTE_CHANNEL_CLOSED' })
    await b.service.dispose(); await rejected
    expect(b.harness.handles).toHaveLength(0)
  })
  it('同host不同port明确拒绝而非静默复用第一台机器', async () => {
    const b = boot(temp())
    await b.service.open({ host: 'example', root: '/a', port: 2221 })
    await expect(b.service.open({ host: 'example', root: '/b', port: 2222 })).rejects.toMatchObject({ code: 'REMOTE_CONNECTION_CONFLICT' })
    expect(b.harness.handles).toHaveLength(1)
  })
  it('通道死亡后的workspace状态由通道事实派生', async () => {
    const b = boot(temp())
    await b.service.open({ host: 'example', root: '/a' })
    b.harness.last().exit({ code: 255, stderr: 'Connection reset' })
    expect(b.service.list()[0]?.state).toBe('unavailable')
    expect(b.service.list()[0]?.error?.code).toBe('REMOTE_CHANNEL_DEAD')
  })
})

describe('锚点是受权限约束的本地写入', () => {
  it('workspace-write不能创建根外marker，拒绝前不spawn', async () => {
    const root = temp(); const outside = join(temp(), 'outside'); const b = boot(root, 'workspace-write')
    await expect(b.tool('remote_open').execute({ host: 'example', root: '/app', anchor: outside }, { agent: {} })).rejects.toMatchObject({ code: 'SANDBOX_DENIED' })
    expect(existsSync(outside)).toBe(false)
    expect(b.harness.handles).toHaveLength(0)
  })
  it('拒绝marker符号链接，不读取或覆盖链接目标', async () => {
    const root = temp(); const b = boot(root); const anchor = join(root, 'anchor'); mkdirSync(anchor)
    const target = join(root, 'unrelated.json'); writeFileSync(target, JSON.stringify({ host: 'example', root: '/app' }))
    symlinkSync(target, join(anchor, ANCHOR_MARKER_FILE))
    await expect(b.service.open({ host: 'example', root: '/app', anchor })).rejects.toMatchObject({ code: 'REMOTE_ANCHOR_CONFLICT' })
    expect(b.harness.handles).toHaveLength(0)
  })
})

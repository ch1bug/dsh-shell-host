/** #137：传输形态必须与落实的启动参数一致，而非仅按客户端平台推断。 */
import { describe, expect, it } from 'vitest'
import { channelArgv, RemoteChannel } from '../src/remote/channel.ts'
import { fakeChannelHarness } from './helpers/fake-channel.ts'
const base = { host: 'example', requestTimeoutMs: 100, keepaliveMs: 0, reconnectMax: 0, reconnectBaseMs: 1 }
describe('传输形态的可观测性', () => {
  it('ControlPath=none明确禁用共享，状态不可虚报master', async () => {
    const harness = fakeChannelHarness()
    const channel = new RemoteChannel({ ...base, platform: 'linux', ssh: { options: ['ControlPath=none'] }, spawner: harness.spawner })
    try { await channel.acquire(); expect(channel.status().transport.shape).toBe('per-session-connection') }
    finally { channel.close() }
  })

  it('Windows明确关闭OpenSSH配置里的multiplexing，绝不尝试master', () => {
    const argv = channelArgv({ ...base, platform: 'win32' })
    expect(argv).toContain('ControlMaster=no')
    expect(argv).toContain('ControlPath=none')
  })
  it('Windows显式要求master也响亮拒绝，不偷偷尝试再回退', () => {
    expect(() => channelArgv({ ...base, platform: 'win32', ssh: { options: ['ControlMaster=yes'] } })).toThrow(/ControlMaster/u)
  })
  it('POSIX调用方关闭master时状态也必须报独立连接', async () => {
    const harness = fakeChannelHarness()
    const channel = new RemoteChannel({ ...base, platform: 'linux', ssh: { options: ['controlmaster=no'] }, spawner: harness.spawner })
    try {
      await channel.acquire()
      expect(channel.status().transport.shape).toBe('per-session-connection')
      expect(harness.last().spec.argv).toContain('ControlPath=none')
    } finally { channel.close() }
  })
  it('仅自定socket路径时仍明确开启master，不把配置中的no误报为master', () => {
    const argv = channelArgv({ ...base, platform: 'linux', ssh: { options: ['ControlPath=/tmp/mine.sock'] } })
    expect(argv).toContain('ControlMaster=yes')
    expect(argv).toContain('ControlPath=/tmp/mine.sock')
  })
})

/** #138：公共FS→长驻通道→shipping codec；故障按请求顺序注入，不特判shell文本。 */
import { describe, expect, it } from 'vitest'
import { createRemoteFileSystem } from '../src/remote-fs/index.ts'
import { RemoteChannel } from '../src/remote/channel.ts'
import { encodeResponse } from '../src/remote/frame.ts'
import { fakeChannelHarness } from './helpers/fake-channel.ts'
import type { RemoteWorkspaceService, RemoteWorkspaceStatus } from '../src/remote/service.ts'

const size = 256 * 1024 + 3
const meta = Buffer.from(`v1\0` + `81a4\0${size}\0`)
const payload = Buffer.alloc(size, 0xff)
payload.set([0, 13, 10], size - 3)
function harness(mode: 'split' | 'dead' | 'timeout' | 'short' | 'changed' = 'split') {
  const replies = [meta, meta, payload.subarray(0, 256 * 1024), meta, meta, payload.subarray(256 * 1024), meta, meta]
  let index = -1
  const wire = fakeChannelHarness({ respond: request => {
    if (index === -1) { index++; return encodeResponse(request.id, 0, 'Linux|/bin/sh') }
    const at = index++, bytes = replies[at]!
    if (at === 5 && mode === 'dead') { queueMicrotask(() => wire.last().exit({ code: 255 })); return undefined }
    if (at === 5 && mode === 'timeout') return undefined
    const output = at === 5 && mode === 'short' ? Buffer.alloc(0) : at === 6 && mode === 'changed' ? Buffer.from(`v2\0` + `81a4\0${size}\0`) : bytes
    const frame = encodeResponse(request.id, 0, output)
    // 一次data含本帧尾部与下一条完整帧：已结算id的重复帧不影响后续请求。
    queueMicrotask(() => {
      wire.last().emit(frame.slice(0, 17))
      wire.last().emit(frame.slice(17) + frame)
    })
    return undefined
  } })
  const channel = new RemoteChannel({ host: 'test', requestTimeoutMs: 100, keepaliveMs: 0, reconnectMax: 0, reconnectBaseMs: 1, spawner: wire.spawner })
  const row: RemoteWorkspaceStatus = { workspaceId: 'w', host: 'test', root: '/srv', anchor: '/anchor', state: 'ready', channel: channel.status() }
  const remote: RemoteWorkspaceService = { list: () => [row], workspace: () => row, require: () => row, workspaceForAnchor: () => row, exec: (_id, command) => channel.request(command), open: async () => row, dispose: async () => { channel.close() } }
  const target = { targetKey: 'test\0/srv/data' as import('../src/remote-fs/contract.ts').FsTargetKey, displayPath: '/srv/data' }
  return { channel, fs: createRemoteFileSystem(remote), target }
}
describe('#138 分块读传输终态', () => {
  it('base64非UTF8/NUL跨多帧，半包与粘包不改变字节', async () => {
    const h = harness()
    try {
      await h.channel.acquire()
      expect(Buffer.from(await h.fs.readBytes(h.target, undefined, size))).toEqual(payload)
    } finally { h.channel.close() }
  })
  it.each(['dead', 'timeout', 'short', 'changed'] as const)('已有前缀后 %s 必须拒绝整次读取', async mode => {
    const h = harness(mode)
    try {
      await h.channel.acquire()
      await expect(h.fs.readBytes(h.target, undefined, size)).rejects.toMatchObject({ code: mode === 'changed' ? 'FS_STALE_VERSION' : 'FS_IO_ERROR' })
    } finally { h.channel.close() }
  })
})

/** #137 / ADR-0016:236：版本与clientId握手必须先于远端能力探测。 */
import { describe, expect, it } from 'vitest'
import { RemoteChannel, type ChannelSpawner } from '../src/remote/channel.ts'
import { encodeResponse } from '../src/remote/frame.ts'
function peer(reply?: (version: string, clientId: string) => { exitCode?: number; stdout: string }) {
  const commands: string[] = []
  const spawner: ChannelSpawner = () => {
    let output: (chunk: Buffer) => void = () => {}
    return {
      write(wire) {
        const [, id, payload] = wire.trimEnd().split(' ')
        const command = Buffer.from(payload ?? '', 'base64').toString()
        commands.push(command)
        let result = { exitCode: 0, stdout: 'Linux|/bin/sh' }
        if (command.startsWith('DSH-HELLO ')) {
          const [, version = '', clientId = ''] = command.split(' ')
          const value = reply?.(version, clientId) ?? { stdout: `${version} ${clientId}` }
          result = { exitCode: value.exitCode ?? 0, stdout: value.stdout }
        }
        output(Buffer.from(encodeResponse(Number(id), result.exitCode, result.stdout)))
        return true
      },
      onStdout(cb) { output = cb }, onStderr() {}, onExit() {}, kill() {},
    }
  }
  return { commands, channel: new RemoteChannel({ host: 'example', platform: 'win32', requestTimeoutMs: 200, keepaliveMs: 0, reconnectMax: 0, reconnectBaseMs: 0, spawner }) }
}
describe('版本握手', () => {
  it('先交换协议版本与唯一clientId，再做uname/SHELL探测', async () => {
    const p = peer()
    try {
      await p.channel.acquire()
      expect(p.commands[0]).toMatch(/^DSH-HELLO 1 [a-f0-9-]{36}$/u)
      expect(p.commands[1]).toContain('uname -s')
    } finally { p.channel.close() }
  })
  it('异版peer响亮拒绝，绝不进入文件请求', async () => {
    const p = peer((_version, id) => ({ stdout: `999 ${id}` }))
    try { await expect(p.channel.acquire()).rejects.toMatchObject({ code: 'REMOTE_PROTOCOL_VERSION' }); expect(p.commands).toHaveLength(1) }
    finally { p.channel.close() }
  })
  it('clientId不匹配说明串线，响亮拒绝', async () => {
    const p = peer(() => ({ stdout: '1 wrong-client' }))
    try { await expect(p.channel.acquire()).rejects.toMatchObject({ code: 'REMOTE_PROTOCOL_ERROR' }) }
    finally { p.channel.close() }
  })
  it('旧peer不认识握手命令时也是协议失败，不误报缺sh', async () => {
    const p = peer(() => ({ exitCode: 127, stdout: '' }))
    try { await expect(p.channel.acquire()).rejects.toMatchObject({ code: 'REMOTE_PROTOCOL_VERSION' }) }
    finally { p.channel.close() }
  })
})

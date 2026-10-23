/** #137：pipe argv 与 PTY 命令行的引用层不同，选项语义必须保持同源。 */
import { describe, expect, it } from 'vitest'
import { composeSshArgv, composeSshCommand } from '../src/ssh/compose.ts'

describe('ssh 两种传输形态的引用边界', () => {
  it('pipe argv 传原始 ProxyCommand 值，不能把 shell 引号传给 ssh', () => {
    const args = { host: 'example', options: [{ key: 'ProxyCommand', value: 'nc %h %p' }] }
    expect(composeSshArgv({ ...args, tty: false })).toContain('ProxyCommand=nc %h %p')
    expect(composeSshCommand(args)).toContain("ProxyCommand='nc %h %p'")
  })
})

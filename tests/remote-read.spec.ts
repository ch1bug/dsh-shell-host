/** #138：只经注册工具的公共 execute/render 面验证远程 read。 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FsInfo, FsTarget, FsTargetKey, FsVersion, RemoteFileSystem } from '../src/remote-fs/contract.ts'
import { FsError } from '../src/remote-fs/contract.ts'
import { registerRemoteRead } from '../src/remote-fs/read-tool.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext
function harness(text = 'one\ntwo\nthree\n', info: FsInfo | undefined = { type: 'file', size: 14, version: 'v' as FsVersion }) {
  const target: FsTarget = { targetKey: 'remote' as FsTargetKey, displayPath: '/srv/file.txt' }
  const fs = {
    resolve: vi.fn(async () => target), stat: vi.fn(async () => info),
    processPath: vi.fn(() => '/srv/canonical.txt'), readText: vi.fn(async () => text),
    streamText: vi.fn(async function* () { yield text }),
  }
  const streamText = vi.fn(async () => fs.streamText())
  const service = { ...fs, streamText } as unknown as RemoteFileSystem
  let registered: ToolDefinition | undefined
  const cwd = vi.fn(async (_exec: ToolRunContext) => '/anchor/work')
  registerRemoteRead({ tools: { register: tool => { registered = tool } } }, service, cwd)
  if (!registered) throw new Error('remote_read 未注册')
  return { tool: registered, fs, streamText, cwd }
}

describe('remote_read 公共注册面', () => {
  it('窗口保留 canonical path、精确总行数与上游 continuation 文本', async () => {
    const h = harness()
    expect(h.tool.name).toBe('remote_read')
    const args = { file_path: 'file.txt', offset: 2, limit: 1 }
    const value = await h.tool.execute(args, exec)
    expect(value).toEqual({ path: '/srv/canonical.txt', offset: 2, lines: [{ number: 2, text: 'two' }], totalLines: 3 })
    expect(h.tool.output.render(args, value as Parameters<typeof h.tool.output.render>[1])).toEqual([{ type: 'text', text: '<path>/srv/canonical.txt</path>\n<type>file</type>\n<content>\n2: two\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)\n</content>' }])
  })
  it('空文件、CRLF与末尾LF遵上游行计数', async () => {
    const empty = harness(''), crlf = harness('a\r\n\r\nb\n')
    expect(await empty.tool.execute({ file_path: 'x' }, exec)).toMatchObject({ lines: [], totalLines: 0 })
    expect(await crlf.tool.execute({ file_path: 'x' }, exec)).toMatchObject({ lines: [{ number: 1, text: 'a' }, { number: 2, text: '' }, { number: 3, text: 'b' }], totalLines: 3 })
    expect(crlf.cwd).toHaveBeenCalledWith(exec)
    expect(crlf.fs.resolve).toHaveBeenCalledWith('x', { cwd: '/anchor/work', signal: exec.signal })
  })
  it.each([{ file_path: ' ' }, { file_path: 'x', offset: 0 }, { file_path: 'x', offset: NaN }, { file_path: 'x', limit: 1.5 }, { file_path: 'x', limit: 2001 }])('非法参数拒绝，不能静默clamp：%j', async args => {
    const h = harness()
    await expect(h.tool.execute(args, exec)).rejects.toThrow()
    expect(h.fs.resolve).not.toHaveBeenCalled()
  })
  it('超过EOF和目录各用对应FS错误', async () => {
    const h = harness('a\n')
    await expect(h.tool.execute({ file_path: 'x', offset: 2 }, exec)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    const dir = harness('', { type: 'directory', version: 'v' as FsVersion })
    await expect(dir.tool.execute({ file_path: 'x' }, exec)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
  it('长行截断与50KiB输出上限仍保留精确总行数及续读footer', async () => {
    const h = harness(('x'.repeat(3000) + '\n').repeat(40))
    const args = { file_path: 'x' }, value = await h.tool.execute(args, exec)
    const result = value as { lines: Array<{ number: number; text: string }>; totalLines: number }
    expect(result.totalLines).toBe(40)
    expect(result.lines).toHaveLength(25)
    expect(result.lines[0]?.text).toBe('x'.repeat(2000) + '... (line truncated to 2000 chars)')
    expect(h.tool.output.render(args, value as Parameters<typeof h.tool.output.render>[1])).toEqual([{ type: 'text', text: expect.stringContaining('(Output capped. Showing lines 1-25. Use offset=26 to continue.)') }])
  })
  it('大型/未知size走streamText，窗口后仍消费全流，末尾失败不能返回前缀', async () => {
    for (const size of [undefined, 10 * 1024 * 1024]) {
      const h = harness('a\nb\n', { type: 'file', version: 'v' as FsVersion, ...(size === undefined ? {} : { size }) })
      await h.tool.execute({ file_path: 'x', limit: 1 }, exec)
      expect(h.streamText).toHaveBeenCalledOnce()
      expect(h.fs.readText).not.toHaveBeenCalled()
      h.fs.streamText.mockImplementation(async function* () { yield 'prefix\n'; throw new FsError('channel lost', 'FS_IO_ERROR') })
      await expect(h.tool.execute({ file_path: 'x', limit: 1 }, exec)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    }
  })
})

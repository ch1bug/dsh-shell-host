/** #139：公共mutation面交给真实shell；不按命令字符串伪造成功。 */
import { spawn } from 'node:child_process'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { detectPlainBash } from '../src/detect.ts'
import { createRemoteFileSystem } from '../src/remote-fs/index.ts'
import type { RemoteWorkspaceService, RemoteWorkspaceStatus } from '../src/remote/service.ts'
import type { RemoteResult } from '../src/remote/channel.ts'
import { createHash } from 'node:crypto'
import { realFileChannel } from './helpers/real-file-channel.ts'
import { encodeRequest, FRAME_MAX_LINE_BYTES } from '../src/remote/frame.ts'

const bash = process.platform === 'win32' ? detectPlainBash() : 'bash'
if (!bash) console.warn('!! SKIP (loud) remote-write-machine：缺少bash，原子写脚本未验证')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
function run(command: string): Promise<RemoteResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bash!, ['-c', command], { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = [], err: Buffer[] = []
    const timer = setTimeout(() => { child.kill(); reject(new Error('mutation脚本超过10秒')) }, 10_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }) })
  })
}
let root = ''
function remote(): RemoteWorkspaceService {
  const row: RemoteWorkspaceStatus = { workspaceId: 'test-write', host: 'write-host', root, anchor: '/local-write', state: 'ready', channel: { host: 'write-host', state: 'ready', users: 1, reconnects: 0, pending: 0, transport: { shape: 'per-session-connection', controlMasterUsable: false } } }
  return { list: () => [row], workspace: () => row, require: () => row, workspaceForAnchor: () => row, exec: (_id, command) => run(command), open: async () => row, dispose: async () => {} }
}
describe.skipIf(!bash)('真实远程写与编辑公共契约（#139）', () => {
  beforeAll(async () => {
    const setup = await run('mktemp -d /tmp/dsh-write-139-XXXXXXXX')
    expect(setup.exitCode).toBe(0)
    root = setup.stdout.toString().trim()
    expect(root).toMatch(/^\/tmp\/dsh-write-139-[\w]+$/)
  })
  afterAll(async () => {
    if (/^\/tmp\/dsh-write-139-[\w]+$/.test(root)) expect((await run(`rm -rf -- ${quote(root)}`)).exitCode).toBe(0)
  })
  it('创建父目录、空串与shell元字符/末尾换行无损；覆盖改变inode但保持权限位', async () => {
    const fs = createRemoteFileSystem(remote()), target = await fs.resolve(root + "/new/a 'line\n.txt")
    const content = "中文\r\n$(touch nope) ' \\ $&\n\n"
    const created = await fs.writeText(target, content, { kind: 'createIfAbsent' })
    expect(created).toMatchObject({ operation: 'create', before: null, after: content.replaceAll('\r\n', '\n') })
    expect((await fs.stat(target))?.version).toBe(created.version)
    expect(await fs.readText(target)).toBe(content)
    const path = fs.processPath(target)
    expect((await run(`chmod 751 -- ${quote(path)}`)).exitCode).toBe(0)
    const old = (await run(`stat -c '%i:%a' -- ${quote(path)}`)).stdout.toString().trim()
    const updated = await fs.writeText(target, '', { kind: 'replaceIfVersion', version: (await fs.stat(target))!.version })
    expect(updated).toMatchObject({ operation: 'update', before: content.replaceAll('\r\n', '\n'), after: '' })
    const after = (await run(`stat -c '%i:%a' -- ${quote(path)}`)).stdout.toString().trim()
    if (old.split(':')[1] !== '751') console.warn('!! SKIP (loud) remote-write permissions：当前挂载不保留chmod 751，真实POSIX权限位断言未验证')
    expect(after.split(':')[1]).toBe(old.split(':')[1])
    expect(after.split(':')[0]).not.toBe(old.split(':')[0])
    expect(await fs.readText(target)).toBe('')
  }, 30_000)
  it('边界：create发布时并发目录必须失败，不向目录内写content', async () => {
    const service = remote(), fs = createRemoteFileSystem(service), target = await fs.resolve(root + '/directory-race')
    service.exec = (_id, command) => run(`ln() { mkdir -p -- ${quote(fs.processPath(target))}; command ln "$@"; }; ` + command)
    await expect(fs.writeText(target, 'candidate', { kind: 'createIfAbsent' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    service.exec = (_id, command) => run(command)
    expect(await fs.listDir(target)).toEqual([])
    expect((await fs.listDir(await fs.resolve(root))).some(entry => entry.name.startsWith('.dsh-write-'))).toBe(false)
  }, 30_000)
  it('边界：替换边界合成CRLF不能写出双CR', async () => {
    const fs = createRemoteFileSystem(remote()), target = await fs.resolve(root + '/crlf-boundary')
    const created = await fs.writeText(target, 'a\r\n')
    const outcome = await fs.editText(target, { oldString: 'a', newString: '\r', replaceAll: false }, { version: created.version })
    expect(outcome.after).toBe('\r\n')
    expect(await fs.readText(target)).toBe('\r\n')
  }, 30_000)
  it('默认唯一匹配、replaceAll字面量及CRLF恢复；陈旧guard优先于匹配错误', async () => {
    const fs = createRemoteFileSystem(remote()), target = await fs.resolve(root + '/edit.txt')
    const initial = await fs.writeText(target, 'a $& a\r\n尾\r\n')
    await expect(fs.editText(target, { oldString: 'a', newString: '$1', replaceAll: false }, { version: initial.version })).rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    const edited = await fs.editText(target, { oldString: 'a', newString: '$1', replaceAll: true }, { version: initial.version })
    expect(edited).toMatchObject({ before: 'a $& a\n尾\n', after: '$1 $& $1\n尾\n' })
    expect(await fs.readText(target)).toBe('$1 $& $1\r\n尾\r\n')
    await expect(fs.editText(target, { oldString: '不存在', newString: 'x', replaceAll: false }, { version: initial.version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(fs.editText(target, { oldString: '不存在', newString: 'x', replaceAll: false }, { version: edited.version })).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(fs.writeText(target, 'blind', { kind: 'createIfAbsent' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    const results = await Promise.allSettled(['one', 'two'].map(content => fs.writeText(target, content, { kind: 'replaceIfVersion', version: edited.version })))
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'FS_STALE_VERSION' } })
    expect((await fs.listDir(await fs.resolve(root))).some(entry => entry.name.startsWith('.dsh-write-'))).toBe(false)
  }, 30_000)
  it('解码/发布失败或发布前取消均不改原文件并清理staging；错误码可分支', async () => {
    const service = remote(), fs = createRemoteFileSystem(service), target = await fs.resolve(root + '/failure.txt')
    await fs.writeText(target, 'original')
    for (const [failure, code] of [
      ['base64() { return 1; }; ', 'FS_IO_ERROR'],
      ['mv() { printf "Permission denied" >&2; return 1; }; ', 'FS_PERMISSION_DENIED'],
    ]) {
      service.exec = (_id, command) => run(failure + command)
      await expect(fs.writeText(target, 'must-not-publish')).rejects.toMatchObject({ code })
      service.exec = (_id, command) => run(command)
      expect(await fs.readText(target)).toBe('original')
      expect((await fs.listDir(await fs.resolve(root))).some(entry => entry.name.startsWith('.dsh-write-'))).toBe(false)
    }
    const controller = new AbortController()
    controller.abort()
    await expect(fs.writeText(target, 'cancelled', undefined, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(fs.editText(await fs.resolve(root + '/absent-edit'), { oldString: 'x', newString: 'y', replaceAll: false })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(fs.writeText(target, 'local-policy', undefined, undefined, { mode: 'workspace-write', workspaceRoot: root })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  }, 30_000)
  it('上传期间外部改动/并发创建触发最终guard，活动取消也清理临时文件', async () => {
    const service = remote(), fs = createRemoteFileSystem(service)
    for (const present of [false, true]) {
      const target = await fs.resolve(root + '/race-' + String(present))
      const expected = present ? { kind: 'replaceIfVersion' as const, version: (await fs.writeText(target, 'before')).version } : { kind: 'createIfAbsent' as const }
      service.exec = (_id, command) => run(`base64() { command base64 "$@"; printf external > ${quote(fs.processPath(target))}; }; ` + command)
      await expect(fs.writeText(target, 'candidate', expected)).rejects.toMatchObject({ code: present ? 'FS_STALE_VERSION' : 'FS_NOT_OBSERVED' })
      service.exec = (_id, command) => run(command)
      expect(await fs.readText(target)).toBe('external')
    }
    const target = await fs.resolve(root + '/active-abort'), controller = new AbortController()
    service.exec = async (_id, command) => {
      const result = await run('base64() { command base64 "$@"; printf abort-upload >&2; }; ' + command)
      if (result.stderr.toString().includes('abort-upload')) controller.abort()
      return result
    }
    await expect(fs.writeText(target, 'candidate', { kind: 'createIfAbsent' }, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    service.exec = (_id, command) => run(command)
    expect(await fs.stat(target)).toBeUndefined()
    expect((await fs.listDir(await fs.resolve(root))).some(entry => entry.name.startsWith('.dsh-write-'))).toBe(false)
  }, 30_000)
  it('超过单请求帧的大文本分块上传，经真实协议发布后摘要与末尾字节相同', async () => {
    const channel = await realFileChannel(bash!)
    try {
      const service = remote()
      let maxRequest = 0
      service.exec = (_id, command) => { maxRequest = Math.max(maxRequest, Buffer.byteLength(encodeRequest(1, command))); return channel.exec(command) }
      const fs = createRemoteFileSystem(service), target = await fs.resolve(root + '/large-write')
      const content = 'a'.repeat(5 * 1024 * 1024) + '中文\0\n\n'
      expect(Buffer.byteLength(encodeRequest(1, Buffer.from(content).toString('base64')))).toBeGreaterThan(FRAME_MAX_LINE_BYTES)
      await fs.writeText(target, content, { kind: 'createIfAbsent' })
      const digest = await run(`sha256sum -- ${quote(fs.processPath(target))}`)
      expect(digest.exitCode).toBe(0)
      expect(digest.stdout.toString().split(' ')[0]).toBe(createHash('sha256').update(content).digest('hex'))
      expect(Buffer.from(await fs.readByteRange(target, { offset: Buffer.byteLength(content) - 3, length: 3 }))).toEqual(Buffer.from([0, 10, 10]))
      expect(maxRequest).toBeLessThan(FRAME_MAX_LINE_BYTES)
      expect(channel.maxFrameBytes()).toBeLessThan(FRAME_MAX_LINE_BYTES)
    } finally { await channel.close() }
  }, 300_000)
})

export {}

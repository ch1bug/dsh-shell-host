/** #137：RemoteFileSystem 公共面交给真 bash 执行脚本，不按命令文本特判结果。 */
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectPlainBash } from '../src/detect.ts'
import { createRemoteFileSystem } from '../src/remote-fs/index.ts'
import type { RemoteWorkspaceService, RemoteWorkspaceStatus } from '../src/remote/service.ts'
import type { RemoteResult } from '../src/remote/channel.ts'
import { FRAME_MAX_LINE_BYTES } from '../src/remote/frame.ts'
import { realFileChannel } from './helpers/real-file-channel.ts'

const bash = process.platform === 'win32' ? detectPlainBash() : 'bash'
if (!bash) console.warn('!! SKIP (loud) remote-fs-machine：缺少 bash，真实文件脚本未验证')
function run(command: string): Promise<RemoteResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bash!, ['-c', command], { env: { ...process.env, LC_ALL: 'C', ...(process.platform === 'win32' ? { MSYS: 'winsymlinks:sys' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = [], err: Buffer[] = []
    const timer = setTimeout(() => { child.kill(); reject(new Error('bash 文件脚本超过 10s')) }, 10_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }) })
  })
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
let root = ''
let row: RemoteWorkspaceStatus
function remote(): RemoteWorkspaceService {
  return {
    list: () => [row], workspace: () => row, require: () => row,
    workspaceForAnchor: path => path === row.anchor || path.startsWith(row.anchor + '/') ? row : undefined,
    exec: (_id, command) => run(command), open: async () => row, dispose: async () => {},
    openSession: async () => { throw new Error('file fixture has no PTY') },
    closeWorkspace: async () => ({ closed: false, sessionIds: [] }),
  }
}
describe.skipIf(!bash)('真实 bash 文件系统契约（#137）', () => {
  beforeAll(async () => {
    const setup = await run("mktemp -d /tmp/dsh-fs-137-XXXXXXXX")
    expect(setup.exitCode).toBe(0)
    root = setup.stdout.toString().trim()
    expect(root).toMatch(/^\/tmp\/dsh-fs-137-[\w]+$/)
    const fixture = await run(`mkdir -p ${quote(root + '/real/sub')}; printf abc > ${quote(root + '/real/file')}; ln -s real ${quote(root + '/alias')} && test -L ${quote(root + '/alias')} || exit 19; printf x > ${quote(root + '/plain')}`)
    expect(fixture.exitCode).toBe(0)
    row = { workspaceId: 'test-workspace', host: 'opaque-alias', root, anchor: '/local-anchor', sessions: [], connectionId: 'fixture-files', state: 'ready', channel: { host: 'opaque-alias', state: 'ready', users: 1, reconnects: 0, pending: 0, transport: { shape: 'per-session-connection', controlMasterUsable: false } } }
  })
  afterAll(async () => {
    // 精确检查由本用例 mktemp 创建的路径，再清它自己的夹具。
    if (/^\/tmp\/dsh-fs-137-[\w]+$/.test(root)) expect((await run(`rm -rf -- ${quote(root)}`)).exitCode).toBe(0)
  })
  it('字节读面保留非UTF8/NUL和末尾换行，范围及上限沿公共接口生效', async () => {
    const path = root + '/real/binary'
    expect((await run(`printf '\\000\\377\\376a\\n\\n' > ${quote(path)}`)).exitCode).toBe(0)
    const fs = createRemoteFileSystem(remote()), target = await fs.resolve(path)
    expect(Buffer.from(await fs.readBytes(target, undefined, 6))).toEqual(Buffer.from([0, 255, 254, 97, 10, 10]))
    expect(Buffer.from(await fs.readByteRange(target, { offset: 1, length: 3 }))).toEqual(Buffer.from([255, 254, 97]))
    await expect(fs.readBytes(target, undefined, 5)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })
  it('UTF8跨块拼接、BOM与非文本拒绝、lstat不跟随末级符号链接', async () => {
    const path = root + '/real/utf8', text = 'a'.repeat(256 * 1024 - 4) + '中文\r\n尾行\n'
    expect((await run(`{ printf '\\357\\273\\277'; head -c 262140 /dev/zero | tr '\\0' a; printf '中文\\r\\n尾行\\n'; } > ${quote(path)}`)).exitCode).toBe(0)
    const fs = createRemoteFileSystem(remote()), target = await fs.resolve(path)
    expect(await fs.readText(target)).toBe(text)
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe(text)
    expect((await run(`printf '\\377' > ${quote(root + '/real/nontext')}`)).exitCode).toBe(0)
    const binary = await fs.resolve(root + '/real/nontext')
    await expect(fs.readText(binary)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    expect(await fs.lstat(root + '/alias')).toMatchObject({ type: 'symlink' })
    expect(await fs.lstat(root + '/missing')).toBeUndefined()
  })
  it('超单帧文件经真实握手/base64循环分块返回，逐字节完整且每帧有界', async () => {
    const path = root + '/real/large', length = 7 * 1024 * 1024
    expect((await run(`{ head -c ${String(length)} /dev/zero | tr '\\0' a; printf '\\000\\377\\n'; } > ${quote(path)}`)).exitCode).toBe(0)
    const channel = await realFileChannel(bash!)
    try {
      const service = remote()
      service.exec = (_id, command) => channel.exec(command)
      const fs = createRemoteFileSystem(service), target = await fs.resolve(path)
      const bytes = Buffer.from(await fs.readBytes(target, undefined, length + 3))
      expect(bytes.length).toBe(length + 3)
      expect(bytes.subarray(0, length)).toEqual(Buffer.alloc(length, 97))
      expect(bytes.subarray(length)).toEqual(Buffer.from([0, 255, 10]))
      expect(4 * Math.ceil(bytes.length / 3)).toBeGreaterThan(FRAME_MAX_LINE_BYTES)
      expect(channel.maxFrameBytes()).toBeLessThan(FRAME_MAX_LINE_BYTES)
      expect(Buffer.from(await fs.readByteRange(target, { offset: length - 1, length: 10 }))).toEqual(Buffer.from([97, 0, 255, 10]))
      expect((await fs.readByteRange(target, { offset: length + 5, length: 3 })).length).toBe(0)
    } finally { await channel.close() }
  }, 180_000)
  it('cwd 是真实解析基准：远端 cwd 与锚点子目录都不回退 root', async () => {
    const fs = createRemoteFileSystem(remote())
    expect((await fs.resolve('file', { cwd: root + '/real' })).displayPath).toBe(root + '/real/file')
    expect((await fs.resolve('../file', { cwd: '/local-anchor/real/sub' })).displayPath).toBe(root + '/real/file')
  })
  it('stat 缺目标/目录、listDir 类型与 canonical child identity', async () => {
    const fs = createRemoteFileSystem(remote())
    const absent = await fs.resolve(root + '/missing')
    await expect(fs.stat(absent)).resolves.toBeUndefined()
    await expect(fs.listDir(absent)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    const file = await fs.resolve(root + '/real/file')
    expect(await fs.stat(file)).toMatchObject({ type: 'file', size: 3 })
    await expect(fs.listDir(file)).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    const directory = await fs.resolve(root)
    expect((await fs.stat(directory))?.type).toBe('directory')
    const entries = await fs.listDir(directory)
    expect(entries.map(e => e.name)).toEqual(['alias', 'plain', 'real'])
    const alias = entries.find(e => e.name === 'alias')!
    expect(alias.type).toBe('directory')
    expect(alias.target.targetKey).toBe((await fs.resolve(root + '/real')).targetKey)
    expect(alias.size).toBeUndefined()
  })
  it('纳秒 version：同一秒内相同长度文件的两次 mtime 不得相等', async () => {
    const fs = createRemoteFileSystem(remote()), target = await fs.resolve(root + '/real/file')
    expect((await run(`touch -m -d '2020-01-01 00:00:00.100000000 UTC' -- ${quote(root + '/real/file')}`)).exitCode).toBe(0)
    const before = await fs.stat(target)
    expect((await run(`touch -m -d '2020-01-01 00:00:00.200000000 UTC' -- ${quote(root + '/real/file')}`)).exitCode).toBe(0)
    const after = await fs.stat(target)
    expect(before?.version).not.toBe(after?.version)
    expect(before?.version).toContain('.100000000')
    expect(after?.version).toContain('.200000000')
  })
  it('真实 127：缺少 utility 是 FS_IO_ERROR，不是 target 不存在', async () => {
    const service = remote(), fs = createRemoteFileSystem(service)
    const target = await fs.resolve(root)
    service.exec = (_id, command) => run('PATH=/dsh-missing-utils; ' + command)
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(fs.listDir(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(fs.resolve(root)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
  it('真实权限错误不折叠成缺目标（无 chmod 隔离的环境响亮跳过）', async context => {
    const locked = root + '/locked'
    expect((await run(`mkdir ${quote(locked)}; touch ${quote(locked + '/child')}`)).exitCode).toBe(0)
    const fs = createRemoteFileSystem(remote())
    const directoryTarget = await fs.resolve(locked), childTarget = await fs.resolve(locked + '/child')
    expect((await run(`chmod 000 ${quote(locked)}`)).exitCode).toBe(0)
    try {
      const probe = await run(`stat -L -- ${quote(locked + '/child')}`)
      if (probe.exitCode === 0) {
        console.warn('!! SKIP (loud) remote-fs permissions：当前身份可穿透 chmod 000，真 EACCES 未验证；注入错误分类由 unit 覆盖')
        context.skip()
      }
      await expect(fs.resolve(locked + '/child')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
      await expect(fs.stat(childTarget)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
      await expect(fs.listDir(directoryTarget)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    } finally {
      expect((await run(`chmod 700 ${quote(locked)}`)).exitCode).toBe(0)
    }
  })
  it('含换行/引号/#/? 的真实文件名保持完整 NUL 记录与 URL identity', async () => {
    const name = "a 'line\n#?%.txt", absolute = root + '/real/' + name
    expect((await run(`printf data > ${quote(absolute)}`)).exitCode).toBe(0)
    const fs = createRemoteFileSystem(remote())
    const target = await fs.resolve(absolute)
    const listed = await fs.listDir(await fs.resolve(root + '/real'))
    expect(listed.find(e => e.name === name)?.target.targetKey).toBe(target.targetKey)
    const url = new URL(fs.fileUrl(target))
    expect(url.hash).toBe('')
    expect(url.search).toBe('')
    expect(url.protocol).toBe('file:')
    expect(decodeURIComponent(url.pathname)).toBe(absolute)
  })
  it('符号链接别名 canonical identity 与缺失后缀 nearest-parent', async () => {
    const fs = createRemoteFileSystem(remote())
    const alias = await fs.resolve(root + '/alias/file')
    const actual = await fs.resolve(root + '/real/file')
    expect(alias.targetKey).toBe(actual.targetKey)
    expect(fs.processPath(alias)).toBe(root + '/real/file')
    expect((await fs.resolve(root + '/alias/missing/deep')).targetKey).toBe((await fs.resolve(root + '/real/missing/deep')).targetKey)
    await expect(fs.resolve(root + '/plain/child')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
  it('先解析symlink再处理..，不能用词法normalize改变物理目标', async () => {
    expect((await run(`ln -s real/sub ${quote(root + '/deep')}; test -L ${quote(root + '/deep')}`)).exitCode).toBe(0)
    const fs = createRemoteFileSystem(remote())
    const actual = await fs.resolve(root + '/real/file')
    expect((await fs.resolve(root + '/deep/../file')).targetKey).toBe(actual.targetKey)
    expect((await fs.resolve('../file', { cwd: root + '/deep' })).targetKey).toBe(actual.targetKey)
  })
})

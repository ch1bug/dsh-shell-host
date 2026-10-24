/** #137：公共 RemoteFileSystem/工具面。故障由 exec seam 注入固定字节，
 * 不识别实现的 shell 文本；脚本是否真能运行由真实 bash 档证明。 */
import { describe, expect, it, vi } from 'vitest'
import { apply, createRemoteFileSystem } from '../src/remote-fs/index.ts'
import type { FsTargetKey, FsVersion, FsSandboxPolicy, RemoteFileSystem } from '../src/remote-fs/contract.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { RemoteWorkspaceService, RemoteWorkspaceStatus } from '../src/remote/service.ts'
import type { RemoteResult } from '../src/remote/channel.ts'

function row(id = 'one', root = '/srv/app', anchor = '/local/one'): RemoteWorkspaceStatus {
  return { workspaceId: id, host: id, root, anchor, sessions: [], connectionId: 'fixture-files', state: 'ready', channel: { host: id, state: 'ready', transport: { shape: 'per-session-connection', controlMasterUsable: false }, users: 1, reconnects: 0, pending: 0 } }
}
function result(exitCode = 0, stdout = '', stderr = ''): RemoteResult {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }
}
function harness(rows = [row()]) {
  const exec = vi.fn<RemoteWorkspaceService['exec']>().mockResolvedValue(result(0, '/srv/app\0'))
  const remote: RemoteWorkspaceService = {
    list: () => rows, workspace: id => rows.find(r => r.workspaceId === id),
    require: id => { const r = rows.find(r => r.workspaceId === id); if (!r) throw new Error('unknown workspace'); return r },
    workspaceForAnchor: cwd => rows.filter(r => cwd === r.anchor || cwd.startsWith(r.anchor + '/')).sort((a,b) => b.anchor.length-a.anchor.length)[0],
    exec, open: async () => rows[0]!, dispose: async () => {},
    openSession: async () => { throw new Error('file fixture has no PTY') },
    closeWorkspace: async () => ({ closed: false, sessionIds: [] }),
  }
  return { remote, exec, fs: createRemoteFileSystem(remote) }
}
const metadata = '1:2:3:2026-10-21 12:00:00.123456789 +0000:2026-10-21 12:00:00.987654321 +0000\0' + '81a4\0' + '3\0'

describe('同形类型（编译期也判）', () => {
  it('采用宿主的 nominal symbol，不允许裸 string/其他品牌冒充', () => {
    type Rebrand<B extends string> = string & { readonly [K in Exclude<keyof MessageId, keyof string>]: B }
    const upstream = 'x' as Rebrand<'FsTargetKey'>
    const target: FsTargetKey = upstream
    const back: Rebrand<'FsTargetKey'> = target
    // @ts-expect-error 裸字符串不是 nominal target key
    const invalid: FsTargetKey = 'x'
    // @ts-expect-error 两个品牌不能互换
    const wrong: FsVersion = target
    const policy: FsSandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/root' }
    const upstreamPolicy: SandboxExecutionPolicy = policy
    // @ts-expect-error 非法 sandbox mode 不能扩宽成 string
    const wrongPolicy: FsSandboxPolicy = { mode: 'anything', workspaceRoot: '/' }
    void [back, invalid, wrong, upstreamPolicy, wrongPolicy]
    expect(target).toBe('x')
  })
})

describe('exec 错误与不完整数据', () => {
  it('传输层错误被映射为FsError/FS_IO_ERROR，并保留cause', async () => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    const transport = Object.assign(new Error('connection lost'), { code: 'REMOTE_CHANNEL_DEAD' })
    h.exec.mockRejectedValue(transport)
    for (const operation of [() => h.fs.resolve('/srv/app'), () => h.fs.stat(target), () => h.fs.listDir(target)]) {
      await expect(operation()).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: transport })
    }
  })

  it('stat 缺目标返回 undefined，listDir 缺目标抛 FS_NOT_FOUND', async () => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    h.exec.mockResolvedValue(result(1, '', "stat: cannot statx '/srv/app': No such file or directory"))
    await expect(h.fs.stat(target)).resolves.toBeUndefined()
    await expect(h.fs.listDir(target)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
  it('权限拒绝不伪装成不存在；缺少 utility (127) 不伪装成缺文件', async () => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    h.exec.mockResolvedValue(result(1, '', 'stat: Permission denied'))
    await expect(h.fs.stat(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(h.fs.listDir(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    h.exec.mockResolvedValue(result(127, '', 'sh: stat: not found'))
    await expect(h.fs.stat(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(h.fs.listDir(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
  it('文件 stat 使用数字 mode 与原样高精度 version', async () => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    h.exec.mockResolvedValue(result(0, metadata))
    expect(await h.fs.stat(target)).toMatchObject({ type: 'file', size: 3, version: metadata.split('\0')[0] })
  })
  it.each(['f\0' + '3\0' + 'x', 'f\0' + '3\0' + 'x\0', 'f\0' + 'oops\0' + 'x\0' + '/srv/app/x\0'])('截断/非法 NUL listing 必须响亮失败：%s', async wire => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    h.exec.mockResolvedValue(result(0, wire))
    await expect(h.fs.listDir(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
  it('完整 listing 排序，目录不带 size，symlink canonical key 来自远端', async () => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    h.exec.mockResolvedValue(result(0, ['d','4096','z-dir','/srv/app/z-dir','f','3','a-alias','/srv/actual'].join('\0') + '\0'))
    const entries = await h.fs.listDir(target)
    expect(entries.map(e => e.name)).toEqual(['a-alias', 'z-dir'])
    expect(entries[1]?.size).toBeUndefined()
    expect(h.fs.processPath(entries[0]!.target)).toBe('/srv/actual')
  })
})

describe('#138读面错误与编码边界', () => {
  it.each([['FS_NOT_FOUND', result(1, '', 'No such file or directory')], ['FS_PERMISSION_DENIED', result(1, '', 'Permission denied')], ['FS_NOT_REGULAR_FILE', result(0, 'v1\0' + '41ed\0' + '4096\0')]])('读面保留%s而非空内容', async (code, reply) => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    h.exec.mockResolvedValue(reply)
    for (const operation of [() => h.fs.readText(target), () => h.fs.streamText(target), () => h.fs.readBytes(target, undefined, 10), () => h.fs.readByteRange(target, { offset: 0, length: 0 })]) {
      await expect(operation()).rejects.toMatchObject({ code })
    }
  })
  it('文本对不合法UTF8及末尾残缺序列严格拒绝，BOM按TextDecoder处理', async () => {
    for (const bytes of [Buffer.from([255]), Buffer.from([0xe4, 0xb8]), Buffer.from([0])]) {
      const h = harness(), target = await h.fs.resolve('/srv/app')
      const info = result(0, `v1\0` + `81a4\0${String(bytes.length)}\0`)
      h.exec.mockResolvedValue(info).mockResolvedValueOnce(info).mockResolvedValueOnce(info).mockResolvedValueOnce({ exitCode: 0, stdout: bytes, stderr: Buffer.alloc(0) })
      await expect(h.fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    }
  })
  it('stat.size为0不等于EOF，必须实际读取，也不得绕过空文件权限检查', async () => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    const zero = result(0, 'v1\0' + '81a4\0' + '0\0')
    h.exec.mockResolvedValue(zero).mockResolvedValueOnce(zero).mockResolvedValueOnce(zero).mockResolvedValueOnce(result(0, 'virtual-data\n'))
    expect(await h.fs.readText(target)).toBe('virtual-data\n')
    h.exec.mockResolvedValue(zero).mockResolvedValueOnce(zero).mockResolvedValueOnce(zero).mockResolvedValueOnce(result(0, '123456'))
    await expect(h.fs.readBytes(target, undefined, 5)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    h.exec.mockResolvedValue(zero).mockResolvedValueOnce(zero).mockResolvedValueOnce(zero).mockResolvedValueOnce(result(1, '', 'Permission denied'))
    await expect(h.fs.readBytes(target, undefined, 10)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })
  it('预先取消所有读面均拒绝且不进入远端', async () => {
    const h = harness(), target = await h.fs.resolve('/srv/app'), controller = new AbortController()
    h.exec.mockClear(); controller.abort()
    const signal = controller.signal
    for (const operation of [() => h.fs.readText(target, signal), () => h.fs.streamText(target, signal), () => h.fs.readBytes(target, signal, 10), () => h.fs.readByteRange(target, { offset: 0, length: 0 }, signal), () => h.fs.lstat('/srv/app', undefined, signal)]) {
      await expect(operation()).rejects.toMatchObject({ code: 'FS_ABORTED' })
    }
    expect(h.exec).not.toHaveBeenCalled()
  })
})

describe('取消与 cwd 选择', () => {
  it('预先取消不发请求；在飞取消及时拒绝；迟到 reject 仍被观察', async () => {
    const h = harness(), controller = new AbortController()
    controller.abort()
    await expect(h.fs.resolve('/srv/app', { signal: controller.signal })).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(h.exec).not.toHaveBeenCalled()
    let rejectRemote!: (error: Error) => void
    h.exec.mockImplementation(() => new Promise((_resolve, reject) => { rejectRemote = reject }))
    const active = new AbortController()
    const pending = h.fs.resolve('/srv/app', { signal: active.signal })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await Promise.resolve()
    active.abort()
    await assertion
    rejectRemote(new Error('late failure'))
    await Promise.resolve()
  })
  it('两个 host 同 root 不按登记顺序猜；anchor 可以明确选择', async () => {
    const h = harness([row('one'), row('two', '/srv/app', '/local/two')])
    await expect(h.fs.resolve('x', { cwd: '/srv/app' })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await h.fs.resolve('x', { cwd: '/local/two' })
    expect(h.exec.mock.calls[0]?.[0]).toBe('two')
    await expect(h.fs.resolve('/srv/app')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
  it('同 host 两个工作区别名指向同 canonical file：target identity 也相同', async () => {
    const first = row('one'), second = { ...row('two', '/srv/other', '/local/two'), host: first.host }
    const h = harness([first, second])
    h.exec.mockResolvedValue(result(0, '/physical/same-file\0'))
    const left = await h.fs.resolve('/srv/alias', { cwd: first.anchor })
    const right = await h.fs.resolve('/srv/other/alias', { cwd: second.anchor })
    expect(left.targetKey).toBe(right.targetKey)
    expect(h.fs.contains(left, right)).toBe(true)
  })
  it('Windows path、空串、NUL 均在 spawn 前拒绝', async () => {
    const h = harness()
    await expect(h.fs.resolve('C:\\x')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(h.fs.resolve('')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(h.fs.resolve('/a\0b')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(h.exec).not.toHaveBeenCalled()
  })
  it('fileUrl 保留身份，但转义 # ? % 空格；不把 ssh host 当 URL authority', async () => {
    const h = harness()
    h.exec.mockResolvedValue(result(0, '/srv/a #?%.txt\0'))
    const target = await h.fs.resolve('/srv/a #?%.txt')
    const url = new URL(h.fs.fileUrl(target))
    expect(url.protocol).toBe('file:')
    expect(url.host).toBe('')
    expect(url.hash).toBe('')
    expect(url.search).toBe('')
    expect(decodeURIComponent(url.pathname)).toBe('/srv/a #?%.txt')
  })
  it('watch仍按上游基类响亮拒绝，mutation已有专门公共验收', async () => {
    const h = harness(), target = await h.fs.resolve('/srv/app')
    await expect(h.fs.watch(target, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
})

function toolHarness(workingDirectory?: { ensure: () => Promise<string> }) {
  const h = harness(), provided = new Map<string, unknown>(), tools: any[] = []
  apply({ provide: (key, value) => { provided.set(key, value) }, tools: { register: tool => tools.push(tool) }, get: key => key === 'remote' ? h.remote : key === 'workingDirectory' ? workingDirectory : provided.get(key) }, { listLimit: 1 })
  return { ...h, fs: provided.get('remoteFs') as RemoteFileSystem, tool: tools[0] }
}
describe('remote_ls 公共工具', () => {
  it('cwd 服务失败不被吞成 fallback', async () => {
    const error = new Error('cwd disappeared'), h = toolHarness({ ensure: async () => { throw error } })
    await expect(h.tool.execute({}, { agent: {} })).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: error })
    expect(h.exec).not.toHaveBeenCalled()
  })
  it('只调用 remoteFs resolve/listDir，明确拒绝相对路径，报告截断', async () => {
    const h = toolHarness()
    const target = { targetKey: 'one\0/srv/app' as FsTargetKey, displayPath: '/srv/app' }
    const resolve = vi.spyOn(h.fs, 'resolve').mockResolvedValue(target)
    const listDir = vi.spyOn(h.fs, 'listDir').mockResolvedValue([{ name: 'a', type: 'file', target }, { name: 'b', type: 'file', target }])
    await expect(h.tool.execute({ path: 'relative' }, { agent: {} })).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(resolve).not.toHaveBeenCalled()
    const output = await h.tool.execute({}, { agent: {} })
    expect(listDir).toHaveBeenCalledOnce()
    expect(output).toMatchObject({ path: '/srv/app', truncated: true, total: 2 })
    expect(output.entries).toHaveLength(1)
    expect(h.exec).not.toHaveBeenCalled()
  })
})

describe('#139已打开通道后的逐次写权限', () => {
  it('成功后降级read-only/workspace-write或移除policy服务，均在resolve/写入前拒绝', async () => {
    const h = harness(), provided = new Map<string, unknown>(), tools: any[] = []
    const session = {}, actor = { agent: { session }, signal: new AbortController().signal }
    let mode = 'danger-full-access', mounted = true
    const resolvePolicy = vi.fn(() => ({ mode, workspaceRoot: '/local/one' }))
    apply({ provide: (key, value) => { provided.set(key, value) }, tools: { register: tool => tools.push(tool) }, get: key => key === 'remote' ? h.remote : key === 'sandboxPolicy' ? (mounted ? { resolve: resolvePolicy } : undefined) : provided.get(key) }, {})
    const fs = provided.get('remoteFs') as RemoteFileSystem
    const target = { targetKey: 'one\0/srv/app' as FsTargetKey, displayPath: '/srv/app' }
    const resolve = vi.spyOn(fs, 'resolve').mockResolvedValue(target)
    const write = vi.spyOn(fs, 'writeText').mockResolvedValue({ operation: 'create', version: 'v2' as FsVersion, before: null, after: 'new' })
    const edit = vi.spyOn(fs, 'editText').mockResolvedValue({ version: 'v3' as FsVersion, before: 'new', after: 'edited' })
    const writeTool = tools.find(tool => tool.name === 'remote_write'), editTool = tools.find(tool => tool.name === 'remote_edit')
    await writeTool.execute({ file_path: '/srv/app', content: 'new' }, actor)
    for (mode of ['read-only', 'workspace-write']) {
      for (const [tool, args] of [[writeTool, { file_path: '/srv/app', content: 'new' }], [editTool, { file_path: '/srv/app', old_string: 'new', new_string: 'edited' }]]) {
        await expect(tool.execute(args, actor)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED', message: expect.stringContaining('[sandbox:') })
      }
    }
    expect(resolvePolicy).toHaveBeenLastCalledWith({ session })
    mounted = false
    await expect(writeTool.execute({ file_path: '/srv/app', content: 'new' }, actor)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(edit).not.toHaveBeenCalled()
    expect(h.exec).not.toHaveBeenCalled()
  })
})

export {}

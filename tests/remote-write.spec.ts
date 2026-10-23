/** #139：远程mutation工具公共注册面，不触发本地fs观察事件。 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FsError, type FsTarget, type FsTargetKey, type FsVersion, type RemoteFileSystem } from '../src/remote-fs/contract.ts'
import { registerRemoteMutations } from '../src/remote-fs/mutation-tools.ts'
import { RemoteObservations } from '../src/remote-fs/observation.ts'
import { registerRemoteRead } from '../src/remote-fs/read-tool.ts'

const v1 = 'v1' as FsVersion, v2 = 'v2' as FsVersion
function actor() { return { signal: new AbortController().signal, agent: { session: {} } } as unknown as ToolRunContext }
function harness() {
  const target: FsTarget = { targetKey: 'remote-key' as FsTargetKey, displayPath: '/srv/file.txt' }
  const fs = {
    resolve: vi.fn(async () => target), processPath: vi.fn(() => '/srv/canonical.txt'),
    stat: vi.fn(async () => ({ type: 'file', size: 4, version: v1 } as { type: 'file'; size: number; version: FsVersion } | undefined)),
    readText: vi.fn(async () => 'old\n'),
    streamText: vi.fn(async () => (async function* () { yield 'old\n' })()),
    writeText: vi.fn(async () => ({ operation: 'create' as 'create' | 'update', before: null as string | null, after: 'new\n', version: v2 })),
    editText: vi.fn(async () => ({ before: 'old\n', after: 'new\n', version: v2 })),
  }
  const tools = new Map<string, ToolDefinition>()
  const ctx = { tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) } }
  const observations = new RemoteObservations(), cwd = vi.fn(async () => '/anchor')
  registerRemoteMutations(ctx, fs as unknown as RemoteFileSystem, cwd, observations, () => {})
  const get = (name: string) => { const tool = tools.get(name); if (!tool) throw new Error(`${name}未注册`); return tool }
  return { fs, target, observations, cwd, get, ctx }
}

describe('remote_write/remote_edit公共工具面', () => {
  it('未观察write只尝试create；成功隐藏version并为同session后续edit提供新version', async () => {
    const h = harness(), exec = actor(), write = h.get('remote_write'), edit = h.get('remote_edit')
    const result = await write.execute({ file_path: 'file.txt', content: 'new\n' }, exec)
    expect(result).toEqual({ path: '/srv/canonical.txt', operation: 'create', before: null, after: 'new\n' })
    expect(h.fs.writeText).toHaveBeenCalledWith(h.target, 'new\n', { kind: 'createIfAbsent' }, exec.signal)
    expect(h.fs.stat).not.toHaveBeenCalled()
    await edit.execute({ file_path: 'file.txt', old_string: 'new', new_string: 'newer' }, exec)
    expect(h.fs.editText).toHaveBeenCalledWith(h.target, { oldString: 'new', newString: 'newer', replaceAll: false }, { version: v2 }, exec.signal)
    expect(h.fs.resolve).toHaveBeenCalledWith('file.txt', { cwd: '/anchor', signal: exec.signal })
    expect(write.parameters).not.toHaveProperty('sandbox_permissions')
    expect(edit.parameters).not.toHaveProperty('sandbox_permissions')
  })

  it('read成功窗口后才记录stat版本；缺失记录absent；EOF或流失败不污染观察', async () => {
    const h = harness(), exec = actor()
    registerRemoteRead(h.ctx, h.fs as unknown as RemoteFileSystem, h.cwd, h.observations)
    const read = h.get('remote_read'), write = h.get('remote_write'), edit = h.get('remote_edit')
    await expect(read.execute({ file_path: 'x', offset: 9 }, exec)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(edit.execute({ file_path: 'x', old_string: 'old', new_string: 'new' }, exec)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED', message: expect.stringContaining('read the file, then retry') })
    await read.execute({ file_path: 'x' }, exec)
    h.fs.writeText.mockRejectedValueOnce(new FsError('changed', 'FS_STALE_VERSION'))
    await expect(write.execute({ file_path: 'x', content: 'new' }, exec)).rejects.toMatchObject({ code: 'FS_STALE_VERSION', message: 'changed — re-read the file, then retry' })
    expect(h.fs.writeText).toHaveBeenLastCalledWith(h.target, 'new', { kind: 'replaceIfVersion', version: v1 }, exec.signal)
    h.fs.stat.mockResolvedValue({ type: 'file', size: 20 * 1024 * 1024, version: v2 })
    h.fs.streamText.mockImplementation(async () => (async function* () { yield 'prefix\n'; throw new FsError('lost', 'FS_IO_ERROR') })())
    await expect(read.execute({ file_path: 'x' }, exec)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await edit.execute({ file_path: 'x', old_string: 'old', new_string: '' , replace_all: true }, exec)
    expect(h.fs.editText).toHaveBeenLastCalledWith(h.target, { oldString: 'old', newString: '', replaceAll: true }, { version: v1 }, exec.signal)
    h.fs.stat.mockResolvedValue(undefined)
    await expect(read.execute({ file_path: 'x' }, exec)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(edit.execute({ file_path: 'x', old_string: 'old', new_string: 'new' }, exec)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await write.execute({ file_path: 'x', content: '' }, exec)
    expect(h.fs.writeText).toHaveBeenLastCalledWith(h.target, '', { kind: 'createIfAbsent' }, exec.signal)
  })

  it('pending展示参数片段，完成展示真实context hunks；JSON replay与坏meta回退同上游', async () => {
    const h = harness(), exec = actor(), write = h.get('remote_write'), edit = h.get('remote_edit')
    const args = { file_path: 'alias.txt', content: 'new\n' }
    expect(write.presentCall?.(args)).toEqual({ card: 'diff', title: 'Write alias.txt', diffs: [{ path: 'alias.txt', oldText: null, newText: 'new\n' }], locations: [{ path: 'alias.txt' }] })
    const before = Array.from({ length: 20 }, (_, n) => `line${n + 1}`).join('\n') + '\n'
    const after = before.replace('line2\n', 'changed2\n').replace('line18\n', 'changed18\n')
    h.fs.writeText.mockResolvedValue({ operation: 'update', before, after, version: v2 })
    const value = await write.execute(args, exec)
    const meta = write.output.presentationMeta?.(args, value as never)
    const replay = JSON.parse(JSON.stringify({ content: [], meta }))
    expect(write.presentResult?.(args, replay)).toEqual({ card: 'diff', title: 'Write alias.txt', diffs: [
      { path: '/srv/canonical.txt', oldText: 'line1\nline2\nline3\nline4\nline5', newText: 'line1\nchanged2\nline3\nline4\nline5' },
      { path: '/srv/canonical.txt', oldText: 'line15\nline16\nline17\nline18\nline19\nline20', newText: 'line15\nline16\nline17\nchanged18\nline19\nline20' },
    ] })
    expect(write.output.render(args, value as never)).toEqual([{ type: 'text', text: '<path>/srv/canonical.txt</path>\n<type>file</type>\n<content>\nUpdated file\n</content>' }])
    expect(write.presentResult?.(args, { content: [], isError: false, meta: { path: '/canonical', diffs: [] } })).toMatchObject({ diffs: [{ path: '/canonical', oldText: null, newText: 'new\n' }] })
    const ea = { file_path: 'alias.txt', old_string: 'old', new_string: 'new' }
    expect(edit.presentCall?.(ea)).toMatchObject({ diffs: [{ path: 'alias.txt', oldText: 'old', newText: 'new' }] })
    const edited = await edit.execute(ea, exec), em = edit.output.presentationMeta?.(ea, edited as never)
    expect(edit.presentResult?.(ea, JSON.parse(JSON.stringify({ content: [], meta: em })))).toMatchObject({ diffs: [{ path: '/srv/canonical.txt', oldText: 'old', newText: 'new' }] })
    for (const meta of [undefined, {}, { diffs: [] }, { diffs: [{ path: 'x', oldText: 1, newText: 'x' }] }]) expect(edit.presentResult?.(ea, JSON.parse(JSON.stringify({ content: [], isError: false, meta })))).toBeUndefined()
    expect(write.presentResult?.(args, { content: [], isError: true, meta })).toBeUndefined()
  })



  it('session、opaque key与远程状态源互相隔离；无session永远不能借用观察', async () => {
    const h = harness(), exec = actor(), other = actor(), edit = h.get('remote_edit'), write = h.get('remote_write')
    h.observations.record(h.target, { kind: 'present', version: v1 }, exec)
    await expect(edit.execute({ file_path: 'x', old_string: 'a', new_string: 'b' }, other)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    const direct = { signal: exec.signal } as ToolRunContext
    await write.execute({ file_path: 'x', content: 'b' }, direct)
    await expect(edit.execute({ file_path: 'x', old_string: 'a', new_string: 'b' }, direct)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    h.fs.resolve.mockResolvedValue({ ...h.target, targetKey: 'different-remote' as FsTargetKey })
    await expect(edit.execute({ file_path: 'x', old_string: 'a', new_string: 'b' }, exec)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    h.fs.resolve.mockResolvedValue({ ...h.target, displayPath: '/alias' })
    await edit.execute({ file_path: 'alias', old_string: 'a', new_string: 'b' }, exec)
    expect(h.fs.editText).toHaveBeenLastCalledWith({ ...h.target, displayPath: '/alias' }, { oldString: 'a', newString: 'b', replaceAll: false }, { version: v1 }, exec.signal)
    h.observations.clear()
    await expect(edit.execute({ file_path: 'x', old_string: 'a', new_string: 'b' }, exec)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(h.fs.stat).not.toHaveBeenCalled()
  })

  it('参数验证不resolve；backend失败保留原观察与非guard错误身份', async () => {
    const h = harness(), exec = actor(), write = h.get('remote_write'), edit = h.get('remote_edit')
    await expect(write.execute({ file_path: ' ', content: '' }, exec)).rejects.toThrow('file_path')
    for (const args of [{ file_path: ' ', old_string: 'a', new_string: 'b' }, { file_path: 'x', old_string: '', new_string: 'b' }, { file_path: 'x', old_string: 'a', new_string: 'a' }]) await expect(edit.execute(args, exec)).rejects.toThrow()
    expect(h.fs.resolve).not.toHaveBeenCalled()
    h.observations.record(h.target, { kind: 'present', version: v1 }, exec)
    const error = new FsError('ambiguous', 'FS_AMBIGUOUS_EDIT')
    h.fs.editText.mockRejectedValueOnce(error)
    await expect(edit.execute({ file_path: 'x', old_string: 'a', new_string: 'b' }, exec)).rejects.toBe(error)
    await write.execute({ file_path: 'x', content: '' }, exec)
    expect(h.fs.writeText).toHaveBeenLastCalledWith(h.target, '', { kind: 'replaceIfVersion', version: v1 }, exec.signal)
  })

  it('create/相同overwrite的空hunk用canonical fallback；纯插入无旧文本、无末尾换行标记不泄漏', async () => {
    const h = harness(), exec = actor(), write = h.get('remote_write'), args = { file_path: 'x', content: 'new' }
    const created = await write.execute(args, exec)
    const createdMeta = write.output.presentationMeta?.(args, created as never)
    expect(createdMeta).toEqual({ operation: 'create', path: '/srv/canonical.txt', diffs: [] })
    expect(write.presentResult?.(args, JSON.parse(JSON.stringify({ content: [], isError: false, meta: createdMeta })))).toMatchObject({ diffs: [{ path: '/srv/canonical.txt', oldText: null, newText: 'new' }] })
    h.fs.writeText.mockResolvedValue({ operation: 'update', before: '', after: 'new', version: v2 })
    const inserted = await write.execute(args, exec)
    expect(write.output.presentationMeta?.(args, inserted as never)).toMatchObject({ diffs: [{ path: '/srv/canonical.txt', oldText: null, newText: 'new' }] })
    h.fs.writeText.mockResolvedValue({ operation: 'update', before: 'new', after: 'new', version: v2 })
    const unchanged = await write.execute(args, exec)
    expect(write.output.presentationMeta?.(args, unchanged as never)).toMatchObject({ operation: 'update', diffs: [] })
  })

  it('edit输出不回显内容或version；replace_all确认文本沿用上游', async () => {
    const h = harness(), exec = actor(), edit = h.get('remote_edit')
    h.observations.record(h.target, { kind: 'present', version: v1 }, exec)
    const args = { file_path: 'x', old_string: 'old', new_string: '', replace_all: true }
    const value = await edit.execute(args, exec)
    expect(value).toEqual({ path: '/srv/canonical.txt', before: 'old\n', after: 'new\n' })
    expect(edit.output.render(args, value as never)).toEqual([{ type: 'text', text: 'The file /srv/canonical.txt has been updated. All occurrences were successfully replaced.' }])
    expect(edit.output.render({ ...args, replace_all: false }, value as never)).toEqual([{ type: 'text', text: 'The file /srv/canonical.txt has been updated successfully.' }])
  })
})

/** #138真实文件通道挂具：shipping帧循环，先握手，逐请求有界等待，close才收口。 */
import { spawn } from 'node:child_process'
import { FrameDecoder, REMOTE_FRAME_LOOP, encodeRequest } from '../../src/remote/frame.ts'
import type { RemoteResult } from '../../src/remote/channel.ts'

export async function realFileChannel(bash: string) {
  const child = spawn(bash, ['-c', REMOTE_FRAME_LOOP], { stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = new FrameDecoder()
  const pending = new Map<number, { resolve: (result: RemoteResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  let id = 0, stderr = '', closed = false, maxFrameBytes = 0
  const fail = (error: Error) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
    pending.clear()
  }
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.stdout.on('data', (chunk: Buffer) => {
    for (const frame of decoder.feed(chunk)) {
      if (frame.kind === 'malformed') { fail(new Error(frame.reason)); continue }
      const waiter = pending.get(frame.id)
      if (!waiter) continue
      pending.delete(frame.id); clearTimeout(waiter.timer)
      if (frame.kind === 'error') waiter.reject(new Error(frame.message))
      else {
        maxFrameBytes = Math.max(maxFrameBytes, 4 * Math.ceil(frame.stdout.length / 3) + 4 * Math.ceil(frame.stderr.length / 3) + 50)
        waiter.resolve(frame)
      }
    }
  })
  const closure = new Promise<void>(resolve => child.on('close', () => {
    closed = true
    fail(new Error(`真实帧进程关闭：${stderr}`))
    resolve()
  }))
  const exec = (command: string): Promise<RemoteResult> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('真实帧通道已关闭')); return }
    const current = id++
    const timer = setTimeout(() => { pending.delete(current); reject(new Error('真实帧请求超过10秒')); child.kill() }, 10_000)
    pending.set(current, { resolve, reject, timer })
    child.stdin.write(encodeRequest(current, command))
  })
  const close = async () => { child.stdin.end(); await closure }
  try {
    const hello = await exec('DSH-HELLO 1 real-file-client')
    if (hello.exitCode !== 0 || hello.stdout.toString() !== '1 real-file-client') throw new Error('真实文件通道握手失败')
  } catch (error) { child.kill(); await closure; throw error }
  return { exec, close, maxFrameBytes: () => maxFrameBytes }
}

/** #140：通过同一owner-scoped PTY facade打开独立远端shell。 */
import { randomBytes } from 'node:crypto'
import type { SandboxMode } from '../permission-gate.ts'
import type { OpenResult, SessionSummary, TailPage } from '../pty/session-core.ts'
import { posixQuote } from '../posix-quote.ts'
import { composeSshCommand, normalizeSshOptions } from '../ssh/compose.ts'
import type { SshTransport } from '../ssh/transport.ts'
import { controlPathFor, remoteError, validateRemoteShell, workspaceTransport } from './channel.ts'
import type { RemoteWorkspaceDeclaration } from './service.ts'

/** 公开PTY服务的消费面：无原始进程访问，不在探测阶段写输入。 */
export interface RemoteSessionCore {
  open(owner: unknown, spec: { command: string; cwd?: string; shell?: boolean; authorizedMode?: SandboxMode }, signal?: AbortSignal): Promise<OpenResult>
  tail(owner: unknown, id: string, lines?: number): TailPage
  list(owner: unknown): SessionSummary[]
  close(owner: unknown, id: string): Promise<unknown>
}

export interface RemoteSessionInput {
  declaration: RemoteWorkspaceDeclaration
  kind: string
  cwd?: string
  env?: Record<string, string>
  spawnCwd?: string
  authorizedMode?: SandboxMode
  signal?: AbortSignal
  platform?: NodeJS.Platform
  timeoutMs: number
  /** 共享master时必须与文件通道实测SSH_CONNECTION相同；不向工具公开此原值。 */
  expectedConnection?: string
}

export type RemoteSessionOpened = OpenResult & {
  transport: SshTransport
  remoteShell: { uname: string; shell: string }
}

// 启动诊断预算：既是累计输出的字符上限，也作为 core.tail 的行数预算参数——
// 行数语义下这是放宽的上界（防巨量 banner 撑爆轮询），真正的字符上限由 output.length 独立兜底。
const MAX_STARTUP_BUDGET = 64 * 1024

/** ONE本地argv operand；远端解析留给sh，SSH参数复用composition。 */
function localOperand(value: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return posixQuote(value)
  return '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"'
}

/** kind仅标注用途。每次在自己的连接内，初始化cwd/env后再发布nonce。 */
export async function openRemoteSession(core: RemoteSessionCore, owner: unknown, input: RemoteSessionInput): Promise<RemoteSessionOpened> {
  const { declaration } = input
  if (!['shell', 'build', 'test'].includes(input.kind)) throw remoteError('REMOTE_INVALID_SESSION_KIND', 'remote session kind must be shell, build or test')
  const cwd = input.cwd ?? declaration.root
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.startsWith('//') || cwd.includes('\0')) throw remoteError('REMOTE_INVALID_PATH', 'remote session cwd must be an absolute POSIX path')
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw remoteError('REMOTE_INVALID_DECLARATION', 'remote session timeoutMs must be positive and finite')
  if (input.env !== undefined && (input.env === null || typeof input.env !== 'object' || Array.isArray(input.env))) throw remoteError('REMOTE_INVALID_ENV', 'remote environment must be a record of strings')
  const env = Object.entries(input.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0')) throw remoteError('REMOTE_INVALID_ENV', `invalid remote environment entry ${JSON.stringify(key)}`)
    return posixQuote(`${key}=${value}`)
  })
  const platform = input.platform ?? process.platform
  const transport = workspaceTransport(platform, declaration.options)
  const supplied = normalizeSshOptions(declaration.options)
  const path = supplied.find((option) => option.key.toLowerCase() === 'controlpath')?.value ?? controlPathFor(declaration.host)
  // 保留原jump/proxy配置，保证%C与master相同。共享事实靠连接内实测，不靠参数猜测。
  const other = supplied.filter((option) => !['controlmaster', 'controlpath', 'controlpersist'].includes(option.key.toLowerCase()))
  const marker = `DSH_REMOTE_READY_${randomBytes(16).toString('hex')}`
  const shared = input.expectedConnection !== undefined
  if (shared && input.expectedConnection!.trim() === '') throw remoteError('REMOTE_SESSION_CONNECTION_UNPROBED', 'master connection identity is unavailable')
  // 事实在用户env注入前采样，再用位置参数传给初始化后的sh，避免env覆盖实测值。
  const ready = `printf '\\n%s|%s|%s${shared ? '|%s' : ''}\\n' ${posixQuote(marker)} "$1" "$2"${shared ? ' "$3"' : ''}; exec sh -i`
  const script = [
    'dsh_uname=$(uname -s) || exit 125',
    'dsh_shell=${SHELL:-}',
    'dsh_connection=${SSH_CONNECTION:-}',
    // base64/mktemp 不是会话自己的需求，是 frame.ts 文件帧协议的远端依赖（ADR-0016
    // decision 3 的 coreutils 面）。同一宿主同时承载文件通道，缺一件就 fail closed：
    // 与其让会话起来后文件面逐请求失败，不如在探测期响亮拒绝。
    'for dsh_tool in sh uname env base64 mktemp; do command -v "$dsh_tool" >/dev/null 2>&1 || exit 127; done',
    `cd ${posixQuote(cwd)} || exit 125`,
    `exec env ${env.join(' ')} sh -c ${posixQuote(ready)} sh "$dsh_uname" "$dsh_shell" "$dsh_connection"`,
  ].join('; ')
  const command = composeSshCommand({
    host: declaration.host,
    ...(declaration.port === undefined ? {} : { port: declaration.port }),
    ...(declaration.jump === undefined ? {} : { jump: declaration.jump }),
    options: [...other, 'ControlMaster=no', { key: 'ControlPath', value: transport.shape === 'control-master' ? path : 'none' }, 'ControlPersist=no'],
    shell: localOperand(`sh -c ${posixQuote(script)}`, platform),
  })
  if (input.signal?.aborted) throw remoteError('REMOTE_SESSION_ABORTED', 'remote session launch aborted')
  const controller = new AbortController()
  const relay = () => controller.abort()
  input.signal?.addEventListener('abort', relay, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, input.timeoutMs)
  let opened: OpenResult | undefined
  const checkWait = () => {
    if (timedOut) throw remoteError('REMOTE_SESSION_TIMEOUT', 'remote session launch timed out before a usable interactive shell was observed')
    if (controller.signal.aborted) throw remoteError('REMOTE_SESSION_ABORTED', 'remote session launch aborted')
  }
  try {
    opened = await core.open(owner, {
      command, shell: true,
      ...(input.spawnCwd === undefined ? {} : { cwd: input.spawnCwd }),
      ...(input.authorizedMode === undefined ? {} : { authorizedMode: input.authorizedMode }),
    }, controller.signal)
    let output = opened.initialOutput
    for (;;) {
      checkWait()
      if (output.length > MAX_STARTUP_BUDGET) throw remoteError('REMOTE_SESSION_OUTPUT_LIMIT', 'remote session startup output exceeded its bounded diagnostic budget')
      const row = core.list(owner).find((session) => session.id === opened!.sessionId)
      if (opened.status.kind === 'exited' || row === undefined || row.status.kind === 'exited') throw remoteError('REMOTE_SESSION_EXITED', 'remote session exited during startup; a POSIX shell plus coreutils is required')
      const lines = output.split('\n')
      const at = lines.findIndex((line) => line.startsWith(`${marker}|`))
      if (at >= 0) {
        const fields = lines[at]!.replace(/\r$/u, '').split('|')
        const uname = fields[1] ?? ''
        const shell = fields[2] ?? ''
        if (fields.length !== (shared ? 4 : 3)) throw remoteError('REMOTE_SHELL_UNPROBED', 'remote session probe has an invalid shape')
        validateRemoteShell(declaration.host, uname, shell)
        if (shared && fields[3] !== input.expectedConnection) throw remoteError('REMOTE_SESSION_CONNECTION_MISMATCH', 'remote session did not join the measured master connection; refusing to publish a falsely shared session')
        lines.splice(at, 1)
        return { ...opened, status: row.status, initialOutput: lines.join('\n'), transport, remoteShell: { uname, shell } }
      }
      const page = core.tail(owner, opened.sessionId, MAX_STARTUP_BUDGET)
      // truncated也可能指已经消费过的历史行，不等于本次delta丢失；缺nonce仍fail closed。
      if (page.text !== '') output += page.text
      else await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(wait); controller.signal.removeEventListener('abort', finish); resolve() }
        const wait = setTimeout(finish, 10)
        controller.signal.addEventListener('abort', finish, { once: true })
      })
    }
  } catch (error) {
    if (opened !== undefined) {
      try { await core.close(owner, opened.sessionId) }
      catch (cleanupError) {
        throw Object.assign(new AggregateError([error, cleanupError], 'remote session launch failed and PTY cleanup failed', { cause: error }), { sessionId: opened.sessionId, code: 'REMOTE_SESSION_CLEANUP_FAILED' })
      }
    }
    throw error
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', relay)
  }
}

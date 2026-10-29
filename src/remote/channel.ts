/**
 * The remote workspace's CHANNEL — one long-lived `ssh <host> -- sh` process
 * per host, ref-counted by workspace, with keepalive and BOUNDED reconnect
 * (#137, ADR-0016 decision 8 + ADR-0017 decision 5).
 *
 * What this module owns, and why each part is here:
 *
 *  - **one channel per host, ref-counted by CONNECTION** (ADR-0017 decision 5
 *    revises ADR-0016's "one channel per host" wording): {@link RemoteChannel.acquire}
 *    / {@link RemoteChannel.release} count the workspaces bound to the host,
 *    and the last release closes the process. The counting unit is a connection
 *    because on a POSIX client later sessions may ride ONE master
 *    ({@link workspaceTransport}), while on Windows every session pays its own
 *    handshake — the two shapes ref-count differently and the channel must know
 *    which one it is in.
 *  - **keepalive**: an idle framed channel looks exactly like a silently dead
 *    one until a request is written into a black hole. A periodic `true`
 *    request turns a dead peer into an observed failure (and the failure then
 *    goes through the reconnect path) instead of a stall on the next real call.
 *  - **bounded reconnect**: a dropped connection is retried at most
 *    `reconnectMax` times with linear backoff; after that the channel reports
 *    `unavailable` with a stable code. There is deliberately NO unbounded
 *    retry loop: an unreachable host must surface as a reading, not as a
 *    request that never settles.
 *  - **the POSIX remote probe** (ADR-0017 decision 6): on open the channel asks
 *    the remote for `uname -s` and `$SHELL`; a Windows-ish answer is refused
 *    LOUDLY, naming both readings and the ADR decision. Windows remotes are out
 *    of scope for v1, and a probe that cannot answer is still not a pass.
 *  - **the four transport failures** live at this layer, not in the codec: the
 *    codec decodes a malformed line into a report, and the channel turns a
 *    protocol violation into a FAILED channel (a desynchronised stream cannot
 *    be trusted for the next request). Channel death reaps the pending map so
 *    no caller waits for a frame that will never come.
 *
 * Why a plain pipe process and not a PTY session: the framed protocol needs the
 * exact bytes on both sides, and a PTY adds line-discipline echo plus CR/LF
 * translation to them (`pty_tail`'s byte-incremental contract depends on the
 * same fact). So the channel spawns `ssh -T` with piped stdio — it is a
 * TRANSPORT, not a session, and it is deliberately invisible to
 * `pty_list` / `pty_signal` (those operate sessions a model converses with; this
 * one speaks a frame codec). The session surface of a workspace is #140's.
 *
 * @module dsh-shell-host/remote/channel
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { posix as posixPath } from 'node:path'
import { tmpdir } from 'node:os'
import { composeSshArgv, normalizeSshOptions, type SshOptionInput } from '../ssh/compose.ts'
import { controlMasterUsable, type SshTransport } from '../ssh/transport.ts'
import { FRAME_RESPONSE, FrameDecoder, REMOTE_FRAME_LOOP, REMOTE_PROTOCOL_VERSION, handshakeCommand, encodeRequest } from './frame.ts'
import { posixQuote } from '../posix-quote.ts'
import { codedError } from '../coded-error.ts'

/** The stable error codes this layer reports. Consumers branch on these, never on prose. */
export const REMOTE_CHANNEL_ERRORS = {
  /** The channel process exited (or was never started) with no usable channel left. */
  DEAD: 'REMOTE_CHANNEL_DEAD',
  /** Bounded reconnect ran out — the host is unavailable, not "still connecting". */
  LOST: 'REMOTE_CHANNEL_LOST',
  /** An explicit close reclaimed the channel while requests were in flight. */
  CLOSED: 'REMOTE_CHANNEL_CLOSED',
  /** The remote refused/lacked `sh` (exit 127 / "not found" on the far side). */
  NO_SHELL: 'REMOTE_NO_SHELL',
  /** The remote login shell is not POSIX-family (ADR-0017 decision 6). */
  NON_POSIX_SHELL: 'REMOTE_NON_POSIX_SHELL',
  /** The probe could not establish POSIX-ness — not a pass (see the probe text). */
  SHELL_UNPROBED: 'REMOTE_SHELL_UNPROBED',
  /** One request did not settle inside its budget. */
  TIMEOUT: 'REMOTE_REQUEST_TIMEOUT',
  /** The stream stopped speaking the frame codec — the channel is failed, not retried line by line. */
  PROTOCOL: 'REMOTE_PROTOCOL_ERROR',
  VERSION: 'REMOTE_PROTOCOL_VERSION',
} as const

/** A coded error (`code` is the stable fact; the message is for humans). */
export function remoteError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return codedError(message, code, extra)
}

/** 文件通道和交互会话各自采样，只共享POSIX事实的判定规则。 */
export function validateRemoteShell(host: string, uname: string, shell: string): void {
  if (uname === '' || shell === '') throw remoteError(REMOTE_CHANNEL_ERRORS.SHELL_UNPROBED,
    `remote ${host} refused: POSIX probe did not establish both uname and SHELL (uname=${JSON.stringify(uname)}, SHELL=${JSON.stringify(shell)}; ADR-0017 decision 6).`)
  const allowed = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ksh93', 'ash', 'fish', 'mksh', 'yash'])
  if (/mingw|msys|cygwin|windows_nt/iu.test(uname) || !allowed.has(posixPath.basename(shell))) {
    throw remoteError(REMOTE_CHANNEL_ERRORS.NON_POSIX_SHELL,
      `remote ${host} refused: its login shell is not POSIX-family (uname=${JSON.stringify(uname)}, SHELL=${JSON.stringify(shell)}). ` +
      'ADR-0017 decision 6 requires a POSIX-family login shell; Windows remotes are out of scope for v1.')
  }
}

/** One decoded response's payload: the remote command's own exit code and bytes. */
export interface RemoteResult {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

/** The child process surface the channel drives (a seam: the unit lane injects a fake). */
export interface ChannelProcess {
  readonly pid?: number
  write(chunk: string): boolean
  onStdout: (callback: (chunk: Buffer) => void) => void
  onStderr: (callback: (chunk: string) => void) => void
  /** Completion is emitted after stdio closes, not merely when the process exits. */
  onExit: (callback: (info: { code: number | null; signal: NodeJS.Signals | null }) => void) => void
  /** Optional for existing adapters; the default adapter reports spawn and stdio errors. */
  onError?: (callback: (error: Error) => void) => void
  kill: (signal?: NodeJS.Signals) => void
}

/** What the channel asks a spawner for: the exact argv, the working directory
 * the host permission gate allowed, plus the host for diagnostics. */
export interface ChannelSpawnSpec {
  readonly host: string
  readonly argv: readonly string[]
  readonly cwd?: string
}

/** The injectable spawner (default = `node:child_process` with piped stdio). */
export type ChannelSpawner = (spec: ChannelSpawnSpec) => ChannelProcess

/** The channel's live state, as `remote_status` reports it. */
export type ChannelState = 'connecting' | 'ready' | 'unavailable' | 'closed'

/** The structured status a workspace / `remote_status` reports. */
export interface ChannelStatus {
  readonly host: string
  readonly state: ChannelState
  /** ADR-0017's transport fact: the shape this channel ACTUALLY opened in. */
  readonly transport: SshTransport
  /** Workspaces currently bound to this channel (the ref-count). */
  readonly users: number
  /** How many reconnect attempts have succeeded since creation. */
  readonly reconnects: number
  /** Requests in flight right now. */
  readonly pending: number
  /** The remote login shell facts measured at open (`undefined` until probed). */
  readonly remoteShell?: { readonly uname: string; readonly shell: string }
  /** The last failure, coded. Cleared by a successful reconnect. */
  readonly lastError?: { readonly code: string; readonly message: string }
  /** The channel process id, when the backend exposes one. */
  readonly pid?: number
}

/** Per-call knobs (the entry's settings namespace resolves these once). */
export interface ChannelOptions {
  readonly host: string
  /** The ssh process's working directory: the host gate's boundary
   * (`workspace-write` hands back the session workspace root). Omitted =
   * inherit the host process cwd. */
  readonly cwd?: string
  /** One request's budget; the keepalive uses it too. */
  readonly requestTimeoutMs: number
  /** Idle probe period (0 = disabled, the unit lane's default so no timer outlives a case). */
  readonly keepaliveMs: number
  /** Retry budget after an unexpected exit (0 = never reconnect). */
  readonly reconnectMax: number
  /** First backoff step; step N waits `reconnectBaseMs * N`. */
  readonly reconnectBaseMs: number
  readonly platform?: NodeJS.Platform
  /** Ssh connection fields shared with the workspace declaration. */
  readonly ssh?: { readonly port?: number; readonly jump?: string; readonly options?: readonly SshOptionInput[] }
  /** Injected spawner (tests). */
  readonly spawner?: ChannelSpawner
  /** Injected clock (tests): the reconnect sleep. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * The transport shape a WORKSPACE channel opens in (ADR-0017 decisions 2/3).
 *
 * POSIX client ⇒ `control-master`: multiplexing is measured working there, and
 * the shape is what lets later sessions (#140) share one TCP connection + auth.
 * Windows client ⇒ `per-session-connection`: multiplexing is measured unusable
 * (`getsockname failed: Not a socket`), so no master is attempted — NOT "try the
 * master, then fall back" (that would log a failed attempt on every start).
 * The decision is a platform fact, taken once, never re-derived per request.
 */
export function workspaceTransport(platform: NodeJS.Platform = process.platform, options?: readonly SshOptionInput[]): SshTransport {
  const usable = controlMasterUsable(platform)
  const supplied = normalizeSshOptions(options)
  const configured = supplied.find((o) => o.key.toLowerCase() === 'controlmaster')?.value?.toLowerCase()
  const disabledPath = supplied.find((o) => o.key.toLowerCase() === 'controlpath')?.value?.toLowerCase() === 'none'
  if (configured !== undefined && configured !== 'yes' && configured !== 'no') {
    throw remoteError('REMOTE_INVALID_DECLARATION', 'remote ControlMaster must be yes or no; auto/ask cannot guarantee an observable transport shape')
  }
  if (!usable && configured === 'yes') {
    throw remoteError('REMOTE_INVALID_DECLARATION', 'ControlMaster=yes is unavailable on Windows (ADR-0017); no master will be attempted')
  }
  return {
    shape: usable && configured !== 'no' && !disabledPath ? 'control-master' : 'per-session-connection',
    controlMasterUsable: usable,
  }
}

/** POSIX控制socket按进程、host与OpenSSH %C端点隔离；过长路径由ssh响亮拒绝。 */
export function controlPathFor(host: string): string {
  const digest = createHash('sha256').update(host).digest('hex').slice(0, 12)
  return posixPath.join(tmpdir().replace(/\\/gu, '/'), `dsh-remote-${process.pid}-${digest}-%C.sock`)
}

/** The argv the channel spawns. The remote command is ONE argv atom: ssh joins
 * its operands and the remote LOGIN shell parses the result, so the loop must
 * arrive already POSIX-quoted (never split by this layer).
 *
 * POSIX默认明确启用master；ControlMaster=no或ControlPath=none选择独立连接。
 * Windows强制关闭master以覆盖ssh config中的共享设置，显式要求yes时响亮拒绝。
 * auto/ask不提供可确定形态，因此拒绝；ControlPersist固定为no，最后释放即回收。
 * 调用方的自定义socket路径仅在实际启用master时保留。 */
export function channelArgv(options: ChannelOptions): string[] {
  const transport = workspaceTransport(options.platform, options.ssh?.options)
  const supplied = normalizeSshOptions(options.ssh?.options)
  const path = supplied.find((o) => o.key.toLowerCase() === 'controlpath')?.value ?? controlPathFor(options.host)
  // 明确配置实际模式，不让用户 ~/.ssh/config 把 Windows 路径改成一次失败的master尝试。
  const control = transport.shape === 'control-master'
    ? ['ControlMaster=yes', { key: 'ControlPath', value: path }, 'ControlPersist=no']
    : ['ControlMaster=no', 'ControlPath=none', 'ControlPersist=no']
  const other = supplied.filter((o) => !['controlmaster', 'controlpath', 'controlpersist'].includes(o.key.toLowerCase()))
  return composeSshArgv({
    host: options.host,
    ...(options.ssh?.port === undefined ? {} : { port: options.ssh.port }),
    ...(options.ssh?.jump === undefined ? {} : { jump: options.ssh.jump }),
    options: [...other, ...control],
    tty: false,
    remoteCommand: `sh -c ${posixQuote(REMOTE_FRAME_LOOP)}`,
  })
}

interface PendingRequest {
  readonly resolve: (result: RemoteResult) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout | undefined
}

/** The default spawner: piped stdio, no shell, no window on Windows. */
export const defaultChannelSpawner: ChannelSpawner = (spec) => {
  const child = spawn(spec.argv[0] ?? 'ssh', spec.argv.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
  })
  const errors: Error[] = []
  let failed: ((error: Error) => void) | undefined
  const report = (error: Error) => {
    if (failed === undefined) {
      // Preserve only the first pre-subscription error; a failed process cannot
      // justify an unbounded diagnostics queue.
      if (errors.length === 0) errors.push(error)
    } else failed(error)
  }
  // Register immediately: ENOENT and EPIPE are asynchronous EventEmitter errors,
  // not exceptions caught by spawn()/write()'s caller.
  child.on('error', report)
  child.stdin.on('error', report)
  child.stdout.on('error', report)
  child.stderr.on('error', report)
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    write: (chunk) => child.stdin.write(chunk, (error) => { if (error != null) report(error) }),
    onStdout: (callback) => {
      child.stdout.on('data', (chunk: Buffer) => { callback(chunk) })
    },
    onStderr: (callback) => {
      child.stderr.on('data', (chunk: Buffer) => { callback(chunk.toString()) })
    },
    onError: (callback) => {
      failed = callback
      for (const error of errors.splice(0)) callback(error)
    },
    onExit: (callback) => {
      // `exit` may precede the final stdout bytes; `close` means they drained.
      child.once('close', (code, signal) => { callback({ code, signal }) })
    },
    kill: (signal) => {
      child.kill(signal)
    },
  }
}

/**
 * One host's channel. Created by the workspace service; never by a tool (ADR-0016
 * decision 8: "tools never open connections").
 */
export class RemoteChannel {
  private readonly options: ChannelOptions
  private readonly transport: SshTransport
  private readonly spawner: ChannelSpawner
  private readonly sleep: (ms: number) => Promise<void>
  private state: ChannelState = 'connecting'
  private users = 0
  private reconnects = 0
  private child: ChannelProcess | undefined
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private readonly clientId = randomUUID()
  private lastError: { code: string; message: string } | undefined
  private remoteShell: { uname: string; shell: string } | undefined
  /** Initial open, explicit reopen and bounded recovery all occupy ONE slot. */
  private connectionTask: Promise<void> | undefined
  private recoveryRequested = false
  private recovering = false
  private generation = 0
  private keepaliveTimer: NodeJS.Timeout | undefined
  private closing = false

  constructor(options: ChannelOptions) {
    this.options = options
    this.transport = workspaceTransport(options.platform, options.ssh?.options)
    this.spawner = options.spawner ?? defaultChannelSpawner
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() }))
  }

  status(): ChannelStatus {
    return {
      host: this.options.host,
      state: this.state,
      transport: this.transport,
      users: this.users,
      reconnects: this.reconnects,
      pending: this.pending.size,
      ...(this.remoteShell === undefined ? {} : { remoteShell: this.remoteShell }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.child?.pid === undefined ? {} : { pid: this.child.pid }),
    }
  }

  async acquire(): Promise<void> {
    this.users += 1
    await this.ensureReady()
  }

  release(): void {
    this.users = Math.max(0, this.users - 1)
    if (this.users === 0) this.close()
  }

  /** Explicit lifecycle entry. A caller joins any existing recovery instead of
   * racing it with a second ssh. A terminal failure may be retried explicitly. */
  ensureReady(): Promise<void> {
    if (this.closing) return Promise.reject(this.unavailableError())
    if (this.connectionTask !== undefined) return this.connectionTask
    if (this.state === 'ready' && this.child !== undefined) return Promise.resolve()
    return this.beginConnection(false)
  }

  /** Data-plane calls NEVER initiate connections or reset the reconnect budget.
   * They may join a lifecycle operation already started by the workspace. */
  async request(command: string): Promise<RemoteResult> {
    if (this.closing) throw this.unavailableError()
    const task = this.connectionTask
    if (task !== undefined) {
      try { await task } catch { throw this.unavailableError() }
    }
    if (this.state !== 'ready' || this.child === undefined) throw this.unavailableError()
    return this.send(command)
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    this.generation += 1
    this.recoveryRequested = false
    this.state = 'closed'
    this.stopKeepalive()
    const child = this.child
    this.child = undefined
    this.failPending(REMOTE_CHANNEL_ERRORS.CLOSED, `remote channel for ${this.options.host} was closed`)
    this.kill(child)
  }

  private unavailableError(): Error {
    if (this.closing) return remoteError(REMOTE_CHANNEL_ERRORS.CLOSED, `remote channel for ${this.options.host} is closed`)
    return remoteError(this.lastError?.code ?? REMOTE_CHANNEL_ERRORS.DEAD,
      this.lastError?.message ?? `remote channel for ${this.options.host} is not ready; open the workspace first`)
  }

  /** Assign the shared slot BEFORE any spawner callback can fire. */
  private beginConnection(recovery: boolean): Promise<void> {
    this.state = 'connecting'
    this.recovering = recovery
    this.recoveryRequested = false
    const task = Promise.resolve().then(async () => {
      if (this.closing) throw this.unavailableError()
      if (recovery) await this.reconnect()
      else await this.open()
    }).finally(() => {
      if (this.connectionTask === task) this.connectionTask = undefined
      this.recovering = false
      if (this.recoveryRequested && !this.closing) this.startRecovery()
    })
    this.connectionTask = task
    return task
  }

  private startRecovery(): void {
    if (this.closing || this.connectionTask !== undefined) return
    // Detached lifecycle work has an explicit rejection sink; status carries
    // its terminal error and requests observe the same code.
    void this.beginConnection(true).catch(() => {})
  }

  private async send(command: string, controlId?: number): Promise<RemoteResult> {
    const child = this.child
    const generation = this.generation
    if (child === undefined || this.closing) throw this.unavailableError()
    const id = controlId ?? this.nextId++
    return new Promise<RemoteResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(remoteError(REMOTE_CHANNEL_ERRORS.TIMEOUT,
          `remote request ${String(id)} on ${this.options.host} did not settle within ${String(this.options.requestTimeoutMs)}ms`))
      }, this.options.requestTimeoutMs > 0 ? this.options.requestTimeoutMs : 30_000)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.write(encodeRequest(id, command))
      } catch (error) {
        if (this.current(child, generation)) this.fail(REMOTE_CHANNEL_ERRORS.DEAD,
          `write to the remote channel for ${this.options.host} failed: ${String(error)}`)
      }
    })
  }

  private current(child: ChannelProcess, generation: number): boolean {
    return !this.closing && this.child === child && this.generation === generation
  }

  private async open(): Promise<void> {
    if (this.closing) throw this.unavailableError()
    const generation = ++this.generation
    this.remoteShell = undefined
    let child: ChannelProcess
    try {
      child = this.spawner({ host: this.options.host, argv: channelArgv(this.options),
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }) })
    } catch (error) {
      this.fail(REMOTE_CHANNEL_ERRORS.DEAD, `spawning ssh for ${this.options.host} failed: ${String(error)}`)
      throw this.unavailableError()
    }
    this.child = child
    // Decoder and diagnostic tail are per-generation: an old process cannot
    // append a partial frame to the next one's parser or alter its error class.
    const decoder = new FrameDecoder()
    let stderrTail = ''
    child.onStdout((chunk) => {
      if (!this.current(child, generation)) return
      for (const frame of decoder.feed(chunk)) {
        if (!this.current(child, generation)) return
        if (frame.kind === 'malformed') {
          this.fail(REMOTE_CHANNEL_ERRORS.PROTOCOL,
            `remote ${this.options.host} sent a line outside the frame codec (${frame.reason}): ${JSON.stringify(frame.line.slice(0, 120))}`)
          return
        }
        const pending = this.pending.get(frame.id)
        if (pending === undefined) continue
        this.pending.delete(frame.id)
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        if (frame.kind === 'error') pending.reject(remoteError(frame.id === 0 ? REMOTE_CHANNEL_ERRORS.VERSION : REMOTE_CHANNEL_ERRORS.PROTOCOL,
          `remote ${this.options.host} refused request ${String(frame.id)}: ${frame.message}`))
        else pending.resolve({ exitCode: frame.exitCode, stdout: frame.stdout, stderr: frame.stderr })
      }
    })
    child.onStderr((chunk) => {
      if (!this.current(child, generation)) return
      stderrTail = `${stderrTail}${chunk}`.slice(-4096)
      if (this.transport.shape === 'control-master' && /disabling multiplexing|mux_client_request_session.*failed/iu.test(stderrTail)) {
        this.fail('REMOTE_TRANSPORT_UNAVAILABLE', `ssh could not honor ControlMaster for ${this.options.host}; refusing a silent fallback: ${firstLine(stderrTail)}`)
      }
    })
    child.onExit((info) => {
      if (!this.current(child, generation)) return
      const noShell = info.code === 127 && missingRemoteSh(stderrTail)
      this.fail(noShell ? REMOTE_CHANNEL_ERRORS.NO_SHELL : REMOTE_CHANNEL_ERRORS.DEAD,
        `remote channel for ${this.options.host} died: ${noShell ? 'the remote reported no sh; a POSIX shell plus coreutils is required (ADR-0016/17)' : 'the channel process closed'} ` +
        `(code ${String(info.code)}, signal ${String(info.signal)}; stderr: ${JSON.stringify(firstLine(stderrTail))})`)
    })
    child.onError?.((error) => {
      if (this.current(child, generation)) this.fail(REMOTE_CHANNEL_ERRORS.DEAD,
        `remote channel for ${this.options.host} failed to spawn or use stdio: ${error.message}`)
    })
    try {
      if (!this.current(child, generation)) throw this.unavailableError()
      const hello = await this.send(handshakeCommand(this.clientId), 0)
      if (!this.current(child, generation)) throw this.unavailableError()
      const [version, clientId] = hello.stdout.toString().split(' ')
      if (hello.exitCode !== 0 || version !== String(REMOTE_PROTOCOL_VERSION)) {
        throw remoteError(REMOTE_CHANNEL_ERRORS.VERSION, `remote ${this.options.host} uses an incompatible protocol version; expected ${REMOTE_PROTOCOL_VERSION}, received ${JSON.stringify(hello.stdout.toString())}`)
      }
      if (clientId !== this.clientId || hello.stdout.toString() !== `${REMOTE_PROTOCOL_VERSION} ${this.clientId}`) throw remoteError(REMOTE_CHANNEL_ERRORS.PROTOCOL, `remote ${this.options.host} handshake clientId mismatch`)
      const result = await this.send('# dsh-probe\nuname -s; printf "|"; printf "%s" "${SHELL:-}"')
      if (!this.current(child, generation)) throw this.unavailableError()
      this.validateProbe(result)
      // No async suspension between the generation check and publishing ready.
      this.state = 'ready'
      this.lastError = undefined
      this.startKeepalive(child, generation)
    } catch (error) {
      if (this.current(child, generation)) {
        const coded = error as { code?: string; message?: string }
        this.fail(coded.code ?? REMOTE_CHANNEL_ERRORS.DEAD, coded.message ?? String(error))
      }
      if (this.closing) throw this.unavailableError()
      throw error
    }
  }

  private validateProbe(result: RemoteResult): void {
    if (result.exitCode !== 0) {
      const noShell = result.exitCode === 127 && missingRemoteSh(result.stderr.toString())
      throw remoteError(noShell ? REMOTE_CHANNEL_ERRORS.NO_SHELL : REMOTE_CHANNEL_ERRORS.SHELL_UNPROBED,
        `remote ${this.options.host} refused: POSIX probe failed (exit ${String(result.exitCode)}; stderr: ${JSON.stringify(firstLine(result.stderr.toString()))}); ` +
        'a POSIX shell plus coreutils is required, Windows remotes are out of scope (ADR-0017 decision 6).')
    }
    const text = result.stdout.toString()
    const bar = text.indexOf('|')
    const uname = (bar < 0 ? text : text.slice(0, bar)).trim()
    const shell = (bar < 0 ? '' : text.slice(bar + 1)).trim()
    this.remoteShell = { uname, shell }
    validateRemoteShell(this.options.host, uname, shell)
  }

  private fail(code: string, message: string): void {
    if (this.closing) return
    this.stopKeepalive()
    const child = this.child
    this.child = undefined
    this.generation += 1
    this.state = 'unavailable'
    this.lastError = { code, message }
    this.failPending(code, message)
    this.kill(child)
    const permanent = isPermanentChannelFailure(code)
    if (!permanent && !this.recovering && this.users > 0 && this.options.reconnectMax > 0) {
      this.recoveryRequested = true
      this.startRecovery()
    }
  }

  private async reconnect(): Promise<void> {
    for (let step = 1; step <= this.options.reconnectMax; step += 1) {
      await this.sleep(this.options.reconnectBaseMs * step)
      if (this.closing || this.users === 0) throw this.unavailableError()
      try {
        await this.open()
        this.reconnects += 1
        return
      } catch (error) {
        if (this.closing) throw this.unavailableError()
        const code = (error as { code?: string }).code
        if (isPermanentChannelFailure(code)) throw error
      }
    }
    this.state = 'unavailable'
    this.lastError = { code: REMOTE_CHANNEL_ERRORS.LOST,
      message: `remote channel for ${this.options.host} is unavailable after ${String(this.options.reconnectMax)} reconnect attempts: ${this.lastError?.message ?? 'unknown cause'}` }
    throw this.unavailableError()
  }

  private kill(child: ChannelProcess | undefined): void {
    try { child?.kill('SIGTERM') } catch { /* The process may already be gone. */ }
  }

  private failPending(code: string, message: string): void {
    const waiters = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.reject(remoteError(code, message))
    }
  }

  private startKeepalive(child: ChannelProcess, generation: number): void {
    this.stopKeepalive()
    if (this.options.keepaliveMs <= 0) return
    let busy = false
    this.keepaliveTimer = setInterval(() => {
      if (busy || !this.current(child, generation)) return
      busy = true
      void this.send('true').catch((error: unknown) => {
        if (this.current(child, generation) && (error as { code?: string }).code === REMOTE_CHANNEL_ERRORS.TIMEOUT) {
          this.fail(REMOTE_CHANNEL_ERRORS.DEAD, `remote channel for ${this.options.host} missed its keepalive (${String(this.options.keepaliveMs)}ms)`)
        }
      }).finally(() => { busy = false })
    }, this.options.keepaliveMs)
    this.keepaliveTimer.unref()
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }
  }
}

/** 永久违约不能靠重新握手修好；首连与自动重连共用同一分类。 */
function isPermanentChannelFailure(code: string | undefined): boolean {
  return code === REMOTE_CHANNEL_ERRORS.NO_SHELL || code === REMOTE_CHANNEL_ERRORS.NON_POSIX_SHELL ||
    code === REMOTE_CHANNEL_ERRORS.SHELL_UNPROBED || code === REMOTE_CHANNEL_ERRORS.VERSION
}

/** Missing local identity files or ssh executables are NOT remote shell facts. */
function missingRemoteSh(stderr: string): boolean {
  return /(?:^|[\s:])sh:\s*(?:command\s+)?not found\b|(?:^|[\s:])sh:\s*No such file/imu.test(stderr)
}
/** The first non-empty line of a diagnostics blob (stderr tails are noisy). */
export function firstLine(text: string): string {
  return text.split(/\r?\n/u).find((line) => line.trim() !== '')?.trim() ?? ''
}

/** The marker the response codec uses on the wire (re-exported for harnesses). */
export { FRAME_RESPONSE }
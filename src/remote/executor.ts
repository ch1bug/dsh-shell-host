/**
 * One-shot remote shell executor over system OpenSSH (ADR-0004 decisions 3–4,
 * ticket #2). `resolve` validates the descriptor loudly and expands the argv
 * with the workdir composed on the REMOTE side of the transport; `execute`
 * spawns the ssh client, streams both output streams under in-memory caps
 * (tail retained, never spilled — spill loudly rejects), fuses the deadline
 * and the caller's abort into one first-cause kill of the ssh client, and
 * settles a field-identical {@link ShellResult} (D8).
 * Absorbed as the `./remote` entry (issue #29, ADR-0007 pure move).
 * @module dsh-shell-host/remote/executor
 */

import { spawn } from 'node:child_process'
import { assertServiceableDescriptor, sshDescriptor } from './descriptor.ts'
import type { RemoteBackendDescriptor } from './descriptor.ts'
import { COMMAND_TOKEN, ERROR_PREFIX } from './descriptor.ts'
import { posixQuote } from '../posix-quote.ts'
import type { CollectedOutput, ShellExecRequest, ShellResult } from './types.ts'

/** Default per-stream in-memory cap when a request omits `stdoutMaxBytes`. */
const DEFAULT_OUTPUT_MAX_BYTES = 1_048_576

/**
 * The remote payload for one request: `cd -- <q(workdir)> && eval
 * <q(command)>` — the workdir is applied REMOTELY (no path mapping exists on
 * the transport, D8) and `eval` re-enters the caller's command verbatim
 * through one layer of quoting.
 */
function composeRemotePayload(workdir: string, command: string): string {
  return `cd -- ${posixQuote(workdir)} && eval ${posixQuote(command)}`
}

/**
 * Resolved one-shot execution spec: the caller's request with the descriptor
 * expanded. `workdir` stays a REMOTE path — resolution never rewrites it.
 */
export interface ShellExecSpec {
  /** The command string, run remotely as `bash -c <command>`. */
  command: string
  /** REMOTE working directory, passed through verbatim (no path mapping, D8). */
  workdir: string
  /** Foreground timeout in milliseconds. */
  timeoutMs: number
  /** The concrete ssh argv (launcher + transport template + composed command). */
  argv: readonly string[]
  /** Resolved per-stream capture budget, applied to stdout and stderr alike. */
  outputMaxBytes: number
  /** Caller cancellation carried from the request. */
  signal?: AbortSignal | undefined
}

/**
 * Bounded in-memory collection with the TAIL retained on overflow (the seam's
 * CollectedOutput shape; `spillPath` stays unset — the remote executor never
 * spills, spill loudly rejects).
 */
function collectStream(stream: NodeJS.ReadableStream, maxBytes: number): { text: string; truncated: boolean; done: Promise<void> } {
  let chunks: Buffer[] = []
  let total = 0
  let truncated = false
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    total += chunk.length
    if (total > maxBytes) {
      truncated = true
      // Byte-exact TAIL retention: fold once when over cap (O(n) overall).
      chunks = [Buffer.from(Buffer.concat(chunks).subarray(-maxBytes))]
      total = maxBytes
    }
  })
  // The stream must never hang `execute`: a stream error (an EPIPE race
  // during the kill path, most likely) settles collection with what arrived.
  const done = new Promise<void>(resolve => {
    stream.on('end', resolve)
    stream.on('error', resolve)
  })
  return {
    get text() {
      return Buffer.concat(chunks).toString('utf8')
    },
    get truncated() {
      return truncated
    },
    done,
  }
}

/**
 * One-shot remote executor: descriptor validation + argv expansion + the ssh
 * transport. Loud-failure posture throughout — a misconfigured descriptor or
 * a spill-shaped request can never reach a silent no-op.
 */
export class RemoteShellExecutor {
  readonly descriptor: RemoteBackendDescriptor

  constructor(host: string, descriptor?: RemoteBackendDescriptor) {
    this.descriptor = descriptor ?? sshDescriptor(host)
    // Loud-failure posture: a host that disagrees with the supplied
    // descriptor is a caller bug, never silently ignored.
    if (this.descriptor.host !== host) {
      throw new Error(`${ERROR_PREFIX}: host '${host}' does not match the supplied descriptor's host '${this.descriptor.host}'`)
    }
  }

  /**
   * Resolve a request into a fully-specified spec: validate the descriptor
   * loudly (misconfiguration can never reach a spawn), reject spill-shaped
   * requests loudly, and expand the argv. Unlike the local executor there is
   * NO host-cwd default — the request must carry an explicit remote `workdir`.
   * @throws Error naming the unserviceable descriptor part, or the spill option.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    assertServiceableDescriptor(this.descriptor)
    // Spill is a host-plane capability with no remote meaning (D8): a request
    // that smuggles one in (JS callers bypass the typed surface) rejects here,
    // before any spawn.
    if ('spill' in request) {
      throw new Error(`${ERROR_PREFIX}: spill is a host capability with no remote meaning and is loudly rejected`)
    }
    // The composed payload substitutes DIRECTLY into every {command} entry of
    // the one-shot template (assertServiceableDescriptor has already
    // guaranteed at least one {command} entry exists), so the splice can
    // never be misdirected by a command that equals another token.
    // ssh joins its argv with bare spaces and hands the joined string to the
    // REMOTE shell, which re-splits it — an unwrapped payload with spaces
    // would be torn apart (`bash -c cd -- ...` runs a bare `cd` and lands in
    // the home directory). One extra single-quote layer around the whole
    // payload makes it a single remote shell word.
    const payload = posixQuote(composeRemotePayload(request.workdir, request.command))
    const composed: readonly string[] = [
      ...this.descriptor.executable,
      this.descriptor.host,
      ...this.descriptor.argv.oneShot.map(arg => arg.replaceAll(COMMAND_TOKEN, payload)),
    ]
    const spec: ShellExecSpec = {
      command: request.command,
      workdir: request.workdir,
      timeoutMs: request.timeoutMs,
      outputMaxBytes: request.stdoutMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
      argv: composed,
    }
    if (request.signal !== undefined) spec.signal = request.signal
    return spec
  }

  /**
   * Execute one resolved spec over the ssh transport: spawn the client, fuse
   * the deadline and the caller's abort into one first-cause kill (SIGKILL on
   * the ssh client — killing it tears the remote command down with the
   * session), collect both streams under the spec's cap with the tail
   * retained, and settle a field-identical {@link ShellResult}. A settled ssh
   * exit (including the transport's own 255 with a note on stderr — a failed
   * remote preparation) is a RESULT, never a rejection; only a spawn that
   * never produced a process rejects (the seam's infrastructure-failure
   * posture).
   * @throws Error when the ssh executable itself could not be spawned.
   */
  async execute(spec: ShellExecSpec): Promise<ShellResult> {
    const child = spawn(spec.argv[0] ?? '', spec.argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const childStdout = child.stdout
    const childStderr = child.stderr
    if (!childStdout || !childStderr) {
      throw new Error(`${ERROR_PREFIX}: ssh transport did not expose piped output streams`)
    }

    const stdout = collectStream(childStdout, spec.outputMaxBytes)
    const stderr = collectStream(childStderr, spec.outputMaxBytes)

    const settled = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on('error', err => {
        reject(new Error(`${ERROR_PREFIX}: failed to spawn the ssh transport: ${String(err)}`))
      })
      child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
    })

    let timedOut = false
    let aborted = false
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, spec.timeoutMs)

    const onAbort = () => {
      // First-cause classification: the deadline and the abort race, and only
      // the first one to fire kills — the other flag can no longer set.
      aborted = true
      child.kill('SIGKILL')
    }
    if (spec.signal) {
      if (spec.signal.aborted) onAbort()
      else spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    const exit = await settled
    clearTimeout(deadline)
    if (spec.signal) spec.signal.removeEventListener('abort', onAbort)

    await Promise.all([stdout.done, stderr.done])
    const result: ShellResult = {
      exitCode: exit.exitCode,
      signal: exit.signal,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout: { text: stdout.text, truncated: stdout.truncated },
      stderr: { text: stderr.text, truncated: stderr.truncated },
      // sandbox stays absent: reserved-never-populated (D8 deviation, locked
      // by the conformance test).
    }
    return result
  }
}

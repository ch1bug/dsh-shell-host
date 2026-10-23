/**
 * The shared FAKE-CHANNEL harness for the remote workspace pair (#137,
 * ADR-0016 acceptance: "`./remote` and `./remote-files` share ONE fake-channel
 * harness whose frame codec is the shipping one").
 *
 * Division of labour, which is the point of this file:
 *   - the WIRE is the shipping codec — `encodeResponse` / `encodeError` format
 *     every byte the fake remote emits, and the channel under test decodes them
 *     with the shipping `FrameDecoder`. A drift in the response shape therefore
 *     fails here, not in a spec that quietly re-spells it;
 *   - the REQUEST split is harness plumbing (three lines: split the line, parse
 *     the id, base64-decode the command) because the remote side of that split
 *     is the shipped POSIX `sh` loop, whose real behaviour is covered by
 *     `tests/remote-frame-machine.spec.ts` (a real bash runs the real loop).
 *
 * The handle exposes the three failure shapes the channel must survive:
 * `emit` for a HALF packet (feed a frame in two writes) and a STICKY packet
 * (two frames in one write), `exit` for CHANNEL DEATH (optionally with the
 * stderr that identifies a missing `sh`), and `answer` returning raw bytes so a
 * spec can inject a malformed line.
 *
 * @module tests/helpers/fake-channel
 */

import { encodeError, encodeResponse, REMOTE_PROTOCOL_VERSION } from "../../src/remote/frame.ts";
import type { ChannelProcess, ChannelSpawner, ChannelSpawnSpec } from "../../src/remote/channel.ts";

/** One request the channel wrote, decoded. */
export interface FakeRequest {
  readonly id: number;
  readonly command: string;
}

/** The spec answered per request: `undefined` = stay silent (no reply yet). */
export type FakeResponder = (request: FakeRequest) => string | undefined;

/** What the fake remote "ran" for one command. */
export interface FakeExecResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** One spawned fake channel. */
export interface FakeChannelHandle {
  readonly spec: ChannelSpawnSpec;
  /** Application requests (id > 0), in write order; control handshake stays in writes. */
  readonly requests: FakeRequest[];
  /** Every raw write the channel made (including any framing bugs). */
  readonly writes: string[];
  /** Feed raw bytes to the channel (half/sticky packet control). */
  emit(raw: string): void;
  /** Emit one well-formed response for `id` (the shipping encoder). */
  respond(id: number, result: FakeExecResult): void;
  /** Emit one well-formed ERROR frame for `id`. */
  fail(id: number, message: string): void;
  /** Simulate the process exiting (channel death). */
  exit(info?: { code?: number | null; signal?: NodeJS.Signals | null; stderr?: string }): void;
  /** How many times this handle was killed. */
  readonly killed: number;
}

/** The default fake remote: a POSIX host (the ADR-0017 decision 6 pass shape). */
export function posixRemoteExec(command: string): FakeExecResult {
  if (command.startsWith("# dsh-probe\n")) return { exitCode: 0, stdout: "Linux|/bin/bash" }
  return { exitCode: 127, stderr: "dsh fake channel: no scripted answer for this command" }
}

/** A responder that runs `exec` and formats the answer with the SHIPPING encoder. */
export function frameLoopResponder(exec: (command: string) => FakeExecResult): FakeResponder {
  return (request) => {
    const result = exec(request.command)
    return encodeResponse(request.id, result.exitCode, result.stdout ?? "", result.stderr ?? "")
  }
}

/** Decode ONE request line (`R <id> <base64 command>`) — harness plumbing, see the header. */
function decodeRequestLine(line: string): FakeRequest | undefined {
  const match = /^R (\d+) ([A-Za-z0-9+/=]*)$/u.exec(line)
  if (match === null) return undefined
  return { id: Number(match[1]), command: Buffer.from(match[2] ?? "", "base64").toString("utf8") }
}

/** Build a spawner that hands out fake channels and records every handle. */
export function fakeChannelHarness(options: {
  /** Default: {@link posixRemoteExec} wrapped in the shipping encoder. */
  respond?: FakeResponder
  /** Answer requests SYNCHRONOUSLY (default true). False = manual `respond`/`emit`. */
  autoAnswer?: boolean
} = {}) {
  const respond = options.respond ?? frameLoopResponder(posixRemoteExec)
  const autoAnswer = options.autoAnswer !== false
  const handles: FakeChannelHandle[] = []

  const spawner: ChannelSpawner = (spec) => {
    const requests: FakeRequest[] = []
    const writes: string[] = []
    const stdout: Array<(chunk: Buffer) => void> = []
    const stderr: Array<(chunk: string) => void> = []
    const exits: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = []
    let killed = 0
    let buffer = ""

    const handle: FakeChannelHandle = {
      spec,
      requests,
      writes,
      emit(raw) {
        for (const callback of stdout) callback(Buffer.from(raw, "utf8"))
      },
      respond(id, result) {
        handle.emit(encodeResponse(id, result.exitCode, result.stdout ?? "", result.stderr ?? ""))
      },
      fail(id, message) {
        handle.emit(encodeError(id, message))
      },
      exit(info = {}) {
        if (info.stderr !== undefined) for (const callback of stderr) callback(info.stderr)
        for (const callback of exits) callback({ code: info.code ?? 0, signal: info.signal ?? null })
      },
      get killed() {
        return killed
      },
    }
    handles.push(handle)

    const child: ChannelProcess = {
      pid: 10_000 + handles.length,
      write(chunk) {
        writes.push(chunk)
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const request = decodeRequestLine(line)
          if (request === undefined) continue
          // id0是协议控制握手，不计入应用请求；原始writes仍保留全部线路字节。
          if (request.id === 0 && request.command.startsWith('DSH-HELLO ')) {
            const [, version, clientId] = request.command.split(' ')
            handle.emit(version === String(REMOTE_PROTOCOL_VERSION)
              ? encodeResponse(0, 0, `${REMOTE_PROTOCOL_VERSION} ${clientId}`)
              : encodeError(0, 'incompatible protocol version'))
            continue
          }
          requests.push(request)
          if (!autoAnswer) continue
          const reply = respond(request)
          if (reply !== undefined) handle.emit(reply)
        }
        return true
      },
      onStdout(callback) {
        stdout.push(callback)
      },
      onStderr(callback) {
        stderr.push(callback)
      },
      onExit(callback) {
        exits.push(callback)
      },
      kill() {
        killed += 1
      },
    }
    return child
  }

  return {
    spawner,
    handles,
    /** The most recently spawned handle (a spec's usual working one). */
    last(): FakeChannelHandle {
      const handle = handles[handles.length - 1]
      if (handle === undefined) throw new Error("no fake channel was spawned")
      return handle
    },
  }
}
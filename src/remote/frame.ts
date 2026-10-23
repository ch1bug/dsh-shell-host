/**
 * The remote workspace's FRAME CODEC (#137, ADR-0016 decision 2 / decision 10).
 *
 * The channel is ONE long-lived `ssh <host> -- sh -c <loop>` process; every
 * file/command request is framed onto its stdin and answered on its stdout.
 * ADR-0016 requires the codec to survive the real transport failures —
 * **half packets** (a frame split across reads), **sticky packets** (two frames
 * in one read), **error frames** (the remote loop refusing a payload) and
 * **channel death** (the loop stops answering) — so this module is the single
 * place those four cases are decided, and the remote side is shipped as
 * {@link REMOTE_FRAME_LOOP} (the SAME codec, written in POSIX `sh`).
 *
 * ## The wire shape (one ASCII line per frame, `\n`-terminated)
 *
 *   request   `R <id> <base64(command)>`
 *   response  `K <id> <exitCode> <base64(stdout)> <base64(stderr)>`
 *   error     `E <id> <base64(reason)>`
 *
 * id 0 is reserved for `DSH-HELLO <version> <clientId>`: the loop replies with
 * its own version and the echoed clientId before accepting application frames.
 * An incompatible version is an error frame, never a shell command.
 *
 * Why a LINE protocol with base64 payloads, and not a binary length prefix:
 * the remote side is a zero-install `sh` loop (ADR-0016 decision 3), and `read`
 * in `sh` is line-oriented — a binary header would need `dd` byte-exact reads
 * from a stream with no `read -N`. Base64 keeps every payload opaque (a command
 * carrying newlines, a future binary read in #138) while the framing stays a
 * plain line split, which is what makes the four cases above tractable on both
 * ends. The cost is 33% wire overhead; the protocol is request/response, not a
 * bulk transfer (large payloads are #138's chunking/tar concern).
 *
 * The four cases, and where each is decided:
 *   - **half packet** — {@link FrameDecoder.feed} buffers the trailing partial
 *     line and returns nothing for it; the next chunk completes it.
 *   - **sticky packet** — one chunk legitimately decodes to N frames; `feed`
 *     returns ALL complete frames.
 *   - **error frame** — an `E` line becomes a `kind: "error"` frame carrying the
 *     remote reason; a line that is not a frame at all becomes
 *     `kind: "malformed"` instead of being skipped (a silently skipped line is
 *     how a desynchronised stream starts looking healthy).
 *   - **channel death** — not this module's business: the channel reaps its own
 *     pending map on exit (`src/remote/channel.ts`) so a dead loop fails loudly
 *     instead of waiting for a frame that will never come.
 *
 * @module dsh-shell-host/remote/frame
 */

/** Marker of a request line (client → remote). */
export const FRAME_REQUEST = 'R'
/** Marker of a response line (remote → client). */
export const FRAME_RESPONSE = 'K'
/** Marker of an error line (remote → client): the loop refused the payload. */
export const FRAME_ERROR = 'E'

/** ADR-0016：首个控制请求必须协商版本并回显clientId，不能用shell探测代替。 */
export const REMOTE_PROTOCOL_VERSION = 1
export function handshakeCommand(clientId: string, version = REMOTE_PROTOCOL_VERSION): string {
  return `DSH-HELLO ${version} ${clientId}`
}

/**
 * Hard ceiling on ONE buffered line. A frame that never terminates (a plain
 * `cat` on the far side, a corrupted loop) must not grow the client's buffer
 * without bound — past this the decoder reports `malformed` and the channel
 * fails that request instead of allocating forever.
 */
export const FRAME_MAX_LINE_BYTES = 8 * 1024 * 1024

/** One decoded frame. `malformed` is a REPORT, never silently dropped. */
export type DecodedFrame =
  | { readonly kind: 'response'; readonly id: number; readonly exitCode: number; readonly stdout: Buffer; readonly stderr: Buffer }
  | { readonly kind: 'error'; readonly id: number; readonly message: string }
  | { readonly kind: 'malformed'; readonly line: string; readonly reason: string }

/** Encode one request line: `<id>` + the command as base64 (never split lines). */
export function encodeRequest(id: number, command: string): string {
  return `${FRAME_REQUEST} ${String(id)} ${Buffer.from(command, 'utf8').toString('base64')}\n`
}

/**
 * Encode one response line. Exported for the FAKE-CHANNEL HARNESS (ADR-0016
 * acceptance: "`./remote` and `./remote-files` share one fake-channel harness
 * whose frame codec is the shipping one") — the remote `sh` loop formats the
 * same line by hand, so the harness must not grow a second spelling.
 */
export function encodeResponse(id: number, exitCode: number, stdout: string | Buffer = '', stderr: string | Buffer = ''): string {
  const out = Buffer.from(stdout).toString('base64')
  const err = Buffer.from(stderr).toString('base64')
  return `${FRAME_RESPONSE} ${String(id)} ${String(exitCode)} ${out} ${err}\n`
}

/** Encode one error line (the loop could not run the request it was given). */
export function encodeError(id: number, message: string): string {
  return `${FRAME_ERROR} ${String(id)} ${Buffer.from(message, 'utf8').toString('base64')}\n`
}

/** Decode one base64 operand; `undefined` = it is not base64 at all. */
function decodePayload(text: string): Buffer | undefined {
  if (text === '') return Buffer.alloc(0)
  // Buffer.from 对残缺字节/错误padding过于宽松；线路只接受可逆的标准base64。
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text) || text.length % 4 !== 0) return undefined
  const bytes = Buffer.from(text, 'base64')
  return bytes.toString('base64') === text ? bytes : undefined
}

/** Parse one complete line (no trailing `\n`) into a frame report. */
function parseLine(line: string): DecodedFrame {
  const space = line.indexOf(' ')
  if (space <= 0) {
    return { kind: 'malformed', line, reason: 'line has no frame marker and operand' }
  }
  const marker = line.slice(0, space)
  const rest = line.slice(space + 1)
  if (marker === FRAME_REQUEST) {
    // The remote loop never sends requests; seeing one means the two ends
    // disagree about direction (a stale process, a mixed-in shell prompt).
    return { kind: 'malformed', line, reason: 'the remote side sent a request frame — the ends disagree about direction' }
  }
  const parts = rest.split(' ')
  const id = Number(parts[0])
  if (!/^\d+$/u.test(parts[0] ?? '') || !Number.isSafeInteger(id) || id < 0) {
    return { kind: 'malformed', line, reason: `frame id is not a non-negative integer: ${JSON.stringify(parts[0])}` }
  }
  if (marker === FRAME_ERROR) {
    if (parts.length !== 2) {
      return { kind: 'malformed', line, reason: `error frame carries ${String(parts.length)} operands, expected 2` }
    }
    const message = decodePayload(parts[1] ?? '')
    if (message === undefined) return { kind: 'malformed', line, reason: 'error frame payload is not base64' }
    return { kind: 'error', id, message: message.toString('utf8') }
  }
  if (marker !== FRAME_RESPONSE) {
    return { kind: 'malformed', line, reason: `unknown frame marker ${JSON.stringify(marker)}` }
  }
  if (parts.length !== 4) {
    return { kind: 'malformed', line, reason: `response frame carries ${String(parts.length)} operands, expected 4` }
  }
  const exitCode = Number(parts[1])
  if (!Number.isInteger(exitCode)) {
    return { kind: 'malformed', line, reason: `exit code is not an integer: ${JSON.stringify(parts[1])}` }
  }
  const stdout = decodePayload(parts[2] ?? '')
  if (stdout === undefined) return { kind: 'malformed', line, reason: 'response stdout is not base64' }
  const stderr = decodePayload(parts[3] ?? '')
  if (stderr === undefined) return { kind: 'malformed', line, reason: 'response stderr is not base64' }
  return { kind: 'response', id, exitCode, stdout, stderr }
}

/**
 * The incremental decoder: feed it whatever the channel read, get back every
 * COMPLETE frame. A trailing partial line is retained until the next chunk —
 * that is the half-packet case, and it is the reason this is a class and not a
 * pure `decode(chunk)` function.
 */
export class FrameDecoder {
  /** The retained tail (bytes after the last `\n`). */
  private pending = ''
  /** Set once the ceiling was crossed: the stream is unrecoverable. */
  private overflowed: string | undefined

  /**
   * Feed one read. Returns every frame completed by THIS chunk, in order
   * (0..N — the sticky-packet case is N > 1).
   */
  feed(chunk: Buffer | string): DecodedFrame[] {
    if (this.overflowed !== undefined) {
      return [{ kind: 'malformed', line: this.pending.slice(0, 200), reason: this.overflowed }]
    }
    this.pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const frames: DecodedFrame[] = []
    for (;;) {
      const newline = this.pending.indexOf('\n')
      if (newline < 0) break
      if (newline > FRAME_MAX_LINE_BYTES) {
        this.overflowed = `one frame line exceeded the ${String(FRAME_MAX_LINE_BYTES)}-byte ceiling`
        frames.push({ kind: 'malformed', line: this.pending.slice(0, 200), reason: this.overflowed })
        this.pending = ''
        return frames
      }
      const line = this.pending.slice(0, newline).replace(/\r$/u, '')
      this.pending = this.pending.slice(newline + 1)
      if (line === '') continue // tolerate a stray blank line (a pty-ish echo, a trailing CR)
      frames.push(parseLine(line))
    }
    if (this.pending.length > FRAME_MAX_LINE_BYTES) {
      this.overflowed = `one frame line exceeded the ${String(FRAME_MAX_LINE_BYTES)}-byte ceiling without a terminator — the remote loop is not speaking this codec`
      frames.push({ kind: 'malformed', line: this.pending.slice(0, 200), reason: this.overflowed })
      this.pending = ''
    }
    return frames
  }

  /** The bytes retained for the next chunk (a half packet in flight). */
  get retained(): string {
    return this.pending
  }
}

/**
 * The remote side of the codec: a zero-install POSIX `sh` loop that reads one
 * request line, runs the decoded command in its own `sh -c`, and answers with
 * the framed exit code + stdout + stderr.
 *
 * Design facts this loop encodes (they are the reason it is THIS shape):
 *   - **one `sh -c` per request** — a persistent shell would let one request's
 *     `cd`/`exit` move the next one (ADR-0017 decision 1: per-session cwd is
 *     never bookkeeping inside a shared shell);
 *   - **stdout and stderr stay separate bytes** — the client decodes them into
 *     distinct buffers, so a tool can tell "the command printed nothing" from
 *     "the command failed";
 *   - **the exit code is the command's own** — `dsh_code=$?` is read right
 *     after the redirection completes, before any other command runs;
 *   - **a payload that is not base64 becomes an `E` frame**, never a silent
 *     skip: the client then fails THAT request loudly instead of waiting.
 *
 * Requires `sh` + `base64` + `mktemp` (ADR-0016 decision 3: coreutils on the
 * remote; no server, no transfer, no version directory).
 */
export const REMOTE_FRAME_LOOP = `dsh_ready=0
while IFS= read -r dsh_line; do
  case "$dsh_line" in
    '') continue ;;
  esac
  case "$dsh_line" in
    'R '*) dsh_body=\${dsh_line#R } ;;
    *) exit 65 ;;
  esac
  dsh_id=\${dsh_body%% *}
  dsh_payload=\${dsh_body#* }
  case "$dsh_id" in ''|*[!0-9]*) exit 65 ;; esac
  dsh_cmd=$(printf '%s' "$dsh_payload" | base64 -d 2>/dev/null) || {
    printf '${FRAME_ERROR} %s %s\\n' "$dsh_id" "$(printf '%s' 'request payload is not base64' | base64 | tr -d '\\n')"
    continue
  }
  if [ "$dsh_ready" = 0 ]; then
    case "$dsh_id:$dsh_cmd" in
      '0:DSH-HELLO ${REMOTE_PROTOCOL_VERSION} '*) dsh_client=\${dsh_cmd#DSH-HELLO ${REMOTE_PROTOCOL_VERSION} } ;;
      *) printf '${FRAME_ERROR} %s %s\\n' "$dsh_id" "$(printf '%s' 'incompatible protocol version or missing handshake' | base64 | tr -d '\\n')"; exit 65 ;;
    esac
    case "$dsh_client" in
      ''|*[!A-Za-z0-9._-]*) printf '${FRAME_ERROR} 0 %s\\n' "$(printf '%s' 'invalid protocol clientId' | base64 | tr -d '\\n')"; exit 65 ;;
    esac
    if [ "\${#dsh_client}" -gt 128 ]; then exit 65; fi
    printf '${FRAME_RESPONSE} 0 0 %s \\n' "$(printf '%s' '${REMOTE_PROTOCOL_VERSION} '"$dsh_client" | base64 | tr -d '\\n')"
    dsh_ready=1
    continue
  fi
  if [ "$dsh_id" = 0 ]; then exit 65; fi
  dsh_out=$(mktemp) || continue
  dsh_err=$(mktemp) || { rm -f "$dsh_out"; continue; }
  sh -c "$dsh_cmd" </dev/null >"$dsh_out" 2>"$dsh_err"
  dsh_code=$?
  printf '${FRAME_RESPONSE} %s %s %s %s\\n' "$dsh_id" "$dsh_code" "$(base64 <"$dsh_out" | tr -d '\\n')" "$(base64 <"$dsh_err" | tr -d '\\n')"
  rm -f "$dsh_out" "$dsh_err"
done`
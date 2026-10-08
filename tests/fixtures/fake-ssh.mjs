#!/usr/bin/env node
/**
 * Fake ssh for transport tests (the host-repo detect-injection posture: no
 * real remote is ever contacted). Mounted as a launcher candidate —
 * `['node', this-file, '--mode', <mode>]` — so the executor exercises the
 * real child_process transport while this script stands in for OpenSSH.
 *
 * Payload contract under test (executor-side composition): the argv entry
 * after `-c` is `cd -- '<workdir>' && eval '<command>'` with POSIX
 * single-quote escaping. Modes:
 * - happy: prints `[cwd=<dir>] out=<cmd>` to stdout, exit 0
 * - slow: prints nothing, never exits (timeout/abort tests kill it)
 * - fail: prints an ssh note to stderr, exit 255 (unreachable-host posture)
 */
import { argv, exit } from 'node:process'

const modeIndex = argv.indexOf('--mode')
const mode = modeIndex === -1 ? 'happy' : argv[modeIndex + 1]

/** Extract the payload handed to the remote `bash -c` (after the last `-c`). */
const rawSlot = argv[argv.lastIndexOf('-c') + 1] ?? ''
// The executor wraps the payload in one extra single-quote layer (ssh joins
// argv with spaces and the REMOTE shell re-splits them); undo that layer.
function unwrapSlot(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll(`'\\''`, `'`)
  }
  return value
}
const payload = unwrapSlot(rawSlot)

/** POSIX single-quoted segments of the payload: 'a' and 'b' from `cd -- 'a' && eval 'b'`. */
const quoted = [...payload.matchAll(/'([^']*)'/g)].map(m => m[1])

if (mode === 'happy') {
  const [dir, cmd] = quoted
  if (dir === undefined || cmd === undefined) {
    console.error('fake-ssh: payload does not match `cd -- <q> && eval <q>`:', payload)
    exit(2)
  }
  console.log(`[cwd=${dir}] out=${cmd}`)
  exit(0)
}

if (mode === 'fail') {
  console.error('ssh: connect to host buildhost port 22: Connection refused')
  exit(255)
}

// slow: park forever; the transport's kill path is what ends us.
setInterval(() => {}, 1_000)

/**
 * The ssh launching composition — SINGLE SOURCE (#49/#54), moved here when the
 * ssh tool family became its own component (#136, `./ssh`).
 *
 * Three callers derive from this one function and must never re-hardcode its
 * semantics:
 *   - `ssh_start` (the `./ssh` entry) — the interactive full-duplex instance;
 *   - the launcher layer's ssh transport dimension (ADR-0008 decision 1):
 *     `src/launchers.ts` composes a custom ssh preset's command with it;
 *   - the specs — the keepalive constants and the option rendering are
 *     asserted from these exports, so format drift is pinned at the source.
 *
 * Keepalive defaults injected on every start (#21 phase 1): NAT/firewall idle
 * drops otherwise kill long sessions silently. Each default is individually
 * suppressible via a caller-supplied `options` entry with the same key (#50:
 * exact key match on the normalized {key, value} shape).
 *
 * @module dsh-shell-host/ssh/compose
 */

import { posixQuote } from '../posix-quote.ts'

export const SSH_KEEPALIVE_INTERVAL_DEFAULT = 'ServerAliveInterval=15'
export const SSH_KEEPALIVE_COUNT_DEFAULT = 'ServerAliveCountMax=4'

/** Suppression keys (#50), derived from the #49 atoms so the source stays single. */
const SSH_KEEPALIVE_INTERVAL_KEY: string = SSH_KEEPALIVE_INTERVAL_DEFAULT.split('=')[0]
const SSH_KEEPALIVE_COUNT_KEY: string = SSH_KEEPALIVE_COUNT_DEFAULT.split('=')[0]

/**
 * One ssh `-o` option (#50 structured shape). `value` omitted = valueless
 * option. The atomic-string form (`"Key=value"` / `"Key"`) is accepted as
 * sugar and normalized into this shape.
 */
// A type LITERAL, not an interface: defineTool's schema inference maps an
// unitems array parameter to JsonValue[], and only object-literal types get
// the implicit index signature that makes them assignable to JsonValue.
export type SshOption = {
  key: string
  value?: string
}

/** Tool-parameter shape: either form per entry (#50 additive dual shape). */
export type SshOptionInput = string | SshOption

/** Chars that force POSIX quoting of a structured value (one shell word). */
const SHELL_UNSAFE = /[\s'"`$\\;&|<>(){}*?[\]#~!]/

/**
 * Normalize the dual-shape `options` input into `SshOption[]` (#50): the
 * atomic string is split at its FIRST `=` (empty key rejected); a valueless
 * atom becomes `{ key }`. Suppression then matches on the normalized KEY —
 * exact, no prefix heuristics.
 */
const normalizeSshOptions = (options: SshOptionInput[] | undefined): SshOption[] => {
  if (options === undefined) return []
  return options.map((entry, i): SshOption => {
    const at = `ssh_start options[${i}]`
    if (typeof entry === 'string') {
      if (entry === '' || /\s/.test(entry)) {
        throw new Error(`${at} must be a single -o atom with no whitespace (spaced values: use the structured {key, value} form), got: ${JSON.stringify(entry)}`)
      }
      const eq = entry.indexOf('=')
      if (eq < 0) return { key: entry }
      if (eq === 0) throw new Error(`${at}: empty option key in ${JSON.stringify(entry)}`)
      return { key: entry.slice(0, eq), value: entry.slice(eq + 1) }
    }
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`${at} must be a -o atom string or a {key, value} object, got: ${JSON.stringify(entry)}`)
    }
    const { key, value } = entry as { key?: unknown; value?: unknown }
    if (typeof key !== 'string' || key === '' || /\s/.test(key) || key.includes('=')) {
      throw new Error(`${at}.key must be a non-empty ssh option name with no whitespace or '=', got: ${JSON.stringify(key)}`)
    }
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`${at}.value must be a string when present, got: ${JSON.stringify(value)}`)
    }
    return value === undefined ? { key } : { key, value }
  })
}

/**
 * Render one normalized option as the `-o` operand: valueless keys alone;
 * values POSIX-quoted only when they carry whitespace/shell metacharacters
 * (atom-shaped values keep their #21-era verbatim look).
 */
const renderSshOption = (option: SshOption): string =>
  option.value === undefined ? option.key : `${option.key}=${SHELL_UNSAFE.test(option.value) ? posixQuote(option.value) : option.value}`

/** The ssh launch argument clump, named once (#54) and shared by every caller. */
export interface SshLaunchArgs {
  host: string
  jump?: string
  port?: number
  shell?: string
  options?: SshOptionInput[]
}

/**
 * The ssh composition, single source (#49/#54): the ssh_start tool and the
 * launcher layer's ssh transport dimension (ADR-0008 decision 1) both derive
 * from this one function — the launcher never re-hardcodes keepalive or -o
 * semantics.
 */
export function composeSshCommand(args: SshLaunchArgs): string {
  /** argv ATOMS (host/jump) — never shell text; reject whitespace loudly. */
  const atom = (kind: string, value: string) => {
    if (!/^[\w.@:[\]-]+$/.test(value)) {
      throw new Error(`ssh ${kind} must be a single argv atom (no whitespace/shell metacharacters), got: ${JSON.stringify(value)}`)
    }
    return value
  }
  // -tt: force remote TTY allocation even when the local side is a pipe —
  // the interactive full-duplex contract (banner, prompt, echo) depends on
  // the remote shell being interactive.
  const parts = ['ssh', '-tt']
  if (args.jump !== undefined) parts.push('-J', atom('jump', args.jump))
  if (args.port !== undefined) {
    if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
      throw new Error(`ssh port must be an integer in 1..65535, got: ${args.port}`)
    }
    parts.push('-p', String(args.port))
  }
  const supplied = normalizeSshOptions(args.options)
  // Keepalive defaults first so an explicit caller option reads as the
  // override; each default is suppressed when the caller supplies an
  // option with the same KEY AND a value — exact match on the normalized
  // shape (#50), never a prefix heuristic. A valueless entry does not
  // "set" the option (and would compose an invalid bare `Key` anyway),
  // so it leaves the default in place.
  const setsKey = (key: string) => supplied.some((option) => option.key === key && option.value !== undefined)
  if (!setsKey(SSH_KEEPALIVE_INTERVAL_KEY)) {
    parts.push('-o', SSH_KEEPALIVE_INTERVAL_DEFAULT)
  }
  if (!setsKey(SSH_KEEPALIVE_COUNT_KEY)) {
    parts.push('-o', SSH_KEEPALIVE_COUNT_DEFAULT)
  }
  for (const option of supplied) parts.push('-o', renderSshOption(option))
  parts.push(atom('host', args.host))
  // `shell` is deliberately NOT an atom: it is remote SHELL TEXT appended
  // verbatim (e.g. "bash --login"). core.open delivers `command` as shell
  // text into the PTY (the PTY model has no argv array), so only host/jump
  // need atom validation — they are the pieces ssh itself parses.
  if (args.shell !== undefined && args.shell.trim() !== '') parts.push(args.shell.trim())
  return parts.join(' ')
}

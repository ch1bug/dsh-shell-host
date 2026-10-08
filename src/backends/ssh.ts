/**
 * The `ssh` backend (issue #23, AC9; merged from dsh-shell-remote): one-shot
 * remote shell execution over system OpenSSH — `ssh <host> -- bash -c <cmd>`
 * — inheriting the user's `~/.ssh/config`, keys, agent, and jump hosts for
 * free (the wsl-backend-shells-out-to-wsl.exe posture). The descriptor rides
 * the same vocabulary as the local backends: ordered launcher candidates
 * (bare `ssh` resolved through PATH), argv templates, no env injection, no
 * PATH prefix, and identity path mapping — all path semantics are REMOTE, the
 * executor never maps paths (no `/mnt/c` counterpart; ADR-0004 decision 4,
 * carried into this merge). The host is a backend-specific descriptor field
 * (the ADR-0003 decision 4 pattern `wsl` established): an explicit `sshHost`
 * config knob is required; an empty or absent host fails loudly — no silent
 * spawn against an unnamed remote.
 * @module dsh-shell-host/backends/ssh
 */

import type { Config } from '../index.ts'
import type { SpecificBackendDescriptor } from '../backends.ts'
import { COMMAND_TOKEN } from '../backends.ts'

/** Backend-specific fields carried by the `ssh` descriptor. */
export interface SshSpecific {
  /** Remote target, passed to ssh verbatim (a `~/.ssh/config` alias or `[user@]host`). */
  host: string
}

/**
 * Build the `ssh` backend descriptor for the configured host. The host is
 * spliced into both argv templates (the descriptor is the single declaration
 * place — no invented `{host}` placeholder): the one-shot transport keeps the
 * `--` guard against option injection from a host-shaped string, and the
 * interactive template allocates a PTY (`-t`) into a login shell.
 * @throws Error naming the `sshHost` knob when the host is missing or blank.
 */
export function sshBackend(config: Config): SpecificBackendDescriptor<'ssh'> {
  const host = config.sshHost.get()?.trim() ?? ''
  if (host.length === 0) {
    throw new Error(
      `shell-host: backend 'ssh' requires a remote target; set sshHost (a ~/.ssh/config alias or [user@]host) explicitly`,
    )
  }
  return {
    id: 'ssh',
    specific: { host },
    executable: ['ssh'],
    argv: {
      oneShot: [host, '--', 'bash', '-c', COMMAND_TOKEN],
      interactive: ['-t', host, 'bash', '--login', '-i'],
    },
    env: {},
    pathPrefix: [],
    pathMapping: {
      toShell: async (path) => path,
      fromShell: async (path) => path,
    },
  }
}

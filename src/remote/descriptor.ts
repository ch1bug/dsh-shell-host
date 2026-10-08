/**
 * Remote backend descriptor layer, forked from the dsh-shell-host descriptor
 * vocabulary (ADR-0001 words) and reshaped for the remote world (ADR-0004
 * decisions 3–4): the transport shells out to system OpenSSH — `ssh <host> --
 * bash -c <cmd>` — inheriting the user's `~/.ssh/config`, keys, agent, and
 * jump hosts for free (the wsl-backend-shells-out-to-wsl.exe posture).
 *
 * Remote differences from the local descriptor surface:
 * - `pathMapping` is ABSENT: all path semantics are remote; the executor never
 *   maps paths (no `/mnt/c` counterpart to map to, D8 / decision 4).
 * - `env`/`pathPrefix` injection is ABSENT: environment shaping happens on the
 *   remote side of the transport, not in the local spawn's env.
 * Absorbed as the `./remote` entry (issue #29, ADR-0007 pure move); ADR-0007:
 * `./remote` is NOT a registry backend — the `backend` single-select never
 * points at it (ADR-0006's `ssh` registry entry is a separate layer).
 * @module dsh-shell-host/remote/descriptor
 */

/** Command-payload token inside the one-shot argv template (ADR-0001 vocabulary). */
export const COMMAND_TOKEN = '{command}'

/**
 * Declarative remote backend description (the descriptor seam, R1 skeleton).
 * `executable` carries the ssh launcher candidates (default: bare `ssh`,
 * resolved through PATH — the same bare-name contract as the local `plain`
 * backend); `argv.oneShot` is the command template, and the transport
 * contract `ssh <host> -- bash -c <cmd>` is realized as launcher + `host` +
 * `['--', 'bash', '-c', '{command}']` — the host is spliced by
 * {@link expandOneShotArgv}, and the `--` guards against option injection
 * from a host-shaped string.
 */
export interface RemoteBackendDescriptor {
  /** Descriptor id: `'ssh'` (the only transport in the staged plan, ADR-0004 decision 3; an ssh library stays behind revisit). */
  id: string
  /** Remote target, passed to ssh verbatim (a `~/.ssh/config` alias or `[user@]host`). */
  host: string
  /** Ordered ssh launcher candidates. A bare name resolves through PATH; absolute paths must exist. */
  executable: readonly string[]
  /** One-shot argv template; the entry containing {@link COMMAND_TOKEN} receives the command. */
  argv: {
    oneShot: readonly string[]
  }
}

/** The default ssh descriptor shape for `host`: bare `ssh` + the transport contract. */
export function sshDescriptor(host: string): RemoteBackendDescriptor {
  return {
    id: 'ssh',
    host,
    executable: ['ssh'],
    argv: { oneShot: ['--', 'bash', '-c', COMMAND_TOKEN] },
  }
}

/**
 * Validate a descriptor this executor can run with (the local
 * `assertServiceableBackend` posture, adapted): non-empty launcher candidates
 * and a {@link COMMAND_TOKEN} placeholder in the one-shot template.
 * @throws Error naming the unserviceable descriptor part.
 */
export function assertServiceableDescriptor(backend: RemoteBackendDescriptor): void {
  if (backend.executable.length === 0) {
    throw new Error(`dsh-shell-remote: backend '${backend.id}' declares no executable candidates`)
  }
  if (backend.host.trim().length === 0) {
    throw new Error(`dsh-shell-remote: backend '${backend.id}' declares an empty host`)
  }
  if (!backend.argv.oneShot.some(arg => arg.includes(COMMAND_TOKEN))) {
    throw new Error(`dsh-shell-remote: backend '${backend.id}' oneShot argv template lacks a ${COMMAND_TOKEN} placeholder`)
  }
}

/**
 * Expand the one-shot transport into the concrete ssh argv:
 * `<launcher...> <host> <template...>` — the descriptor's `host` is the
 * destination and is spliced in here (the template itself carries no host
 * slot; the ADR-0004 contract `ssh <host> -- bash -c <cmd>` is launcher +
 * host + template). The command payload is substituted into every
 * {@link COMMAND_TOKEN} occurrence.
 */
export function expandOneShotArgv(backend: RemoteBackendDescriptor, command: string): readonly string[] {
  return [
    ...backend.executable,
    backend.host,
    ...backend.argv.oneShot.map(arg => arg.replaceAll(COMMAND_TOKEN, command)),
  ]
}

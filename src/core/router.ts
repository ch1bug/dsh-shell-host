/**
 * Backend router (issue #23, AC6): the `config.backend` selection is routed
 * to one of the registered backend factories — msys2 / plain / pwsh / wsl /
 * ssh — and validated before a handle can exist. Routing is per-resolution:
 * the volatile selection (and every descriptor input) hot-switches without
 * remounting the executor, so changing the backend applies to new commands
 * with no reload (AC8's semantics live in the config, not the lifecycle).
 * The registry itself lives in {@link module:dsh-shell-host/backends}; this
 * module is the single resolution entry the executor calls.
 * @module dsh-shell-host/core/router
 */

import { assertServiceableBackend, resolveBackend } from '../backends.ts'
import type { BackendDescriptor } from '../backends.ts'
import type { Config } from '../index.ts'

/**
 * Route the configured backend id to its validated descriptor.
 * @throws Error naming the backend when the id is unknown or the descriptor
 *   is unserviceable (missing executable candidates, no command placeholder).
 */
export function routeBackend(config: Config): BackendDescriptor {
  const backend = resolveBackend(config)
  assertServiceableBackend(backend)
  return backend
}

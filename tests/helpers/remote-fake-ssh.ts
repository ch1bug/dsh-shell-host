import { fileURLToPath } from 'node:url'
import { COMMAND_TOKEN } from '../../src/remote/descriptor.ts'
import type { RemoteBackendDescriptor } from '../../src/remote/descriptor.ts'

/** Path of the fake-ssh fixture (never contacts a real remote). */
export const FAKE_SSH = fileURLToPath(new URL('../fixtures/fake-ssh.mjs', import.meta.url))

/** Descriptor whose launcher candidate is the fixture fake ssh in the given mode. */
export function fakeSshDescriptor(mode: string): RemoteBackendDescriptor {
  return {
    id: 'ssh',
    host: 'buildhost',
    executable: ['node', FAKE_SSH, '--mode', mode],
    argv: { oneShot: ['--', 'bash', '-c', COMMAND_TOKEN] },
  }
}

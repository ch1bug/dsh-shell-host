import { describe, expect, it } from 'vitest'
import type { CollectedOutput, ShellExecRequest, ShellResult } from '../src/remote/types.ts'

// Absorbed from dsh-shell-remote tests/types.spec.ts (issue #29, ADR-0007
// pure move); renamed remote-types.spec.ts to avoid clashing with any host
// repo type-probe naming.

/**
 * D8 field-identity probe (type level): a ShellResult-shaped object
 * constructed with exactly the seam's ShellRunResult fields must typecheck —
 * no extra fields (excess property check), none missing. The R2 contract
 * conformance test adds the runtime field-by-field diff against
 * dsh-bash-local.
 */
describe('ShellResult (D8 field identity, type level)', () => {
  it('accepts the exact seam ShellRunResult field set', () => {
    const result: ShellResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 120_000,
      stdout: { text: 'out', truncated: false },
      stderr: { text: '', truncated: false },
      // sandbox stays absent: the remote executor never confines.
    }
    expect(result.exitCode).toBe(0)
  })

  it('CollectedOutput keeps the spillPath field in shape even though remote never populates it', () => {
    const out: CollectedOutput = { text: 'tail', truncated: true }
    expect(out.spillPath).toBeUndefined()
  })

  it('rejects an unknown field at the type level', () => {
    // @ts-expect-error D8: ShellResult has no spill-path-typed extra fields and no hostPath invention
    const bad: ShellResult = { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, hostPath: 'C:\\' }
    expect(bad).toBeDefined()
  })

  it('the request carries an explicit REMOTE workdir — no default', () => {
    const request: ShellExecRequest = { command: 'pwd', workdir: '/srv/app', timeoutMs: 1_000 }
    expect(request.workdir).toBe('/srv/app')
  })
})

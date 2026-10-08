import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RemoteShellExecutor } from '../src/remote/executor.ts'
import { sshDescriptor } from '../src/remote/descriptor.ts'
import { fakeSshDescriptor } from './helpers/remote-fake-ssh.ts'

// Absorbed from dsh-shell-remote tests/conformance.spec.ts (issue #29,
// ADR-0007 pure move); renamed remote-conformance.spec.ts. Post-move the seam
// dists resolve against THIS repo's node_modules (relative to this file), so
// the canary asserts the dsh-shell-host checkout's own seam install.

/**
 * D8 contract conformance (ADR-0004 decision 4, ticket #2): ShellResult must
 * stay field-identical to the seam's ShellRunResult and CollectedOutput must
 * stay field-identical to the seam's CollectedOutput — a RUNTIME field-by-field
 * diff against the seam's type definitions in the dsh-shell-host node_modules,
 * not just a type-level probe. The known DELIBERATE deviation (README-recorded)
 * is `sandbox`: typed `never` and reserved-never-populated on the remote side.
 */

/** Seam type sources: overridable via DSH_SHELL_HOST_TYPES / DSH_SHELL_HOST_SUBPROCESS_TYPES for other checkouts. */
const SEAM_TYPES = process.env['DSH_SHELL_HOST_TYPES'] ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-shell/lib/types/types.d.ts', import.meta.url))
const SEAM_SUBPROCESS_TYPES = process.env['DSH_SHELL_HOST_SUBPROCESS_TYPES'] ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-subprocess/lib/types/types.d.ts', import.meta.url))

/**
 * The upstream anchor this merged package rides, DERIVED from package.json's
 * own `dsh-v<official>-r<N>` version (ADR-0005: anchor bump resets `-r`;
 * single source of truth — an anchor bump edits package.json only, and this
 * canary follows). Asserts the seam dist the D8 diff reads actually IS this
 * version, so a stale checkout can never silently satisfy the diff against
 * the wrong anchor.
 */
const ANCHORED_SEAM_VERSION = readFileSync(new URL('../package.json', import.meta.url), 'utf8').match(/"version": "([^"]+)-r\d+"/)?.[1]

/** Extract the declared property names of `interface <name> { ... }` from the seam .d.ts. */
function seamInterfaceFields(source: string, name: string): readonly string[] {
  const match = source.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))
  if (!match || match[1] === undefined) throw new Error(`conformance: interface ${name} not found in seam types`)
  return [...match[1].matchAll(/^\s{4}(\w+)[?]?[:<]/gm)].map(m => m[1] as string)
}

/** A produced ShellResult, real through the descriptor (ssh is never spawned: resolve-only fields are not what D8 pins, so execute a fake-free zero-cost probe via a settled local result). */
async function producedResult(): Promise<Record<string, unknown>> {
  const exec = new RemoteShellExecutor('buildhost', fakeSshDescriptor('happy'))
  const spec = exec.resolve({ command: 'echo hi', workdir: '/srv/app', timeoutMs: 5_000 })
  const result = await exec.execute(spec)
  return result as unknown as Record<string, unknown>
}

describe('D8 contract conformance (runtime field-by-field diff)', () => {
  it('the seam dist actually resolves to the anchored version (canary against stale checkouts)', () => {
    for (const typesPath of [SEAM_TYPES, SEAM_SUBPROCESS_TYPES]) {
      const pkg = JSON.parse(readFileSync(join(dirname(typesPath), '..', '..', 'package.json'), 'utf8')) as { version?: string }
      expect(pkg['version'], `seam dist at ${typesPath} is not the anchored version`).toBe(ANCHORED_SEAM_VERSION)
    }
  })

  const seam = readFileSync(SEAM_TYPES, 'utf8')

  it('ShellResult carries exactly the seam ShellRunResult fields — sandbox is the single recorded deviation', async () => {
    const seamFields = seamInterfaceFields(seam, 'ShellRunResult')
    expect(seamFields).toContain('sandbox')
    // The DELIBERATE deviation: sandbox is typed `never` and never populated,
    // so at runtime it is ABSENT — locked separately below, excluded here.
    const pinnedFields = seamFields.filter(f => f !== 'sandbox')
    const result = await producedResult()
    const runtimeFields = Object.keys(result)
    // Every pinned seam field is present...
    for (const field of pinnedFields) {
      expect(runtimeFields, `missing D8 field: ${field}`).toContain(field)
    }
    // ...and nothing extra exists beyond the seam set.
    for (const field of runtimeFields) {
      expect(seamFields, `runtime result carries a field outside the seam: ${field}`).toContain(field)
    }
  })

  it('CollectedOutput carries exactly the seam CollectedOutput fields', async () => {
    const subprocessSeam = readFileSync(SEAM_SUBPROCESS_TYPES, 'utf8')
    const seamFields = seamInterfaceFields(subprocessSeam, 'CollectedOutput')
    expect(seamFields).toEqual(['text', 'truncated', 'spillPath'])
    const result = await producedResult()
    const stdout = result['stdout'] as Record<string, unknown>
    // spillPath is optional and never populated remotely, so it is absent at
    // runtime: the runtime keys are a subset of the seam set, spillPath among
    // the declared-but-never-set fields.
    expect(seamFields).toContain('spillPath')
    for (const field of Object.keys(stdout)) {
      expect(seamFields, `stdout carries a field outside the seam: ${field}`).toContain(field)
    }
    expect(stdout['spillPath']).toBeUndefined()
  })

  it('sandbox stays reserved-never-populated — the DELIBERATE D8 deviation, locked', async () => {
    const result = await producedResult()
    expect(result['sandbox']).toBeUndefined()
  })
})

// The bare-name descriptor stays importable so the conformance suite pins the
// public surface alongside the transport facts above.
describe('D8 public surface', () => {
  it('the default ssh descriptor remains the transport contract', () => {
    expect(sshDescriptor('h').argv.oneShot).toEqual(['--', 'bash', '-c', '{command}'])
  })
})

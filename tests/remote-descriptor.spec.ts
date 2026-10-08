import { describe, expect, it } from 'vitest'
import { COMMAND_TOKEN, assertServiceableDescriptor, expandOneShotArgv, sshDescriptor } from '../src/remote/descriptor.ts'

// Absorbed from dsh-shell-remote tests/descriptor.spec.ts (issue #29, ADR-0007
// pure move); renamed remote-descriptor.spec.ts to avoid the host repo's own
// descriptor.spec.ts (the local registry descriptor suite).

describe('sshDescriptor', () => {
  it('declares the ADR-0004 decision-3 transport contract', () => {
    const d = sshDescriptor('buildhost')
    expect(d.id).toBe('ssh')
    expect(d.host).toBe('buildhost')
    expect(d.executable).toEqual(['ssh'])
    expect(d.argv.oneShot).toEqual(['--', 'bash', '-c', COMMAND_TOKEN])
  })
})

describe('assertServiceableDescriptor', () => {
  it('accepts the default descriptor', () => {
    expect(() => assertServiceableDescriptor(sshDescriptor('buildhost'))).not.toThrow()
  })

  it('rejects an empty host loudly', () => {
    const d = sshDescriptor('  ')
    expect(() => assertServiceableDescriptor(d)).toThrow(/empty host/)
  })

  it('rejects a template without the command token loudly', () => {
    const d = { ...sshDescriptor('buildhost'), argv: { oneShot: ['--', 'bash', '-c'] } }
    expect(() => assertServiceableDescriptor(d)).toThrow(/{command} placeholder/)
  })

  it('rejects empty launcher candidates loudly', () => {
    const d = { ...sshDescriptor('buildhost'), executable: [] }
    expect(() => assertServiceableDescriptor(d)).toThrow(/no executable candidates/)
  })
})

describe('expandOneShotArgv', () => {
  it('produces `ssh <host> -- bash -c <cmd>` and substitutes the payload', () => {
    const argv = expandOneShotArgv(sshDescriptor('buildhost'), 'echo hi')
    expect(argv).toEqual(['ssh', 'buildhost', '--', 'bash', '-c', 'echo hi'])
  })

  it('substitutes every token occurrence', () => {
    const d = { ...sshDescriptor('h'), argv: { oneShot: ['--', 'bash', '-c', `cd ${COMMAND_TOKEN} && ${COMMAND_TOKEN}`] } }
    expect(expandOneShotArgv(d, 'pwd')).toEqual(['ssh', 'h', '--', 'bash', '-c', 'cd pwd && pwd'])
  })
})

/**
 * T3 #15: the WSL bridge (ADR-0003 decision 5) — the wsl backend's dedicated
 * cross-VM path-mapping layer. Both directions live here and are tested here:
 * toShell `C:\x → /mnt/c/x` (drvfs default mount points), fromShell
 * `/mnt/<drive>/` reverse plus the `\\wsl$\<distro>\` projection for VM-internal
 * paths. Non-default drvfs mount points are a documented limitation, not a
 * supported input.
 * @module tests/wsl-bridge
 */
import { describe, expect, it } from 'vitest'
import { fromWslPath, toWslPath } from '../src/wsl-bridge.ts'

describe('T3 #15: the WSL bridge — toShell (host → WSL)', () => {
  it('maps a drive path onto its default drvfs mount point', () => {
    expect(toWslPath('C:\\Work\\code\\dsh-shell-host')).toBe('/mnt/c/Work/code/dsh-shell-host')
    expect(toWslPath('d:\\tmp')).toBe('/mnt/d/tmp')
  })

  it('maps a drive root without a trailing slash', () => {
    expect(toWslPath('C:\\')).toBe('/mnt/c')
  })

  it('normalizes forward-slash host paths (paths arriving from mixed provenance)', () => {
    expect(toWslPath('<old-work>')).toBe('/mnt/c/Work/code')
  })

  it('maps a \\\\wsl$ UNC path onto its in-VM path (a host view of VM files goes back in)', () => {
    expect(toWslPath('\\\\wsl$\\Ubuntu-22.04\\home\\u\\x.txt')).toBe('/home/u/x.txt')
    expect(toWslPath('\\\\wsl.localhost\\Debian\\root')).toBe('/root')
  })

  it('fails loudly on a relative path — the bridge maps, it never guesses', () => {
    expect(() => toWslPath('relative\\path')).toThrow(/relative\\path/)
    expect(() => toWslPath('')).toThrow()
  })
})

describe('T3 #15: the WSL bridge — fromShell (WSL → host)', () => {
  it('maps a default drvfs mount point back onto its drive', () => {
    expect(fromWslPath('/mnt/c/Work/code', 'Ubuntu-22.04')).toBe('C:\\Work\\code')
    expect(fromWslPath('/mnt/d', 'Debian')).toBe('D:\\')
  })

  it('projects a VM-internal path through the \\\\wsl$ share for the configured distro', () => {
    expect(fromWslPath('/home/u/x.txt', 'Ubuntu-22.04')).toBe('\\\\wsl$\\Ubuntu-22.04\\home\\u\\x.txt')
    expect(fromWslPath('/root', 'Debian')).toBe('\\\\wsl$\\Debian\\root')
  })

  it('trims a trailing slash before projecting', () => {
    expect(fromWslPath('/home/u/', 'Ubuntu-22.04')).toBe('\\\\wsl$\\Ubuntu-22.04\\home\\u')
  })

  it('fails loudly on a relative path', () => {
    expect(() => fromWslPath('home/u', 'Ubuntu-22.04')).toThrow(/home\/u/)
  })

  it('maps a \\\\wsl$ share of a foreign distro onto its own in-VM path (documented limitation: the share names the VM)', () => {
    expect(toWslPath('\\\\wsl$\\OtherDistro\\opt\\x')).toBe('/opt/x')
  })
})

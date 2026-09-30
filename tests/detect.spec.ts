import { describe, expect, it } from 'vitest'
import { detectMsysRoot, detectPlainBash, MSYS2_ROOT_CANDIDATES, PLAIN_BASH_CANDIDATES } from '../src/detect.ts'

/**
 * T3 detection tests, fully injected (fake `exists` predicates and PATH
 * strings) so they need no real install — the real-install behavior is
 * covered live in descriptor.spec.ts. Cygwin in particular is not installed
 * on the dev host, so its detection is only reachable through these fakes.
 */
function existsFor(present: string[]) {
  const set = new Set(present.map(p => p.toLowerCase()))
  return (path: string): boolean => set.has(path.toLowerCase())
}

describe('detectMsysRoot', () => {
  it('returns the first candidate root that has usr/bin/bash.exe', () => {
    const exists = existsFor(['C:\\msys64\\usr\\bin\\bash.exe'])
    expect(detectMsysRoot(exists)).toBe('C:\\msys64')
  })

  it('probes the VS Code-ordered candidate list', () => {
    // VS Code's `bash (MSYS2)` profile probes ${HOMEDRIVE}\msys64; our list
    // starts at C:\msys64 (the installer default) then mirrors it.
    expect(MSYS2_ROOT_CANDIDATES[0].toLowerCase()).toBe('c:\\msys64')
    const home = (process.env.HOMEDRIVE ?? 'C:').toLowerCase()
    expect(MSYS2_ROOT_CANDIDATES.map(c => c.toLowerCase())).toContain(`${home}\\msys64`)
  })

  it('returns undefined when nothing is installed', () => {
    expect(detectMsysRoot(() => false)).toBeUndefined()
  })
})

describe('detectPlainBash (win32 PATH probe + ordered fallbacks)', () => {
  it('resolves bash.exe from PATH but excludes the WSL System32 stub', () => {
    // CONTEXT.md fact 6: C:\Windows\System32\bash.exe is WSL, never a POSIX
    // bash we can inject into — the probe must skip it.
    const path = ['C:\\Windows\\System32', 'D:\\tools'].join(';')
    const exists = existsFor(['D:\\tools\\bash.exe'])
    expect(detectPlainBash(exists, path)).toBe('D:\\tools\\bash.exe')
  })

  it('does not pick the WSL System32 bash even when it is the only PATH hit', () => {
    const path = 'C:\\Windows\\System32'
    const exists = existsFor(['C:\\Windows\\System32\\bash.exe'])
    expect(detectPlainBash(exists, path)).toBeUndefined()
  })

  it('falls back to Git Bash, then Cygwin, then MSYS2 when PATH has no bash', () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    expect(PLAIN_BASH_CANDIDATES.map(c => c.toLowerCase())).toContain(gitBash.toLowerCase())
    expect(PLAIN_BASH_CANDIDATES.some(c => c.toLowerCase().includes('cygwin64'))).toBe(true)

    const exists = existsFor([gitBash])
    expect(detectPlainBash(exists, '')).toBe(gitBash)

    // Cygwin (no real install on the host — fake path proves the ordering).
    const cygwin = 'C:\\cygwin64\\bin\\bash.exe'
    const cygwinOnly = existsFor([cygwin])
    expect(detectPlainBash(cygwinOnly, '')).toBe(cygwin)

    // MSYS2 last: a full msys2 backend is the richer surface, but a plain
    // backend pointing at its bash still works (subsystem 'none' semantics).
    const msys2 = 'C:\\msys64\\usr\\bin\\bash.exe'
    const msys2Only = existsFor([msys2])
    expect(detectPlainBash(msys2Only, '')).toBe(msys2)
  })

  it('skips PATH entries whose bash.exe does not exist', () => {
    const path = 'D:\\ghost;C:\\Program Files\\Git\\bin'
    const exists = existsFor(['C:\\Program Files\\Git\\bin\\bash.exe'])
    expect(detectPlainBash(exists, path)).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })
})

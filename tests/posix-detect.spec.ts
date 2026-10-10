import { describe, expect, it } from 'vitest'
import { detectPosixShell, posixInteractiveArgv, posixShellProbedLocations } from '../src/detect.ts'
import { plainBackend } from '../src/backends.ts'

/**
 * #26 native cross-platform detection (macOS/Linux), fully injected —
 * platform / exists / /etc/shells reader / getpwuid analog are all deps, so
 * every test runs on the win32 dev host. The acceptance chain (human-
 * decision 2026-10-11, lane B) is the VS Code fact chain: candidates =
 * /etc/shells line-by-line; default = getpwuid → sh fallback; macOS zsh/
 * bash get login flags. The Linux side is additionally verified live in a
 * WSL container (batch gate evidence); macOS stays argument-aligned with
 * recorded pending-real-machine items.
 */

const ETC_SHELLS = [
  '# /etc/shells: valid login shells',
  '/bin/sh',
  '/bin/bash',
  '/usr/bin/zsh',
  '/opt/homebrew/bin/fish', // Homebrew shell not in a default install
  '', // blank line
].join('\n')

function deps(over: Parameters<typeof detectPosixShell>[0] = {}): Parameters<typeof detectPosixShell>[0] {
  return {
    platform: 'linux',
    exists: () => true,
    readEtcShells: () => ETC_SHELLS,
    userInfoShell: () => '/bin/bash',
    ...over,
  }
}

describe('posixShellProbedLocations (#26: candidates = /etc/shells, line-by-line)', () => {
  it('parses /etc/shells, dropping comments and blank lines', () => {
    expect(posixShellProbedLocations(deps())).toEqual([
      '/bin/sh', '/bin/bash', '/usr/bin/zsh', '/opt/homebrew/bin/fish',
    ])
  })

  it('returns [] when /etc/shells is unreadable', () => {
    expect(posixShellProbedLocations(deps({ readEtcShells: () => undefined }))).toEqual([])
  })
})

describe('detectPosixShell (#26: default = getpwuid → sh fallback)', () => {
  it('is win32-only-undefined: the platform gate keeps the Windows surface untouched', () => {
    expect(detectPosixShell(deps({ platform: 'win32' }))).toBeUndefined()
  })

  it('prefers the getpwuid shell (os.userInfo().shell) when it exists', () => {
    expect(detectPosixShell(deps({ userInfoShell: () => '/usr/bin/zsh' }))).toBe('/usr/bin/zsh')
  })

  it('falls back to sh when getpwuid reports no shell (empty string)', () => {
    expect(detectPosixShell(deps({ userInfoShell: () => '' }))).toBe('sh')
  })

  it('falls back to sh when the getpwuid shell does not exist on disk', () => {
    expect(detectPosixShell(deps({ exists: p => p !== '/usr/bin/zsh', userInfoShell: () => '/usr/bin/zsh' }))).toBe('sh')
  })

  it('never spawns a nologin/false shell — sh fallback instead (VS Code 1:1 filter set)', () => {
    for (const bogus of ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false']) {
      expect(detectPosixShell(deps({ userInfoShell: () => bogus }))).toBe('sh')
    }
  })

  it('the getpwuid shell wins even when absent from /etc/shells (candidates are the probe surface, not a whitelist)', () => {
    expect(detectPosixShell(deps({ userInfoShell: () => '/usr/local/bin/elixir-sh' }))).toBe('/usr/local/bin/elixir-sh')
  })
})

describe('posixInteractiveArgv (#26: macOS zsh/bash login flags, VS Code 1:1)', () => {
  it('macOS zsh gets [-l]', () => {
    expect(posixInteractiveArgv('/bin/zsh', 'darwin')).toEqual(['-l'])
  })

  it('macOS bash gets [--login]', () => {
    expect(posixInteractiveArgv('/bin/bash', 'darwin')).toEqual(['--login'])
  })

  it('macOS Homebrew shells get the same flags by basename', () => {
    expect(posixInteractiveArgv('/opt/homebrew/bin/zsh', 'darwin')).toEqual(['-l'])
    expect(posixInteractiveArgv('/usr/local/bin/bash', 'darwin')).toEqual(['--login'])
  })

  it('macOS other shells (fish…) get no flags — VS Code adds none', () => {
    expect(posixInteractiveArgv('/usr/local/bin/fish', 'darwin')).toEqual([])
  })

  it('Linux gets no flags — VS Code Linux profiles add none', () => {
    expect(posixInteractiveArgv('/bin/bash', 'linux')).toEqual([])
    expect(posixInteractiveArgv('/usr/bin/zsh', 'linux')).toEqual([])
  })
})

describe('plain backend POSIX branch (#26: detected shell, not bare bash)', () => {
  // Config facade with no explicit bashPath — only the field plainBackend reads.
  const noExplicit = { bashPath: { get: () => undefined } } as never
  it('executable = the detected getpwuid shell', () => {
    const backend = plainBackend(noExplicit, deps({ userInfoShell: () => '/usr/bin/zsh' }))
    expect(backend.id).toBe('plain')
    expect(backend.executable).toEqual(['/usr/bin/zsh'])
  })

  it('one-shot stays [-c {command}] (zsh/bash/sh/fish all accept -c)', () => {
    const backend = plainBackend(noExplicit, deps())
    expect(backend.argv.oneShot).toEqual(['-c', '{command}'])
  })

  it('interactive argv follows the macOS login-flag matrix', () => {
    expect(plainBackend(noExplicit, deps({ platform: 'darwin', userInfoShell: () => '/bin/zsh' })).argv.interactive).toEqual(['-l'])
    expect(plainBackend(noExplicit, deps({ platform: 'darwin', userInfoShell: () => '/bin/bash' })).argv.interactive).toEqual(['--login'])
    expect(plainBackend(noExplicit, deps({ platform: 'linux' })).argv.interactive).toEqual([])
  })

  it('sh fallback lands as the bare name so PATH resolves it (never loud-fails on POSIX)', () => {
    const backend = plainBackend(noExplicit, deps({ userInfoShell: () => '/usr/sbin/nologin' }))
    expect(backend.executable).toEqual(['sh'])
  })

  it('POSIX surface keeps env {} / no PATH prefix / identity mapping', async () => {
    const backend = plainBackend(noExplicit, deps())
    expect(backend.env).toEqual({})
    expect(backend.pathPrefix).toEqual([])
    expect(await backend.pathMapping.toShell('/tmp/x')).toBe('/tmp/x')
  })
})

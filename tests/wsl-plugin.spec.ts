// tests/wsl-plugin.spec.ts — the `./wsl` entry (issue #30, ADR-0007 pure
// move from dsh-wsl-bridge, anchor dsh-v0.2.1-alpha.1-r1). Smoke suite: the
// plugin contract (name/inject/apply), the seven-tool registration, and a
// full tool execution round-trip through a fake host shell seam. The source
// repo shipped no tests; these are written against the source repo's tool-
// level behavior descriptions (its README "How it works" + tool docs).
import { describe, expect, it } from 'vitest'

import * as wslPlugin from '../src/wsl-plugin/index.js'

/** Fake shell-seam result the tools consume. */
function fakeRun(
  stdout = '',
  stderr = '',
  exitCode = 0,
  opts: { truncated?: boolean; stderrTruncated?: boolean } = {},
) {
  return {
    exitCode,
    stdout: { text: stdout, truncated: opts.truncated ?? false },
    // #39: the seam layer (`CollectedOutput`) carries the truncation flag on
    // BOTH streams symmetrically; the tool surface must not drop the stderr
    // half.
    stderr: { text: stderr, truncated: opts.stderrTruncated ?? false },
  }
}

/** Build a fake ctx: tools.register collector + a scripted shell service. */
function fakeCtx(script: (request: any) => any) {
  const registered: any[] = []
  const calls: any[] = []
  const ctx = {
    get(serviceName: string) {
      if (serviceName === 'shell') {
        return {
          resolve: (request: any) => request,
          execute: async (request: any) => {
            calls.push(request)
            const result = script(request)
            return { result: async () => result }
          },
        }
      }
      return undefined // sandboxPolicy absent by default
    },
    tools: { register: (tool: any) => registered.push(tool) },
  }
  return { ctx, registered, calls }
}

describe('./wsl entry contract (issue #30, ADR-0007)', () => {
  it('exposes the absorbed plugin contract: name, inject, apply', () => {
    expect(wslPlugin.name).toBe('dsh-wsl-bridge')
    expect(wslPlugin.inject).toEqual(['tools', 'shell', 'sandboxPolicy'])
    expect(typeof wslPlugin.apply).toBe('function')
  })

  it('registers exactly the seven win_* tools via defineTool + ctx.tools.register', () => {
    const { ctx, registered } = fakeCtx(() => fakeRun())
    wslPlugin.apply(ctx as any)
    expect(registered.map((t) => t.name)).toEqual([
      'win_ls', 'win_read', 'win_write', 'win_run', 'win_open', 'win_path', 'win_drives',
    ])
    for (const tool of registered) {
      expect(typeof tool.execute).toBe('function')
      expect(typeof tool.description).toBe('string')
      expect(tool.parameters).toBeTypeOf('object')
    }
  })
})

describe('win_* tool behavior through the fake shell seam', () => {
  it('win_path passes either form through wslpath and reports both sides', async () => {
    const { ctx, registered, calls } = fakeCtx((request) => fakeRun('C:\\Users\\me\n'))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_path')!
    const out = await tool.execute({ path: '/mnt/c/Users/me' }, { agent: { session: {} } })
    expect(calls[0].command).toBe(`wslpath -w '/mnt/c/Users/me'`)
    expect(out).toEqual({ input: '/mnt/c/Users/me', wslPath: '/mnt/c/Users/me', winPath: 'C:\\Users\\me', error: null })
  })

  it('win_ls parses long listings into entries and normalizes the path', async () => {
    const listing = 'total 4\n-rw-r--r-- 1 me me 12 2026-10-08 17:00 notes.txt\ndrwxr-xr-x 1 me me 0 2026-10-08 17:00 docs\n'
    const { ctx, registered, calls } = fakeCtx(() => fakeRun(listing))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_ls')!
    const out = await tool.execute({ path: 'C:\\Users\\me' }, {})
    expect(calls[0].command).toBe(`ls -la --time-style=long-iso '/mnt/c/Users/me'`)
    expect(out.path).toBe('/mnt/c/Users/me')
    expect(out.winPath).toBe('C:\\Users\\me')
    expect(out.entries).toEqual([
      { perms: '-rw-r--r--', size: 12, mtime: '2026-10-08 17:00', name: 'notes.txt', isDir: false },
      { perms: 'drwxr-xr-x', size: 0, mtime: '2026-10-08 17:00', name: 'docs', isDir: true },
    ])
    expect(out.error).toBeNull()
    // #33: the truncation signal is part of the shape even when nothing was
    // truncated — a small directory must be field-identical to pre-#33 plus
    // the explicit `truncated: false`.
    expect(out.truncated).toBe(false)
  })

  it('win_ls marks stdout truncation explicitly and names the escape hatch (#33)', async () => {
    // Over the seam's default 64KB cap the executor keeps only the TAIL and
    // exits 0 — pre-#33 the tool silently lost the head entries. The result
    // must carry an explicit, caller-visible truncation signal.
    const head = 'total 4\n-rw-r--r-- 1 me me 12 2026-10-08 17:00 notes.txt\n'
    const tail = '-rw-r--r-- 1 me me 1 2026-10-08 17:00 last.txt\n'
    const { ctx, registered } = fakeCtx(() => fakeRun(head + tail, '', 0, { truncated: true }))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_ls')!
    const out = await tool.execute({ path: 'C:\\Users\\me' }, {})
    expect(out.truncated).toBe(true)
    expect(out.note).toMatch(/truncat/i)
    expect(out.note).toContain('stdoutMaxBytes')
    // Error stays stderr-scoped (existing field semantics unchanged).
    expect(out.error).toBeNull()
  })

  it('win_ls forwards stdoutMaxBytes to the shell request (#33)', async () => {
    const { ctx, registered, calls } = fakeCtx(() => fakeRun(''))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_ls')!
    await tool.execute({ path: 'C:\\Users\\me', stdoutMaxBytes: 262144 }, {})
    expect(calls[0].stdoutMaxBytes).toBe(262144)
  })

  it('win_ls omits stdoutMaxBytes when the caller does not pass one (#33 default path)', async () => {
    const { ctx, registered, calls } = fakeCtx(() => fakeRun(''))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_ls')!
    await tool.execute({ path: 'C:\\Users\\me' }, {})
    expect(calls[0]).not.toHaveProperty('stdoutMaxBytes')
  })

  it('win_write base64-encodes UTF-8 content (non-Latin-1 safe) and reports byte count', async () => {
    const { ctx, registered, calls } = fakeCtx(() => fakeRun('', '', 0))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_write')!
    const out = await tool.execute({ path: 'C:\\Users\\me\\中文.txt', content: '你好' }, {})
    const cmd = calls[0].command as string
    expect(cmd).toContain(`mkdir -p '/mnt/c/Users/me'`)
    expect(cmd).toContain(`| base64 -d > '/mnt/c/Users/me/中文.txt'`)
    // '你好' is 6 UTF-8 bytes — the count comes from TextEncoder, not btoa.
    expect(out.bytes).toBe(6)
    expect(out.exitCode).toBe(0)
    expect(out.error).toBeNull()
  })

  it('win_read returns content on success and a loud error on failure', async () => {
    const { ctx, registered } = fakeCtx(() => fakeRun('line1\nline2\n'))
    wslPlugin.apply(ctx as any)
    const read = registered.find((t) => t.name === 'win_read')!
    const ok = await read.execute({ path: '/mnt/c/x.txt' }, {})
    expect(ok.content).toBe('line1\nline2\n')
    expect(ok.error).toBeNull()

    const failing = fakeCtx(() => fakeRun('', 'sed: no such file', 1))
    wslPlugin.apply(failing.ctx as any)
    const bad = failing.registered.find((t) => t.name === 'win_read')!
    const err = await bad.execute({ path: '/mnt/c/x.txt' }, {})
    expect(err.exitCode).toBe(1)
    expect(err.error).toBe('sed: no such file')
    expect(err.content).toBe('')
  })

  it('win_run (direct) executes as-is in WSL bash and forwards the seam result', async () => {
    const { ctx, registered, calls } = fakeCtx(() => ({ exitCode: 3, timedOut: false, aborted: false, stdout: { text: 'out', truncated: false }, stderr: { text: 'err', truncated: false } }))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_run')!
    const out = await tool.execute({ command: '/mnt/c/Windows/System32/ipconfig.exe /all', shell: 'direct', cwd: 'C:\\Work' }, {})
    expect(calls[0].command).toBe('/mnt/c/Windows/System32/ipconfig.exe /all')
    expect(calls[0].workdir).toBe('/mnt/c/Work')
    expect(out).toMatchObject({ shell: 'direct', exitCode: 3, stdout: 'out', stderr: 'err' })
    // #39: both truncation signals are part of the shape even when nothing
    // was cut — field-identical to pre-#39 plus the explicit `false`s.
    expect(out.stdoutTruncated).toBe(false)
    expect(out.stderrTruncated).toBe(false)
  })

  it('win_run surfaces BOTH stream truncation signals symmetrically (#39)', async () => {
    // The seam executor sets the truncated flag per stream; a large stderr
    // (e.g. a chatty build log) must be caller-visible the same way a large
    // stdout already is since #33 — same semantics, mirrored per side.
    const { ctx, registered } = fakeCtx(() => ({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdout: { text: 'ok', truncated: true },
      stderr: { text: 'warn...', truncated: true },
    }))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_run')!
    const out = await tool.execute({ command: 'make', shell: 'direct' }, {})
    expect(out.stdoutTruncated).toBe(true)
    expect(out.stderrTruncated).toBe(true)
  })

  it('run() maps every defined opt onto the request and omits undefined ones (#39)', async () => {
    // The opts→request mapping is one pass (no per-field conditional spread);
    // behavior pinned: defined fields land, absent fields stay absent.
    const { ctx, registered, calls } = fakeCtx(() => fakeRun(''))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_run')!
    const signal = new AbortController().signal
    await tool.execute({ command: 'x', shell: 'direct', timeoutMs: 5000, cwd: 'C:\\Work' }, { signal })
    expect(calls[0].timeoutMs).toBe(5000)
    expect(calls[0].workdir).toBe('/mnt/c/Work')
    expect(calls[0].signal).toBe(signal)
    expect(calls[0]).not.toHaveProperty('stdoutMaxBytes')
    expect(calls[0]).not.toHaveProperty('sandboxPolicy')
    // No opt-vs-policy confusion: an undefined opt never overwrites a resolved
    // policy and vice versa — the pick is per-field, order-independent.
    const minimal = fakeCtx(() => fakeRun(''))
    wslPlugin.apply(minimal.ctx as any)
    const bare = minimal.registered.find((t) => t.name === 'win_run')!
    await bare.execute({ command: 'x', shell: 'direct' }, {})
    expect(minimal.calls[0].timeoutMs).toBe(120000) // win_run's own default, always defined
    expect(minimal.calls[0]).not.toHaveProperty('signal')
  })

  it('win_open reports the explorer exit-code-1 note and both path forms', async () => {
    const { ctx, registered } = fakeCtx(() => fakeRun('', '', 1))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_open')!
    const out = await tool.execute({ path: 'C:\\Users' }, {})
    expect(out.winPath).toBe('C:\\Users')
    expect(out.wslPath).toBe('/mnt/c/Users')
    expect(out.note).toContain('with code 1 on success')
  })

  it('win_drives parses /mnt into drive rows, filtering non-drive entries on the JS side (#32)', async () => {
    // The shell side returns the RAW /mnt listing; drive filtering happens in
    // JS, so the emitted command never embeds a pattern (see the quoting test
    // below).
    const { ctx, registered, calls } = fakeCtx(() => fakeRun('c\nDistro\nd\nsnap\n\n'))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_drives')!
    const out = await tool.execute({}, {})
    expect(calls[0].command).toBe('ls -1 /mnt 2>/dev/null')
    expect(out.drives).toEqual([
      { drive: 'C', wslPath: '/mnt/c', winPath: 'C:\\' },
      { drive: 'D', wslPath: '/mnt/d', winPath: 'D:\\' },
    ])
  })

  it('win_drives never emits a `$` in its command — the quoting-collision class (#32)', async () => {
    // Regression guard for the #32 bug construction: the executor launches
    // `wsl.exe -d <distro> -e bash -c <command>` and wsl.exe rejoins argv into
    // a parsed command line, so any `$'` inside the command (e.g. a grep
    // pattern ending in `$`) opens ANSI-C quoting and unbalances the quotes —
    // bash dies with "unexpected EOF" and the tool returned empty drives.
    // A fake shell cannot observe that interaction; the machine lane asserts
    // the mechanism on the real seam (tests/wsl-plugin-live.spec.ts). Here we
    // pin the class itself: the command carries no `$` at all.
    const { ctx, registered, calls } = fakeCtx(() => fakeRun(''))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_drives')!
    await tool.execute({}, {})
    expect(calls[0].command).not.toContain('$')
  })
})

describe('path helpers (the plugin entry keeps its own converters — two layers, ADR-0007)', () => {
  it('internal converters pass relative/POSIX paths through unchanged (source behavior, unlike the strict backend bridge)', async () => {
    const { ctx, registered, calls } = fakeCtx(() => fakeRun(''))
    wslPlugin.apply(ctx as any)
    const tool = registered.find((t) => t.name === 'win_ls')!
    await tool.execute({ path: 'relative\\dir' }, {})
    // The plugin's simplified toWslPath passes a relative path through
    // (slashes normalized) — src/wsl-bridge.ts would throw loudly. The two
    // converters are deliberately NOT merged (pure move; ADR-0007).
    expect(calls[0].command).toBe(`ls -la --time-style=long-iso 'relative/dir'`)
  })
})

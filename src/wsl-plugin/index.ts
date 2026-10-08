/**
 * dsh-shell-host `./wsl` entry — absorbed from dsh-wsl-bridge (issue #30,
 * ADR-0007 pure move; the source module stays anchored at
 * dsh-v0.2.1-alpha.1-r1 per ADR-0005): Windows access tools for WSL agents.
 * Installed as a DSH bundle row (`dsh plugin --profile <name> add`); it is a
 * PLUGIN-LAYER entry (defineTool + ctx.tools, depends on
 * @deepseek-ai/dsh-tools) — categorically different from the executor
 * entries `./host`/`./pty`/`./remote`: it registers model tools, not
 * execution backends (ADR-0007 "Entry form differences").
 *
 * Registers win_ls / win_read / win_write / win_run / win_open / win_path /
 * win_drives as model tools via the official defineTool + ctx.tools.register.
 * Everything runs through the host `shell` service with the calling
 * session's sandbox policy — the same seam the built-in bash tool uses.
 *
 * Two layers, deliberately not merged (ADR-0007 redundancy check): the
 * plugin entry's internal toWslPath/toWinPath helpers are its own simplified
 * converters (relative paths pass through, backslashes normalized); the
 * in-backend `src/wsl-bridge.ts` (ADR-0003 decision 5) is the wsl backend's
 * strict cross-VM mapping layer (relative paths throw loudly, `\\wsl$` UNC
 * handled). The plugin entry keeps its own helpers so tool behavior is
 * unchanged from the source repo — adopting the strict mapping here would
 * change tool behavior, which a pure move must not.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'dsh-wsl-bridge'
const inject = ['tools', 'shell', 'sandboxPolicy']

/** The context slice the plugin consumes (duck-typed seam, source JS shape). */
interface WslCtx {
  get: (name: string) => any
  tools: { register: (tool: unknown) => void }
}

/** A shell seam result slice the tools read (duck-typed). */
interface ShellRun {
  exitCode: number
  timedOut?: boolean
  aborted?: boolean
  stdout: { text: string; truncated?: boolean }
  // #39: the seam (`CollectedOutput`) carries the truncation flag on BOTH
  // streams symmetrically — the duck-type slice mirrors it.
  stderr: { text: string; truncated?: boolean }
}

/** UTF-8-safe base64: Node's b64() rejects non-Latin-1 (Chinese file content
 * would throw "Invalid character"). Encode via TextEncoder + bytes first. */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(String(s))
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

function shq(s: unknown): string {
  return `'` + String(s).replaceAll(`'`, `'\\''`) + `'`
}

function toWslPath(p: unknown): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p))
  if (m === null) return String(p).replaceAll('\\', '/')
  const rest = m[2]!.replaceAll('\\', '/')
  return '/mnt/' + m[1]!.toLowerCase() + (rest !== '' ? '/' + rest : '')
}

function toWinPath(p: unknown): string {
  const m = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(String(p))
  if (m === null) return String(p).replaceAll('/', '\\')
  return m[1]!.toUpperCase() + ':\\' + m[2]!.replaceAll('/', '\\')
}

/** Tool-exec context slice carried into run() (source JS shape, duck-typed). */
interface WslExec {
  agent?: { session?: unknown } | null
  signal?: AbortSignal
}

/** Collect only the defined fields of a candidate mapping — the shell request
 * must carry absent keys, not undefined-valued ones (#39: one pass replaces
 * the per-field `...(x !== undefined ? {x} : {})` clump; field set and
 * semantics unchanged). */
function pickDefined<T extends Record<string, unknown>>(mapping: T): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(mapping) as Array<keyof T>) {
    if (mapping[key] !== undefined) out[key] = mapping[key]
  }
  return out
}

/** Execute through the host shell seam (foreground = await the handle's
 * result() projection; no run() on the alpha.1 seam, dsh-shell-host #17). */
async function run(ctx: WslCtx, command: string, exec: WslExec, opts: { timeoutMs?: number; workdir?: string; stdoutMaxBytes?: number } = {}): Promise<ShellRun> {
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const policy = sandboxPolicy === undefined ? undefined : sandboxPolicy.resolve(
    exec.agent !== undefined ? { session: (exec.agent as { session?: unknown }).session } : {}
  )
  const shell = ctx.get('shell')
  const request = {
    command,
    ...pickDefined({
      timeoutMs: opts.timeoutMs,
      workdir: opts.workdir,
      // #33: per-request stdout cap override — the seam applies its own default
      // (64KB) when omitted; overflow keeps only the TAIL and sets
      // `stdout.truncated` on the result.
      stdoutMaxBytes: opts.stdoutMaxBytes,
      sandboxPolicy: policy,
      signal: exec.signal,
    }),
  }
  const handle = await shell.execute(shell.resolve(request))
  return handle.result()
}

/** Shared render for structured tool output: one indented-JSON text block. */
const renderJson = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]

/** Register the seven win_* tools against the host shell seam. */
function registerTools(ctx: WslCtx): void {
  const tools = [
    {
      name: 'win_ls',
      // #33: large directories overflow the executor's default 64KB stdout
      // cap (the tail is kept, the head dropped) — the result now carries an
      // explicit `truncated` signal plus a `note`, and `stdoutMaxBytes`
      // raises the cap so the caller can fetch the complete listing.
      description: 'List a Windows-side directory from inside WSL. Accepts either a Windows path (C:\\Users\\me) or a WSL mount path (/mnt/c/Users/me); both are normalized automatically. Returns parsed entries plus the raw `ls -la` listing. Very large directories may hit the executor\'s stdout cap: check `truncated` in the result, and pass stdoutMaxBytes (bytes, e.g. 1048576) to raise the cap and get the complete listing.',
      parameters: {
        path: { type: 'string', required: true, description: 'Directory to list, e.g. C:\\Users\\me or /mnt/c/Users/me' },
        long: { type: 'boolean', description: 'Detailed listing with sizes/timestamps (default true)' },
        stdoutMaxBytes: { type: 'integer', description: 'Per-call stdout byte cap override (default: executor default, 64KB). Raise it (e.g. 1048576) when listing a very large directory; `truncated: true` in the result means the listing was cut.' },
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { path: string; long?: boolean; stdoutMaxBytes?: number }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal }) {
        const p = toWslPath(args.path)
        const long = args.long !== false
        const cmd = (long ? 'ls -la --time-style=long-iso ' : 'ls -1 ') + shq(p)
        const r = await run(ctx, cmd, exec, { timeoutMs: 20000, stdoutMaxBytes: args.stdoutMaxBytes })
        const entries: Array<Record<string, unknown>> = []
        if (long) {
          for (const line of r.stdout.text.split('\n')) {
            const m = /^([dlbcps-][rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/.exec(line)
            if (m) entries.push({ perms: m[1], size: Number(m[2]), mtime: m[3] + ' ' + m[4], name: m[5], isDir: m[1]![0] === 'd' })
          }
        } else {
          for (const line of r.stdout.text.split('\n')) {
            const nm = line.trim()
            if (nm !== '' && nm !== 'total') entries.push({ name: nm })
          }
        }
        // #33: truncation is caller-visible. The executor keeps only the
        // stdout TAIL past the cap, so head entries vanish — pre-#33 that
        // happened silently (exitCode 0, error null). Now the result marks
        // it explicitly and names the escape hatch. Small-directory output
        // is field-identical to pre-#33 plus `truncated: false`.
        const truncated = r.stdout.truncated === true
        const note = truncated
          ? 'stdout truncated by the executor cap; the listing is incomplete (head entries dropped). Pass a larger stdoutMaxBytes (bytes) or list a subdirectory to get the full listing.'
          : null
        return {
          path: p, winPath: toWinPath(p), exitCode: r.exitCode, entries, truncated, note,
          raw: r.stdout.text,
          error: r.stderr.text.trim() !== '' ? r.stderr.text.trim() : null,
        }
      },
    },
    {
      name: 'win_read',
      description: 'Read a Windows-side text file from inside WSL. Accepts Windows or WSL paths. Optional 1-based line offset/limit, and GBK encoding conversion for files saved with the legacy Chinese codepage.',
      parameters: {
        path: { type: 'string', required: true, description: 'File to read, e.g. C:\\Users\\me\\notes.txt or /mnt/c/Users/me/notes.txt' },
        offset: { type: 'integer', description: '1-based first line to return (default 1)' },
        limit: { type: 'integer', description: 'Maximum number of lines to return' },
        encoding: { type: 'string', enum: ['utf8', 'gbk'], description: 'utf8 (default) or gbk (converts from GBK via iconv)' },
      },
      output: { schema: { type: 'json' }, render: (_a: unknown, v: any) => [{ type: 'text' as const, text: typeof v.content === 'string' ? v.content : JSON.stringify(v, null, 2) }] as any },
      async execute(args: { path: string; offset?: number; limit?: number; encoding?: 'utf8' | 'gbk' }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal }) {
        const p = toWslPath(args.path)
        const start = args.offset || 1
        const range = args.limit !== undefined ? `${start},${start + args.limit - 1}p` : `${start},$p`
        const base = `sed -n ${shq(range)} ${shq(p)}`
        const cmd = args.encoding === 'gbk'
          ? `${base} | iconv -f GBK -t UTF-8 2>/dev/null || ${base}`
          : base
        const r = await run(ctx, cmd, exec, { timeoutMs: 30000 })
        if (r.exitCode !== 0) {
          return { path: p, winPath: toWinPath(p), exitCode: r.exitCode, content: '', error: r.stderr.text.trim() !== '' ? r.stderr.text.trim() : 'read failed' }
        }
        return { path: p, winPath: toWinPath(p), exitCode: r.exitCode, content: r.stdout.text, error: null }
      },
    },
    {
      name: 'win_write',
      description: 'Write UTF-8 text to a Windows-side file from inside WSL (creates missing parent directories). Accepts Windows or WSL paths. Overwrites by default; set append=true to append.',
      parameters: {
        path: { type: 'string', required: true, description: 'File to write, e.g. C:\\Users\\me\\out.txt or /mnt/c/Users/me/out.txt' },
        content: { type: 'string', required: true, description: 'Full text content to write' },
        append: { type: 'boolean', description: 'Append instead of overwrite' },
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { path: string; content?: string; append?: boolean }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal }) {
        const p = toWslPath(args.path)
        const enc = b64(String(args.content ?? ''))
        const slash = p.lastIndexOf('/')
        const dir = slash > 0 ? p.slice(0, slash) : '/'
        const op = args.append === true ? '>>' : '>'
        const cmd = `mkdir -p ${shq(dir)} && printf '%s' ${enc} | base64 -d ${op} ${shq(p)}`
        const r = await run(ctx, cmd, exec, { timeoutMs: 20000 })
        return {
          path: p, winPath: toWinPath(p), exitCode: r.exitCode,
          bytes: new TextEncoder().encode(String(args.content ?? '')).length,
          error: r.exitCode !== 0 ? (r.stderr.text.trim() !== '' ? r.stderr.text.trim() : 'write failed') : null,
        }
      },
    },
    {
      name: 'win_run',
      description: 'Run a Windows program or command line and capture its output. shell="cmd" wraps with cmd.exe /c (UTF-8 codepage first); shell="powershell" writes a temp .ps1 (UTF-8 BOM, console output forced to UTF-8) and runs via powershell.exe -File; shell="direct" executes the string as-is in WSL bash (WSL interop for .exe). Windows paths for cwd converted automatically; cmd/powershell default to C:\\ when no cwd given. Either stream past the executor cap is tail-kept: stdoutTruncated/stderrTruncated in the result mark it (#39).',
      parameters: {
        command: { type: 'string', required: true, description: 'Command line to run, e.g. "dir C:\\Users" (cmd), "Get-Process explorer" (powershell), or "/mnt/c/Windows/System32/ipconfig.exe /all" (direct)' },
        shell: { type: 'string', enum: ['cmd', 'powershell', 'direct'], description: 'How to execute: cmd (default) | powershell | direct' },
        cwd: { type: 'string', description: 'Working directory on the Windows side (Windows or WSL path)' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' },
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { command: string; shell?: 'cmd' | 'powershell' | 'direct'; cwd?: string; timeoutMs?: number }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal }) {
        const timeoutMs = args.timeoutMs !== undefined ? args.timeoutMs : 120000
        const workdir = args.cwd !== undefined ? toWslPath(args.cwd) : '/mnt/c'
        const rand = Math.random().toString(36).slice(2, 10)
        const command = String(args.command)
        if (args.shell === 'powershell') {
          const ps1 = `/mnt/c/Windows/Temp/dsh_${rand}.ps1`
          const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + command
          const enc = b64('\ufeff' + script)
          await run(ctx, `printf '%s' ${enc} | base64 -d > ${shq(ps1)}`, exec, { timeoutMs: 10000 })
          const r = await run(ctx, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${shq(toWinPath(ps1))}`, exec, { timeoutMs, workdir })
          await run(ctx, `rm -f ${shq(ps1)}`, exec, { timeoutMs: 5000 }).catch(() => {})
          return { shell: 'powershell', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text,
            // #39: both truncation signals caller-visible, symmetric with the
            // #33 stdout semantics (executor keeps the TAIL past the cap).
            stdoutTruncated: r.stdout.truncated === true, stderrTruncated: r.stderr.truncated === true }
        }
        if (args.shell === 'direct') {
          const r = await run(ctx, command, exec, { timeoutMs, workdir })
          return { shell: 'direct', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text,
            stdoutTruncated: r.stdout.truncated === true, stderrTruncated: r.stderr.truncated === true } // #39
        }
        const bat = `/mnt/c/Windows/Temp/dsh_${rand}.bat`
        const enc = b64('@echo off\r\nchcp 65001 >nul\r\n' + command + '\r\n')
        await run(ctx, `printf '%s' ${enc} | base64 -d > ${shq(bat)}`, exec, { timeoutMs: 10000 })
        const r = await run(ctx, `cmd.exe /c ${shq(toWinPath(bat))}`, exec, { timeoutMs, workdir })
        await run(ctx, `rm -f ${shq(bat)}`, exec, { timeoutMs: 5000 }).catch(() => {})
        return { shell: 'cmd', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text,
          stdoutTruncated: r.stdout.truncated === true, stderrTruncated: r.stderr.truncated === true } // #39
      },
    },
    {
      name: 'win_open',
      description: 'Open a Windows-side file or folder with its default Windows handler (explorer.exe). Explorer returns immediately with exit code 1 even on success.',
      parameters: {
        path: { type: 'string', required: true, description: 'File or folder to open' },
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { path: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal }) {
        const win = toWinPath(args.path)
        const r = await run(ctx, `explorer.exe ${shq(win)}`, exec, { timeoutMs: 15000 })
        return { winPath: win, wslPath: toWslPath(args.path), exitCode: r.exitCode, stdout: r.stdout.text, stderr: r.stderr.text, note: 'explorer.exe exits with code 1 on success; ignore nonzero exit if the app opened.' }
      },
    },
    {
      name: 'win_path',
      description: 'Convert a path between Windows (C:\\...) and WSL (/mnt/c/...) forms using wslpath. Pass either form; returns both.',
      parameters: {
        path: { type: 'string', required: true, description: 'Path to convert' },
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { path: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal }) {
        const p = String(args.path)
        const isWsl = p.startsWith('/')
        const flag = isWsl ? '-w' : '-u'
        const r = await run(ctx, `wslpath ${flag} ${shq(p)}`, exec, { timeoutMs: 10000 })
        const converted = r.exitCode === 0 ? r.stdout.text.trim() : null
        return { input: p, wslPath: isWsl ? p : converted, winPath: isWsl ? converted : p, error: r.exitCode !== 0 ? (r.stderr.text.trim() !== '' ? r.stderr.text.trim() : 'wslpath failed') : null }
      },
    },
    {
      name: 'win_drives',
      description: 'List the Windows drives currently mounted in WSL (e.g. c -> /mnt/c). Useful before accessing Windows paths.',
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(_args: Record<string, never>, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal }) {
        // #32: no grep — a pattern ending in `$` collides with the executor's
        // bash -c quoting (`$'` opens ANSI-C quoting, "unexpected EOF") and
        // the tool returned empty drives on the real seam. The listing comes
        // back raw; drive filtering happens here, in JS.
        const r = await run(ctx, `ls -1 /mnt 2>/dev/null`, exec, { timeoutMs: 10000 })
        const drives = r.stdout.text.split('\n').map((s) => s.trim())
          .filter((d) => /^[a-z]$/.test(d))
          .map((d) => ({ drive: d.toUpperCase(), wslPath: '/mnt/' + d, winPath: d.toUpperCase() + ':\\' }))
        return { drives, raw: r.stdout.text }
      },
    },
  ]

  for (const tool of tools) {
    ctx.tools.register(defineTool(tool as any))
  }
}

/** Plugin entry: register the win_* tool surface against the host shell seam. */
export function apply(ctx: WslCtx): void {
  registerTools(ctx)
}

export { inject, name }

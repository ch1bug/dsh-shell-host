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
 * Everything runs through the host `shell` service (provided by the platform
 * shell executors — ADR-0013: this package provides no executor) with the
 * calling session's sandbox policy, resolved ONCE per tool call.
 *
 * #102: the win_* family is the `./wsl` execution face, so it now carries the
 * host permission model too — the resolved policy rides every shell request
 * (the executor enforces it), a policy denial surfaces the official
 * `[sandbox: …]` marker plus the same-turn escalation hint, and
 * `sandbox_permissions` + `justification` route a one-shot wider retry through
 * the official approval service. A deployment missing `sandboxPolicy` /
 * `approval` refuses to execute instead of running unconstrained.
 *
 * Self-contained path helpers (ADR-0013 note): the entry's internal
 * toWslPath/toWinPath converters are its own simplified converters (relative
 * paths pass through, backslashes normalized). [History: ADR-0007 kept them
 * separate from the wsl backend's strict cross-VM mapping layer
 * (`src/wsl-bridge.ts`, deleted with the executor world) so tool behavior
 * stayed unchanged from the source repo — a pure move must not change
 * behavior.]
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  escalationHintMarker,
  resolvePolicyWithEscalation,
  sandboxDenialMarker,
  sandboxPermissionParameters,
  sessionOf,
  type SandboxExecutionPolicyLike,
} from '../permission-gate.ts'

const name = 'dsh-wsl-bridge'
// #102: `approval` joined the dependency set — the win_* escalation face asks it
// (and execution fails closed without it). `shell`/`sandboxPolicy` were already
// required by the policy downlink that predates this ticket.
const inject = ['tools', 'shell', 'sandboxPolicy', 'approval']

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
  /** #102: the approval audit trail attaches to this tool call. */
  callId?: string
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

/**
 * #102: resolve the policy of ONE tool execution — the standing session
 * policy, or (when the caller asked to retry wider) the mode the official
 * approval service granted for this call. Resolved ONCE per tool call, so a
 * multi-command tool (win_run writes a temp script, then executes it) asks the
 * user at most once instead of prompting per internal shell call.
 */
function resolveToolPolicy(
  ctx: WslCtx,
  exec: WslExec,
  opts: { toolName: string; sandboxPermissions?: string; justification?: string },
): Promise<SandboxExecutionPolicyLike> {
  return resolvePolicyWithEscalation(ctx, {
    toolName: opts.toolName,
    agent: exec.agent,
    session: sessionOf(exec.agent),
    callId: exec.callId,
    signal: exec.signal,
    sandboxPermissions: opts.sandboxPermissions,
    justification: opts.justification,
    // The win_* family is the fs-ish/operation family (upstream's noun).
    subject: 'operation',
  }).then((resolution) => resolution.policy)
}

/** The denial markers a confining shell executor appends to its output
 * (`[sandbox: file access denied under <mode> mode]`), derived from the
 * official marker so the text cannot drift. */
const DENIAL_MARKERS = [sandboxDenialMarker('read-only'), sandboxDenialMarker('workspace-write')]

/**
 * #102: give the model the SAME-TURN escalation hint when the executor
 * reported a policy denial. The marker is appended to the command output by
 * the sandboxing executor (it may land on either stream), so the hint rides
 * the stderr side — every win_* result already surfaces stderr as its `error`
 * (or the raw stream), which is how a denial reaches the model.
 */
function withEscalationHint(run: ShellRun): ShellRun {
  const seen = DENIAL_MARKERS.some((marker) => run.stdout.text.includes(marker) || run.stderr.text.includes(marker))
  if (!seen) return run
  const hint = escalationHintMarker('operation')
  if (run.stderr.text.includes(hint)) return run
  const prefix = run.stderr.text === '' || run.stderr.text.endsWith('\n') ? '' : '\n'
  return { ...run, stderr: { ...run.stderr, text: `${run.stderr.text}${prefix}${hint}` } }
}

/** Execute through the host shell seam (foreground = await the handle's
 * result() projection; no run() on the alpha.1 seam, dsh-shell-host #17). */
async function run(ctx: WslCtx, command: string, exec: WslExec, opts: { policy: SandboxExecutionPolicyLike; timeoutMs?: number; workdir?: string; stdoutMaxBytes?: number; stderrMaxBytes?: number }): Promise<ShellRun> {
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
      // #42: the stderr-side twin of the stdout cap override — same default,
      // same tail-keeping truncation with `stderr.truncated` on the result.
      stderrMaxBytes: opts.stderrMaxBytes,
      // #102: the RESOLVED per-call policy rides the request (the seam
      // enforces it); `resolvePolicyWithEscalation` already failed closed when
      // the service is missing or the approval was not granted.
      sandboxPolicy: opts.policy,
      signal: exec.signal,
    }),
  }
  const handle = await shell.execute(shell.resolve(request))
  return withEscalationHint(await handle.result())
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
        ...sandboxPermissionParameters('operation'),
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { path: string; long?: boolean; stdoutMaxBytes?: number; sandbox_permissions?: string; justification?: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal; callId?: string }) {
        const policy = await resolveToolPolicy(ctx, exec, { toolName: 'win_ls', sandboxPermissions: args.sandbox_permissions, justification: args.justification })
        const p = toWslPath(args.path)
        const long = args.long !== false
        const cmd = (long ? 'ls -la --time-style=long-iso ' : 'ls -1 ') + shq(p)
        const r = await run(ctx, cmd, exec, { timeoutMs: 60000, stdoutMaxBytes: args.stdoutMaxBytes, policy })
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
        ...sandboxPermissionParameters('operation'),
      },
      output: { schema: { type: 'json' }, render: (_a: unknown, v: any) => [{ type: 'text' as const, text: typeof v.content === 'string' ? v.content : JSON.stringify(v, null, 2) }] as any },
      async execute(args: { path: string; offset?: number; limit?: number; encoding?: 'utf8' | 'gbk'; sandbox_permissions?: string; justification?: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal; callId?: string }) {
        const policy = await resolveToolPolicy(ctx, exec, { toolName: 'win_read', sandboxPermissions: args.sandbox_permissions, justification: args.justification })
        const p = toWslPath(args.path)
        const start = args.offset || 1
        const range = args.limit !== undefined ? `${start},${start + args.limit - 1}p` : `${start},$p`
        const base = `sed -n ${shq(range)} ${shq(p)}`
        const cmd = args.encoding === 'gbk'
          ? `${base} | iconv -f GBK -t UTF-8 2>/dev/null || ${base}`
          : base
        const r = await run(ctx, cmd, exec, { timeoutMs: 30000, policy })
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
        ...sandboxPermissionParameters('operation'),
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { path: string; content?: string; append?: boolean; sandbox_permissions?: string; justification?: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal; callId?: string }) {
        const policy = await resolveToolPolicy(ctx, exec, { toolName: 'win_write', sandboxPermissions: args.sandbox_permissions, justification: args.justification })
        const p = toWslPath(args.path)
        const enc = b64(String(args.content ?? ''))
        const slash = p.lastIndexOf('/')
        const dir = slash > 0 ? p.slice(0, slash) : '/'
        const op = args.append === true ? '>>' : '>'
        const cmd = `mkdir -p ${shq(dir)} && printf '%s' ${enc} | base64 -d ${op} ${shq(p)}`
        const r = await run(ctx, cmd, exec, { timeoutMs: 20000, policy })
        return {
          path: p, winPath: toWinPath(p), exitCode: r.exitCode,
          bytes: new TextEncoder().encode(String(args.content ?? '')).length,
          error: r.exitCode !== 0 ? (r.stderr.text.trim() !== '' ? r.stderr.text.trim() : 'write failed') : null,
        }
      },
    },
    {
      name: 'win_run',
      description: 'Run a Windows program or command line and capture its output. shell="cmd" wraps with cmd.exe /c (UTF-8 codepage first); shell="powershell" writes a temp .ps1 (UTF-8 BOM, console output forced to UTF-8) and runs via powershell.exe -File; shell="direct" executes the string as-is in WSL bash (WSL interop for .exe). Windows paths for cwd converted automatically; cmd/powershell default to C:\\ when no cwd given. Either stream past the executor cap is tail-kept: stdoutTruncated/stderrTruncated in the result mark it (#39). Raise the cap per side with stdoutMaxBytes/stderrMaxBytes (bytes).',
      parameters: {
        command: { type: 'string', required: true, description: 'Command line to run, e.g. "dir C:\\Users" (cmd), "Get-Process explorer" (powershell), or "/mnt/c/Windows/System32/ipconfig.exe /all" (direct)' },
        shell: { type: 'string', enum: ['cmd', 'powershell', 'direct'], description: 'How to execute: cmd (default) | powershell | direct' },
        cwd: { type: 'string', description: 'Working directory on the Windows side (Windows or WSL path)' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' },
        stdoutMaxBytes: { type: 'integer', description: 'Per-call stdout byte cap override (default: executor default, 64KB). Raise it when a command emits more; stdoutTruncated: true means stdout was cut.' },
        stderrMaxBytes: { type: 'integer', description: 'Per-call stderr byte cap override (default: executor default, 64KB). Raise it when a command writes a lot to stderr (e.g. build logs); stderrTruncated: true means stderr was cut.' },
        ...sandboxPermissionParameters('operation'),
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { command: string; shell?: 'cmd' | 'powershell' | 'direct'; cwd?: string; timeoutMs?: number; stdoutMaxBytes?: number; stderrMaxBytes?: number; sandbox_permissions?: string; justification?: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal; callId?: string }) {
        // One policy resolution per tool call: the temp-script write below is an
        // internal PREPARATION step, not a second user-visible ask.
        const policy = await resolveToolPolicy(ctx, exec, { toolName: 'win_run', sandboxPermissions: args.sandbox_permissions, justification: args.justification })
        const timeoutMs = args.timeoutMs !== undefined ? args.timeoutMs : 120000
        const workdir = args.cwd !== undefined ? toWslPath(args.cwd) : '/mnt/c'
        const rand = Math.random().toString(36).slice(2, 10)
        const command = String(args.command)
        if (args.shell === 'powershell') {
          const ps1 = `/mnt/c/Windows/Temp/dsh_${rand}.ps1`
          const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + command
          const enc = b64('\ufeff' + script)
          await run(ctx, `printf '%s' ${enc} | base64 -d > ${shq(ps1)}`, exec, { timeoutMs: 10000, policy })
          const r = await run(ctx, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${shq(toWinPath(ps1))}`, exec, { timeoutMs, workdir, stdoutMaxBytes: args.stdoutMaxBytes, stderrMaxBytes: args.stderrMaxBytes, policy })
          await run(ctx, `rm -f ${shq(ps1)}`, exec, { timeoutMs: 5000, policy }).catch(() => {})
          return { shell: 'powershell', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text,
            // #39: both truncation signals caller-visible, symmetric with the
            // #33 stdout semantics (executor keeps the TAIL past the cap).
            stdoutTruncated: r.stdout.truncated === true, stderrTruncated: r.stderr.truncated === true }
        }
        if (args.shell === 'direct') {
          const r = await run(ctx, command, exec, { timeoutMs, workdir, stdoutMaxBytes: args.stdoutMaxBytes, stderrMaxBytes: args.stderrMaxBytes, policy })
          return { shell: 'direct', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text,
            stdoutTruncated: r.stdout.truncated === true, stderrTruncated: r.stderr.truncated === true } // #39
        }
        const bat = `/mnt/c/Windows/Temp/dsh_${rand}.bat`
        const enc = b64('@echo off\r\nchcp 65001 >nul\r\n' + command + '\r\n')
        await run(ctx, `printf '%s' ${enc} | base64 -d > ${shq(bat)}`, exec, { timeoutMs: 10000, policy })
        const r = await run(ctx, `cmd.exe /c ${shq(toWinPath(bat))}`, exec, { timeoutMs, workdir, stdoutMaxBytes: args.stdoutMaxBytes, stderrMaxBytes: args.stderrMaxBytes, policy })
        await run(ctx, `rm -f ${shq(bat)}`, exec, { timeoutMs: 5000, policy }).catch(() => {})
        return { shell: 'cmd', exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted, stdout: r.stdout.text, stderr: r.stderr.text,
          stdoutTruncated: r.stdout.truncated === true, stderrTruncated: r.stderr.truncated === true } // #39
      },
    },
    {
      name: 'win_open',
      description: 'Open a Windows-side file or folder with its default Windows handler (explorer.exe). Explorer returns immediately with exit code 1 even on success.',
      parameters: {
        path: { type: 'string', required: true, description: 'File or folder to open' },
        ...sandboxPermissionParameters('operation'),
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { path: string; sandbox_permissions?: string; justification?: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal; callId?: string }) {
        const policy = await resolveToolPolicy(ctx, exec, { toolName: 'win_open', sandboxPermissions: args.sandbox_permissions, justification: args.justification })
        const win = toWinPath(args.path)
        const r = await run(ctx, `explorer.exe ${shq(win)}`, exec, { timeoutMs: 15000, policy })
        return { winPath: win, wslPath: toWslPath(args.path), exitCode: r.exitCode, stdout: r.stdout.text, stderr: r.stderr.text, note: 'explorer.exe exits with code 1 on success; ignore nonzero exit if the app opened.' }
      },
    },
    {
      name: 'win_path',
      description: 'Convert a path between Windows (C:\\...) and WSL (/mnt/c/...) forms using wslpath. Pass either form; returns both.',
      parameters: {
        path: { type: 'string', required: true, description: 'Path to convert' },
        ...sandboxPermissionParameters('operation'),
      },
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(args: { path: string; sandbox_permissions?: string; justification?: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal; callId?: string }) {
        const policy = await resolveToolPolicy(ctx, exec, { toolName: 'win_path', sandboxPermissions: args.sandbox_permissions, justification: args.justification })
        const p = String(args.path)
        const isWsl = p.startsWith('/')
        const flag = isWsl ? '-w' : '-u'
        const r = await run(ctx, `wslpath ${flag} ${shq(p)}`, exec, { timeoutMs: 10000, policy })
        const converted = r.exitCode === 0 ? r.stdout.text.trim() : null
        return { input: p, wslPath: isWsl ? p : converted, winPath: isWsl ? converted : p, error: r.exitCode !== 0 ? (r.stderr.text.trim() !== '' ? r.stderr.text.trim() : 'wslpath failed') : null }
      },
    },
    {
      name: 'win_drives',
      description: 'List the Windows drives currently mounted in WSL (e.g. c -> /mnt/c). Useful before accessing Windows paths.',
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson as any },
      async execute(_args: { sandbox_permissions?: string; justification?: string }, exec: { agent?: { session?: unknown } | null; signal?: AbortSignal; callId?: string }) {
        const policy = await resolveToolPolicy(ctx, exec, { toolName: 'win_drives', sandboxPermissions: _args.sandbox_permissions, justification: _args.justification })
        // #32: no grep — a pattern ending in `$` collides with the executor's
        // bash -c quoting (`$'` opens ANSI-C quoting, "unexpected EOF") and
        // the tool returned empty drives on the real seam. The listing comes
        // back raw; drive filtering happens here, in JS.
        const r = await run(ctx, `ls -1 /mnt 2>/dev/null`, exec, { timeoutMs: 10000, policy })
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

/**
 * Host-only fork of `@deepseek-ai/dsh-tool-pwsh` (issue #63, the A route —
 * human decision 2026-10-10, same posture as the permission-presets fork,
 * ADR-0002): the upstream tool's executor looks up a bare `pwsh` and silently
 * falls back to bash when PowerShell is absent, so the `pwsh` tool on a
 * PowerShell-less Windows machine runs BASH. This fork registers the SAME
 * tool name (`pwsh`, defineTool + ctx.tools — the plugin-layer entry form,
 * ADR-0007) so the loader's same-id later row (`tool-pwsh` in
 * cordis.patch.yml) replaces the platform row, and fixes exactly the one
 * broken dimension: executable resolution — the ordered
 * `pwsh.exe → powershell.exe` probe (`pwshProbedLocations` + `spawnableExists`,
 * the same candidate list the backends pwsh descriptor uses), with a loud
 * failure naming every probe point when both are absent. With only Windows
 * PowerShell 5.1 present the tool executes PowerShell syntax normally through
 * `powershell.exe -Command` (the machine lane proves the fallback live).
 *
 * One-shot execution rides `ctx.subprocess` directly (subprocess-context.ts —
 * a one-shot command is not a PTY-world problem and must NOT self-host
 * node-pty); the `-NoLogo -NoProfile -NonInteractive -Command` argv and the
 * UTF-8 output preamble mirror the backends pwsh descriptor (#3, D7 phase
 * 1.5) — that descriptor stays untouched: it is the executor layer's seam, a
 * different plane this fork never reads (ADR-0007 "Entry form differences").
 *
 * Scope parity is deliberately NARROW: foreground one-shot execution with a
 * kill-on-timeout deadline, bounded output collection with spill notes, and
 * the bash-tool rendering story (stdout, marked [stderr], exit-status
 * markers; non-zero exits reported, not errored). No background jobs, no
 * sandbox escalation surface, no systemPrompt section — those belong to the
 * platform tool's own surface and are re-introduced only when a ticket needs
 * them. Drift policy: re-diff against upstream
 * packages/shell/tool-pwsh on every DSH bump; upstream PR explicitly NOT
 * pursued (route B reserved for the maintainer's call).
 *
 * @module dsh-shell-host/pwsh
 */

import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { pwshProbedLocations, spawnableExists } from './detect.ts'
import { clampTimeout, deadline, timeoutOf } from './timeout.ts'
import { ENV_OVERRIDES } from './index.ts'
import type { CollectedOutput, SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from './types.ts'

// The module name mirrors upstream's (packages/shell/tool-pwsh exports the
// same): cosmetic identity only — the loader row id (cordis.patch.yml's
// `tool-pwsh`) owns the settings namespace and the takeover, the
// permission-presets precedent — but a mirrored name keeps any name-keyed
// surface (logs, diagnostics) reading identically to the row it replaces.
const name = 'tool-pwsh'
// The spec's verbatim export list: tools only. The subprocess service is
// fetched lazily via ctx.get() at execution time — a one-shot command is not
// a mount-time dependency (the service must merely be composed alongside).
const inject = ['tools']

/** Resolved runtime budgets (plain values — apply() defaults the schema's
 * volatile fields, the same resolveConfig posture as the ./terminal entry). */
export interface PwshToolConfig {
  /** Default foreground timeout in milliseconds. */
  timeoutMs: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes: number
  /** SIGTERM→SIGKILL grace period delegated to the subprocess service. */
  graceMs: number
}

// The budget defaults, single-sourced (the ./terminal resolveConfig posture):
// the schema's defaults and apply()'s fallbacks read the same constants.
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_BYTES = 64_000
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024
const DEFAULT_GRACE_MS = 3_000

const Config = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS).volatile(),
  maxTimeoutMs: z.number().default(DEFAULT_MAX_TIMEOUT_MS).volatile(),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES).volatile(),
  maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES).volatile(),
  graceMs: z.number().default(DEFAULT_GRACE_MS).volatile(),
})

/** Injectable probe dependencies (the descriptor.spec detect-injection
 * pattern): existence, PATH, and the well-known-root env default to the real
 * machine. */
export interface PwshToolDeps {
  exists?: (candidate: string) => boolean
  path?: string
  env?: NodeJS.ProcessEnv
}

/**
 * UTF-8 output pinning prepended to every one-shot command — the SAME
 * statement text as the backends pwsh descriptor's `ENCODING_PREAMBLE`
 * (surveyed from the upstream `pwsh-local` executor): the subprocess
 * collector decodes output as UTF-8, and Windows PowerShell 5.1 — the
 * last-resort fallback this fork exists for — writes the console/OEM code
 * page by default. Statements ride line 1 after `; ` separators so PowerShell
 * error line numbers stay accurate. Duplicated, not imported: backends.ts is
 * the executor layer and must stay untouched by this fork (red line).
 */
const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** One-shot argv prefix (the backends pwsh descriptor's oneShot template sans the command slot). */
const ONESHOT_ARGV_PREFIX = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] as const

/**
 * Resolve the first EXISTING PowerShell candidate (ordered
 * `pwsh.exe → powershell.exe`), or fail loudly naming every probe point —
 * the detection posture inherited from the backends descriptor: never a
 * silent bare-name spawn, never a bash fallback (#63).
 * @param deps - injected probe facts (tests); defaults to the real machine.
 * @returns the resolved absolute path.
 * @throws Error enumerating every probed location when none exists.
 */
export function resolvePwshExecutable(deps: PwshToolDeps = {}): string {
  const probed = pwshProbedLocations(deps.path, deps.env)
  const exists = deps.exists ?? spawnableExists
  const hit = probed.find(candidate => exists(candidate))
  if (hit === undefined) {
    throw new Error(
      `pwsh: no PowerShell found; install PowerShell 7 or use a bash/MSYS2 surface instead. `
      + `Probed: ${probed.join(', ')}`,
    )
  }
  return hit
}

/**
 * Resolve an explicit workdir first, making a relative one session-workspace-
 * relative; otherwise the session header cwd, then process.cwd() — the
 * upstream tool's workdir semantics, kept verbatim.
 */
function resolveWorkdir(modelWorkdir: string | undefined, exec: { agent?: unknown } | undefined): string {
  const headerCwd = (exec?.agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd as string | undefined
  if (modelWorkdir === undefined) return headerCwd ?? process.cwd()
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir)
  return modelWorkdir
}

/** Validate the tool args (upstream's posture: fail before anything executes). */
function validatePwshArgs(args: { command: string; description: string; timeoutMs?: number }): void {
  if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
}

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then the timeout/signal/exit markers — the bash-tool
 * rendering story (upstream renderPwshResult minus the sandbox markers this
 * fork never produces). A clean exit produces no marker; a non-zero exit is
 * reported, not errored.
 */
function renderPwshResult(result: { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; timeoutMs: number; stdout: CollectedOutput; stderr: CollectedOutput }): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** The model-facing description: upstream's base text (no sandbox surfaces in this fork) plus the fork's detection contract. */
const DESCRIPTION =
  'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. Each call runs in a fresh pwsh process; '
  + 'pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment variables with `$env:NAME`. '
  + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
  + 'Non-zero exits are reported as `[exit code: N]` markers, not errors. '
  + 'This deployment probes pwsh.exe (PowerShell 7) first and falls back to Windows PowerShell 5.1\'s powershell.exe; '
  + 'when neither exists the call fails loudly naming every probed location — never a silent fallback. '
  + 'Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. '
  + 'Do not assign to automatic variables such as `$HOME`; variable names are case-insensitive, so `$home` is the same read-only variable.'

/** The structured abort the tool throws when the caller cancels the call (upstream's AbortError shape). */
function toolAborted(): Error {
  return Object.assign(new Error('tool call aborted'), { name: 'AbortError' })
}

/** The tool-execution context slice the entry consumes (duck-typed seam). */
interface PwshToolCtx {
  tools: { register: (tool: unknown) => void }
  get: (name: string) => unknown
}

/** Register the single `pwsh` tool over `ctx.subprocess`. */
function registerPwshTool(ctx: PwshToolCtx, config: PwshToolConfig, deps: PwshToolDeps): void {
  const subprocess = () => {
    const runtime = ctx.get('subprocess') as { spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle } | undefined
    if (runtime === undefined) {
      throw new Error('pwsh: the subprocess service is missing — the fork executes one-shot commands over ctx.subprocess')
    }
    return runtime
  }

  ctx.tools.register(defineTool({
    name: 'pwsh',
    description: DESCRIPTION,
    parameters: {
      command: { type: 'string', required: true, description: 'The PowerShell command to execute.' },
      description: { type: 'string', required: true, description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "Get-Process" → "List running processes".' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The configured default and cap apply; the command is killed on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          timeoutMs: { type: 'number', required: true },
          stdout: { type: 'object', additionalProperties: true, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' } } },
          stderr: { type: 'object', additionalProperties: true, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' } } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: renderPwshResult(value as Parameters<typeof renderPwshResult>[0]) }],
    },
    async execute(args: { command: string; description: string; timeoutMs?: number; workdir?: string }, exec: { agent?: unknown; signal?: AbortSignal }) {
      validatePwshArgs(args)
      // Detection runs per call (the launcher posture): a machine that gains
      // or loses PowerShell mid-flight is reflected at the next command, and
      // the loud double-absence error carries the full probe list.
      const executable = resolvePwshExecutable(deps)
      const timeoutMs = clampTimeout(args.timeoutMs, config.timeoutMs, config.maxTimeoutMs, 'pwsh: request.timeoutMs')
      const workdir = resolveWorkdir(args.workdir, exec)
      const collect = (maxBytes: number): SubprocessCollect =>
        ({ maxBytes, spill: { maxBytes: config.maxSpillBytes } })
      // The fused deadline combines the caller's cancellation with the
      // kill-on-timeout contract (the executor layer's `onExpiry: 'kill'`
      // posture, one-shot only — no background promotion in this fork).
      const d = deadline(exec?.signal, timeoutMs, 'PWSH_TIMEOUT')
      let handle: SubprocessHandle
      try {
        handle = subprocess().spawn({
          argv: [executable, ...ONESHOT_ARGV_PREFIX, ENCODING_PREAMBLE + args.command],
          cwd: workdir,
          stdio: {
            stdin: 'ignore',
            stdout: collect(config.maxOutputBytes),
            stderr: collect(config.maxOutputBytes),
          },
          graceMs: config.graceMs,
          signal: d.signal,
          // ENV_OVERRIDES first (trusted callers win later anyway — nothing
          // here passes env), scrub and merge order owned by the subprocess
          // service, exactly like the executor layer's spawns.
          env: { ...ENV_OVERRIDES },
        })
      } catch (error) {
        d[Symbol.dispose]()
        throw error
      }
      const outcome = await handle.done
      d[Symbol.dispose]()
      const timedOut = timeoutOf(d.signal, 'PWSH_TIMEOUT') !== undefined
      const aborted = d.signal.aborted && !timedOut
      if (aborted) throw toolAborted()
      const streamJson = (label: 'stdout' | 'stderr'): { text: string; truncated: boolean; spillPath?: string } => {
        const o = finalOutput(handle.collected[label]!)
        return { text: o.text, truncated: o.truncated, ...(o.spillPath !== undefined ? { spillPath: o.spillPath } : {}) }
      }
      return {
        kind: 'foreground' as const,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut,
        timeoutMs,
        stdout: streamJson('stdout'),
        stderr: streamJson('stderr'),
      }
    },
    presentCall: (args: { command: string; description: string; workdir?: string }) => ({
      card: 'terminal' as const,
      title: args.command,
      description: args.description,
      ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
    }),
  }))
}

/** Plugin entry: register the same-name `pwsh` tool takeover. */
function apply(ctx: PwshToolCtx, config: unknown, deps: PwshToolDeps = {}): void {
  const c = (config ?? {}) as Partial<PwshToolConfig>
  registerPwshTool(ctx, {
    timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: c.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    maxOutputBytes: c.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxSpillBytes: c.maxSpillBytes ?? DEFAULT_MAX_SPILL_BYTES,
    graceMs: c.graceMs ?? DEFAULT_GRACE_MS,
  }, deps)
}

export { Config, apply, inject, name }

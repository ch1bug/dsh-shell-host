/**
 * dsh-shell-host `./terminal` entry (issue #55, ADR-0008; seam-free since
 * #61/ADR-0010): the launcher-layer PLUGIN-LAYER entry — the same entry form
 * as `./wsl` (defineTool + ctx.tools; registers model tools, not execution
 * backends, ADR-0007 "Entry form differences"). One tool, `shell_open
 * (preset, cwd?, env?, idleTimeoutMs?)`: resolves the (transport × shell-env)
 * preset through the #54 launcher layer (`src/launchers.ts`, whose
 * absent/unknown loud postures are inherited) and opens it on the pty
 * entry's session core — the returned sessionId IS the core session id,
 * operated afterwards with the existing pty_send / pty_tail / pty_close
 * tools. No forwarding tools (ADR-0008 decision 5, no Middle Man).
 *
 * A local preset composes `executable + interactive argv` as the launch
 * command; a custom ssh preset's composed command (keepalive defaults +
 * options semantics, single-sourced from `src/ssh/compose.ts`)
 * is the launch command verbatim — the same shape ssh_start opens. Env rides
 * the spawn spec at process birth (#53 VS Code profile semantics); the
 * preset's PATH prefix is prepended ahead of the inherited PATH under the
 * inherited key's own casing.
 *
 * Independent settings namespace (Config export, sibling-entry convention):
 * the custom preset data channel (shape finalized in #54, the later CRUD UI
 * reads/writes the same data). The built-in preset table is read-only — its
 * live view is surfaced by the loud unknown-id error, which enumerates the
 * resolved preset ids.
 *
 * #61: the cap count and the per-session idle timeout are CORE-derived now
 * (the pty core's registry is the single fact source — the #62 remount
 * zeroing is structurally gone): shell_open reads `core.active(owner)` for
 * the cap and hands `idleTimeoutMs` to the core's own watcher.
 *
 * #119: a shell_open session is declared a SHELL TARGET (`shell: true` on the
 * open spec) — the one layer that knows it resolved a launcher preset. The
 * consequence is visible on the pty surface: `pty_signal` refuses SIGKILL on
 * such a session (killing a shell cannot reclaim its children) and points at
 * pty_close, the single close path. The core never infers this from command
 * text, so `pty_open({ command: "bash" })` stays a plain target on purpose.
 * @module dsh-shell-host/terminal
 */

import z from '@deepseek-ai/schemastery'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, appendFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { launcherError, resolveLauncherDetailed, resolveLaunchers, builtInLauncherIds, type CustomLauncherConfig, type LauncherDeps, type LocalLauncherPreset, type ResolvedLauncher } from '../launchers.ts'
import { codedError } from '../coded-error.ts'
import { validateCustomEntries } from './register.ts'
import { createAuditLedger } from './audit-ledger.ts'
import { spawnableExists } from '../detect.ts'
import { DEFAULT_MAX_SESSIONS as CORE_DEFAULT_MAX_SESSIONS } from '../pty/session-core.ts'
import {
  SANDBOX_EXECUTION_SEMANTICS,
  createPermissionGate,
  sandboxPermissionParameters,
  sessionOf,
  type SandboxMode,
} from '../permission-gate.ts'

const name = 'dsh-shell-host-terminal'
// #102: shell_open drives the host permission gate, so both host services are
// real dependencies (the gate fails closed without them; declaring them makes
// the row refuse to activate instead of serving a tool that can only fail).
const inject = ['tools', 'pty', 'sandboxPolicy', 'approval']

/** Default concurrent-session soft cap (#56 ruling 3) — the terminal-side
 * settings surface; the pty core enforces its own copy of the same default. */
export const DEFAULT_MAX_SESSIONS = 8

/** Runtime configuration schema — the `./terminal` entry's own settings
 * namespace. `custom` is the custom-preset data channel (the #54
 * CustomLauncherConfig shape, persisted; CRUD UI is a later ticket).
 * `maxSessions` is the concurrent-session soft cap counted over the pty
 * CORE's registry (#61/#62) for the owning agent. */
export interface TerminalConfig {
  custom: CustomLauncherConfig[]
  maxSessions: number
  /** #170: the custom.d directory — the custom-preset FILE FAMILY's root
   * (one `<id>.json` per preset, ADR-0018 修订). Must be absolute when set.
   * Default: `<DSH_HOME|~/.dsh>/custom.d` (the plugin cannot observe the
   * active profile NAME at runtime — a profile-scoped location is had by
   * setting this field explicitly; recorded in .scratch/170-landing.md). */
  customDir?: string
}

const Config = z.object({
  /** Custom launcher presets (the #54 data shape): local rows declare
   * executable (or inherit a built-in `base`), ssh rows declare host (+ the
   * ssh connection fields). A custom id overrides a built-in view. */
  custom: z.array(z.any()).default([]),
  /** Concurrent-session soft cap (#56): shell_open fails loudly once an
   * owner's own active sessions reach this count. */
  maxSessions: z.number().default(DEFAULT_MAX_SESSIONS),
})

function resolveConfig(raw: unknown): TerminalConfig {
  const c = (raw ?? {}) as Partial<TerminalConfig>
  const maxSessions = c.maxSessions ?? DEFAULT_MAX_SESSIONS
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error(`terminal: maxSessions must be a positive integer, got: ${JSON.stringify(c.maxSessions)}`)
  }
  if (c.customDir !== undefined && !isAbsolute(c.customDir)) {
    throw new Error(`terminal: customDir must be an absolute path, got: ${JSON.stringify(c.customDir)}`)
  }
  return {
    custom: Array.isArray(c.custom) ? c.custom : [],
    maxSessions,
    ...(c.customDir === undefined ? {} : { customDir: c.customDir }),
  }
}

/** The tool-execution context slice the entry consumes (duck-typed seam). */
interface TerminalCtx {
  tools: { register: (tool: unknown) => void }
  get: (name: string) => unknown
}

/** The pty entry's session core facade (provided as the `pty` service).
 * #61: `active` is the registry-derived liveness view (#62's fact source);
 * `open` accepts the opt-in per-session idleTimeoutMs, enforced by the
 * core's own watcher (output-defined idle, #56 ruling). */
interface PtyCore {
  open(owner: unknown, spec: { command: string; cwd?: string; env?: Record<string, string>; idleTimeoutMs?: number; shell?: boolean; authorizedMode?: SandboxMode }, signal?: AbortSignal): Promise<{ sessionId: string; initialOutput?: string; [key: string]: unknown }>
  close(owner: unknown, id: string): Promise<{ closed: boolean }>
  active(owner: unknown): string[]
}

/**
 * The launch command for a local preset: the first EXISTING executable
 * candidate (resolveLauncher already proved at least one exists; re-checking
 * keeps the loud posture if the machine changed mid-flight) + the preset's
 * interactive argv. Paths with spaces double-quote — quoting that is valid
 * for every dialect the ConPTY wrapper can host (bash / pwsh / cmd); argv
 * atoms are passed verbatim. Returns the HIT candidate too — the shell_open
 * result's `executable` field (#56).
 */
function localLaunchCommand(preset: LocalLauncherPreset, deps: LauncherDeps): { executable: string; command: string; probed: string[] } {
  const exists = deps.exists ?? spawnableExists
  const executable = preset.executable.find(candidate => exists(candidate))
  if (executable === undefined) {
    throw launcherError('NO_EXECUTABLE_CANDIDATE', `launcher: preset '${preset.id}' has no existing executable candidate. Probed: ${preset.executable.join(', ')}`)
  }
  const exe = executable.includes(' ') ? `"${executable}"` : executable
  return { executable, command: [exe, ...preset.argv].join(' '), probed: [...preset.probed] }
}

/**
 * Merge the preset env, the PATH prefix (ahead of the inherited PATH, under
 * the inherited key's own casing — Windows spells it `Path`), then the tool
 * args' overrides. A fresh object: the preset's env is never mutated.
 */
function launchEnv(preset: ResolvedLauncher, overrides: Record<string, string> | undefined, deps: LauncherDeps): Record<string, string> | undefined {
  // ssh presets carry no shell-env (ADR-0008: ssh is the transport dimension):
  // only tool-arg overrides apply, and they ride the spawn spec — a local
  // preset's env/PATH prefix never leaks onto an ssh connection.
  if (preset.transport === 'ssh') return overrides
  const env: Record<string, string> = { ...preset.env }
  if (preset.pathPrefix.length > 0) {
    const inherited = deps.env ?? process.env
    const pathKey = Object.keys(inherited).find(key => key.toLowerCase() === 'path') ?? 'PATH'
    env[pathKey] = [...preset.pathPrefix, inherited[pathKey] ?? ''].join(delimiter)
  }
  return { ...env, ...overrides }
}

/**
 * #170 audit check, run when shell_open is about to launch a CUSTOM preset's
 * executable: compare the file's current content hash against the ledger's
 * latest `registered` baseline. Advisory ONLY (D4) — the return value rides
 * the tool result as the `audit` field; the launch proceeds either way. No
 * ledger record at all → no warning (a newly installed file is a legitimate
 * shape); matching hash → no warning (the discriminating counter-sample).
 * A mismatch is recorded ONCE per observed hash (a `changed` event whose
 * hash was already the latest observation does not re-append) but never
 * moves the registered baseline.
 */
function auditWarningFor(id: string, executable: string, config: TerminalConfig, deps: TerminalDeps): { warning: string; expectedHash: string; expectedRecordedAt: string; actualHash: string } | undefined {
  const fs = deps.mountFs ?? defaultMountFs()
  const ledger = ledgerFor(customDirOf(config, deps), fs)
  const lastReg = ledger.latestRegisteredFor(id)
  if (lastReg === undefined || typeof lastReg.hash !== 'string') return undefined
  const actual = fs.hashFile(executable)
  if (actual === undefined || actual === lastReg.hash) return undefined
  const latest = ledger.latestEventFor(id)
  if (!(latest?.kind === 'changed' && latest.hash === actual)) {
    ledger.append({ kind: 'changed', id, hash: actual, expectedHash: lastReg.hash })
  }
  return {
    warning: 'executable-changed-since-registration',
    expectedHash: lastReg.hash,
    expectedRecordedAt: lastReg.ts,
    actualHash: actual,
  }
}

/** Register the single shell_open tool against the pty session core. */
function registerShellOpen(ctx: TerminalCtx, config: TerminalConfig, deps: TerminalDeps): void {
  const core = ctx.get('pty') as PtyCore
  if (core === undefined) {
    throw new Error('terminal: the pty session core is missing — mount the dsh-shell-host/pty entry alongside ./terminal')
  }
  /** #102: shell_open is a narrower executable channel (preset table + probe
   * points, never a free command line) but it is still a PROCESS SPAWN — so
   * it takes the same host policy gate as pty_open. */
  const gate = createPermissionGate(ctx)

  ctx.tools.register(defineTool({
    name: 'shell_open',
    description:
      'Open a persistent terminal for a launcher preset (e.g. msys2-ucrt, pwsh, powershell, wsl, cmd, git-bash, python-repl, zsh, bash, fish — POSIX rows on POSIX platforms — or a configured custom preset). ' +
      'Returns a sessionId that is a PTY session: operate it with pty_send / pty_tail / pty_close — no second tool family. ' +
      'Unknown ids fail loudly listing the available presets; uninstalled environments fail loudly naming every probe point. ' +
      'A per-agent concurrent-session cap applies; idleTimeoutMs opts ONE session into auto-close when it produces no new output for that long. ' +
      // #159 boundary, stated on the persistent surface itself: no call-length
      // deadline covers a persistent session, and single commands inside it
      // are not precisely clockable (a PTY is a byte stream).
      'This session is PERSISTENT: the #159 one-shot hard deadline (pty_open + autoClose) does NOT cover it, and single shell commands inside it cannot be precisely timed — the only automatic reclaim is the opt-in idleTimeoutMs. ' +
      SANDBOX_EXECUTION_SEMANTICS,
    parameters: {
      preset: { type: 'string', required: true, description: 'Launcher preset id (built-in view or configured custom preset).' },
      cwd: { type: 'string', description: 'Working directory override; defaults to the preset\'s cwd.' },
      env: { type: 'object', additionalProperties: true, description: 'Env var overrides merged over the preset env (VS Code profile semantics).' },
      idleTimeoutMs: { type: 'number', description: 'Opt-in per-session idle timeout (ms, positive integer): auto-close the session after this much time with no new output. Omit = never idle-closed (persistent-session contract).' },
      ...sandboxPermissionParameters('command'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true, description: 'Core session id — pass to pty_send / pty_tail / pty_close.' },
          preset: { type: 'string', required: true, description: 'The resolved preset id.' },
          transport: { type: 'string', required: true, description: '"local" or "ssh".' },
          command: { type: 'string', required: true, description: 'The launch command opened on the PTY.' },
          initialOutput: { type: 'string', description: 'Output captured during launch.' },
          executable: { type: 'string', description: 'The executable candidate that hit (local presets).' },
          probed: { type: 'array', items: { type: 'string' }, description: 'Every probe point considered (local presets).' },
          audit: { type: 'object', additionalProperties: true, description: '#170 advisory audit warning — present only when a custom preset\'s executable content hash differs from the registration ledger baseline. Launch is NOT blocked.' },
          cwd: { type: 'string', description: 'The effective working directory, when one applies.' },
          source: { type: 'string', required: true, description: '"builtin" or "custom" — where the preset view came from.' },
          overrode: { type: 'boolean', required: true, description: 'True when a custom preset REPLACED a built-in view of the same id (loud flag, never an error).' },
          sandboxMode: {
            type: 'string',
            description: 'The sandbox mode this spawn ran under (the session policy, or the approved one-shot escalation target).',
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
      // #121: pure display metadata on `tool/result.meta` — the preset
      // resolution facts (ticket: 映 preset / executable). Pure display: the
      // schema/render above are untouched; the built-in Web Client renders
      // third-party names with the generic card either way, so the consumers
      // here are the session event stream / replay / PTC dispatch logs.
      presentationMeta: (_args: unknown, value: { preset?: string; source?: string; executable?: string; probed?: string[]; cwd?: string; overrode?: boolean }) => ({
        // Lossless JSON: absent members are omitted, never undefined-valued.
        ...(value.preset === undefined ? {} : { preset: value.preset }),
        ...(value.source === undefined ? {} : { source: value.source }),
        ...(value.executable === undefined ? {} : { executable: value.executable }),
        ...(value.probed === undefined ? {} : { probed: value.probed }),
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        ...(value.overrode === undefined ? {} : { overrode: value.overrode }),
      }),
    },
    async execute(args: { preset: string; cwd?: string; env?: Record<string, string>; idleTimeoutMs?: number; sandbox_permissions?: string; justification?: string }, exec: { agent?: unknown; signal?: AbortSignal; callId?: string }) {
      const owner = exec?.agent
      if (owner === undefined) {
        throw codedError('shell_open requires an owning agent session', 'NO_AGENT')
      }
      if (args.idleTimeoutMs !== undefined && (!Number.isInteger(args.idleTimeoutMs) || args.idleTimeoutMs <= 0)) {
        throw new Error(`shell_open: idleTimeoutMs must be a positive integer (ms), got: ${JSON.stringify(args.idleTimeoutMs)}`)
      }
      // Soft cap over the owner's OWN active sessions (#56 ruling 3), counted
      // from the CORE registry (#61/#62) — dead rows are pruned there on
      // close, so a pty_close always frees its slot and an entry remount
      // cannot reset the count.
      const active = core.active(owner)
      if (active.length >= config.maxSessions) {
        throw new Error(
          `terminal: shell_open hit the concurrent session limit (max ${config.maxSessions}); ` +
          `${active.length} sessions already active for this agent: ${active.join(', ')}. ` +
          'Close one with pty_close before opening another.',
        )
      }
      const detail = resolveLauncherDetailed(args.preset, deps, config.custom)
      const launcher = detail.launcher
      let launched: { executable: string; command: string; probed: string[] } | undefined
      let command: string
      if (launcher.transport === 'local') {
        launched = localLaunchCommand(launcher, deps)
        command = launched.command
      } else {
        command = launcher.command
      }
      // #170: advisory hash check against the registration ledger (custom
      // presets only; a mismatch warns on THIS result and never blocks).
      const audit = detail.source === 'custom' && launched !== undefined
        ? auditWarningFor(launcher.id, launched.executable, config, deps)
        : undefined
      const cwd = launcher.transport === 'local' ? (args.cwd ?? launcher.cwd) : args.cwd
      const env = launchEnv(launcher, args.env, deps)
      // #102: authorize BEFORE the spawn — the gate resolves the session
      // policy per execution and (when the caller asked to retry wider) routes
      // the request through the official approval service.
      const authorization = await gate.authorizeSpawn({
        toolName: 'shell_open',
        agent: owner,
        session: sessionOf(owner),
        callId: exec.callId,
        signal: exec.signal,
        cwd,
        sandboxPermissions: args.sandbox_permissions,
        justification: args.justification,
        subject: 'command',
      })
      const opened = await core.open(owner, {
        command,
        // Under workspace-write the gate hands back the concrete boundary cwd
        // (an omitted cwd DEFAULTS to the workspace root); under
        // danger-full-access the caller's/preset's value passes through.
        ...(authorization.cwd === undefined ? {} : { cwd: authorization.cwd }),
        ...(env === undefined ? {} : { env }),
        ...(args.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: args.idleTimeoutMs }),
        // #119: this layer KNOWS it resolved a launcher preset (a shell), so it
        // declares the session a shell target — pty_signal then refuses SIGKILL
        // on it (official terminal_signal semantics: killing a shell cannot
        // reclaim the children it owns). No heuristic in the core.
        shell: true,
        // #102: the mode the spawn was AUTHORIZED under (the one-shot grant
        // when an escalation was approved) is the session's write baseline.
        authorizedMode: authorization.grantedMode,
      }, exec.signal)
      return {
        sessionId: opened.sessionId,
        preset: launcher.id,
        transport: launcher.transport,
        command,
        ...(opened.initialOutput === undefined ? {} : { initialOutput: opened.initialOutput }),
        ...(launched === undefined ? {} : { executable: launched.executable, probed: launched.probed }),
        ...(authorization.cwd === undefined ? {} : { cwd: authorization.cwd }),
        source: detail.source,
        overrode: detail.overrode,
        ...(audit === undefined ? {} : { audit }),
        sandboxMode: authorization.grantedMode,
      }
    },
    presentCall: (args: { preset: string }) => ({ card: 'terminal', title: `shell_open ${args.preset}` }),
  }))
}

/** Plugin entry: register the launcher-layer tool surface over the pty core.
 *
 * #105/#170 registration gate: the custom preset storage is the custom.d
 * FILE FAMILY (ADR-0018 修订), validated at EVERY mount by
 * `src/terminal/register.ts` (no built-in overrides, explicit absolute
 * paths, charset-locked ids). Since #170 a rejected entry is SINGLE-ENTRY
 * DISABLED — it is skipped and surfaced on `terminal_list` with its reasons
 * while the other files mount normally (the #105 whole-batch fail-closed
 * throw and the process-level restart snapshot are both retired by the
 * ADR revision); fixing a file re-enables the preset on the NEXT MOUNT
 * (asserted by tests/terminal-registration.spec.ts, not by documentation).
/** #170 (ADR-0018 修订): the machine seam for the custom.d FILE FAMILY and
 * the audit ledger — production uses node:fs; tests fake the whole thing
 * (TESTING.md 坑 12: the machine is always faked at the probe seam). */
export interface MountFs {
  /** Directory listing; `undefined` = the directory does not exist. */
  listDir(dir: string): string[] | undefined
  /** Whole-file text read; `undefined` = unreadable/missing. */
  readFile(path: string): string | undefined
  /** Content hash (sha256 hex); `undefined` = unreadable. */
  hashFile(path: string): string | undefined
  /** Append one line (the ledger's write path; the parent exists). */
  appendFile(path: string, line: string): void
  /** Create a directory (recursively) — the ledger's parent on first append. */
  ensureDir(dir: string): void
}

function defaultMountFs(): MountFs {
  return {
    listDir: dir => {
      try {
        return readdirSync(dir)
      } catch {
        return undefined
      }
    },
    readFile: path => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    hashFile: path => {
      try {
        return createHash('sha256').update(readFileSync(path)).digest('hex')
      } catch {
        return undefined
      }
    },
    appendFile: (path, line) => {
      appendFileSync(path, line, 'utf8')
    },
    ensureDir: dir => {
      mkdirSync(dir, { recursive: true })
    },
  }
}

/** Terminal-layer deps: the launcher probe seams plus the #170 mount seams
 * (the #105 validation seams `isDirectory`/`platform` are re-declared
 * optional — validation deps are assembled inside mountCustom). */
export interface TerminalDeps extends LauncherDeps {
  /** Directory probe passed through to the #105 validation matrix. */
  isDirectory?: (path: string) => boolean
  /** Platform gate for separator shape (#167), passed through unchanged. */
  platform?: NodeJS.Platform
  /** The custom.d root override (settings `customDir` wins when set). */
  customDir?: string
  /** The file-family + ledger machine seam; defaults to node:fs. */
  mountFs?: MountFs
}

/** One preset that FAILED its mount-time validation: skipped (single-entry
 * disable, ADR-0018 修订) but visible on terminal_list with the reasons. */
export interface DisabledPreset {
  id: string
  file: string
  reasons: string[]
}

/** The last mount's outcome — what terminal_list projects. NO process-level
 * snapshot: the file family re-reads on EVERY apply (ADR-0018 修订 point 3 —
 * "fix the file, next mount re-enables" replaces the #105 restart contract). */
let mountState: { active: readonly CustomLauncherConfig[]; disabled: readonly DisabledPreset[] } = { active: [], disabled: [] }

/** Test seam: reset the mount state (kept name for the #105 suite's shape). */
export function _resetRegistrationForTests(): void {
  mountState = { active: [], disabled: [] }
}

function customDirOf(config: TerminalConfig, deps: TerminalDeps): string {
  return deps.customDir ?? config.customDir ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'custom.d')
}

function ledgerFor(customDir: string, fs: MountFs): ReturnType<typeof createAuditLedger> {
  // The append path ensures the directory first — a fresh profile has no
  // custom.d yet.
  return createAuditLedger({
    ledgerPath: join(customDir, 'audit.jsonl'),
    readFile: path => fs.readFile(path),
    appendFile: (path, line) => {
      fs.ensureDir(customDir)
      fs.appendFile(path, line)
    },
  })
}

/**
 * The #170 mount: read the custom.d FILE FAMILY, validate every entry
 * through the #105 matrix (single-entry disable — the whole-batch
 * `registrationError` gate is RETIRED, ADR-0018 修订 point 2), record the
 * ignore event for the now-废止 patch-row channel, and drive the audit
 * ledger's transition events (registered / enabled / disabled — deduped to
 * TRANSITIONS so a remount does not spam the history).
 */
function mountCustom(resolved: TerminalConfig, deps: TerminalDeps): { active: CustomLauncherConfig[]; disabled: DisabledPreset[] } {
  const customDir = customDirOf(resolved, deps)
  const fs = deps.mountFs ?? defaultMountFs()
  const ledger = ledgerFor(customDir, fs)

  // D8: patch-row custom entries are 废止 — ignore + ONE audit event per
  // mount (the channel, not each entry; no compatibility double-read). The
  // `what` discriminator keeps the channel-level event unambiguous in the
  // shared ledger (D1 reserves `source` for future audit faces).
  if (resolved.custom.length > 0) {
    ledger.append({ kind: 'ignored', what: 'patch-source', count: resolved.custom.length })
  }

  const names = (fs.listDir(customDir) ?? []).filter(name => name.endsWith('.json')).sort()
  const parsed = names.map(name => {
    const body = fs.readFile(join(customDir, name))
    if (body === undefined) return { name, entry: undefined as unknown, error: 'unreadable' as const }
    try {
      return { name, entry: JSON.parse(body) as unknown, error: undefined }
    } catch {
      return { name, entry: undefined as unknown, error: 'invalid JSON' as const }
    }
  })
  const { accepted, rejected } = validateCustomEntries(
    parsed.map(p => p.entry),
    {
      builtInIds: builtInLauncherIds(deps),
      ...(deps.exists === undefined ? {} : { exists: deps.exists }),
      ...(deps.isDirectory === undefined ? {} : { isDirectory: deps.isDirectory }),
      // #167: the separator-shape platform gate rides the same injection
      // seam as the probe seams (defaults to process.platform).
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    },
  )
  const disabled: DisabledPreset[] = []
  for (const reject of rejected) {
    const file = parsed[reject.index]?.name ?? `<index ${reject.index}>`
    disabled.push({ id: reject.id, file, reasons: reject.reasons })
  }
  for (const p of parsed) {
    if (p.error === undefined) continue
    disabled.push({ id: p.name.replace(/\.json$/, ''), file: p.name, reasons: [`preset file is not valid ${p.error === 'unreadable' ? 'readable' : 'JSON'}: ${p.name}`] })
  }
  // The D5 shape is `<id>.json`: the FILE NAME must match the entry's id —
  // a mismatch is exactly the kind of silent drift the file family exists
  // to isolate, so it disables the entry instead of resolving it.
  const stillAccepted: CustomLauncherConfig[] = []
  for (const entry of accepted) {
    const file = parsed.find(p => (p.entry as { id?: unknown })?.['id'] === entry.id)?.name
    if (file !== undefined && file.replace(/\.json$/, '') !== entry.id) {
      disabled.push({ id: entry.id, file, reasons: [`preset file name must match the preset id: ${file} declares id ${JSON.stringify(entry.id)}`] })
      continue
    }
    stillAccepted.push(entry)
  }

  // Ledger transitions (deduped: append only on CHANGE, never per mount).
  const exists = deps.exists ?? spawnableExists
  const currentHashOf = (entry: CustomLauncherConfig): { hash?: string; executable?: string } => {
    if (entry.transport !== 'local' || entry.executable === undefined) return {}
    const hit = entry.executable.find(candidate => exists(candidate))
    if (hit === undefined) return {}
    const hash = fs.hashFile(hit)
    return hash === undefined ? {} : { hash, executable: hit }
  }
  for (const entry of stillAccepted) {
    const { hash, executable } = currentHashOf(entry)
    // Recovery check BEFORE the (possibly new) registered event lands —
    // otherwise the fresh event hides the preceding 'disabled'.
    if (ledger.latestEventFor(entry.id)?.kind === 'disabled') {
      ledger.append({ kind: 'enabled', id: entry.id })
    }
    // The registered BASELINE is written ONCE per preset id (first mount):
    // later content changes are observed as `changed` events at LAUNCH time
    // and never move the baseline — re-registering on a hash change would
    // silently swallow the very mismatch the launch check exists to surface.
    if (ledger.latestRegisteredFor(entry.id) === undefined) {
      ledger.append({ kind: 'registered', id: entry.id, ...(hash === undefined ? {} : { hash }), ...(executable === undefined ? {} : { executable }) })
    }
  }
  for (const d of disabled) {
    if (ledger.latestEventFor(d.id)?.kind !== 'disabled') {
      ledger.append({ kind: 'disabled', id: d.id, reasons: d.reasons, file: d.file })
    }
  }
  return { active: stillAccepted, disabled }
}

/**
 * #170: the read-only preset listing surface — every preset (built-in view,
 * active custom, DISABLED custom with the original validation reasons) in
 * one projection. The disabled rows come straight from the last mount's
 * validation outcome; recovery needs no command (fix the file, next mount
 * re-enables), so this face has no write path — the #105 agent-face guard
 * (no registration writer) is unchanged in spirit: terminal_list is a pure
 * read, and the audit ledger stays append-only with no tool over it.
 */
function registerTerminalList(ctx: TerminalCtx, deps: TerminalDeps): void {
  ctx.tools.register(defineTool({
    name: 'terminal_list',
    description:
      'List the terminal launcher presets: built-in views, mounted custom presets, and custom presets DISABLED by mount-time validation (with the original reasons). Read-only — a disabled preset is fixed by repairing its custom.d file; the next mount re-enables it.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          presets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                transport: { type: 'string', required: true },
                source: { type: 'string', required: true, description: '"builtin" or "custom".' },
                disabled: { type: 'boolean', description: 'True when mount-time validation rejected the preset; absent when mounted.' },
                reasons: { type: 'array', items: { type: 'string' }, description: 'The original validation failure text (disabled rows only).' },
                file: { type: 'string', description: 'The custom.d file name (custom rows).' },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute() {
      const { presets } = resolveLaunchers(deps, [])
      const rows: Array<{ id: string; transport: string; source: string; disabled?: boolean; reasons?: string[]; file?: string }> =
        presets.map(p => ({ id: p.id, transport: p.transport, source: 'builtin' }))
      for (const entry of mountState.active) {
        const idx = rows.findIndex(r => r.id === entry.id)
        const row = { id: entry.id, transport: entry.transport, source: 'custom' as const, file: `${entry.id}.json` }
        if (idx >= 0) rows[idx] = row
        else rows.push(row)
      }
      for (const d of mountState.disabled) {
        rows.push({ id: d.id, transport: 'local', source: 'custom', disabled: true, reasons: d.reasons, file: d.file })
      }
      return { presets: rows }
    },
    presentCall: () => ({ card: 'terminal', title: 'terminal_list' }),
  }))
}

function apply(ctx: TerminalCtx, config: unknown, deps: TerminalDeps = {}): void {
  const resolved = resolveConfig(config)
  mountState = mountCustom(resolved, deps)
  registerShellOpen(ctx, { ...resolved, custom: [...mountState.active] }, deps)
  registerTerminalList(ctx, deps)
}

export { Config, apply, inject, name }

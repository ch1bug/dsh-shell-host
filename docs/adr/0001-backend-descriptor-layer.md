# ADR-0001: Backend descriptor layer for the bash executor

- Status: Accepted (T1 deliverable, direct input to T2/#5)
- Date: 2026-09-30
- Deciders: human (D7 consensus, triage 2026-09-30); this ADR records the VS Code source survey that grounds it
- Context: `CONTEXT.md` D2/D7; spec issue #1; tickets #4 (this) → #5 (implements)

## Context

The fork baseline (`src/index.ts`, upstream `@deepseek-ai/dsh-bash-local`
0.2.0-rc.2 verbatim) hardcodes the bash binary as `'bash'` resolved along
`PATH`, spawns one-shot `['bash', '-c', cmd]` (non-login, no rc files), and
has no environment-injection or path-mapping knobs — only 6 volatile budget
fields (`cwd/timeoutMs/maxTimeoutMs/maxOutputBytes/maxSpillBytes/graceMs`).
Windows needs an explicit MSYS2 path (a bare `bash` on Windows PATH can hit
WSL), MSYSTEM environment selection, and Windows↔MSYS path translation
(cwd in, file paths out). D7 decides: build a declarative **backend
descriptor layer** in one shot (not a msys2-only patch), modeled on VS
Code's terminal-profile/remote patterns. This ADR fixes the field set from
primary sources so T2 implements, not designs.

## VS Code survey (primary sources read, master branch)

### 1. A terminal profile IS a declarative descriptor

`src/vs/platform/terminal/node/terminalProfiles.ts` —
`detectAvailableWindowsProfiles`:

```ts
detectedProfiles.set('bash (MSYS2)', {
  path: [{ path: `${HOMEDRIVE}\\msys64\\usr\\bin\\bash.exe`, isUnsafe: true }],
  args: ['--login', '-i'],
  // CHERE_INVOKING retains current working directory
  env: { CHERE_INVOKING: '1' },
  icon: Codicon.terminalBash,
  isAutoDetected: true,
})
```

This is exactly our target shape: **spawn path candidates + argv template +
env injection** declared per backend. Nearby in the same function: Cygwin
(`args: ['--login']`, two candidate paths), Git Bash (`source`-based paths,
`args: ['--login', '-i']` via `initializeWindowsProfiles`), and WSL
(`getWslProfiles`: `path: wsl.exe`, `args: ['-d', distroName]` enumerated
from `wsl.exe -l -q`). The declared types live in
`src/vs/platform/terminal/common/terminal.ts`:
`ITerminalProfile` (`profileName/path/args/env/overrideName/isUnsafePath`),
`ITerminalExecutable` (`path: SingleOrMany<string | ITerminalUnsafePath>` —
**ordered fallback candidates**), `IBaseUnresolvedTerminalProfile`
(`args/env`).

### 2. Path candidates resolve by ordered fallback, PATH search last

Same file, `validateProfilePaths`: absolute paths are checked with
`fsProvider.existsFile` in order; a bare `basename(path) === path` is
searched on `PATH` via `findExecutable` (from
`src/vs/base/node/processes.ts`). At spawn time
`src/vs/platform/terminal/node/terminalProcess.ts` `_validateExecutable`
re-resolves the executable (`findExecutable(slc.executable, cwd, envPaths,
executableEnv)`) and **rewrites** `slc.executable` to the resolved absolute
path so node-pty does not re-search PATH. Lesson for us: a Windows-safe bash
executor should never spawn a bare `'bash'`; the descriptor's candidate list
ends in an explicit PATH probe at most, and the resolved absolute path is
what gets spawned.

### 3. The consumption face is a shell launch config, argv is replaceable

`src/vs/platform/terminal/common/terminal.ts` — `IShellLaunchConfig`:
`executable`, `args: string[] | string` (argv array vs pre-escaped
CommandLine), `cwd`, `env: ITerminalEnvironment`. In
`terminalProcess.ts` `setupPtyProcess`:
`const args = shellIntegrationInjection?.newArgs || shellLaunchConfig.args || []`,
then `spawn(shellLaunchConfig.executable!, args, options)` — argv is a
**template that later layers may replace** (shell integration swaps in
`['--init-file', '{0}/shellIntegration-bash.sh']`-style argv from
`src/vs/platform/terminal/node/terminalEnvironment.ts`
`shellIntegrationArgs`, including the literal string-`format` template
parameter `{0}`). Lesson: the descriptor's argv for one-shot vs interactive
modes are two templates on the same seam, and the `{0}` placeholder pattern
is how VS Code injects script paths into argv — we use the same shape with
a named token (`{command}`) for the command payload.

### 4. Login/interactive is argv classification, not a boolean

`src/vs/platform/terminal/node/terminalEnvironment.ts`:
`shLoginArgs = ['--login', '-l']`, `shInteractiveArgs = ['-i',
'--interactive']`, `areZshBashFishLoginArgs()` strips interactive flags
before classifying. Lesson: the descriptor declares argv **per mode**
(one-shot / login-interactive), and code classifies user-supplied extra args
against known flag spellings — we will not need classification in phase 1
(no user-supplied shellArgs on the executor seam), but the template-per-mode
shape is what makes `pwsh`/`wsl` later additions trivial (pwsh login argv
differs entirely: `['-l', '-noexit', '-command', ...]` in the same
`shellIntegrationArgs` table).

### 5. Environment injection is layered with null-means-delete

`ITerminalEnvironment` is `{ [key: string]: string | null | undefined }`
(`common/terminal.ts`) — **a `null` value removes the variable** from the
inherited environment. Profile env (`terminalProfiles.ts`, e.g.
`CHERE_INVOKING: '1'`) is carried onto the profile object through
`validateProfilePaths`; injection adds `envMixin` on top
(`node/terminalEnvironment.ts` `getShellIntegrationInjection`, e.g.
`VSCODE_SHELL_LOGIN`, `ZDOTDIR`); `IShellLaunchConfig.strictEnv` /
`useShellEnvironment` control inheritance. Lesson: a profile's env wins
over the inherited environment (applied closest to the shell among the
inherited layers). Our upstream base already layers
`{ ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }` (upstream
`src/index.ts`, last spread wins); the descriptor's env joins at the VS
Code profile-env position — **after caller env, before `dshEnv`**, so
`{ ...ENV_OVERRIDES, ...spec.env, ...descriptor.env, ...spec.dshEnv }`:
MSYSTEM/PATH injection beats the caller's inherited environment (the point
of D3) while `dshEnv` keeps its upstream-contracted innermost win.

### 6. Path mapping is a first-class bidirectional seam

`common/terminal.ts` — `IPtyService.getWslPath(original: string, direction:
'unix-to-win' | 'win-to-unix')`: the platform service exposes **directional
path translation as an RPC-shaped interface method**, not ad-hoc calls.
`common/terminalEnvironment.ts` — `escapeNonWindowsPath(path, shellType)`
(shell-specific quoting before handing a path to bash-family shells) and
`sanitizeCwd` (quote-stripping, drive-letter casing). Lesson: the descriptor
carries a path-mapping member with `toShell` (cwd in) and `fromShell`
(paths out) directions; for msys2 both are `cygpath` calls, for wsl
`wslpath` (the `getWslPath` analog), phase 2 per D7.

## Decision

`dsh-bash-msys` gets a declarative `BackendDescriptor` (T2 implements):

```ts
interface BackendDescriptor {
  id: string                                  // 'msys2' | 'pwsh' | 'wsl' | ... (ITerminalProfile.profileName analog)
  executable: Array<string | { path: string, isUnsafe: boolean }>  // ordered candidates, VS Code ITerminalExecutable
  argv: {
    oneShot: string[]      // msys2: ['-c', '{command}'] — non-login (upstream default)
    interactive: string[]  // msys2: ['--login', '-i']  — PTY terminal (D3)
  }
  env: Record<string, string | null>          // msys2: MSYSTEM, CHERE_INVOKING, PATH; null deletes (ITerminalEnvironment)
  pathMapping: {
    toShell(winPath: string): Promise<string>    // cygpath -u / wslpath
    fromShell(shellPath: string): Promise<string> // cygpath -w / wslpath -w
  }
}
```

- Field provenance: `id` ← `ITerminalProfile.profileName` (`common/terminal.ts`);
  `executable` ← `terminalProfiles.ts`
  `validateProfilePaths` + `terminalProcess.ts` `_validateExecutable`;
  `argv` ← `IShellLaunchConfig.args` + `shellIntegrationArgs` templates
  (mode-per-template); `env` ← `ITerminalProfile.env` +
  `ITerminalEnvironment` null-deletes; `pathMapping` ←
  `IPtyService.getWslPath(direction)` + `escapeNonWindowsPath`.
- Landing seams in upstream `src/index.ts` (verified in the baseline): the
  hardcoded `'bash'` + `['bash','-c',cmd]` construction inside
  `LocalBashExecutor`'s spawn path (single argv construction site);
  `assertServiceableBashConfig` extends to validate the descriptor
  (candidates non-empty, argv templates contain the command placeholder);
  `Config` gains the backend selection + explicit override; `ENV_OVERRIDES`
  layering is untouched (descriptor env slots in as
  `{ ...ENV_OVERRIDES, ...spec.env, ...descriptor.env, ...spec.dshEnv }` —
  see §5).
- Phase 1 implements `msys2` only; `pwsh` (#3) and `wsl` (#2) are registry
  entries with descriptor sketches in the table below but not implemented
  (wsl is phase 2 per D7: ssh/remote semantics).

| field | msys2 (phase 1) | pwsh (#3, sketch) | wsl (#2, phase 2) |
|---|---|---|---|
| `id` | `msys2` | `pwsh` | `wsl` |
| `executable` | `%HOMEDRIVE%\msys64\usr\bin\bash.exe` (+candidates, VS Code `bash (MSYS2)` verbatim) | `pwsh.exe` via PATH probe (VS Code `ProfileSource.Pwsh` + `enumeratePowerShellInstallations`) | `System32\wsl.exe` (VS Code `getWslProfiles`) |
| `argv.oneShot` | `['-c', '{command}']` (upstream default) | `['-NoLogo', '-Command', '{command}']` | `['-e', 'bash', '-c', '{command}']` (distro via `-d`) |
| `argv.interactive` | `['--login', '-i']` (D3; VS Code MSYS2 profile) | `['-l', '-noexit']` (VS Code `WindowsPwshLogin` shape) | `['-d', '{distro}']` (VS Code WSL profile) |
| `env` | `MSYSTEM=UCRT64` (D1), `CHERE_INVOKING=1`, PATH prepend | minimal (pwsh profile env is empty upstream) | `WSLENV` pass-through list |
| `pathMapping` | `cygpath -u` / `cygpath -w` | identity | `wslpath` (VS Code `getWslPath` both directions) |

## Consequences

- T2 is mechanical: fill the descriptor, wire the two argv templates, keep
  every upstream behavior when the descriptor equals today's hardcoded
  values (the 'plain' fallback must remain byte-equivalent for POSIX hosts).
- The win32 test-lane exclusion (mirrored from upstream's own
  `vitest.config.ts` `windowsUnsupportedPackages`) gets revisited in T2/T3
  once an msys2 backend can actually serve POSIX-style tests on Windows.
- Descriptors make the terminal side (T4, `dsh-terminal-bash` shellPath/
  shellArgs Config) able to reuse the same declaration instead of
  duplicating path knowledge.

## T2 amendment (2026-09-30, human decision on #5)

T2's implementation supersedes part of the Decision/§5 blocks above; recorded
here rather than left as silent drift:

1. **Env layering (supersedes §5's literal spread order).** The human
   harmonized the #5-AC order ("caller wins over injected") with §5's intent
   (issue #5 comment 5902433252): plain variables layer
   `ENV_OVERRIDES → backend env → caller env → dshEnv` (caller beats the
   backend's plain keys); PATH is a **prefix-merge** — the backend's
   `pathPrefix` is prepended to the innermost layer's PATH
   (`dshEnv.PATH ?? env.PATH ?? inherited`), never a whole-key override (VS
   Code `addEnvMixinPathPrefix` pattern). `dshEnv` keeps its innermost win,
   including for PATH.
2. **Descriptor shape, phase-1 narrowing.** `executable` ships as
   `readonly string[]` (the `isUnsafe` variant returns when a backend needs
   it); `argv.interactive` is deferred to the PTY ticket (D3/T4) — only
   `oneShot` exists in T2; env `null`-deletes are deferred until a backend
   actually needs deletion (no msys2 key is deleted). A `pathPrefix` field
   (not in the original Decision block) carries the PATH prefix-merge per
   (1). `pathMapping` ships as declared but is not yet consumed by the
   executor; its consumer arrives with T3/T4 (cwd/paths across the shell
   boundary).
3. **uname AC fact.** Issue #5's "uname reports MSYS_NT" holds only under
   `MSYSTEM=MSYS`; under D1's UCRT64 injection a real MSYS2 reports the
   `MINGW64_NT` family (host-probed). Tests pin `_NT`-family + not-Linux.

## T3 amendment (2026-09-30, issue #6)

Recorded here rather than left as silent drift (same rule as the T2 amendment):

1. **`msystem` config renamed to `subsystem`.** The issue's domain word wins
   (`subsystem: 'none'` needed a home); values are injected `MSYSTEM` strings
   (default `UCRT64`, D1) plus the special `'none'`.
2. **`subsystem: 'none'` = the plain surface.** `resolveBackend` maps any
   `msys2` selection with `subsystem: 'none'` to the plain descriptor
   (`env {}`, no PATH prefix, identity mapping): Git Bash and Cygwin work
   through the same surface with zero MSYS injection. Fact established by
   host probing: Git for Windows bakes `MSYSTEM=MINGW64` into its own
   runtime (unsettable), so "no injection" is pinned at the descriptor seam,
   not by observing `$MSYSTEM` in-session.
3. **Auto-detection (`src/detect.ts`), VS Code `detectAvailableWindowsProfiles`
   pattern.** `msys2` without explicit `msysRoot`/`bashPath` probes
   `C:\msys64` then `${HOMEDRIVE}\msys64` (the VS Code `bash (MSYS2)`
   candidate, verbatim); a root qualifies only with `usr\bin\bash.exe`.
   Explicit configuration ALWAYS wins, even when wrong (compilerPath
   semantics) — a bogus explicit root fails its spawn rather than silently
   falling back to a detected root. The win32 plain surface resolves bare
   `bash` by PATH probe excluding the WSL `C:\Windows\System32\bash.exe`
   stub (CONTEXT.md fact 6), then ordered candidates: Git Bash
   (`Program Files\Git\bin|usr\bin`), Cygwin (`C:\cygwin64`, `C:\cygwin`),
   MSYS2 (`usr\bin\bash.exe`). Detection failure is loud, naming the config
   knob (`msysRoot`/`bashPath`) and every probed location; POSIX plain stays
   byte-equivalent bare `bash`.

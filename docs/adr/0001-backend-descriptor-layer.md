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

`dsh-shell-host` gets a declarative `BackendDescriptor` (T2 implements):

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

## T4 amendment (2026-09-30, issue #7)

Recorded here rather than left as silent drift (same rule as the T2/T3
amendments). T4 restores the phase-1 deferrals exactly as the T2 amendment
planned:

1. **`argv.interactive` ships.** The descriptor's argv carries both mode
   templates again (§4): `msys2` declares `['--login', '-i']` (D3; the VS
   Code `bash (MSYS2)` profile argv); the plain descriptor declares `[]` —
   a plain PTY starts bare bash (Git Bash's runtime bakes its own
   `MSYSTEM=MINGW64` and profiles already load, so forcing `--login` there
   adds nothing phase 1 needs; revisit with the pwsh/wsl backends).
   `expandOneShotArgv` stays the only consumer inside the executor's
   one-shot path; the interactive template is consumed by the PTY
   projection below, not by `execute()`.
2. **PTY projection on the executor.** `LocalBashExecutor` exposes
   `enginePath` (the resolved executable, `resolveExecutable` semantics) and
   `engineArgs` (the resolved `argv.interactive`) — the same member names the
   `dsh-bash-native` preset demonstration uses, so a
   `@deepseek-ai/dsh-terminal-bash` row reads
   `ctx.get('shell')?.enginePath / engineArgs` without backend-specific
   knowledge. Resolution errors stay loud (the getter throws) — a
   misconfigured backend can never silently start a wrong PTY shell.
3. **The preset is a bundle patch, not executor code.** The agent preset
   (`Native MSYS2 Bash`, id `shell-host`) is a `cordis.patch.yml` inserted
   via the package's `dsh.bundle.patch` field, mirroring the
   `dsh-bash-native` full preset's row set (D5): persona +
   agent-instructions, one `isolate: { shell, terminals }` group carrying
   the `dsh-shell-host` executor (default config: `backend: 'msys2'`),
   `dsh-terminal` + `dsh-terminal-bash` (`shellPath`/`shellArgs` from the
   projection above, `inject: [shell]`), the bash tool (persistent
   alternative disabled), file/search/job/skill/goal tools, and the
   plan/compaction/delegation groups. The patch is additive only — no row
   another preset owns is reconfigured or disabled, and the preset never
   touches `agent-preset-registry`.
4. **The PTY row's expressions fail loudly (review finding, 2026-09-30).**
   The `dsh-terminal-bash` `shellPath`/`shellArgs` expressions throw when the
   realm's executor resolved no `enginePath`/`engineArgs` instead of the
   `?? ''`/`?? []` fallback the `dsh-bash-native` demonstration uses — a
   silent fallback would let the terminal plugin start its own default shell,
   the exact wrong-PTY outcome §2 rules out. A `tests/descriptor.spec.ts`
   block pins the patch structure (single additive preset row, backend
   selection, loud expressions) as the in-repo drift alarm until #8's live
   E2E; the `enginePath`/`engineArgs` double `resolveBackend` call is a
   recorded non-issue (two fs probes per terminal-row evaluation, memoized
   only if ever measured to matter).

## T5/D8 amendment (2026-09-30, issue #8 — human-approved direction revision D8)

Mid-T5 the delivery shape pivoted (CONTEXT.md D8): the additive `Native
MSYS2 Bash` preset is replaced by a HOST-PLANE replacement of the built-in
platform shell executors. This section supersedes the additive-only and
single-preset pins in T4 §3/§4 above.

1. **Host-plane replacement.** The patch disables `pwsh-sandbox` (it yields
   the Windows platform-shell role) and re-asserts `bash-sandbox`'s win32
   disable (a base semantics flip cannot sneak the WSL stub back); both are
   win32-guarded and dormant on POSIX. It inserts this executor as the host
   `ctx.shell` row (`shell-host`; default `backend: 'msys2'`,
   `subsystem: 'UCRT64'`). The seam allows exactly one provider per
   composition, so every preset's `tool-bash` resolves this executor —
   loaded once, effective everywhere. The T4 preset row set is removed BY
   DESIGN; the session-picker entry disappearing is the pivot itself, not a
   regression.
2. **terminal-controller override (sidebar USER terminal).** The default
   shell becomes the install-probed MSYS2 bash with `['--login', '-i']`
   under a visible name, and the bare `bash` candidate is pruned (the host
   PATH has no MSYS2; bare `bash` resolves only to the WSL stub). No
   install → no profile → upstream discovery stands (loud absence, probe
   order shared with `src/detect.ts`).
3. **`name:` guards on every override row** (review finding). The three
   override ops carry the base rows' `name` values; under loader patch
   semantics `name` is a validation guard, so a base-side rename makes the
   op skip loudly instead of silently reconfiguring whatever row took over
   the id. The descriptor suite pins the guard strings verbatim.
4. **Known trade-offs, recorded rather than silent.** (a) The web-app
   `standard`/`minimal` presets' win32 `pwsh` tool now hands its command
   text to bash (the seam has no dialect translation, by upstream
   contract); bash-dialect presets are the deployment answer. (b)
   `permission-presets` refuses to compose over a non-confining executor
   (`sandboxMode === undefined` is a hard misconfiguration there), so D8
   removes the `/permission` switcher on win32 — regression, NOT accepted:
   tracked as #10 (fixed by the ADR-0002 permission-presets fork). (c) The engine-side E2E
   checklist lives in an EXPLICIT lane (`pnpm test:e2e`,
   `vitest.e2e.config.ts`), honoring spec #1's testing decision that
   end-to-end acceptance stays out of the unit loop; the suite skips when
   no MSYS2 install is found.

## #3 amendment (2026-09-30, issue #3 — D7 phase 1.5: pwsh descriptor landed)

`pwsh` graduates from a reserved registry id to a first-class backend
descriptor (peer of `msys2`), filling the D7-reserved placeholder with no
destructive refactor. `'wsl'` stays reserved (issue #2, deferred).

1. **Argv conventions, surveyed from the upstream `pwsh-local` executor**
   (local harness checkout, tag `dsh-v0.2.0-rc.2` — `packages/shell/pwsh-local/src/index.ts`
   and `resolve.ts`; the primary source the Brief names). One-shot mirrors it
   verbatim: `-NoLogo -NoProfile -NonInteractive -Command` with the
   `ENCODING_PREAMBLE` (UTF-8 output pinning) riding line 1 of the command
   payload — Windows PowerShell 5.1 writes the OEM code page by default and
   would garble non-ASCII; pwsh 7 is unaffected. The command text stays ONE
   argv element (PowerShell parses it; no quoting layer). Interactive (PTY
   projection): `['-l', '-noexit']` — the `--login -i` analog. **Recorded
   caveat:** `-Login` requires pwsh ≥7.4, so an interactive terminal over
   the Windows PowerShell 5.1 fallback fails at spawn rather than silently
   dropping the flag (loud, not silent — consistent with this executor's
   contract).
2. **Deviations from upstream, each with a reason.** (a) Upstream
   `resolvePwshPath` falls back to a bare `pwsh` resolved through PATH; this
   executor REMOVES that fallback — absence fails loudly naming every probed
   location (`Probed: …`), the same no-silent-fallback contract as `msys2`.
   (b) The shared executor `ENV_OVERRIDES` keeps `TERM=dumb` (a POSIX
   concept upstream pwsh drops); it is inert in PowerShell and keeping the
   override set shared preserves the one-layering-order property (issue #5).
   (c) Upstream `pwsh-local` has no interactive template at all; ours is
   required by the PTY projection (`enginePath`/`engineArgs`).
3. **Discovery.** VS Code terminal-profile probe pattern, PS7 preferred:
   `%ProgramFiles%\PowerShell\7\pwsh.exe`, then every PATH entry's
   `pwsh.exe` (covers the Microsoft Store install; `setx` quotes stripped),
   then `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. The
   lstat-based `spawnableExists` predicate (surveyed from upstream
   `resolve.ts`) also backs `resolveExecutable`, so the Store app execution
   alias — where stat-based `existsSync` hits the target's ACL — resolves
   (observed live on the dev host).
4. **Environment & paths.** `env: {}`, `pathPrefix: []` (native Windows
   PATH surface), identity path mapping both directions — the shell is
   Windows-native; no `MSYSTEM`-like variables exist for this backend.
5. **Unconfined posture (semantic, not inherited).** This executor NEVER
   confines processes; a pwsh backend here is unconfined pwsh, unlike the
   upstream confining `pwsh-sandbox` executor D8 displaced. The maintainer
   ratified the non-confining posture in #10 (fix permission-presets over
   the non-confining executor rather than restore the confining one).
6. **Tests.** `tests/detect.spec.ts`: injected detection order matrix
   (PS7 root > PATH > WinPS 5.1; no-PowerShell → undefined, never bare
   name; probed-locations list pinned). `tests/descriptor.spec.ts`: public-
   boundary pwsh matrix (one-shot output/exit codes, argv conventions +
   live UTF-8 pin, env/pathPrefix/pathMapping assertions, enginePath/
   engineArgs, loud absence), skipping gracefully when no PowerShell is
   installed (same pattern as the MSYS-absent skips); `'wsl'` reserved-id
   regression re-pinned, with `'pwsh'` asserted absent from the reserved/
   unknown enumerations.

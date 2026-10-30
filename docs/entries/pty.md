> Extracted from the README (issue #28, ADR-0007). Back to the [README](../../README.md). 中文版：[pty_zh.md](pty_zh.md)。

## The `./pty` entry (issue #28, ADR-0007; seam-free since #61, ADR-0010)

`src/pty/` is the absorbed dsh-pty-session module (pure move from the
dsh-pty-session repo, anchored at `dsh-v0.2.1-alpha.1-r1` per ADR-0005): a
Layer 0, protocol-agnostic PTY session core — SEAM-FREE since #61
(ADR-0010): sessions are SELF-MANAGED on node-pty (Windows ConPTY) via
`src/pty/session-core.ts` — an owner-scoped registry (sessionId → live
session, owner binding, awaited dispose cleanup), per-session line buffers
with incremental read cursors, the #56 soft cap (`maxSessions`, default 8,
counted from the registry so an entry remount cannot reset it — the #62
root cause is structurally gone) and the opt-in per-session
`idleTimeoutMs` (auto-close on no new output). Six tools — `pty_open` /
`pty_send` / `pty_tail` / `pty_close` / `pty_list` / `pty_signal` — plus a
programmatic facade (`ctx.provide("pty")`) for consumer plugins. Persistent/
interactive session ownership (ADR-0004 decision 5) is unchanged, and the
entry keeps its own settings namespace (`dsh-pty-session` plugin name,
`maxSessions` + `tailLines` + `defaultShellCommand` config) — ADR-0007: sharing
the package does not merge config surfaces.

```js
import * as pty from 'dsh-shell-host/pty'   // { name, inject, Config, apply }
```

Mount it via the bundle layer with `name: 'dsh-shell-host/pty'` — no
dependency on any platform seam (the bundle patch mounts the pty + ssh +
terminal rows unconditionally).

### Session default shell (#149): declare once at open, then bare commands pass straight through

`pty_open` gains `shellCommand`: a string holding a **bare command** (an
executable plus its own interactive argv, e.g.
`<msys2>/usr/bin/bash.exe --login -i`). Once declared, the text written via
`pty_send` is **interpreted by it directly** — `cd` takes effect across
calls, pipes and `&&` work, and there is **no need** to wrap every command
in `bash -lc "…"`.

- **Mutually exclusive with `command`**: passing both = a loud error
  (`INVALID_ARGS`). Only when neither is given does the settings-side
  `defaultShellCommand` come into play; if the Config does not set it either
  ⇒ loud error, with the message naming all three options.
  **The priority chain = explicit `shellCommand` > explicit `command` >
  `defaultShellCommand` > error** — an explicit `command` is an ordinary
  process and **never takes** the global default (otherwise the global
  default would rewrite every existing call).
- **Zero vocabulary**: no new preset ids, no `shell: true` boolean added,
  and `shellCommand` does **not** go through launcher-preset resolution —
  even if the value looks like a preset id (`msys2-ucrt`), it is spawned as
  a **bare command**. The preset surface remains `shell_open` (division of
  labor: see the `./terminal` section).
- **Shell targets**: such a session is a **shell target** ⇒ `pty_signal`
  refuses `SIGKILL` (`SIGNAL_FORBIDDEN`, same wording as `shell_open`), and
  closing goes through `pty_close`. The counter-case is unaffected:
  `pty_open({ command: "bash" })` is **not** a shell target — the core does
  not guess from command-line text.
- **Platform differences (stated as they are)**: win32 = tokenized by
  `parseCommandLine` and spawned **directly** (no shell interpretation);
  POSIX = still `/bin/sh -c <shellCommand>`, i.e. **one extra `sh` parent
  process** (`pid` reports the `sh`). No new POSIX tokenization / quoting
  surface is added (that is exactly the complexity this issue rejected).
- **Cost (the cost of choosing an explicit command, not hidden)**: preset
  environment (`MSYSTEM` / `CHERE_INVOKING` / PATH prefix) is **not
  injected on this issue's behalf** — the caller owns it; if you want the
  preset environment, use `shell_open`. env/PATH is injected only **at
  spawn time** ⇒ a running session cannot switch environments.
- **Temporary switching (zero tool surface)**: send one line launching
  another interpreter inside the session to enter it, `exit` to return to
  the default — the state lives naturally in the PTY process tree, no state
  machine, no new parameter. For a **single command** form of one-shot
  invocation the caller writes its own dialect (`bash -lc` /
  `pwsh -Command` / `cmd /d /c`); the tools do **not assemble quotes on
  your behalf** (each dialect has different quoting rules).
- **Environment-detection context**: this entry registers **one**
  `systemPrompt.context` (`shell-host:environments`, order 130,
  `interpolate: false`), whose content = "preset id → resolved executable",
  letting the agent know which path to write into `shellCommand` instead of
  guessing. It is an **environment fact**, not an instruction, and does
  **not proactively start rounds**; it is **lazily computed on first
  assembly** and cached (win32 detection has to run `wsl.exe --list
  --quiet`, never synchronously inside `apply`); when no environment is
  available the whole line is **not injected** (it does not say "none").
  Registration goes through a **child fiber**
  (`ctx.inject(['systemPrompt'], …)`, cordis's child-fiber entry): `./pty`'s
  **tool surface never waits on** the prompt surface — a tools-only
  composition without a prompt registry still gets the six tools; and a
  registry attached **later** still receives this context (an opportunistic
  `ctx.get` read would miss that mount order).

```js
// 声明一次，之后裸命令直通
const s = await pty_open({ shellCommand: '<msys2>/usr/bin/bash.exe --login -i' })
await pty_send({ id: s.sessionId, data: 'cd /c/work && ls | head -3' })   // 无包装、无包装回显
```

**Noise readings (#149 AC2, real ConPTY / win32, N=3; carried by
`pty-shell-machine.spec.ts`)**: the same payload — "one `pty_open` per
command" = 3 sessions / 9 initialization escape sequences / **126 bytes**;
"one persistent shell session" = 1 session / 20 sequences / **566 bytes**;
bytes the caller must write per command **55 (wrapped string) → 22 (bare
command)**. **Told as it is**: a persistent **interactive** shell has a
**larger** byte reading — the prompt and command echo are terminal
semantics, not the noise this issue set out to remove; what this issue
removes is "one session per command + one PTY initialization + one shell
startup" and the fact that **the echo no longer contains the wrapper
string**.

### `initialOutput` may be empty (#154): the ConPTY first-quiet-window and the correct way to take readings

**Fact: under a real ConPTY, the `initialOutput` returned by `pty_open` is
often an empty string, and this is not a defect.** The cause lies in the
core's initial settle (`src/pty/session-core.ts`): after opening a session
it first waits for an **output-quiet window** (default
`DEFAULT_SETTLE_QUIET_MS = 150`, returning once 150 ms pass with no new
bytes; there is also a 2s hard ceiling against hanging), while ConPTY's
initialization escape sequences and the shell banner often arrive **after
the first quiet window** ⇒ they do not land in `initialOutput` but in the
**next** `pty_tail` page (the tail cursor starts from lines already present
at open time, so later-arriving bytes are all readable). The
`autoClose: true` one-shot form is unaffected — it waits for real exit and
then runs one more quiet window, so buffered output lands in
`initialOutput` (see the previous section, #146).

Measured readings (collection environment: file sandbox =
`danger-full-access`, no approval prompts, real ConPTY / win32):

- `#149`: `shell initialOutput bytes = 0`; the delta immediately following
  in the same log carries `ESC[?9001h…` and the bash banner
  (`.scratch/149-probe.log`).
- `#147` reading A: `pty_open { command: 'node -e "setInterval(() => {}, 1000)"' }`
  returned `{"initialOutput":""}` (transcript `.scratch/t147-pty-crosscall.md`).

**The correct way to take readings: to measure "startup output" (banner /
initialization escapes / prompt), do not read `initialOutput` — poll with
`pty_tail` in a subsequent tool call.** Reproducible steps (at minimum two
tool calls; record the collection environment alongside):

1. `pty_open { command: 'node -e "setInterval(() => {}, 1000)"' }` (or any
   session that will produce a banner) → note the returned session id;
   **`initialOutput` being `""` at this point is expected** — do not use it
   to assert "no output".
2. In a **separate** tool call, `pty_tail { id }` → the banner and the
   initialization escapes (`ESC[?9001h…`) are in that page; if not yet,
   wait a beat and `pty_tail` again until you read the needle you want.
   (A child process producing no output at all reads back an empty delta
   and is also a normal return — the same wording as the cross-turn
   survival readings in [docs/dev-environment.md §4.6](../../docs/dev-environment.md).)
3. Finish with `pty_close { id }`.

**This issue changes no semantics**: no "start the settle at first output"
switch is added, and the settle default is not changed — if you want that,
file a separate issue (it would touch default behavior / the timeout
ceiling / `shellCommand` interaction and mutation verification).

### pty_list / pty_signal (#119)

Completes tool-surface coverage parity with the official `terminal_list` /
`terminal_signal`. Both act **only on sessions held by the calling agent
itself** (the data source is the core's owner registry — the same posture
as `pty_close`'s `SESSION_OWNED`): `pty_list` lists only your own (other
agents' sessions never appear in the result); `pty_signal` returns
`SESSION_OWNED` for anyone else's id and `NO_SESSION` for an unknown id,
with **ownership checked before signal-name validation** (someone else's id
paired with an invalid signal name still only yields `SESSION_OWNED`).

- **`pty_list`**: each row `{ id, status, pid? }`, **stable order =
  creation order** (sorted by the numeric suffix of the id; lexicographic
  order goes wrong from the 10th session on — `pty-10` would sort ahead of
  `pty-2`). Sessions that have exited but are still held are listed as
  usual — the persistent-session contract is that only `pty_close` reclaims.
- **`pty_signal`**: the whitelist matches the official one (`SIGINT` /
  `SIGTERM` / `SIGKILL` / `SIGTSTP` / `SIGHUP`). **Platform semantics and
  code share the same constant** (`PTY_SIGNAL_SEMANTICS`, exported from
  `src/pty/session-core.ts`; the tool description quotes it verbatim, and
  this section's trade-offs come from the same source):
  - **POSIX**: `process.kill(-pid, signal)` delivers to the session's
    **process group** (a forkpty child is a session leader, so its pid is
    also its pgid) — real signal delivery, best effort. The **foreground
    process group cannot be addressed** (Node exposes no `tcgetpgrp`): an
    interactive shell that puts its foreground job in a separate group is
    not reached; in that scenario use `pty_send` with `"\u0003"`
    (Ctrl-C, delivered by the terminal driver to the foreground group).
  - **Windows / ConPTY**: node-pty's `kill(signal)` on Windows throws
    outright — "Signals not supported on windows." (excerpt preserved in
    the landing doc's evidence carrier), **only terminate semantics
    exists** ⇒ only `SIGTERM` / `SIGKILL` are accepted, and both mean
    **terminate the session** (the ConPTY process tree is torn down);
    `SIGINT` / `SIGTSTP` / `SIGHUP` are **refused loudly**, with no silent
    mapping. This is a platform fact; no pretense of POSIX equivalence.
  - **`SIGKILL` is refused for shell targets across the board** (official
    same semantics: on POSIX a hard-killed shell's children cannot be
    reclaimed) — use `pty_close` for the full close path instead. On
    Windows any deliverable signal is already a whole-process-tree
    teardown, so there the **proper way to end a shell session is
    `SIGTERM`** (`SIGKILL` is still refused by its official name).
    **"Shell target" is declared by the opener**, via two paths:
    `shell_open` (launcher presets, `./terminal`) passes `shell: true`,
    and `pty_open({ shellCommand })` (#149) is likewise marked a shell
    target (the result surface shows it both ways: `shell_open` returns
    `preset`, `pty_open` returns `shellCommand`). The core **does not guess
    from command-line text**, so `pty_open({ command: "bash" })` is not a
    shell target — if it cannot be guessed reliably, do not guess (the
    boundary lives in `OpenSpec.shell` in `src/pty/session-core.ts`).
    ssh sessions are likewise **not** shell targets: their local top-level
    process is the ssh client, not a shell, so `SIGKILL` there is a
    legitimate hard disconnect.
  - Delivery **does not close the session by itself**: after the signal,
    read the aftermath with `pty_tail`, then reclaim with `pty_close`
    (idempotent). Note that a session with `idleTimeoutMs` that stops
    producing output because of the signal **may still be reclaimed later
    by the idle watcher** — that is the idle policy, not `pty_signal`
    closing it.

### Background sends (#120): `run_in_background` wired to the host jobs stack

`pty_send` / `ssh_send` gain one more parameter, `run_in_background?:
boolean` (only `true` recognized). **The foreground path is unchanged** —
without the parameter it is the original "write + await settle (150 ms
quiet window, 2000 ms hard ceiling) and return `{ delta, status }`".

With `true`, it **does not wait for settle**: it immediately returns
`{ kind: 'background', jobId }`, handing the work to **the host's existing
background-jobs stack** — `job_output` collects output, `job_kill` cancels
(the job record carries `kind: 'pty-send'`, `label = '<sessionId>: <text>'`,
`toolCall`, `owner = the owning session id`, a 256 KiB `outputLimitBytes`,
and one output-pull source).

**The two packages are a pair; missing either is a dead end** (verified
against source, `0.2.1-rc.2`): `@deepseek-ai/dsh-jobs` is only the abstract
seam — its `start` **refuses outright when no attached controller serves
that owner**; `@deepseek-ai/dsh-tool-jobs` is that controller
(`attachController`) + `job_output` / `job_list` / `job_kill` + completion
delivery. So the error when `ctx.get('jobs')` yields nothing **names both
packages**, and there is **no silent fallback to the foreground**;
`./pty`'s `enableRunInBackground: false` likewise refuses loudly (the
parameter is not even listed on the tool surface).

- Cancel = ending the settle early: `job_kill` goes through the abort
  signal core `send` has already accepted; the job lands
  `{ status: 'killed', detail: 'cancelled after N bytes read' }`; normal
  completion lands `completed`.
- Output = the delta produced by this send **during the settle window**
  (the reply of core `send`), handed by the job's output source to
  `job_output` (each read consumes the delivered bytes; the cursor is
  monotonic).
- Result surface: the background form only reports
  `started background job <jobId>` (card switches to `generic`); the
  foreground form is verbatim unchanged.
- **No controller is built here, and no `job_*` tools are duplicated**:
  that is the host's capability; this package only wires it up (the
  dependency-surface exception accounting lives in
  [docs/dev-environment.md §4.4](../../docs/dev-environment.md) and ADR-0005
  decision 7).

### Presentation metadata (#121): `presentationMeta` into `result.meta`; `presentResult` is not wired

**Feasibility reading (step 1 of the ticket)**: the built-in Web Client's
tool cards key-match **by first-party wire tool name** in the
`tool.call.toolview` slot (no key falls to the generic card), and
client-ui-tool states plainly that "Host `presentCall` / `presentResult`
values do not reach the Client" ⇒ third-party plugins **cannot reuse**
`card: 'terminal'`, and wiring `presentResult` would be **zero benefit**
for the Web UI (the official `terminal_send`'s copy is likewise only fed to
the host's local consumers). ⇒ This issue wires only `presentationMeta`:
the host side projects it into `tool/result.meta` (persistent, preserved
verbatim in replay), with the consumption surface = session event stream /
replay / PTC dispatch logs; Web cards remain generic for this repo's tool
names (known boundary, unchanged).

- **`pty_send`**: projects the foreground `{ delta, status }` (same posture
  as the official `terminal_send`'s "structured readings in the foreground,
  `null` in the background"); `pty_tail` projects page facts
  `{ lines, truncated }` (not copying the body); `shell_open` projects
  preset-resolution facts `{ preset, source, executable, probed, cwd,
  overrode }`.
- **Zero model-surface change**: `output.schema` / `output.render` are
  untouched verbatim — the metadata is purely presentational and does not
  enter model context (the PTC path writes only the meta of the
  `tool/ptc-dispatch` event, see
  [docs/research/research-ptc-third-party-tools.md §1.4](../../docs/research/research-ptc-third-party-tools.md)).
- **`finalizeContent` not aligned** (assessed along the way per the
  ticket): the official `maxResultBytes` is a byte ceiling on rendered
  text; this repo's output **is already capped per structured surface**
  (the settle window is bounded, `pty_tail` has a lines budget + a
  scrollback ceiling, and #162's cutoff watermark truncates one-shot
  results); stacking one more ceiling would only change the semantics of
  model-visible content (at odds with #162's "distinguish real output from
  truncation residue by construction"), and the benefit is not
  proportional — not done.

### One-shot commands (#146): `autoClose` waits for real exit and reports the real exit code; Windows has no shell interpretation

Two pieces missing when `./pty` is used as an **exec surface**, filled in
by this issue:

- **Exit code**: `pty_open({ command, autoClose: true })` now **waits for
  the process to actually exit** before returning — after exit it runs one
  more quiet window (buffered output lands in `initialOutput`), and the
  result's `status` is then `{ kind: 'exited', exitCode }` (the same shape
  `pty_list` / `pty_send` use; both fields are declared in the output
  schema). The session is then reclaimed as usual via the single close
  path (no `pty_close` needed; the soft-cap slot frees itself). **Abort**
  only stops the **waiting** and does not kill the process; in that case
  the result carries no exit code.
- **`shellCommand` is not one-shot**: a session-level shell is by design
  long-lived (the close path = `pty_close`), so passing `autoClose: true`
  together with a shell declaration (`shellCommand` / the configured
  `defaultShellCommand`) is **refused loudly** (`INVALID_ARGS`) — otherwise
  the call would wait on a process that never exits. For "one-shot + shell
  semantics", write the whole line into `command`
  (`cmd.exe /d /c "…"` or `bash -lc "…"`).
- **Command semantics (single source for the agent surface)**: the
  `pty_open` tool description and the `command` parameter description
  **quote verbatim** the same constant `PTY_COMMAND_SEMANTICS` — win32 is
  **spawned directly after argv tokenization** (argv[0] is the executable);
  `&&`, pipes, redirection and shell built-ins are **NOT interpreted**;
  name the shell explicitly (`cmd.exe /d /c "…"` or `bash -lc "…"`);
  POSIX still rides `/bin/sh -c`.
- **Readable diagnostics**: a win32 spawn failure (the ConPTY original
  `File not found: ` which **names nothing**) is now rethrown naming
  argv[0] (and the path rewritten by `resolveExecutable`) plus a hint
  pointing straight at the fix (`code: 'SPAWN_FAILED'`, the original kept
  in `cause`). It lands in the wrapper layer of `defaultSpawnPty`, not the
  tool layer (the `#67` path).

Real ConPTY reading carrier: `tests/pty-oneshot-machine.spec.ts` (one case
each for exit codes 0 / non-zero + a built-in-command diagnostic).

### Hard deadline (#159): one-shot exec defaults to 600s, preventing an infinite hang waiting on input

The `pty_open({ command, autoClose: true })` call itself now has a **hard
wall-clock deadline, on by default and adjustable** (covering the **entire
tool call** — the initial settle plus waiting for exit all count):

- **Priority**: per-call `deadlineMs` > the `./pty` config's `deadlineMs` >
  default **600000ms** (10 minutes, single source:
  `DEFAULT_DEADLINE_MS` in `session-core.ts`; the tool description body is
  interpolated from that constant). `deadlineMs: 0` = **explicitly off**
  (the default is finite; turning it off must be passed explicitly — there
  is no silent infinity). Illegal values (non-integer / negative) are
  **refused loudly** on both the tool surface and the config surface.
- **Total-duration accounting**: continuous output, log tails, and the
  settle window's early return **neither reset nor defer it** — this and
  #56's opt-in `idleTimeoutMs` (output-defined idle) are **two independent
  mechanisms**, with names that do not shadow each other.
- **Expiry action**: kill the session's **OWN** process tree — POSIX sends
  SIGTERM to the process group first, then a group SIGKILL hard kill after
  a grace window (default 2s); Windows/ConPTY has only the tree-termination
  lever and terminates immediately. **Other owners' sessions are never
  touched**; cleanup goes through the single close path, idempotent.
- **Result semantics**: returns `timeout: true` + the captured output
  (`initialOutput`) + the **real exit code** in `status` (given only if the
  process actually reported one; a deadline kill never fabricates a success
  code). Abort is a separate escape hatch and **never** carries the
  `timeout` marker.
- **Output cutoff watermark (#162)**: a `timeout: true` `initialOutput` is
  **cut at the moment the kill sequence starts** — termination-race residue
  (the tree teardown kills the direct children first; the killed shell runs
  one more command before it dies, e.g. the `T1_LEAK` kind) happens
  causally after the kill and **does not enter the result**; the caller can
  therefore reliably distinguish "the command's real output" from
  "termination residue", with the same accounting on both platforms. The
  settle window still drains the exit event as usual (the real exit code in
  `status` depends on it); only the residue no longer appears in the
  returned text.
- **Boundary (written down)**: the deadline governs the **tool call**, not
  persistent sessions / REPLs / watchers — that is #56's opt-in idle
  territory (stated plainly in the `shell_open` description too); a PTY is
  a byte stream with no command-boundary protocol, so **individual shell
  commands inside a persistent session are not assumed to be precisely
  timeable**. Passing `deadlineMs` to a persistent open is refused loudly.

Unit reading carrier: `tests/pty-deadline.spec.ts` (fakes for a
stdin-waiting case / a continuously-outputting non-exiting case / a long
task with an explicit extension / a normal fast command, all bounded).

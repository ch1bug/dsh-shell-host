> Extracted from the README (issue #136, ADR-0016). Back to the [README](../../README.md). 中文版：[ssh_zh.md](ssh_zh.md)。

## The `./ssh` entry (issue #136, ADR-0016 Q1)

`src/ssh/` is the INTERACTIVE full-duplex ssh instance as its own component
(#136 split it out of `./pty`): `ssh_start` / `ssh_tail` / `ssh_send` /
`ssh_close`, opened on the `./pty` entry's session core — the returned
sessionId IS a core session id, so `pty_send` / `pty_tail` / `pty_close` /
`pty_signal` still operate it (one registry, unchanged).

```js
import * as ssh from 'dsh-shell-host/ssh'   // { name, inject, Config, apply }
```

Independent settings namespace (`ssh`) with the ssh family's own
`enableRunInBackground` (the background-send section below describes the shared
path).

**Migration (profiles that only mount `pty` lose the ssh tools)**: before
`#136` the four `ssh_*` tools were part of the `./pty` row; now only mounting
the `ssh` row gives you them. On upgrade, a legacy profile that only mounts
`pty` **loses all `ssh_*` tools** (`pty_*` unchanged) — add one line to your
own profile patch (the general migration notes live in *The bundle patch*,
["how to install, how to add rows" (#142)](../../README.md#the-bundle-patch);
this section carries the must-know
details):

```yaml
- insert:
    - id: ssh
      name: dsh-shell-host/ssh
```

The same migration includes two **surface narrowings** (both written here so
you don't step on them):

1. The `./pty` module **no longer exports** the ssh composite symbols
   (`composeSshCommand` / `SSH_KEEPALIVE_*` / `SshOption*`) — they moved with
   the component to `src/ssh/compose.ts`; code that imports these symbols by
   name from `dsh-shell-host/pty` will get `undefined`, point the imports at
   the new module.
2. The `pty` namespace's `enableRunInBackground` **now only governs `pty_send`**;
   to turn off ssh's background sending, configure it on the `ssh` row
   (default true; deployments that don't configure it see zero change).

```yaml
- insert:
    - id: ssh
      name: dsh-shell-host/ssh
```

`ssh_start({ host, jump?, shell? })` composes the ssh command line
(`host`/`jump` are argv atoms — no whitespace/shell metacharacters) and opens it
on the core PTY; the three passthroughs reuse the core's cursors and reads
verbatim. **Single source of truth for composition**: `src/ssh/compose.ts`
(keepalive defaults / `port` / `-o` passthrough / argv composition) — the
`./terminal` entry's ssh transport dimension consumes the same source, with
behavior verbatim-identical to pre-#136.

The remote one-shot division of labor follows the ADR-0016 revision: single
executions use `dsh-ssh`'s `ssh_exec`, and this package adds no one-shot tools.
The former standalone `dsh-shell-remote` (route C) is historical division of
labor only; `ssh_start` remains for sessions a human/agent converses with
(long-lived remote shell, intermediate output via the tail cursor).

Long-session hardening (#21 phase 1):

- `ssh_start({ ..., port })` — non-standard remote port, passed as `-p`
  (integer 1..65535; `user@host:port` is NOT valid ssh syntax).
- Keepalive defaults ride on every start: `-o ServerAliveInterval=15 -o
  ServerAliveCountMax=4` — without them, NAT/firewall idle drops kill
  sessions silently. (Single source #49: exported as
  `SSH_KEEPALIVE_INTERVAL_DEFAULT` / `SSH_KEEPALIVE_COUNT_DEFAULT` from
  `src/ssh/compose.ts` — code, tool description, and tests derive from there.)
- `ssh_start({ ..., options })` — free `-o` passthrough for remote-workspace
  capabilities building on this surface (#50, additive dual shape per entry:
  an atomic string — `"Key=value"` or a valueless `"Key"`, no whitespace —
  or a structured `{ key, value? }` whose value may carry spaces and is
  POSIX-quoted into one shell word, e.g. `ProxyCommand`). An option whose
  key is `ServerAliveInterval` / `ServerAliveCountMax` suppresses its
  default (exact key match).

**Transport shape (ADR-0017, interface in `src/ssh/transport.ts`)**: in v1,
**every** client uses "one independent connection per session" — the
`ssh_start` result carries a `transport` structured fact
(`shape: "per-session-connection"` + `controlMasterUsable`), which the remote
workspace uses to answer "which shape does this session take". **Windows
clients cannot use ControlMaster** (measured: both the socket and the fd
fail) ⇒ there we **never** do "try master first, then fall back" (that would
add one failed log line per session). On POSIX clients it is only
ADR-0017 **decision 2** that gives the master+channel shape — that path lands
with the remote workspace (#137); this ticket is a **refactoring ticket** and
does not change the open-session path, so what the result faithfully reports
is always the **actual shape** (today = one connection per session), never a
"possible shape".
**The remote login shell must be POSIX-family** (probed at session open via
`uname` / `$SHELL`; non-POSIX is loudly refused with the reason named);
**Windows remotes are explicitly unsupported in v1**. The probing/refusal for
these two lands with the remote session open path (#137+); this ticket only
carries the interface and the contract.

Reconnect semantics: **RECONNECT-NO, explicit** — a dropped session (network
cut, remote drop) surfaces `status.kind = "exited"` on the next send/tail;
nothing auto-reconnects. Recovery = `ssh_start` again (new session id); the
dead id is reclaimed by `ssh_close` (idempotent).

Live verification (machine lane): `tests/ssh-pty-live.spec.ts` runs the full
start → interactive → incremental tail → close round-trip against a real
host; it is gated on `DSH_SSH_LIVE_HOST` (optionally `DSH_SSH_LIVE_JUMP`)
and skips loudly when unset — no network in the default test lanes.

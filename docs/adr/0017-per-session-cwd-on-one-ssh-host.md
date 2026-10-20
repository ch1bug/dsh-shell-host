# ADR-0017: Per-session cwd on one ssh host — the client platform decides the transport shape

- Status: **Accepted**
- Date: 2026-10-20
- Deciders: human (sign-off 2026-10-20, after the `#150` AC3 probes and the
  alternatives section below). Every decision here cites a measured reading; the
  scope choices are the human's.
- Context: ADR-0016 (decision 5 "remote commands run in a workspace session",
  decision 6 "sessions bind the LOCAL anchor as `cwd`", decision 8 "one channel
  per host"); `#150`; `#149` (session default shell, the local analogue);
  `#136` (ssh as its own component) and `#141` (sshd fixture).
- Revision: **this ADR revises ADR-0016 decision 8's wording** (see Decision 5).
  ADR-0016 decisions 5/6/7 stand.

## Context

ADR-0016's decision 8 puts the remote workspace service in charge of "one channel
per host, ref-counted by workspace/session", and decision 5 runs remote commands
inside a persistent PTY session. Taken together, several logical sessions end up
behind ONE remote shell — and a shell's working directory is mutable state. One
`cd ..` in one session silently moves every other session's reference path, and
nothing reports it: the next command merely runs somewhere else, and the damage
surfaces only when a file lands in the wrong place (`rm -rf` needs one occurrence).

`#150` asked how sessions sharing one ssh connection can each work in their own
directory. Its AC3 required measurements before any decision, because the
"obvious" answer (ssh connection multiplexing) is a platform-dependent claim.

## Measured facts (2026-10-20; readings in `#150`'s two probe comments)

1. **ControlMaster works from a POSIX client.** OpenSSH 9.6p1: master created,
   `-O check` → "Master running", two channels over one master, and the second
   channel's `pwd` was still `/root` after the first channel did `cd /tmp` ⇒ each
   channel gets its own shell, so **per-session cwd is free** when multiplexing is
   available.
2. **ControlMaster is not usable from the Windows client.** `OpenSSH_for_Windows_9.5p2`
   fails in all three shapes tried (`-M -S <path>`, `-o ControlMaster=yes -o
   ControlPath=<path>`, default path) with `getsockname failed: Not a socket`, and
   no control socket is created.
3. **tmux works, but reading output back is not free.** tmux 3.4 (apt, Ubuntu 24.04)
   tracks each session's cwd natively (`#{pane_current_path}` = `/var` and `/etc`
   after separate `cd`s), but `capture-pane` returns the RENDERED screen — raw
   `^MAB^MC^M` displays as `CB`, and the command echo is included — while
   `pipe-pane` preserves raw bytes only at the cost of a remote writer plus a
   read-back hop. Windows remotes have no tmux at all.
4. **A POSIX-build client on Windows does not rescue multiplexing.** msys2's
   OpenSSH 10.6p1 creates the control socket and even reports "Master running",
   but every session request fails with `mux_client_request_session: read from
   master failed: Connection reset by peer` and falls back to a direct connection
   (the multiplexer has to pass the connection fd between client processes —
   `SCM_RIGHTS` — which the cygwin/msys AF_UNIX emulation does not carry here).
   ⇒ "just require the POSIX-family client" is not a fix on a Windows host.

## Decisions

1. **Per-session shell is the invariant.** cwd isolation is obtained by giving each
   logical session its own remote shell; it is **never** obtained by bookkeeping
   `cd` state inside one shared shell. Rejected: prefixing commands
   (`cd <session-cwd> && …`) and scraping `pwd` back, because (a) it cannot work
   for interactive commands (REPL, editors), (b) it adds bytes and echo noise to
   every command — the opposite direction from `#149`, and (c) a background `cd`
   makes the scraped `pwd` a lie.
2. **POSIX clients: ControlMaster** — one TCP connection and one auth per host, one
   channel (and therefore one shell) per session. Measured to work.
3. **Windows clients: one connection per session** — multiplexing is measured
   unusable there, so sessions skip it; each session pays its own handshake. The
   accepted cost is auth/handshake per session; the benefit (per-session cwd) is the
   same invariant as decision 2. Note that switching to a POSIX-build client does
   NOT change this (measured: msys2 OpenSSH 10.6p1 fails at the fd-passing stage) —
   the workaround is not "use a POSIX client", it is "one connection per session",
   or decision 4.
4. **The remote multiplexer (tmux) is an opt-in, not the default.** Use it only
   when one connection MUST carry several sessions and output must be framed per
   session. It is not the default because it needs a remote dependency (absent on
   Windows targets) and its read-back either loses raw bytes (`capture-pane`) or
   needs a remote writer plus a hop (`pipe-pane`). Whenever raw bytes matter,
   `pipe-pane` is the only acceptable read path — `capture-pane` breaks the
   byte-incremental contract `pty_tail` is built on.
5. **Revision of ADR-0016 decision 8**: "one channel per host" becomes "**one
   transport per host where the client platform supports multiplexing; otherwise
   one connection per session**". The ref-counting unit is a **connection**, not a
   host, so the workspace service must know which shape it is in (and the client
   platform capability must be probed once and cached).
6. **The remote login shell must be POSIX-family** (sh/bash/zsh/fish …; never
   `cmd.exe` / `pwsh`). This is the ORIGINAL question ("force POSIX on the ssh
   side") moved to the side where it is load-bearing: the remote, not the client.
   It buys three things — a single `cd`/`pwd`/relative-path semantics for the
   per-session cwd invariant; the remote file face and the command face share one
   vocabulary (POSIX `ls`/`stat`/`mv`/`sh`); and one fewer dimension to partition,
   because "remote is Windows" drops out of scope instead of growing a second cwd
   contract. Windows remotes (OpenSSH Server on Windows) are therefore **out of
   scope for v1** — not a capability claim but a scope decision: supporting them
   needs its own path/`cd` semantics, and there is no measured demand yet. The
   revisit condition is a real Windows-remote use case (then it gets its own ADR,
   not a quiet extension of this one).

## Alternatives and deferred paths

Every shape below was considered against the same requirement — several sessions,
each in its own directory, without silent cross-talk. Ordered by cost.

- **Rejected: `cd` bookkeeping inside one shared shell.** Covered by decision 1:
  it cannot serve interactive commands and it lies after a background `cd`.
- **Rejected: "rescue multiplexing by using a POSIX-build client" on Windows.**
  Measured: msys2 OpenSSH 10.6p1 creates the control socket and reports a running
  master, but every session request fails (`mux_client_request_session: read from
  master failed: Connection reset by peer`) because the multiplexer must pass the
  connection fd between client processes and the cygwin/msys AF_UNIX emulation does
  not carry it. A POSIX host is a different story (its client works — fact 1).
- **Deferred path P1 (cheapest if connection sharing is ever required on Windows):
  host the ssh client in WSL / a container.** Measured working: the master lives in
  WSL and the Windows side drives the same master with one `wsl -e ssh -S …` per
  channel — channel 1 reached `/tmp` after its `cd`, channel 2 still reported
  `/root`. Costs: a WSL/container dependency and one extra process hop per call;
  buys: no new protocol, no remote install. It stays **opt-in**, never the default.
- **Rejected as insufficient: a local broker daemon that only pools connections.**
  One connection still carries exactly ONE remote shell, so cwd is still shared.
  Per-session shells need a remote counterpart — a local-only helper cannot supply
  the invariant.
- **Deferred path P2: a remote framed multiplexer** (the mosh / editor-server
  direction). It delivers one connection + one shell per session + per-session
  output framing. Cost: a protocol of our own plus, most likely, a remote install —
  which collides with ADR-0013's zero-install orientation; ADR-0016 decision 2
  already fixes the order ("a zero-install `sh` frame loop first, then a node
  helper"). Not before a use case demands framing across sessions.
- **Deferred path P3: tmux on the remote.** Measured: per-session cwd is native
  (`#{pane_current_path}`) and output is framed per pane, but read-back is not free
  (`capture-pane` renders and echoes; `pipe-pane` keeps raw bytes at the price of a
  remote writer plus a hop). Costs: a remote dependency absent on Windows targets.

Recommended order when the need appears: **P1 → P3 → P2**. Until then the Windows
shape is one connection per session (decision 3), which already delivers the
per-session cwd invariant; only the connection-sharing optimization is missing
there.

## Consequences

- The remote workspace service needs a client-platform capability probe
  ("is ControlMaster usable?") — cached, failing open to the per-session
  connection shape.
- The ssh/remote entries must **refuse a non-POSIX remote login shell loudly**
  (a probe at session open: `uname`/`echo $SHELL`, not a guess from the host
  name), because decision 6 makes POSIX the contract. The `./ssh` and `./remote`
  READMEs state the boundary: **Windows remotes are not supported by the remote
  workspace**.
- Channel/connection accounting moves from per-host to per-connection; what
  `remote_status` reports (counts, reconnect scope) follows.
- On a Windows client, a dropped connection blasts the sessions bound to that
  connection (there is no shared master to keep alive); on a POSIX client one dead
  master drops every channel at once. Both are bounded-reconnect cases, not
  silent stalls.
- `pty_tail`'s byte-incremental contract stays intact in every shape: the read path
  never renders. The tmux shape must use `pipe-pane` whenever bytes matter.
- Fixtures: an sshd harness must avoid port 2222 (a podman publish shadows it under
  WSL mirrored networking — measured) and, on Windows, needs a Windows-reachable
  sshd (the podman machine's own sshd is one).
- If P1 (WSL-hosted client) is ever adopted as an opt-in transport, it must be
  visible in `remote_status` — a session silently running over a WSL hop would
  make "why is this slow / where did my socket go" a support case instead of a
  config fact.

## Evidence

`#150` carries the probe comments (commands, readings, and the environment facts);
the full local logs stay in `.scratch/` and are not committed. This ADR states no
claim that is not in those readings.
# ADR-0004: Remote execution lives in its own repo (dsh-shell-remote)

- Status: Accepted (design output of #16 grill, 2026-10-03)
- Deciders: human (grill session 2026-10-03, Q1–Q9)
- Context: #16 (remote/ssh anchor ticket), ADR-0003 decision 2 (registry is local-machine-only), ADR-0001 descriptor vocabulary, CONTEXT.md D8/D9
- Anchor of: #16 (transferred — implementation mirror ticket opens in dsh-shell-remote)

## Decisions

1. **Pursue now, staged (Q1=B, Q2=C).** The revisit conditions on #16 were
   waived by human direction: grill the design now. Form = staged — a thin
   ssh transport first (`ssh <host> -- bash -c <cmd>` wrapping existing
   one-shot local semantics, no remote-side component); a Remote-SSH-style
   remote server component is NOT built and stays behind a revisit
   condition (interactive / long-lived remote session need).

2. **Remote execution is a separate repository (Q3 revised = separate repo,
   Q7=A: `dsh-shell-remote`).** Not a module of dsh-shell-host (the earlier
   same-package option was explicitly revised). Three worlds, three repos:
   dsh-shell-host = local one-shot execution; dsh-shell-remote = one-shot
   remote execution; dsh-pty-session = persistent sessions (local or ssh,
   interactive). No cross-registration in either direction; dsh-shell-remote
   never enters the shell-host registry (ADR-0003 decision 2 unchanged).

3. **Transport = shell out to system OpenSSH first; library behind revisit
   (Q5=C).** `ssh.exe` inherits the user's `~/.ssh/config`, keys, agent, and
   jump hosts for free — the same posture as the wsl backend shelling out to
   `wsl.exe` (ADR-0003 decision 3). An in-process ssh library (ssh2/russh)
   is explicitly NOT built now: its advantages (persistent connections,
   multiplexing) belong to the persistent-session world (dsh-pty-session).
   Revisit only if a one-shot-shaped need for programmatic transport appears.

4. **D8 contract holds: field-identical shape, documented remote semantics
   (Q6=A).** ShellResult fields stay field-identical to
   `@deepseek-ai/dsh-bash-local`; all path semantics are declared remote —
   the caller passes remote-valid cwd/spill inputs, the executor never maps
   paths (unlike the wsl bridge, there is no `/mnt/c` counterpart to map
   to). Host-dependent capabilities that have no remote meaning (spill)
   loudly reject, mirroring the missing-distro posture. A contract
   conformance test (field-by-field diff against dsh-bash-local) is part of
   the implementation ticket.

5. **Persistent sessions are also a separate library (human, 2026-10-03).**
   Interactive/long-lived shell semantics — local or over ssh — live in
   dsh-pty-session (its open ticket #3 anchors the ssh session consumer).
   Neither shell-host nor shell-remote grows session semantics.

## Ticket decomposition (Q9=A, two tickets in dsh-shell-remote)

- R1: repo scaffold + descriptor/executor skeleton (fork the type
  vocabulary per ADR-0001; fork-baseline-green posture per dsh-shell-host #4)
- R2: one-shot execution over `ssh <host> -- bash -c <cmd>` (exit code,
  streamed output, cwd semantics) + D8 contract conformance test + spill
  loudly-reject

## Consequences

- #16 in dsh-shell-host is transferred: a mirror ticket opens in
  dsh-shell-remote and #16 closes with a pointer (human Q8=C).
- The shell-host registry boundary (ADR-0003 decision 2) is unchanged; this
  ADR records where the remote half went, not a registry change.
- If the staged remote-server component is ever revisited, it revisits in
  dsh-shell-remote and likely leans on dsh-pty-session for session
  mechanics — not in dsh-shell-host.

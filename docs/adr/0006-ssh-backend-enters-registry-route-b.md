# ADR-0006: The ssh backend enters the shell-host registry (route B decoupling)

- Status: Accepted (supersedes ADR-0003 decision 2's registry boundary and
  ADR-0004 decision 2's no-cross-registration rule, for the ssh transport only)
- Deciders: human (#23 direction, 2026-10-08 — ticket #23 is the authored
  spec; this ADR records the reversal the ticket mandates)
- Context: #23 (route B), ADR-0003 (multi-backend registry; "ssh/远程语义
  永不进 registry"), ADR-0004 (remote execution in its own repo,
  dsh-shell-remote), CONTEXT.md D8/D9/D10

## Decision

Issue #23 (route B) authorizes merging dsh-shell-remote's thin ssh transport
into dsh-shell-host as the `ssh` backend (`src/backends/ssh.ts`), routed by
`config.backend` through the same registry as the local backends. The
transport keeps ADR-0004's shape verbatim: system OpenSSH
(`ssh <host> -- bash -c <cmd>`), D8 field contract, all path semantics
remote (identity mapping), `sshHost` required with a loud blank-host failure.
dsh-shell-remote becomes a thin shell or is archived.

## Superseded scope (narrow)

- ADR-0003 decision 2 ("registry is local-machine-only; ssh/remote semantics
  never enter the registry") — superseded for the ssh one-shot transport only.
- ADR-0004 decision 2's "no cross-registration in either direction" — the
  ssh transport now registers in shell-host's registry.
- NOT superseded: ADR-0004 decision 5 (persistent/interactive sessions stay
  out of shell-host — dsh-pty-session remains the home); the ssh library
  revisit condition; the one-shot semantics of the transport.

## Consequences

- CONTEXT.md's registry glossary entries and D10's three-repo split describe
  the pre-#23 world; the ssh row there is historical. The registry now
  serves msys2 / plain / pwsh / wsl / ssh.
- `executable: ['ssh']` resolves the launcher through bare PATH (the
  `plain` backend's contract) — no candidate probing, deliberately: ssh
  location is platform-managed and `~/.ssh/config` carries the real
  configuration surface.

/**
 * dsh-shell-host `./remote` entry — absorbed from dsh-shell-remote (issue #29,
 * ADR-0007 pure move; the source module stays anchored at
 * dsh-v0.2.1-alpha.1-r1 per ADR-0005): one-shot remote shell execution over
 * system OpenSSH. Type vocabulary and descriptor/executor (R1 + R2, ADR-0004).
 *
 * ADR-0007: `./remote` is NOT a registry backend — the executor config's
 * `backend` single-select (ADR-0003/ADR-0006) never points at it; ADR-0006's
 * `ssh` registry entry (route B thin transport) is a separate layer and
 * stands. Own settings namespace per ADR-0007.
 * @module dsh-shell-host/remote
 */

export * from './types.ts'
export * from './descriptor.ts'
export * from './executor.ts'

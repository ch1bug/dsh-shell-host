# ADR-0003: Multi-backend registry and WSL descriptor semantics

- Status: Accepted (design output of #2 grill, 2026-10-03)
- Deciders: human (grill session 2026-10-03, Q1–Q8)
- Context: #2 (wsl bash executor, generalized to multi-backend), ADR-0001 descriptor layer, CONTEXT.md D7/D8
- Supersedes: the #2 triage note's "do not force a local-backend abstraction for wsl" stance (overridden by the human's 2026-09-30 direction update: multi-backend form, wsl as registry anchor)

## Decisions

1. **Selection semantics = runtime switch, single active backend (Q1=A).**
   The external contract stays field-identical to `dsh-bash-local` (D8 red
   line): no per-call backend channel exists on `ctx.shell`. Multi-backend
   means multiple descriptors are registered; the `backend` config field
   remains a single volatile selection that can be hot-switched. Named
   backend instances (registry + instance names) are explicitly NOT built —
   no real use case today; the registry shape upgrades to that later if one
   appears. VS Code analogue: default terminal profile.

2. **WSL enters the registry as a backend, with a hard host-machine boundary
   (Q2=C).** `'wsl'` goes from loud-rejection placeholder to a real
   descriptor. The registry is for **local machine backends only** —
   including local WSL distros. ssh/remote semantics never enter this
   registry; they are anchored in a separate issue (created alongside this
   ADR) and, if ever pursued, live in their own executor/bundle following
   VS Code Remote-SSH modeling. This boundary is load-bearing: it keeps the
   registry from becoming a mis-shaped entry point for a remote execution
   layer.

3. **WSL one-shot launch protocol = `wsl.exe -d <distro> -e bash -c <cmd>`
   (Q3=A).** Explicit distro; `-e` prevents wsl.exe from re-interpreting the
   command line. The descriptor's path candidates point at `wsl.exe`
   (explicit System32 path — a bare `bash` on Windows PATH is a known
   unreliable probe, see CONTEXT.md verified facts). Distro discovery is a
   descriptor concern; missing distro fails loudly naming the probe points,
   mirroring the pwsh backend's detection-failure posture. Rejected: default-
   distro form (silent semantic change when the user switches default), and
   `bash.exe` System32 launcher (collides with the bare-bash hazard).

4. **Backend-specific fields live on the descriptor itself (Q6=B).** Like a
   VS Code terminal profile, a descriptor is the single declaration place:
   the wsl descriptor carries `distro` and related VM fields directly;
   plain/msys2/pwsh descriptors simply do not have them. No side config
   section per backend, and no invented template placeholders
   (`{distro}`-style) — distro feeds the bridge/launcher, not the argv
   template string.

5. **Cross-VM path mapping is owned by a WSL bridge (Q7).** Both directions
   — toShell (host path → WSL path, e.g. spill files, cwd via
   `C:\x → /mnt/c/x`) and fromShell (WSL path → host-usable path) — are
   carried by the wsl backend's dedicated bridge module, not by the generic
   descriptor mapping functions and not by pass-through. The descriptor
   declares that the wsl backend uses the bridge; the bridge is where the
   `/mnt/<drive>/` rule, `\\wsl$\<distro>\` reverse mapping, and drvfs mount
   edge cases live and get tested.

## Ticket decomposition (Q5=C, three implementation tickets + one anchor)

- T1: descriptor expressiveness extension (fields per decision 4)
- T2: multi-backend registry / runtime switch layer (depends on T1; verified
  end-to-end with the existing plain/msys2/pwsh backends)
- T3: wsl backend descriptor + bridge (depends on T1 and T2; VM semantics:
  launch protocol, `/mnt/c` mapping, cross-VM spill/cwd)
- (separate issue) remote/ssh semantics anchor — explicitly out of registry
  scope (decision 2)

## Consequences

- The `wsl` reserved-id loud-rejection test is replaced by real descriptor
  behavior in T3; until then it stays as-is.
- Registry shape stays instance-free; upgrading to named instances later is
  additive.
- Remote execution has a named home outside this bundle, preventing scope
  creep into the registry.

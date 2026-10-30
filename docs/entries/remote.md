> Extracted from the README (issues #137–#140, ADR-0016). Back to the [README](../../README.md). 中文版：[remote_zh.md](remote_zh.md)。

## Remote workspaces: `./remote` and `./remote-fs` (#137)

These are sibling entries: the former provides `ctx.remote`, responsible for
workspace registration and connection lifecycle; the latter provides
`ctx.remoteFs` — the file tools access the remote only through that service.
They do not replace the upstream `ctx.fs`, and they add no `ctx.shell`
executor. The migration path for old profiles (adding `ssh` / `remote` /
`remote-fs`) is written once in *The bundle patch*, under "how to install,
how to add rows" (#142); it is not repeated here.

### Warm-up configuration and tools

Configuration example for the `remote` row (metadata, no credentials stored):

```yaml
- insert:
    - id: remote
      name: dsh-shell-host/remote
      config:
        workspaces:
          - host: devbox
            root: /srv/app
            title: 远程应用
```

Bundle loading starts the connection immediately; a failure is recorded as
`unavailable` with a stable error code and does not block host startup.
`remote_open({ host, root, anchor?, title?, port?, jump?, options? })`
registers dynamically or retries explicitly, `remote_list` lists registered
workspaces, and `remote_status({ workspaceId? })` shows the actual transport
shape, the probed remote shell, the reference count, reconnect count,
in-flight requests, and the last error. Workspaces on the same host share the
file channel; if port/jump/options differ, reuse is refused loudly — you must
use a different OpenSSH host alias, to avoid silently hitting the wrong host.
Dynamic registrations persist until `remote_close_workspace` or component
disposal; workspaces that must be warmed up across restarts go into the
`workspaces` config above.

`remote_open` creates a local anchor directory containing
`.dsh-remote-workspace.json` (host + remote root and a connection fingerprint,
no credentials). By default it lives under `anchorRoot`; when unconfigured,
that is `.dsh-remote` under the current session workspace root, while config
warm-up uses the deployment's default workspace root. The anchor is an
identity, never a copy of the remote tree; a full host that has a
`workspaceRegistry` automatically registers the anchor as an ordinary
workspace, and the tools-only bundle can still query it through this service.
Taking over is refused when an existing marker mismatches, the marker is a
symbolic link, or a marker-less directory is non-empty.
`remote_open` goes through the #102 permission gate; `workspace-write`
constrains both the ssh startup cwd and the anchor's real path, `read-only`
refuses to open a connection. Config warm-up is a deployer declaration and
never impersonates a one-off grant to some agent.

`remote_ls({ path?, limit? })` lists a remote directory; an explicit `path`
must be an absolute POSIX path, and omitting it lists the workspace root. The
workspace is picked from the local anchor matching the session cwd; with no
anchor in play there is a fallback only when exactly one workspace is
registered, and multi-host ambiguity must fail loudly. `limit` only caps the
displayed rows — the response carries `truncated` and `total` — it is not a
remote scan or memory budget; exceeding the frame limit fails loudly instead
of returning half a tree. **The local read/write/edit tools see the anchor;
remote files must go through the `remote_*` tools.**

`remote_read({ file_path, offset?, limit? })` mirrors the upstream `read`:
paths resolve via the session anchor and the remote filesystem, lines are
1-based; the default and maximum is 2000 lines, at most 2000 characters per
line, at most 50 KiB of selected text, and the footer hints at continuation.
Directories are refused with `FS_NOT_REGULAR_FILE`; the strict UTF-8 text face
refuses invalid encodings and NUL within the first 8 KiB (`FS_NOT_TEXT`) — it
never guesses an encoding or hides bad bytes with replacement characters. The
underlying `readBytes` / `readByteRange` can read non-UTF-8 files back byte by
byte. Reads travel in 256 KiB byte blocks over the existing base64 channel;
UTF-8 decode state is preserved across blocks, and a file larger than one
frame is never crammed into a single frame. Mid-read disconnects, timeouts,
short blocks, or file version changes all fail loudly — a prefix is never
returned posing as a complete result.

`remote_write({ file_path, content })` atomically creates or replaces text;
`remote_edit({ file_path, old_string, new_string, replace_all? })` does
literal replacement, allowing only a unique match by default. Read with
`remote_read` before overwriting/editing; observation is isolated per session
and remote canonical identity, and an external change returns
`FS_STALE_VERSION` — re-read and retry. After a successful create/modify you
can keep editing without an extra read. Edits restore LF/CRLF per upstream
rules, and `$&` and friends are never treated as regex replacement syntax.
Writes enter a private staging directory next to the target in bounded base64
blocks, the version is verified before publish, and a replace preserves the
existing permission bits; staging is cleaned up on failure. Create uses
atomic no-clobber, replace uses `mv`; same-target operations are serialized
within the provider — no claim of OS-level CAS against arbitrary external
processes. When the channel is dead, remote cleanup cannot be guaranteed, and
failures are reported explicitly. This backend does not claim the local file
sandbox can jail remote paths; the write tools re-resolve the caller's session
policy on every call, only `danger-full-access` may write, and downgrades or a
missing policy service are refused before the remote request. Calling the
service directly with a restricted local `sandboxPolicy` likewise returns
`FS_SANDBOX_DENIED` — the tools offer no fake escalation parameters.

### Multi-session orchestration (#140)

`remote_open_session({ workspaceId, kind, cwd?, env? })` opens a standalone
remote shell in a registered workspace; the returned `sessionId` IS a core
session id, and everything afterwards goes through the same agent's
`pty_send` / `pty_tail` / `pty_close`. `kind` only labels the `shell` /
`build` / `test` purpose — it never automatically runs builds or tests; each
of the three purposes gets its own interactive `sh`, and a `cd` in one does
not change the others.

`cwd` is an absolute remote POSIX path, defaulting to the workspace `root`;
`env` is injected into the remote shell only — the local ssh process's cwd
still takes the value authorized by this host's permission gate. Permissions
are re-resolved on every open and the real grant is written into the PTY, so
later `pty_send` calls keep refusing writes on downgrade; being connected is
not a permanent grant, and the local sandbox is not claimed to jail the
remote. Each session probes for a real POSIX login shell within its own
connection and publishes the id only after the cwd/env initialization is
confirmed; the probe also requires the host to have the coreutils the file
frame protocol needs (`base64` / `mktemp`, ADR-0016 decision 3) — the same
host carries the file channel too, so missing one fails closed at probe time
instead of letting the file face fail per-request after the session is up.
Failures, timeouts, and aborts all attempt reclamation; when cleanup fails the
id is kept for the workspace close to retry.

`remote_list` / `remote_status` gain the current agent's `sessions` (id, kind,
cwd, running/exited status, probed shell, transport shape, connectionId). The
workspace `state` refers to the file channel and never impersonates
interactive-session state. POSIX interactive sessions join an existing master
as a slave (same `connectionId`); when the master is lost there is no silent
direct reconnect. On Windows, or when sharing is explicitly disabled, each
session has its own connection and id; a file-connection reconnect affects
only the file connection. Interactive shells **never auto-reconnect** — a drop
is reported by the PTY as `exited` and you open a new session; losing a POSIX
master affects every channel under it. The WSL/tmux paths are unimplemented,
and the status never fakes those shapes.

The soft cap reuses the PTY owner registry as-is, counting local PTY, SSH,
and launcher sessions together; exited-but-unclosed sessions still occupy a
slot, and exceeding the cap raises the core's loud error with the current
session list. There is no second workspace quota.
`remote_close_workspace({ workspaceId })` closes out the **entire
workspace**: it closes the associated ids of all its owners and unregisters
the workspace; it never touches other workspaces, local PTYs, or the local
anchor. It waits for queued opens, repeated closes are idempotent, and a
failure keeps the retry responsibility. The listing does not expose other
agents' session details — that does not shrink the batch-close scope.

### Transport and this phase's boundaries

- POSIX clients explicitly enable ControlMaster; Windows explicitly disables
  it — never try the master first and fall back. `ControlMaster=no` can be
  set explicitly for independent connections, and the status reports that
  shape in sync; modes like `auto`/`ask`, which cannot guarantee an
  observable shape, are refused loudly. WSL hosting and tmux remain deferred
  options under ADR-0017.
- The remote must have a POSIX login shell plus GNU tools such as `base64` /
  `mktemp` / `stat` / `find` / `realpath` / `dd`; on open, `uname` and
  `$SHELL` are probed for real, and Windows or a non-POSIX login shell is
  refused loudly. No remote server is installed, no SFTP, no local file
  mirror.
- The file channel is a raw pipe over `ssh -T`, not an interactive PTY;
  internal requests are id-tagged base64 line frames. Protocol version and
  `clientId` are negotiated first, and a version or identity mismatch is
  refused loudly; the subcommand is isolated from the protocol stdin, and
  response frames are capped at 8 MiB. This is a file transfer channel, not a
  second PTY core.
- Actually implemented this phase: `resolve` / `stat` / `listDir`, plus #138's
  `lstat` / `readText` / `streamText` / `readBytes` / `readByteRange`, and
  #139's `writeText` / `editText`; #140 provides workspace multi-session
  orchestration (see the section above).
- In environments with no live ssh host, real bash loops and injected-channel
  coverage are not ssh live acceptance; the verification report must say
  explicitly `not run locally: remote live`, and a green fake channel must
  never stand in for real network evidence.

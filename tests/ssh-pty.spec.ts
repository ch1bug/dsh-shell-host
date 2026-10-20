/**
 * ssh 四工具（issue #24，承接 dsh-pty-session#3）: ssh_start / ssh_tail /
 * ssh_send / ssh_close over the `./pty` core — SEAM-FREE since #61
 * (ADR-0010): the boot drives the self-managed core with an injected fake
 * spawner whose "remote" is an in-process echo pty, so the suite pins the
 * TOOL semantics (command composition onto the spawn spec, cursor
 * passthrough, death reporting, cleanup) without a network. The live
 * full-duplex round-trip is the machine lane's job (ssh-pty-live.spec.ts).
 *
 * #136: the four tools are registered by the `./ssh` ENTRY now; the boot mounts
 * both entries (`./pty` provides the core, `./ssh` consumes it). The pre-existing
 * assertions are unchanged on purpose — this ticket is a pure move — and the
 * `entry split` / `transport-shape` blocks at the end ADD the AC1 direction
 * ("`./pty` alone no longer registers the ssh family") and the ADR-0017 shape
 * fact.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SSH_KEEPALIVE_INTERVAL_DEFAULT, SSH_KEEPALIVE_COUNT_DEFAULT } from "../src/ssh/compose.ts";
import { controlMasterUsable, sessionTransport } from "../src/ssh/transport.ts";
import * as sshEntry from "../src/ssh/index.ts";
import { bootPlugin, echoFakePty, type FakePtyHandle, type CoreSpawnSpec } from "./helpers/fake-pty.ts";

// #49: the keepalive defaults are single-sourced from the pty entry — the
// assertions derive from the exported constants, so format drift (`-o `
// prefix, ordering, suppression) is pinned even if the values change. The
// literal values themselves are pinned only at the source.

// Harness: boot the plugin over an echo "remote" (every write is echoed
// back with an ECHO: prefix — the fake ssh), capture the spawn specs so the
// composition assertions pin the command the core handed to its spawner.
function makeAgent(name: string) {
  return { name };
}

const handles: FakePtyHandle[] = [];
const specs: CoreSpawnSpec[] = [];

function echoRemoteSpawner(spec: CoreSpawnSpec) {
  specs.push(spec);
  const h = echoFakePty("ECHO:");
  handles.push(h);
  // The fake "remote drop" exits non-zero, like a cut ssh session.
  (h.pty as any).kill = () => setTimeout(() => h.emitExit({ exitCode: 255 }), 5);
  return h.pty;
}

function boot() {
  handles.length = 0;
  specs.length = 0;
  // #136: the ssh family is its own entry now — mount `./ssh` (it consumes the
  // pty service this boot provides). The assertions below are unchanged: this
  // suite pins the TOOL semantics, not which entry registered them.
  return bootPlugin({ ssh: true, spawnPty: echoRemoteSpawner });
}

/** The composed command of the most recent ssh_start. */
const lastCommand = () => specs[specs.length - 1]!.command;

describe("ssh_start (#24)", () => {
  let h: ReturnType<typeof boot>;
  beforeEach(() => {
    h = boot();
  });

  it("composes ssh argv (host only) and opens it on the core", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "example.com" }, { agent });
    expect(opened.sessionId).toBeDefined();
    // Keepalive defaults ride along (long-session contract, #21): options
    // precede the host; the host atom terminates the option run.
    const cmd = lastCommand();
    expect(cmd).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`);
    expect(cmd).toContain(`-o ${SSH_KEEPALIVE_COUNT_DEFAULT}`);
    expect(cmd.trim().endsWith("example.com")).toBe(true);
  });

  it("threads jump host (-J) and remote shell", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute({ host: "box", jump: "bastion", shell: "bash --login" }, { agent });
    const cmd = lastCommand();
    expect(cmd).toContain("-J bastion");
    expect(cmd).toContain("bash --login");
  });

  it("rejects whitespace-bearing host/jump loudly (they are argv atoms, not shell text)", async () => {
    const agent = makeAgent("a");
    await expect(h.tool("ssh_start").execute({ host: "a b" }, { agent })).rejects.toThrow(/host/);
    await expect(h.tool("ssh_start").execute({ host: "ok", jump: "x y" }, { agent })).rejects.toThrow(/jump/);
  });

  it("requires an owning agent like every pty tool", async () => {
    await expect(h.tool("ssh_start").execute({ host: "box" }, {})).rejects.toMatchObject({ code: "NO_AGENT" });
  });
});

describe("ssh_start long-session composition (#21 phase 1)", () => {
  let h: ReturnType<typeof boot>;
  beforeEach(() => {
    h = boot();
  });

  it("threads a non-standard port as -p before the host atom", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute({ host: "box", port: 2222 }, { agent });
    const cmd = lastCommand();
    expect(cmd).toContain("-p 2222");
    expect(cmd.trim().endsWith("box")).toBe(true);
  });

  it("rejects out-of-range and non-numeric ports loudly before any network", async () => {
    const agent = makeAgent("a");
    await expect(h.tool("ssh_start").execute({ host: "box", port: 0 }, { agent })).rejects.toThrow(/port/);
    await expect(h.tool("ssh_start").execute({ host: "box", port: 65536 }, { agent })).rejects.toThrow(/port/);
    await expect(h.tool("ssh_start").execute({ host: "box", port: 22.5 as unknown as number }, { agent })).rejects.toThrow(/port/);
  });

  it("passes free -o options through verbatim after the keepalive defaults", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute(
      { host: "box", options: ["IdentityFile=/home/me/id_ed25519", "Compression=yes"] },
      { agent },
    );
    const cmd = lastCommand();
    expect(cmd).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`); // defaults still ride along
    expect(cmd).toContain("-o IdentityFile=/home/me/id_ed25519");
    expect(cmd).toContain("-o Compression=yes");
    expect(cmd.indexOf(SSH_KEEPALIVE_INTERVAL_DEFAULT)).toBeLessThan(cmd.indexOf("IdentityFile"));
  });

  it("suppresses the keepalive defaults when the caller supplies their own ServerAliveInterval", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute(
      { host: "box", options: ["ServerAliveInterval=60"] },
      { agent },
    );
    const cmd = lastCommand();
    expect(cmd).not.toContain(SSH_KEEPALIVE_INTERVAL_DEFAULT);
    expect(cmd).toContain("-o ServerAliveInterval=60");
    expect(cmd).toContain(`-o ${SSH_KEEPALIVE_COUNT_DEFAULT}`); // count max still applies
  });

  it("rejects whitespace-bearing options loudly (single -o atoms; spaced values belong in ~/.ssh/config)", async () => {
    const agent = makeAgent("a");
    await expect(
      h.tool("ssh_start").execute({ host: "box", options: ["RemoteCommand=bash -l"] }, { agent }),
    ).rejects.toThrow(/options\[0\]/);
  });

  it("accepts an empty options array as no options", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute({ host: "box", options: [] }, { agent });
    expect(lastCommand()).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`);
  });
});

describe("ssh_start structured options (#50, additive dual shape)", () => {
  let h: ReturnType<typeof boot>;
  beforeEach(() => {
    h = boot();
  });

  it("accepts structured {key,value} entries and composes -o key=value", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute(
      { host: "box", options: [{ key: "IdentityFile", value: "/home/me/id_ed25519" }, { key: "Compression", value: "yes" }] },
      { agent },
    );
    const cmd = lastCommand();
    expect(cmd).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`); // defaults still ride along
    expect(cmd).toContain("-o IdentityFile=/home/me/id_ed25519");
    expect(cmd).toContain("-o Compression=yes");
  });

  it("suppresses a keepalive default when a structured entry sets the same key (exact key match)", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute(
      { host: "box", options: [{ key: "ServerAliveInterval", value: "60" }] },
      { agent },
    );
    const cmd = lastCommand();
    expect(cmd).not.toContain(SSH_KEEPALIVE_INTERVAL_DEFAULT);
    expect(cmd).toContain("-o ServerAliveInterval=60");
    expect(cmd).toContain(`-o ${SSH_KEEPALIVE_COUNT_DEFAULT}`); // count max still applies
  });

  it("suppresses a keepalive default from the legacy atomic-string shape too (additive parity, #50)", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute(
      { host: "box", options: ["ServerAliveInterval=60"] },
      { agent },
    );
    const cmd = lastCommand();
    expect(cmd).not.toContain(SSH_KEEPALIVE_INTERVAL_DEFAULT);
    expect(cmd).toContain("-o ServerAliveInterval=60");
  });

  it("does not suppress a keepalive default for a valueless entry (a bare key does not set the option)", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute(
      { host: "box", options: [{ key: "ServerAliveInterval" }] },
      { agent },
    );
    expect(lastCommand()).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`);
    expect(lastCommand()).toContain("-o ServerAliveInterval");
  });

  it("composes a structured spaced value as one POSIX-quoted shell word (space form now representable)", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute(
      { host: "box", options: [{ key: "ProxyCommand", value: "nc -x proxy:1080 %h %p" }] },
      { agent },
    );
    expect(lastCommand()).toContain("-o ProxyCommand='nc -x proxy:1080 %h %p'");
  });

  it("treats an atomic string without '=' as a key-only option (sugar for {key})", async () => {
    const agent = makeAgent("a");
    await h.tool("ssh_start").execute(
      { host: "box", options: ["RequestTTY"] },
      { agent },
    );
    expect(lastCommand()).toContain("-o RequestTTY");
  });

  it("rejects malformed entries loudly: structured key with whitespace, key containing '=', non-string value, atomic string with whitespace", async () => {
    const agent = makeAgent("a");
    await expect(
      h.tool("ssh_start").execute({ host: "box", options: [{ key: "Proxy Command", value: "x" }] }, { agent }),
    ).rejects.toThrow(/options\[0\]/);
    await expect(
      h.tool("ssh_start").execute({ host: "box", options: [{ key: "Key=Value", value: "x" }] }, { agent }),
    ).rejects.toThrow(/options\[0\]/);
    await expect(
      h.tool("ssh_start").execute({ host: "box", options: [{ key: "Compression", value: 42 as unknown as string }] }, { agent }),
    ).rejects.toThrow(/options\[0\]/);
    await expect(
      h.tool("ssh_start").execute({ host: "box", options: [{ key: "Compression" }, "RemoteCommand=bash -l"] }, { agent }),
    ).rejects.toThrow(/options\[1\]/);
  });
});

describe("ssh_tail / ssh_send / ssh_close (#24 passthrough semantics)", () => {
  let h: ReturnType<typeof boot>;
  beforeEach(() => {
    h = boot();
  });

  it("start → interactive send → incremental tail → close, full duplex", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box" }, { agent });
    const id = opened.sessionId;

    // The banner came back in initialOutput; the first tail is empty.
    expect(opened.initialOutput).toBe("");
    const t0 = await h.tool("ssh_tail").execute({ id }, { agent });
    expect(t0.text).toBe("");

    // Interactive round-trip: send increments, tail does not resend.
    const sent = await h.tool("ssh_send").execute({ id, data: "hello remote" }, { agent });
    expect(sent.delta).toContain("ECHO:hello remote");
    const t1 = await h.tool("ssh_tail").execute({ id }, { agent });
    expect(t1.text).toContain("ECHO:hello remote");
    const t2 = await h.tool("ssh_tail").execute({ id }, { agent });
    expect(t2.text).toBe("");

    const closed = await h.tool("ssh_close").execute({ id }, { agent });
    expect(closed.closed).toBe(true);
  });

  it("death is reported, not auto-reconnected: send surfaces the exited status, close reclaims", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box" }, { agent });
    const id = opened.sessionId;

    // Simulate the remote drop: the pty process exits (async, like a real
    // network cut surfacing through the exit event).
    handles[0].emitExit({ exitCode: 255 });

    let status: any;
    for (let i = 0; i < 100; i++) {
      const r: any = await h.tool("ssh_send").execute({ id, data: "ping" }, { agent }).catch((e) => ({ error: e }));
      status = r.status ?? r.error;
      if (status?.kind === "exited" || status?.code === "NO_SESSION") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status?.kind === "exited" || status?.code === "NO_SESSION").toBe(true);

    // No auto-reconnect happened: the SAME id, explicitly closed, reclaims.
    const closed = await h.tool("ssh_close").execute({ id }, { agent });
    expect(closed.closed).toBe(true);
  });

  it("close is idempotent (second close → closed:false, not a throw)", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box" }, { agent });
    await h.tool("ssh_close").execute({ id: opened.sessionId }, { agent });
    const again = await h.tool("ssh_close").execute({ id: opened.sessionId }, { agent });
    expect(again.closed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #136 — the component split itself. AC1 has TWO directions: the tools ARE
// registered by `./ssh`, and they are NOT registered by `./pty` any more.
// ---------------------------------------------------------------------------

describe("entry split (#136): the ssh family's ONLY home is ./ssh", () => {
  it("a pty-only boot registers no ssh_* tool (the 'moved out' direction)", () => {
    // No `ssh: true` → ONLY the pty entry is applied, which is exactly what an
    // old profile (pty row only) gets after #136. If someone registers the ssh
    // family back inside ./pty, this case goes red.
    const ptyOnly = bootPlugin({ spawnPty: echoRemoteSpawner });
    const names = ptyOnly.registered.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["pty_open", "pty_send", "pty_tail", "pty_close", "pty_list", "pty_signal"]));
    for (const name of ["ssh_start", "ssh_tail", "ssh_send", "ssh_close"]) {
      expect(names, `${name} must NOT be registered by ./pty since #136`).not.toContain(name);
    }
  });

  it("the ./ssh entry carries its own name / inject / Config / apply", () => {
    expect(sshEntry.name).toBe("dsh-shell-host-ssh");
    expect(sshEntry.inject).toEqual(["tools", "pty", "sandboxPolicy", "approval"]);
    expect(typeof sshEntry.apply).toBe("function");
    expect(sshEntry.Config).toBeDefined();
  });

  it("ssh_start reports the transport it ACTUALLY opened in (ADR-0017 decision 5)", async () => {
    const agent = makeAgent("a");
    const opened = await boot().tool("ssh_start").execute({ host: "box" }, { agent });
    expect(opened.transport).toEqual({
      shape: "per-session-connection",
      controlMasterUsable: controlMasterUsable(),
    });
  });
});

describe("transport-shape interface (ADR-0017, #136)", () => {
  it("ControlMaster capability is a platform fact — never on win32", () => {
    // ADR-0017 facts 2/4: the Windows client fails at the socket stage, and a
    // POSIX-build client ON Windows fails one stage later (fd passing).
    expect(controlMasterUsable("win32")).toBe(false);
    expect(controlMasterUsable("linux")).toBe(true);
    expect(controlMasterUsable("darwin")).toBe(true);
  });

  it("v1's shape is one independent connection per session on every client", () => {
    expect(sessionTransport("win32")).toEqual({ shape: "per-session-connection", controlMasterUsable: false });
    expect(sessionTransport("linux")).toEqual({ shape: "per-session-connection", controlMasterUsable: true });
  });
});

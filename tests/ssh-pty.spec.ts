/**
 * ssh 四工具（issue #24，承接 dsh-pty-session#3）: ssh_start / ssh_tail /
 * ssh_send / ssh_close over the `./pty` core. Tests are the reference
 * implementation again: the same owner-scoped terminals-seam fake shape as
 * pty-session.spec.ts, backed by real child processes — the "ssh" here is a
 * node echo script, so the suite pins the TOOL semantics (command
 * composition, cursor passthrough, death reporting, cleanup) without a
 * network. The live full-duplex round-trip is the machine lane's job
 * (wsl-plugin-live.spec.ts pattern).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { spawn as cpSpawn } from "node:child_process";
import { apply, SSH_KEEPALIVE_INTERVAL_DEFAULT, SSH_KEEPALIVE_COUNT_DEFAULT } from "../src/pty/index.ts";
import { FakeTerminals, bootSsh } from "./helpers/fake-terminals.ts";

// #49: the keepalive defaults are single-sourced from the pty entry — the
// assertions derive from the exported constants, so format drift (`-o `
// prefix, ordering, suppression) is pinned even if the values change. The
// literal values themselves are pinned only at the source.

// The fake owner-scoped terminals seam is the shared helper (#48): the echo
// child here (node script prefixing every stdin line with ECHO:) is just the
// spawnChild parameter of the same fake pty-session.spec.ts references.

// Harness: boot the plugin, surface the registered tools' execute fns.
function makeAgent(name: string) {
  return { name };
}

function boot() {
  const terminals = new FakeTerminals({
    spawnChild: () =>
      cpSpawn(
        process.execPath,
        [
          "-e",
          // Echo every stdin line back with a marker (fake remote), no exit.
          "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => process.stdout.write('ECHO:' + d));",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      ),
  });
  const { registered, tool } = bootSsh(terminals);
  return { terminals, registered, tool };
}

describe("ssh_start (#24)", () => {
  let h: ReturnType<typeof boot>;
  beforeEach(() => {
    h = boot();
  });

  it("composes ssh argv (host only) and reports the composed command", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "example.com" }, { agent });
    expect(opened.sessionId).toBeDefined();
    // Keepalive defaults ride along (long-session contract, #21): options
    // precede the host; the host atom terminates the option run.
    expect(opened.initialOutput).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`);
    expect(opened.initialOutput).toContain(`-o ${SSH_KEEPALIVE_COUNT_DEFAULT}`);
    expect(opened.initialOutput!.trim().endsWith("example.com")).toBe(true);
  });

  it("threads jump host (-J) and remote shell", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box", jump: "bastion", shell: "bash --login" }, { agent });
    expect(opened.initialOutput).toContain("-J bastion");
    expect(opened.initialOutput).toContain("bash --login");
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
    const opened = await h.tool("ssh_start").execute({ host: "box", port: 2222 }, { agent });
    expect(opened.initialOutput).toContain("-p 2222");
    expect(opened.initialOutput!.trim().endsWith("box")).toBe(true);
  });

  it("rejects out-of-range and non-numeric ports loudly before any network", async () => {
    const agent = makeAgent("a");
    await expect(h.tool("ssh_start").execute({ host: "box", port: 0 }, { agent })).rejects.toThrow(/port/);
    await expect(h.tool("ssh_start").execute({ host: "box", port: 65536 }, { agent })).rejects.toThrow(/port/);
    await expect(h.tool("ssh_start").execute({ host: "box", port: 22.5 as unknown as number }, { agent })).rejects.toThrow(/port/);
  });

  it("passes free -o options through verbatim after the keepalive defaults", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute(
      { host: "box", options: ["IdentityFile=/home/me/id_ed25519", "Compression=yes"] },
      { agent },
    );
    const out = opened.initialOutput;
    expect(out).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`); // defaults still ride along
    expect(out).toContain("-o IdentityFile=/home/me/id_ed25519");
    expect(out).toContain("-o Compression=yes");
    expect(out.indexOf(SSH_KEEPALIVE_INTERVAL_DEFAULT)).toBeLessThan(out.indexOf("IdentityFile"));
  });

  it("suppresses the keepalive defaults when the caller supplies their own ServerAliveInterval", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute(
      { host: "box", options: ["ServerAliveInterval=60"] },
      { agent },
    );
    const out = opened.initialOutput;
    expect(out).not.toContain(SSH_KEEPALIVE_INTERVAL_DEFAULT);
    expect(out).toContain("-o ServerAliveInterval=60");
    expect(out).toContain(`-o ${SSH_KEEPALIVE_COUNT_DEFAULT}`); // count max still applies
  });

  it("rejects whitespace-bearing options loudly (single -o atoms; spaced values belong in ~/.ssh/config)", async () => {
    const agent = makeAgent("a");
    await expect(
      h.tool("ssh_start").execute({ host: "box", options: ["RemoteCommand=bash -l"] }, { agent }),
    ).rejects.toThrow(/options\[0\]/);
  });

  it("accepts an empty options array as no options", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute({ host: "box", options: [] }, { agent });
    expect(opened.initialOutput).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`);
  });
});

describe("ssh_start structured options (#50, additive dual shape)", () => {
  let h: ReturnType<typeof boot>;
  beforeEach(() => {
    h = boot();
  });

  it("accepts structured {key,value} entries and composes -o key=value", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute(
      { host: "box", options: [{ key: "IdentityFile", value: "/home/me/id_ed25519" }, { key: "Compression", value: "yes" }] },
      { agent },
    );
    const out = opened.initialOutput;
    expect(out).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`); // defaults still ride along
    expect(out).toContain("-o IdentityFile=/home/me/id_ed25519");
    expect(out).toContain("-o Compression=yes");
  });

  it("suppresses a keepalive default when a structured entry sets the same key (exact key match)", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute(
      { host: "box", options: [{ key: "ServerAliveInterval", value: "60" }] },
      { agent },
    );
    const out = opened.initialOutput;
    expect(out).not.toContain(SSH_KEEPALIVE_INTERVAL_DEFAULT);
    expect(out).toContain("-o ServerAliveInterval=60");
    expect(out).toContain(`-o ${SSH_KEEPALIVE_COUNT_DEFAULT}`); // count max still applies
  });

  it("suppresses a keepalive default from the legacy atomic-string shape too (additive parity, #50)", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute(
      { host: "box", options: ["ServerAliveInterval=60"] },
      { agent },
    );
    const out = opened.initialOutput;
    expect(out).not.toContain(SSH_KEEPALIVE_INTERVAL_DEFAULT);
    expect(out).toContain("-o ServerAliveInterval=60");
  });

  it("does not suppress a keepalive default for a valueless entry (a bare key does not set the option)", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute(
      { host: "box", options: [{ key: "ServerAliveInterval" }] },
      { agent },
    );
    expect(opened.initialOutput).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`);
    expect(opened.initialOutput).toContain("-o ServerAliveInterval");
  });

  it("composes a structured spaced value as one POSIX-quoted shell word (space form now representable)", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute(
      { host: "box", options: [{ key: "ProxyCommand", value: "nc -x proxy:1080 %h %p" }] },
      { agent },
    );
    const out = opened.initialOutput;
    expect(out).toContain("-o ProxyCommand='nc -x proxy:1080 %h %p'");
  });

  it("treats an atomic string without '=' as a key-only option (sugar for {key})", async () => {
    const agent = makeAgent("a");
    const opened = await h.tool("ssh_start").execute(
      { host: "box", options: ["RequestTTY"] },
      { agent },
    );
    expect(opened.initialOutput).toContain("-o RequestTTY");
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
    expect(opened.initialOutput).toContain("-tt");
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

    // Kill the fake ssh process behind the seam (remote drop / network cut).
    h.terminals.sessions.get(id)!.child.kill();

    // Poll until the seam sees the death (process exit is async).
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

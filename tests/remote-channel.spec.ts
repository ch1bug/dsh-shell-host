/**
 * 长驻通道（#137）：传输形态（ADR-0017 决策 2/3）、POSIX 远端探测（决策 6）、
 * 引用计数、keepalive、有界重连、四种传输故障的终态。
 *
 * 全部用假子进程（`tests/helpers/fake-channel.ts`，线路 = 真正的编解码器）；
 * 真 `ssh` 往返属活体层（本机无 ssh 目标，`ssh-pty-live` 整档 loud skip）。
 *
 * @module tests/remote-channel.spec
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import {
  REMOTE_CHANNEL_ERRORS,
  RemoteChannel,
  defaultChannelSpawner,
  channelArgv,
  controlPathFor,
  workspaceTransport,
  type ChannelOptions,
  type ChannelSpawner,
} from "../src/remote/channel.ts";
import { SSH_KEEPALIVE_COUNT_DEFAULT, SSH_KEEPALIVE_INTERVAL_DEFAULT } from "../src/ssh/compose.ts";
import { encodeError, encodeResponse } from "../src/remote/frame.ts";
import { frameLoopResponder, fakeChannelHarness, posixRemoteExec } from "./helpers/fake-channel.ts";
import { waitUntil } from "./helpers/wait-until.ts";

/** A channel over a fake spawner with test-friendly budgets (no timers left behind). */
function channelWith(overrides: Partial<ChannelOptions> & { spawner: ChannelSpawner }) {
  return new RemoteChannel({
    host: "dev@example",
    requestTimeoutMs: 200,
    keepaliveMs: 0,
    reconnectMax: 0,
    reconnectBaseMs: 1,
    sleep: async () => {},
    ...overrides,
  })
}

describe("传输形态：平台决定，从不「先试 master 再回退」", () => {
  it("win32 ⇒ per-session-connection + controlMasterUsable=false（实测不可用）", () => {
    expect(workspaceTransport("win32")).toEqual({ shape: "per-session-connection", controlMasterUsable: false });
  });

  it("POSIX ⇒ control-master + controlMasterUsable=true（实测可用）", () => {
    expect(workspaceTransport("linux")).toEqual({ shape: "control-master", controlMasterUsable: true });
    expect(workspaceTransport("darwin")).toEqual({ shape: "control-master", controlMasterUsable: true });
  });

  it("win32 的 argv 带 -T 且明确禁用master（覆盖用户配置，绝不尝试）", () => {
    const argv = channelArgv({ host: "dev@example", requestTimeoutMs: 1, keepaliveMs: 0, reconnectMax: 0, reconnectBaseMs: 1, platform: "win32" });
    expect(argv[0]).toBe("ssh");
    expect(argv[1]).toBe("-T");
    expect(argv).not.toContain("-tt");
    // keepalive 默认仍在（长驻通道同样怕 NAT 空闲断）
    expect(argv).toContain(SSH_KEEPALIVE_INTERVAL_DEFAULT);
    expect(argv).toContain(SSH_KEEPALIVE_COUNT_DEFAULT);
    expect(argv).toContain('ControlMaster=no');
    expect(argv).toContain('ControlPath=none');
  });

  it("POSIX 的 argv 明确开启master / ControlPath / ControlPersist=no", () => {
    const argv = channelArgv({ host: "dev@example", requestTimeoutMs: 1, keepaliveMs: 0, reconnectMax: 0, reconnectBaseMs: 1, platform: "linux" });
    expect(argv).toContain("ControlMaster=yes");
    expect(argv).toContain(`ControlPath=${controlPathFor("dev@example")}`);
    expect(argv).toContain("ControlPersist=no");
  });

  it("调用方自己给了 ControlPath/ControlMaster ⇒ 不被覆盖（部署的 ssh 配置说了算）", () => {
    const argv = channelArgv({
      host: "dev@example",
      requestTimeoutMs: 1,
      keepaliveMs: 0,
      reconnectMax: 0,
      reconnectBaseMs: 1,
      platform: "linux",
      ssh: { options: ["ControlPath=/tmp/mine.sock"] },
    });
    expect(argv).toContain("ControlPath=/tmp/mine.sock");
    expect(argv).not.toContain(`ControlPath=${controlPathFor("dev@example")}`);
    expect(argv).not.toContain("ControlMaster=auto");
  });

  it("远端命令是**一个** argv atom（`sh -c '<loop>'`）：ssh 会 join，拆开就会坏", () => {
    const argv = channelArgv({ host: "dev@example", requestTimeoutMs: 1, keepaliveMs: 0, reconnectMax: 0, reconnectBaseMs: 1, platform: "win32" });
    const remote = argv[argv.length - 1] ?? "";
    expect(remote.startsWith("sh -c '")).toBe(true);
    // 循环体里的换行必须留在同一个 atom 里（拆开 = 远端只收到半条命令）。
    expect(remote).toContain("\n");
    // 响应式必须在这个 atom 里（不是被转义成两个 argv）。
    expect(remote).toContain("K %s %s %s %s");
    expect(remote.split("\n").length).toBeGreaterThan(8);
  });

  it("port / jump / 额外 -o 照旧透传（与 ssh_start 同一套合成）", () => {
    const argv = channelArgv({
      host: "dev@example",
      requestTimeoutMs: 1,
      keepaliveMs: 0,
      reconnectMax: 0,
      reconnectBaseMs: 1,
      platform: "win32",
      ssh: { port: 2222, jump: "bastion", options: [{ key: "ProxyCommand", value: "nc %h %p" }] },
    });
    expect(argv).toContain("-p");
    expect(argv).toContain("2222");
    expect(argv).toContain("-J");
    expect(argv).toContain("bastion");
    expect(argv).toContain("-o");
    expect(argv).toContain("ProxyCommand=nc %h %p"); // raw argv 不应携带 shell 引号
  });
});

describe("POSIX 远端探测（ADR-0017 决策 6）", () => {
  it("探测通过 ⇒ ready，且把实测的 uname/$SHELL 记在状态里", async () => {
    const harness = fakeChannelHarness()
    const channel = channelWith({ spawner: harness.spawner })
    await channel.acquire()
    const status = channel.status()
    expect(status.state).toBe("ready");
    expect(status.remoteShell).toEqual({ uname: "Linux", shell: "/bin/bash" });
    expect(status.transport).toEqual(workspaceTransport(process.platform));
    expect(harness.last().requests[0]?.command).toContain("uname -s");
  });

  it("远端是 Windows 系 ⇒ 响亮拒绝，点名 uname 与 SHELL 两个读数与 ADR 决策", async () => {
    const harness = fakeChannelHarness({
      respond: frameLoopResponder((command) =>
        command.startsWith("# dsh-probe")
          ? { exitCode: 0, stdout: "MINGW64_NT-10.0-22631|C:\\Windows\\System32\\cmd.exe" }
          : posixRemoteExec(command),
      ),
    })
    const channel = channelWith({ spawner: harness.spawner })
    await expect(channel.acquire()).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.NON_POSIX_SHELL })
    await expect(channel.acquire()).rejects.toThrow(/MINGW64_NT|not POSIX-family/u);
    // 明确点名 ADR 决策 6 —— 拒绝文案要能直接指向契约。
    expect(channel.status().state).toBe("unavailable");
    expect(channel.status().lastError?.code).toBe(REMOTE_CHANNEL_ERRORS.NON_POSIX_SHELL);
  });

  it("探测两个事实都没答上来 ⇒ 也拒绝（不能回答不是通过）", async () => {
    const harness = fakeChannelHarness({
      respond: frameLoopResponder((command) =>
        command.startsWith("# dsh-probe") ? { exitCode: 0, stdout: "|" } : posixRemoteExec(command),
      ),
    })
    const channel = channelWith({ spawner: harness.spawner })
    await expect(channel.acquire()).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.SHELL_UNPROBED })
  });

  it("远端没有 `sh`（退出 127 + not found）⇒ REMOTE_NO_SHELL，点名该装的工具与 out-of-scope", async () => {
    const harness = fakeChannelHarness({
      respond: frameLoopResponder(() => ({ exitCode: 127, stderr: "bash: sh: command not found" })),
    })
    const channel = channelWith({ spawner: harness.spawner })
    await expect(channel.acquire()).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.NO_SHELL })
    await expect(channel.acquire()).rejects.toThrow(/POSIX shell plus coreutils|out of scope/u);
  });
});

describe("请求往返 / 引用计数 / keepalive", () => {
  it("一条请求拿到远端命令自己的退出码与两股字节", async () => {
    const harness = fakeChannelHarness({
      respond: frameLoopResponder((command) => command.startsWith("# dsh-probe")
        ? posixRemoteExec(command)
        : { exitCode: 7, stdout: "out", stderr: "err" }),
    })
    const channel = channelWith({ spawner: harness.spawner })
    await channel.acquire()
    const result = await channel.request("exit 7")
    expect(result.exitCode).toBe(7);
    expect(result.stdout.toString()).toBe("out");
    expect(result.stderr.toString()).toBe("err");
    expect(channel.status().pending).toBe(0);
  });

  it("引用计数以**连接**为单位：两个工作区一条通道，最后一个 release 才关", async () => {
    const harness = fakeChannelHarness()
    const channel = channelWith({ spawner: harness.spawner })
    await channel.acquire();
    await channel.acquire();
    expect(harness.handles).toHaveLength(1); // 第二个 acquire 复用，不再 spawn
    expect(channel.status().users).toBe(2);
    expect(harness.last().killed).toBe(0);
    channel.release();
    expect(harness.last().killed).toBe(0);
    expect(channel.status().state).toBe("ready");
    channel.release();
    expect(channel.status().state).toBe("closed");
    expect(harness.last().killed).toBe(1);
  });

  it("keepalive 没回音 ⇒ 判死并走失败路径（不是让下一条真请求默默挂住）", async () => {
    const harness = fakeChannelHarness({
      respond: (request) => request.command === "true"
        ? undefined // 静默：模拟对端已死但 TCP 未断
        : frameLoopResponder(posixRemoteExec)(request),
    })
    const channel = channelWith({ spawner: harness.spawner, keepaliveMs: 15, requestTimeoutMs: 30 })
    await channel.acquire()
    await waitUntil(() => channel.status().state === "unavailable", {
      timeoutMs: 2_000,
      describeObserved: () => JSON.stringify(channel.status()),
    })
    expect(channel.status().lastError?.code).toBe(REMOTE_CHANNEL_ERRORS.DEAD)
    channel.close()
  });
});

describe("四种传输故障的终态", () => {
  it("错误帧 ⇒ 该请求以稳定码拒绝（协议层拒绝，不是静默空结果）", async () => {
    const harness = fakeChannelHarness({
      respond: (request) => request.command.startsWith("# dsh-probe")
        ? frameLoopResponder(posixRemoteExec)(request)
        : request.command === "boom" ? encodeError(request.id, "payload is not base64") : undefined,
    })
    const channel = channelWith({ spawner: harness.spawner })
    await channel.acquire()
    await expect(channel.request("boom")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.PROTOCOL })
  });

  it("不可解析的线路 ⇒ 通道整体判死（流已不可信），在飞请求全部被回收", async () => {
    const harness = fakeChannelHarness({
      respond: (request) => request.command.startsWith("# dsh-probe")
        ? frameLoopResponder(posixRemoteExec)(request)
        : request.command === "garbage" ? "this is not a frame\n" : undefined,
    })
    const channel = channelWith({ spawner: harness.spawner })
    await channel.acquire()
    await expect(channel.request("garbage")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.PROTOCOL })
    expect(channel.status().state).toBe("unavailable")
    expect(harness.last().killed).toBe(1)
  });

  it("通道死亡 ⇒ 在飞请求以 DEAD 拒绝，并在预算内重连成 ready", async () => {
    // 不给业务请求回帧，确保测的确实是在飞请求（不是早已返回的 exit 127）。
    const harness = fakeChannelHarness({ respond: (request) => request.command.startsWith("# dsh-probe")
      ? encodeResponse(request.id, 0, "Linux|/bin/bash") : undefined })
    const channel = channelWith({ spawner: harness.spawner, reconnectMax: 1 })
    await channel.acquire()
    const pending = channel.request("sleep 1")
    harness.last().exit({ code: 255, stderr: "Connection reset by peer" })
    await expect(pending).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD })
    await waitUntil(() => channel.status().state === "ready", { timeoutMs: 2_000 })
    expect(harness.handles).toHaveLength(2)
    expect(channel.status().reconnects).toBe(1)
    expect(channel.status().lastError).toBeUndefined()
    channel.close()
  });

  it("重连预算用尽 ⇒ unavailable + REMOTE_CHANNEL_LOST（绝不无限重试）", async () => {
    let attempt = 0
    const flaky: ChannelSpawner = (spec) => {
      attempt += 1
      // 每次新进程都立刻死：重连永远好不了。
      const harness = fakeChannelHarness({
        respond: () => undefined,
      })
      const spawner = harness.spawner
      const child = spawner(spec)
      queueMicrotask(() => harness.last().exit({ code: 255, stderr: "host unreachable" }))
      return child
    }
    const channel = channelWith({ spawner: flaky, reconnectMax: 2 })
    await expect(channel.acquire()).rejects.toBeTruthy()
    await waitUntil(() => channel.status().lastError?.code === REMOTE_CHANNEL_ERRORS.LOST, {
      timeoutMs: 2_000,
      describeObserved: () => JSON.stringify(channel.status()),
    })
    expect(channel.status().state).toBe("unavailable")
    expect(attempt).toBe(3) // 首连 + 2 次重连，一次不多
    channel.close()
  });

  it("请求超时 ⇒ TIMEOUT，且迟到的回帧被丢弃（不会喂给下一条请求）", async () => {
    let lateId: number | undefined
    const harness = fakeChannelHarness({
      respond: (request) => {
        if (request.command.startsWith("# dsh-probe")) return frameLoopResponder(posixRemoteExec)(request)
        if (request.command === "slow") {
          lateId = request.id // 不回：让它超时，之后再补一条迟到的回帧
          return undefined
        }
        return encodeResponse(request.id, 0, "fresh")
      },
    })
    const channel = channelWith({ spawner: harness.spawner, requestTimeoutMs: 20 })
    await channel.acquire()
    await expect(channel.request("slow")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.TIMEOUT })
    // 迟到的回帧：该 id 已不在 pending 里，必须被丢弃而不是当成下一条的结果。
    expect(lateId).toBe(2)
    harness.last().respond(2, { exitCode: 0, stdout: "late" })
    await expect(channel.request("true")).resolves.toMatchObject({ exitCode: 0 })
    channel.close()
  });
});


/** 仅走公开 ChannelSpawner seam：精确控制旧进程、异步错误与 probe 完成次序。 */
function controlledChannels(autoProbe = true) {
  const handles: Array<{
    emit: (data: string) => void;
    exit: (stderr?: string, code?: number) => void;
    error: (error: Error) => void;
    replyProbe: (stdout?: string, exitCode?: number) => void;
    commands: string[];
  }> = [];
  const spawner: ChannelSpawner = () => {
    let output: (chunk: Buffer) => void = () => {};
    let diagnostic: (text: string) => void = () => {};
    let exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
    let failed: (error: Error) => void = () => {};
    let probeId = 0;
    const commands: string[] = [];
    const handle = {
      commands,
      emit: (data: string) => output(Buffer.from(data)),
      exit: (stderr = "connection lost", code = 255) => { diagnostic(stderr); exit({ code, signal: null }); },
      error: (error: Error) => failed(error),
      replyProbe: (stdout = "Linux|/bin/bash", exitCode = 0) => output(Buffer.from(encodeResponse(probeId, exitCode, stdout))),
    };
    handles.push(handle);
    return {
      write: (wire: string) => {
        const [_, id, payload] = wire.trimEnd().split(" ");
        const command = Buffer.from(payload ?? "", "base64").toString();
        if (Number(id) === 0 && command.startsWith('DSH-HELLO ')) {
          const [, version, clientId] = command.split(' ');
          output(Buffer.from(encodeResponse(0, 0, `${version} ${clientId}`)));
          return true;
        }
        commands.push(command);
        if (command.includes("dsh-probe")) {
          probeId = Number(id);
          if (autoProbe) handle.replyProbe();
        }
        return true;
      },
      onStdout: (cb) => { output = cb; },
      onStderr: (cb) => { diagnostic = cb; },
      onExit: (cb) => { exit = cb; },
      onError: (cb: (error: Error) => void) => { failed = cb; },
      kill: () => {},
    };
  };
  return { handles, spawner };
}

/** 一个可控的公开重连时钟：推进一轮只释放一次 sleep。 */
function reconnectClock() {
  let release: (() => void) | undefined;
  return {
    sleep: () => new Promise<void>((resolve) => { release = resolve; }),
    waiting: () => release !== undefined,
    advance: () => { if (release === undefined) throw new Error("重连尚未等待时钟"); release(); release = undefined; },
  };
}

describe("生命周期恢复回归（#137）", () => {
  it("DEAD 后 request 不自行重开（显式 ensureReady 才是连接入口）", async () => {
    const fake = controlledChannels();
    const channel = channelWith({ spawner: fake.spawner });
    await channel.acquire();
    fake.handles[0]!.exit();
    await expect(channel.request("true")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD });
    expect(fake.handles).toHaveLength(1);
    channel.close();
  });

  it("LOST 后反复 request 仍返回 LOST、不重置自动重连预算", async () => {
    const fake = controlledChannels();
    let calls = 0;
    const channel = channelWith({ spawner: (spec) => { if (++calls > 1) throw new Error("offline"); return fake.spawner(spec); }, reconnectMax: 2 });
    await channel.acquire();
    fake.handles[0]!.exit();
    await waitUntil(() => channel.status().lastError?.code === REMOTE_CHANNEL_ERRORS.LOST, { timeoutMs: 1_000 });
    for (let index = 0; index < 3; index++) await expect(channel.request("true")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.LOST });
    expect(calls).toBe(3);
    channel.close();
  });

  it("重连退避期间 ensureReady/acquire/request 共用同一飞行任务", async () => {
    const fake = controlledChannels();
    const clock = reconnectClock();
    const channel = channelWith({ spawner: fake.spawner, reconnectMax: 1, sleep: clock.sleep });
    await channel.acquire();
    fake.handles[0]!.exit();
    const a = channel.ensureReady();
    const b = channel.acquire();
    const request = channel.request("pwd");
    expect(fake.handles).toHaveLength(1);
    await waitUntil(clock.waiting, { timeoutMs: 1_000 });
    clock.advance();
    await Promise.all([a, b]);
    await waitUntil(() => fake.handles[1]?.commands.includes("pwd") === true, { timeoutMs: 1_000 });
    // 首连 probe=id1，重连 probe=id2，业务请求=id3；只给新进程这条业务回帧。
    fake.handles[1]!.emit(encodeResponse(3, 0, "/srv/app"));
    expect((await request).stdout.toString()).toBe("/srv/app");
    expect(fake.handles).toHaveLength(2);
    expect(channel.status().reconnects).toBe(1);
    channel.close();
  });

  it("旧 child 的 stdout/stderr/exit/error 不得污染已就绪的新 child", async () => {
    const fake = controlledChannels();
    const channel = channelWith({ spawner: fake.spawner, reconnectMax: 1 });
    await channel.acquire();
    const old = fake.handles[0]!;
    old.exit();
    await waitUntil(() => channel.status().reconnects === 1, { timeoutMs: 1_000 });
    old.emit("not a frame\n");
    old.exit("old diagnostics", 127);
    old.error(new Error("old stdin error"));
    expect(channel.status()).toMatchObject({ state: "ready", reconnects: 1, pending: 0 });
    expect(channel.status().lastError).toBeUndefined();
    expect(fake.handles).toHaveLength(2);
    channel.close();
  });

  it("probe 已回帧但尚未发布 ready 时 close，完成续体不得复活连接", async () => {
    const fake = controlledChannels(false);
    const channel = channelWith({ spawner: fake.spawner });
    const opening = channel.acquire();
    await waitUntil(() => fake.handles.length === 1, { timeoutMs: 1_000 });
    const rejected = expect(opening).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.CLOSED });
    fake.handles[0]!.replyProbe();
    channel.close();
    await rejected;
    expect(channel.status().state).toBe("closed");
  });

  it("异步 spawn/stdin error 有界拒绝所有在飞请求，保持稳定 DEAD", async () => {
    const fake = controlledChannels(false);
    const channel = channelWith({ spawner: fake.spawner, requestTimeoutMs: 1_000 });
    const opening = channel.acquire();
    await waitUntil(() => fake.handles.length === 1, { timeoutMs: 1_000 });
    const rejected = expect(opening).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD });
    fake.handles[0]!.error(new Error("spawn ssh ENOENT"));
    await rejected;
    expect(channel.status().pending).toBe(0);
    expect(channel.status().lastError?.code).toBe(REMOTE_CHANNEL_ERRORS.DEAD);
    channel.close();
  });

  it("初连两个 ensureReady 同飞；业务期 stdin error 回收所有请求", async () => {
    const fake = controlledChannels(false);
    const channel = channelWith({ spawner: fake.spawner });
    const a = channel.acquire();
    const b = channel.ensureReady();
    await waitUntil(() => fake.handles.length === 1, { timeoutMs: 1_000 });
    fake.handles[0]!.replyProbe();
    await Promise.all([a, b]);
    const first = channel.request("one");
    const second = channel.request("two");
    const rejected = Promise.all([
      expect(first).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD }),
      expect(second).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD }),
    ]);
    fake.handles[0]!.error(new Error("write EPIPE"));
    await rejected;
    expect(channel.status().pending).toBe(0);
    await expect(channel.request("three")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD });
    expect(fake.handles).toHaveLength(1);
    channel.close();
  });

  it("spawner 同步抛错有稳定 DEAD，request 不自行重试", async () => {
    let calls = 0;
    const channel = channelWith({ spawner: () => { calls++; throw new Error("spawn ENOENT"); } });
    await expect(channel.acquire()).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD });
    await expect(channel.request("true")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD });
    expect(calls).toBe(1);
    channel.close();
  });

  it("业务期 write 同步抛错回收 pending，并把连接留为 DEAD", async () => {
    const fake = controlledChannels();
    let writes = 0;
    const spawner: ChannelSpawner = (spec) => {
      const child = fake.spawner(spec);
      return { ...child, write: (wire) => {
        if (wire.startsWith('R 0 ')) return child.write(wire); // 协议控制握手不计业务write
        if (++writes > 1) throw new Error("write on closed stream");
        return child.write(wire);
      } };
    };
    const channel = channelWith({ spawner });
    await channel.acquire();
    await expect(channel.request("true")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD });
    expect(channel.status()).toMatchObject({ state: "unavailable", pending: 0 });
    await expect(channel.request("again")).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD });
    expect(writes).toBe(2);
    channel.close();
  });

  it("probe 是合法注释而非 `<dsh-probe>` 文件重定向", async () => {
    const fake = controlledChannels();
    const channel = channelWith({ spawner: fake.spawner });
    await channel.acquire();
    expect(fake.handles[0]!.commands[0]).toBe('# dsh-probe\nuname -s; printf "|"; printf "%s" "${SHELL:-}"');
    channel.close();
  });

  it.each(["/usr/bin/pwsh", "/bin/csh", "/bin/unknown", "", "bash -c injected"])("登录 shell 白名单拒绝 %j，即便 uname=Linux", async (shell) => {
    const fake = controlledChannels(false);
    const channel = channelWith({ spawner: fake.spawner });
    const opening = channel.acquire();
    await waitUntil(() => fake.handles.length === 1, { timeoutMs: 1_000 });
    const rejected = expect(opening).rejects.toMatchObject({ code: shell === "" ? REMOTE_CHANNEL_ERRORS.SHELL_UNPROBED : REMOTE_CHANNEL_ERRORS.NON_POSIX_SHELL });
    fake.handles[0]!.replyProbe(`Linux|${shell}`);
    await rejected;
    channel.close();
  });

  it.each(["/bin/sh", "/bin/bash", "/usr/bin/zsh", "/bin/dash", "/bin/ksh", "/bin/ash", "/usr/bin/fish"])("登录 shell 白名单接受 %j", async (shell) => {
    const fake = controlledChannels(false);
    const channel = channelWith({ spawner: fake.spawner });
    const opening = channel.acquire();
    await waitUntil(() => fake.handles.length === 1, { timeoutMs: 1_000 });
    fake.handles[0]!.replyProbe(`Linux|${shell}`);
    await opening;
    expect(channel.status().state).toBe("ready");
    channel.close();
  });

  it("非零 probe 即使带着貌似合法的 stdout 也不得通过", async () => {
    const fake = controlledChannels(false);
    const channel = channelWith({ spawner: fake.spawner });
    const opening = channel.acquire();
    await waitUntil(() => fake.handles.length === 1, { timeoutMs: 1_000 });
    const rejected = expect(opening).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.SHELL_UNPROBED });
    fake.handles[0]!.replyProbe("Linux|/bin/bash", 1);
    await rejected;
    channel.close();
  });

  it("ssh 本地 IdentityFile not-found 不能被归为远端缺 sh", async () => {
    const fake = controlledChannels(false);
    const channel = channelWith({ spawner: fake.spawner });
    const opening = channel.acquire();
    await waitUntil(() => fake.handles.length === 1, { timeoutMs: 1_000 });
    const rejected = expect(opening).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.DEAD });
    fake.handles[0]!.exit("Warning: Identity file /tmp/key not found: No such file or directory.", 255);
    await rejected;
    channel.close();
  });
});

describe("默认 process 适配器：公开 ChannelSpawner seam", () => {
  it("onExit 在 close（stdout 已排空）才发布，不在 exit 发布", () => {
    const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 7, kill: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(process as unknown as ReturnType<typeof spawn>);
    const child = defaultChannelSpawner({ host: "test", argv: ["ssh"] });
    let text = "";
    const ended = vi.fn();
    child.onStdout((chunk) => { text += chunk.toString(); });
    child.onExit(ended);
    process.emit("exit", 0, null);
    expect(ended).not.toHaveBeenCalled();
    process.stdout.write("tail after exit");
    process.emit("close", 0, null);
    expect(text).toBe("tail after exit");
    expect(ended).toHaveBeenCalledExactlyOnceWith({ code: 0, signal: null });
  });

  it("spawn 与 stdin 的 error 都有监听，订阅前错误也会被交给通道", () => {
    const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 7, kill: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(process as unknown as ReturnType<typeof spawn>);
    const child = defaultChannelSpawner({ host: "test", argv: ["ssh"] });
    expect(() => process.emit("error", new Error("ENOENT"))).not.toThrow();
    const received = vi.fn();
    const withError = child as typeof child & { onError?: (callback: (error: Error) => void) => void };
    expect(withError.onError).toBeTypeOf("function");
    withError.onError?.(received);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ message: "ENOENT" }));
    expect(() => process.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ message: "EPIPE" }));
  });
});
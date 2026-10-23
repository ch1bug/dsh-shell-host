/**
 * `./remote` 入口（#137）：工作区登记 + 锚点 + 预热 + 三工具 + 服务面。
 *
 * 判据集中在本票 AC 的可判形：
 *   - `remote_open` 建锚点（含 marker）并返回「用 remote_*」提示；
 *   - `remote_list` / `remote_status` 可查状态，`remote_status` 报告 ADR-0017 的**实际**传输形态；
 *   - 组合装载时**预热**：`apply` 立即返回（不阻塞 host 启动），连接随后变 ready；
 *   - 连不上 ⇒ unavailable + 稳定错误码；远端违约（非 POSIX / 无 sh）⇒ 响亮拒绝；
 *   - 同一 host 一条通道、按连接引用计数；dispose 关通道。
 *
 * @module tests/remote.spec
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootPlugin } from "./helpers/fake-pty.ts";
import { fakeChannelHarness, frameLoopResponder, type FakeResponder, type FakeRequest } from "./helpers/fake-channel.ts";
import { waitUntil } from "./helpers/wait-until.ts";
import { fakeSandboxPolicy } from "./helpers/fake-permissions.ts";
import { ANCHOR_MARKER_FILE, REMOTE_WORKSPACE_HINT, name as remoteName, inject as remoteInject } from "../src/remote/index.ts";
import { workspaceIdFor } from "../src/remote/index.ts";
import { REMOTE_WORKSPACE_ERRORS } from "../src/remote/service.ts";
import { REMOTE_CHANNEL_ERRORS } from "../src/remote/channel.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `remote-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

/** Boot the remote pair over a fake channel; returns the boot handle + harness. */
function bootRemote(options: {
  config?: Record<string, unknown>;
  respond?: FakeResponder;
  platform?: NodeJS.Platform;
  policy?: { mode?: "read-only" | "workspace-write" | "danger-full-access"; workspaceRoot?: string };
} = {}) {
  const harness = fakeChannelHarness(options.respond === undefined ? {} : { respond: options.respond });
  const boot = bootPlugin({
    permissions: {
      sandboxPolicy: fakeSandboxPolicy({
        ...(options.policy?.mode === undefined ? {} : { mode: options.policy.mode }),
        ...(options.policy?.workspaceRoot === undefined ? {} : { workspaceRoot: options.policy.workspaceRoot }),
      }),
    },
    remote: options.config ?? {},
    remoteDeps: {
      spawner: harness.spawner,
      platform: options.platform ?? "win32",
      sleep: async () => {},
    },
    remoteFs: {},
  });
  return { ...boot, harness };
}

describe("入口自面：name / inject / Config / apply 与服务面", () => {
  it("./remote 提供 ctx.remote 并注册三工具；./remote-fs 提供 ctx.remoteFs 与 remote_ls", () => {
    const boot = bootRemote();
    expect(remoteName).toBe("dsh-shell-host-remote");
    // `remote_open` 走宿主权限门 ⇒ 两个权限服务是真依赖（fail closed）。
    expect(remoteInject).toEqual(["tools", "sandboxPolicy", "approval"]);
    for (const tool of ["remote_open", "remote_list", "remote_status"]) expect(boot.tool(tool).name).toBe(tool);
    expect(boot.provided.get("remote")).toBeTruthy();
    expect(boot.provided.get("remoteFs")).toBeTruthy();
    expect(boot.tool("remote_ls").name).toBe("remote_ls");
  });
});

describe("remote_open：锚点 + marker + 提示", () => {
  it("创建锚点目录与 marker（host + 远端 root），结果带 remote_* 提示与 ready 状态", async () => {
    const root = tempDir("open");
    const boot = bootRemote({ config: { anchorRoot: root } });
    const result = await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    expect(result.state).toBe("ready");
    expect(result.workspaceId).toBe(workspaceIdFor("dev@example", "/srv/app"));
    expect(result.anchor).toBe(join(root, result.workspaceId));
    expect(statSync(result.anchor).isDirectory()).toBe(true);
    const marker = JSON.parse(readFileSync(join(result.anchor, ANCHOR_MARKER_FILE), "utf8"));
    expect(marker).toMatchObject({ version: 1, host: "dev@example", root: "/srv/app", workspaceId: result.workspaceId });
    // AC：结果必须说"此处用 remote_*"（锚点是身份，不是副本）。
    expect(result.hint).toBe(REMOTE_WORKSPACE_HINT);
    expect(result.sandboxMode).toBe("danger-full-access");
    boot.effects.forEach((effect) => void effect.dispose);
  });

  it("同一 host+root 再开 ⇒ 幂等（同一 id、同一条通道、不重复 spawn）", async () => {
    const root = tempDir("idem");
    const boot = bootRemote({ config: { anchorRoot: root } });
    const first = await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    const second = await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(boot.harness.handles).toHaveLength(1);
    // The flat status row carries the channel facts (users/reconnects/pending).
    expect(second.users).toBe(1);
  });

  it("同 host 不同 root ⇒ 两个工作区、一条通道（引用计数 2）", async () => {
    const root = tempDir("two-ws");
    const boot = bootRemote({ config: { anchorRoot: root } });
    await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/a" }, { agent: {} });
    const second = await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/b" }, { agent: {} });
    expect(second.users).toBe(2);
    expect(boot.harness.handles).toHaveLength(1);
    const listed = await boot.tool("remote_list").execute({}, { agent: {} });
    expect(listed.workspaces.map((row: { root: string }) => row.root)).toEqual(["/srv/a", "/srv/b"]);
  });

  it("锚点已属于另一个 host/root ⇒ 响亮拒绝（锚点是身份，不可复用路径）", async () => {
    const root = tempDir("conflict");
    const anchor = join(root, "shared-anchor");
    const boot = bootRemote({ config: { anchorRoot: root } });
    await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/a", anchor }, { agent: {} });
    await expect(
      boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/b", anchor }, { agent: {} }),
    ).rejects.toMatchObject({ code: REMOTE_WORKSPACE_ERRORS.ANCHOR_CONFLICT });
  });

  it("marker 读不懂 ⇒ 同样拒绝（不覆盖别人的锚点）", async () => {
    const root = tempDir("bad-marker");
    const anchor = join(root, "anchor");
    const boot = bootRemote({ config: { anchorRoot: root } });
    await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/a", anchor }, { agent: {} });
    writeFileSync(join(anchor, ANCHOR_MARKER_FILE), "not json", "utf8");
    // 幂等键换成另一 root，才会走到 marker 校验（同一 root 命中记录、不重读）。
    await expect(
      boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/b", anchor }, { agent: {} }),
    ).rejects.toMatchObject({ code: REMOTE_WORKSPACE_ERRORS.ANCHOR_CONFLICT });
  });

  it("远端 root 必须是绝对 POSIX 路径（Windows 形态拒绝，ADR-0017 决策 6）", async () => {
    const boot = bootRemote({ config: { anchorRoot: tempDir("bad-root") } });
    await expect(
      boot.tool("remote_open").execute({ host: "dev@example", root: "C:\\srv\\app" }, { agent: {} }),
    ).rejects.toMatchObject({ code: REMOTE_WORKSPACE_ERRORS.INVALID_DECLARATION });
    await expect(
      boot.tool("remote_open").execute({ host: "dev@example", root: "relative/dir" }, { agent: {} }),
    ).rejects.toMatchObject({ code: REMOTE_WORKSPACE_ERRORS.INVALID_DECLARATION });
  });

  it("read-only 策略下拒绝开工作区（#102：本地 spawn + 写锚点都要过门）", async () => {
    const boot = bootRemote({ config: { anchorRoot: tempDir("ro") }, policy: { mode: "read-only" } });
    await expect(
      boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} }),
    ).rejects.toMatchObject({ code: "SANDBOX_DENIED" });
    expect(boot.harness.handles, "被拒绝时不得 spawn").toHaveLength(0);
  });

  it("没有 owning agent 的调用被拒，文案点名 remote_* 家族", async () => {
    const boot = bootRemote({ config: { anchorRoot: tempDir("noagent") } });
    await expect(boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, {})).rejects.toMatchObject({
      code: "NO_AGENT",
    });
    await expect(boot.tool("remote_list").execute({}, {})).rejects.toThrow(/remote_\* tools require/u);
  });
});

describe("remote_status：连接状态 + ADR-0017 传输形态", () => {
  it("win32 客户端报 per-session-connection，POSIX 报 control-master（实际形态，不是可能形态）", async () => {
    const win = bootRemote({ config: { anchorRoot: tempDir("transport-win") }, platform: "win32" });
    const winOpen = await win.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    expect(winOpen.transport).toEqual({ shape: "per-session-connection", controlMasterUsable: false });

    const posix = bootRemote({ config: { anchorRoot: tempDir("transport-posix") }, platform: "linux" });
    const posixOpen = await posix.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    expect(posixOpen.transport).toEqual({ shape: "control-master", controlMasterUsable: true });
  });

  it("报告实测的远端 shell 事实、引用计数与在飞请求数", async () => {
    const boot = bootRemote({ config: { anchorRoot: tempDir("status") } });
    const opened = await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    const status = await boot.tool("remote_status").execute({ workspaceId: opened.workspaceId }, { agent: {} });
    expect(status.workspaces).toHaveLength(1);
    expect(status.workspaces[0]).toMatchObject({
      workspaceId: opened.workspaceId,
      state: "ready",
      users: 1,
      pending: 0,
      remoteShell: { uname: "Linux", shell: "/bin/bash" },
    });
  });

  it("未知 workspaceId ⇒ 稳定码 + 列出已注册项", async () => {
    const boot = bootRemote({ config: { anchorRoot: tempDir("unknown") } });
    await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    await expect(boot.tool("remote_status").execute({ workspaceId: "nope" }, { agent: {} })).rejects.toMatchObject({
      code: REMOTE_WORKSPACE_ERRORS.UNKNOWN_WORKSPACE,
    });
  });
});

describe("组合装载时预热（AC：不阻塞 host 启动）", () => {
  it("apply 立即返回，连接随后自己变 ready（首个轮次之前建连）", async () => {
    const root = tempDir("prewarm");
    const boot = bootRemote({ config: { anchorRoot: root, workspaces: [{ host: "dev@example", root: "/srv/app" }] } });
    // 同步返回 = host 启动没被连接阻塞（这一点必须先断言，再等连接）。
    expect(boot.harness.handles).toHaveLength(0);
    await waitUntil(() => boot.harness.handles.length === 1, { timeoutMs: 2_000 });
    await waitUntil(() => (boot.provided.get("remote") as { list: () => Array<{ state: string }> }).list()[0]?.state === "ready", {
      timeoutMs: 2_000,
      describeObserved: () => JSON.stringify((boot.provided.get("remote") as { list: () => unknown }).list()),
    });
  });

  it("连不上 ⇒ 状态 unavailable + 稳定码，且 apply 不抛（host 照常启动）", async () => {
    const root = tempDir("prewarm-fail");
    // 连不上的真实形态：进程起不来/立刻退出，探测请求**没有回帧**（不是回一个错码）。
    const boot = bootRemote({
      config: { anchorRoot: root, workspaces: [{ host: "unreachable@example", root: "/srv/app" }] },
      respond: () => undefined,
    });
    await waitUntil(() => boot.harness.handles.length === 1, { timeoutMs: 2_000 });
    boot.harness.last().exit({ code: 255, stderr: "ssh: connect to host example port 22: Connection refused" });
    await waitUntil(() => {
      const rows = (boot.provided.get("remote") as { list: () => Array<{ state: string }> }).list();
      return rows[0]?.state === "unavailable";
    }, { timeoutMs: 2_000, describeObserved: () => JSON.stringify((boot.provided.get("remote") as { list: () => unknown }).list()) });
    const rows = (boot.provided.get("remote") as { list: () => Array<{ error?: { code: string } }> }).list();
    expect(rows[0]?.error?.code).toBe(REMOTE_CHANNEL_ERRORS.DEAD);
  });
});

describe("远端违约 ⇒ 响亮拒绝（且工作区登记为 unavailable）", () => {
  it("非 POSIX 远端：tool 报错、状态里留 stable code", async () => {
    const root = tempDir("nonposix");
    const boot = bootRemote({
      config: { anchorRoot: root },
      respond: (request: FakeRequest) => request.command.startsWith("# dsh-probe\n")
        ? frameLoopResponder(() => ({ exitCode: 0, stdout: "MINGW64_NT-10.0|C:\\Windows\\System32\\cmd.exe" }))(request)
        : undefined,
    });
    await expect(
      boot.tool("remote_open").execute({ host: "winbox", root: "/c/app" }, { agent: {} }),
    ).rejects.toMatchObject({ code: REMOTE_CHANNEL_ERRORS.NON_POSIX_SHELL });
    const rows = (boot.provided.get("remote") as { list: () => Array<{ state: string; error?: { code: string } }> }).list();
    expect(rows[0]).toMatchObject({ state: "unavailable", error: { code: REMOTE_CHANNEL_ERRORS.NON_POSIX_SHELL } });
  });
});

describe("dispose：关掉通道", () => {
  it("entry 的 dispose effect 释放引用并杀掉通道进程", async () => {
    const boot = bootRemote({ config: { anchorRoot: tempDir("dispose") } });
    await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    const handle = boot.harness.last();
    expect(handle.killed).toBe(0);
    for (const effect of boot.effects) await effect.dispose();
    expect(handle.killed).toBe(1);
  });
});

describe("锚点 → 工作区（ADR-0016 决策 6）", () => {
  it("嵌套锚点取最长匹配（内层工作区不被外层吞掉）", async () => {
    const root = tempDir("nested");
    const outer = join(root, "outer");
    const inner = join(root, "outer", "inner");
    const boot = bootRemote({ config: { anchorRoot: root } });
    await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/outer", anchor: outer }, { agent: {} });
    await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/inner", anchor: inner }, { agent: {} });
    const service = boot.provided.get("remote") as {
      workspaceForAnchor: (path: string) => { root: string } | undefined;
    };
    expect(service.workspaceForAnchor(join(inner, "sub"))?.root).toBe("/srv/inner");
    expect(service.workspaceForAnchor(join(outer, "other"))?.root).toBe("/srv/outer");
    expect(service.workspaceForAnchor(join(root, "elsewhere"))).toBeUndefined();
  });
});

describe("服务面：exec 只经通道，未知工作区响亮", () => {
  it("exec 把命令交给通道并原样返回退出码/字节", async () => {
    const boot = bootRemote({ config: { anchorRoot: tempDir("exec") } });
    const opened = await boot.tool("remote_open").execute({ host: "dev@example", root: "/srv/app" }, { agent: {} });
    const service = boot.provided.get("remote") as {
      exec: (id: string, command: string) => Promise<{ exitCode: number; stdout: Buffer }>;
    };
    // 假远端对未知命令回 127；这里断言"命令确实到了通道"。
    const result = await service.exec(opened.workspaceId, "echo hi");
    expect(result.exitCode).toBe(127);
    expect(boot.harness.last().requests.map((request) => request.command)).toContain("echo hi");
    await expect(service.exec("missing", "true")).rejects.toMatchObject({ code: REMOTE_WORKSPACE_ERRORS.UNKNOWN_WORKSPACE });
  });
});
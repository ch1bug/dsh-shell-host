/**
 * #141：远程工作区的**活体往返**（ADR-0016「Live-verification gap」的落地）。
 *
 * 一条真实 ssh 往返：开工作区 → remote_ls → remote_read → 原子 remote_write →
 * 关闭，每步各有自己的读数。门禁优先级（AC③）：
 *
 *   1. `DSH_SSH_LIVE_HOST`（真实主机）在位 ⇒ 直接对真实主机跑（root 用
 *      `/tmp` 下的临时目录，seed/清理都走通道本身）；
 *   2. 否则用 Docker sshd 挂具（tests/helpers/sshd-container.ts +
 *      tests/fixtures/remote-sshd/Dockerfile，docker/podman 均可）；
 *   3. 两者都不可用 ⇒ 模块顶层打 AC⑤ 哨兵
 *      `!! SKIP (loud): not run locally: 远程活体 …`（**唯一持有者**——挂具
 *      启动失败是另一回事，措辞用 `not run locally: 远程工作区活体往返`，
 *      不含该哨兵子串，grep 记账不会把"装了 docker 但 build 失败"计入"两者
 *      都缺席"）。skip 记账形态：两个挂具用例整跳，但下方"门禁自检"用例
 *      无环境依赖照跑 ⇒ 文件行 `✓ (3 tests | 2 skipped)`，按 verify-all 的
 *      entryStatus（`✓` 且含 skipped ⇒ PASS*）落在 AC③ 要的 PASS*，与
 *      ssh-pty-live 的全跳 SKIP（`↓`）形态区分开。
 *
 * AC④（失败把远端 stderr 原文带回断言）有两层：任何一步失败时 `step()`
 * 把通道 lastError 与容器日志一并带回；另有 chmod 000 注入的**正验读数**，
 * 断言远端 stderr 的原文（`Permission denied`）真的出现在工具错误里。
 *
 * 机器档（serial）：真实进程 + 墙钟成本，与 ssh-pty-live 同一车道。
 *
 * @module tests/remote-roundtrip-live
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { bootPlugin } from "./helpers/fake-pty.ts";
import { ANCHOR_MARKER_FILE } from "../src/remote/index.ts";
import type { RemoteWorkspaceService } from "../src/remote/service.ts";
import {
    containerLogs,
    detectContainerRuntime,
    startSshdContainer,
    SSHD_REMOTE_ROOT,
    type SshdHarness,
} from "./helpers/sshd-container.ts";

// 门禁优先级①：真实主机在位就优先用它，连容器探测都不必跑。
const HOST = process.env.DSH_SSH_LIVE_HOST;
// 门禁优先级②：否则探测 Docker/podman（--version 且 info 都成功才算可用；
// DSH_SSHD_TEST_RUNTIME 覆盖值错 ⇒ 这里响亮 throw，collection 红就是响亮失败）。
const RUNTIME: "docker" | "podman" | null = HOST !== undefined ? null : await detectContainerRuntime();
// AC⑤：`not run locally: 远程活体` 只在两者都缺席时成立（本文件的唯一持有处）。
const GATED_OFF = HOST === undefined && RUNTIME === null;
if (GATED_OFF) {
    console.warn("!! SKIP (loud): not run locally: 远程活体 —— DSH_SSH_LIVE_HOST 与容器运行时两者都缺席（docker/podman 都不在位或 daemon/machine 未启动），五步往返一条都没跑");
}

/** 一条带读数的步：失败时把通道 lastError + 容器日志原文带回（AC④，不吞）。 */
async function step<T>(label: string, run: () => Promise<T>, diagnostics: () => Promise<string>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        const notes = await diagnostics().catch((cause: unknown) => `（诊断自身失败：${String(cause)}）`);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`[${label}] 失败：${message}\n—— 远端/通道诊断（不吞）：\n${notes}`, { cause: error });
    }
}

/**
 * 挂具起不来的 loud skip（措辞族：`not run locally: 远程工作区活体往返`——
 * 刻意不含 AC⑤ 哨兵子串 `not run locally: 远程活体`，那是"两者都缺席"专用）。
 */
function warnHarnessUnavailable(reason: string): void {
    console.warn(`!! SKIP (loud): not run locally: 远程工作区活体往返 —— ${reason}`);
}

describe.skipIf(GATED_OFF)("远程工作区活体往返（#141）", () => {
    // 挂具资源的双重收尾：每个挂具启动成功即注册 onTestFinished（用例超时
    // 中断也收），afterAll 兜底再全收一遍（close 幂等）——AC①"失败也收"
    // 连"Promise.all 未 resolve 就超时、teardown 从未注册"的路径也要盖住
    // （复审实测抓到的泄漏正是这条）。
    const liveHarnesses: SshdHarness[] = [];
    afterAll(async () => {
        for (const harness of liveHarnesses.splice(0)) await harness.close();
    });
    async function startTracked(): Promise<SshdHarness> {
        const harness = await startSshdContainer();
        liveHarnesses.push(harness);
        onTestFinished(async () => { await harness.close(); });
        return harness;
    }

    it(
        "开工作区 → remote_ls → remote_read → 原子 remote_write → 关闭，五步各有读数",
        { timeout: HOST !== undefined ? 120_000 : 300_000 },
        async () => {
            // 真实主机优先；否则起 Docker 挂具。挂具环境类失败（构建/拉取）转
            // loud skip —— stderr 原文照印，绝不静默。
            let harness: SshdHarness | null = null;
            if (HOST === undefined) {
                try {
                    harness = await startTracked();
                } catch (error) {
                    warnHarnessUnavailable(`容器挂具启动失败：${error instanceof Error ? error.message : String(error)}`);
                    return;
                }
            }
            const target = HOST !== undefined
                ? {
                    host: HOST!,
                    // 真实主机没有可预约的目录：用 /tmp 下的一次性根，seed/清理走通道。
                    root: `/tmp/dsh-remote-live-${String(process.pid)}-${String(Date.now())}`,
                    port: undefined as number | undefined,
                    options: ["BatchMode=yes", "LogLevel=ERROR"],
                }
                : {
                    // ssh destination 带用户（`user@host`）：挂具是专用非 root 用户，
                    // 不写的话 ssh 会拿本地用户名去连（stderr 原文：invalid user）。
                    host: `${harness!.user}@${harness!.host}`,
                    root: SSHD_REMOTE_ROOT,
                    port: harness!.port,
                    options: harness!.sshOptions(),
                };

            const anchorRoot = mkdtempSync(join(tmpdir(), "dsh-remote-live-anchor-"));
            onTestFinished(() => rmSync(anchorRoot, { recursive: true, force: true }));
            const boot = bootPlugin({
                remote: { anchorRoot, keepaliveMs: 0, reconnectMax: 0 },
                remoteFs: {},
            });
            onTestFinished(async () => { for (const effect of boot.effects) await effect.dispose(); });
            const diagnostics = async (): Promise<string> => {
                const remote = boot.ctx.get("remote") as RemoteWorkspaceService;
                const rows = remote.list().map((row) =>
                    `  通道 ${row.workspaceId}: state=${row.state}` +
                    (row.error === undefined ? "" : ` lastError=${row.error.code}: ${row.error.message}`));
                const logs = harness === null ? "  (真实主机模式：无容器日志)" : `  容器日志：\n${(await containerLogs(harness)).replaceAll(/^/gmu, "  ")}`;
                return `${rows.join("\n") || "  (无已注册工作区)"}\n${logs}`;
            };
            const tool = boot.tool;
            // 同一个 agent 贯穿五步：观察源按 agent.session 记读后状态，
            // remote_write 的 create/replace 语义靠它成立。
            const agent = { name: "live", session: {} as object };
            const remote = boot.ctx.get("remote") as RemoteWorkspaceService;

            // ── ① 开工作区 ───────────────────────────────────────────────
            const opened = await step("① remote_open", () => tool("remote_open").execute({
                host: target.host,
                root: target.root,
                ...(target.port === undefined ? {} : { port: target.port }),
                options: target.options,
            }, { agent }), diagnostics) as { workspaceId: string; state: string; anchor: string; transport: { shape: string; controlMasterUsable: boolean }; remoteShell?: { uname: string; shell: string }; hint: string };
            expect(opened.state).toBe("ready"); // 读数①：通道就绪
            expect(opened.workspaceId).toBeTruthy(); // 读数①：稳定 id（真实主机模式下 slug 来自 host 本名）
            expect(["control-master", "per-session-connection"]).toContain(opened.transport.shape);
            expect(opened.remoteShell?.uname.trim()).toBeTruthy(); // 读数①：POSIX 探测事实（uname/SHELL）
            expect(opened.hint).toContain("remote_ls"); // 锚点契约提示随行
            const marker = JSON.parse(readFileSync(join(opened.anchor, ANCHOR_MARKER_FILE), "utf8")) as Record<string, unknown>;
            expect(marker).toMatchObject({ version: 1, host: target.host, root: target.root }); // 读数①：锚点身份

            // seed（挂具通道 mkdir + base64，内容带 shell 元字符；setup 不算被测步）。
            const seedDir = `${target.root}/rnd-${String(Date.now())}`;
            const seedContent = "往返种子 $(touch nope) '单引号' \\ 反斜杠\n第二行\n";
            await step("setup seed", async () => {
                const b64 = Buffer.from(seedContent, "utf8").toString("base64");
                const result = await remote.exec(opened.workspaceId,
                    `mkdir -p -- '${seedDir}' && echo '${b64}' | base64 -d > '${seedDir}/hello.txt' && wc -c < '${seedDir}/hello.txt'`);
                if (result.exitCode !== 0 || result.stdout.toString().trim() !== String(Buffer.byteLength(seedContent, "utf8"))) {
                    throw new Error(`seed 失败（exit ${String(result.exitCode)}；stderr: ${result.stderr.toString().trim()}）`);
                }
            }, diagnostics);

            // ── ② remote_ls ──────────────────────────────────────────────
            const listed = await step("② remote_ls", () => tool("remote_ls").execute({ path: seedDir }, { agent }), diagnostics) as { path: string; entries: Array<{ name: string; type: string; path: string; size?: number }>; truncated: boolean; total: number };
            expect(listed.path).toBe(seedDir); // 读数②：列目路径
            expect(listed.total).toBe(1);
            expect(listed.truncated).toBe(false);
            expect(listed.entries[0]).toMatchObject({
                name: "hello.txt",
                type: "file",
                path: `${seedDir}/hello.txt`,
                size: Buffer.byteLength(seedContent, "utf8"),
            }); // 读数②：名字/类型/字节数

            // ── ③ remote_read ────────────────────────────────────────────
            const read = await step("③ remote_read", () => tool("remote_read").execute({ file_path: `${seedDir}/hello.txt` }, { agent }), diagnostics) as { path: string; lines: Array<{ number: number; text: string }>; totalLines: number };
            expect(read.path).toBe(`${seedDir}/hello.txt`);
            expect(read.totalLines).toBe(2);
            expect(read.lines.map((line) => line.text)).toEqual(["往返种子 $(touch nope) '单引号' \\ 反斜杠", "第二行"]); // 读数③：逐行原文

            // ── ④ 原子 remote_write ──────────────────────────────────────
            const writeTarget = `${seedDir}/written.txt`;
            // 先读缺失路径：观察源记录 absent ⇒ 下一步写走 createIfAbsent。
            await expect(tool("remote_read").execute({ file_path: writeTarget }, { agent }))
                .rejects.toMatchObject({ code: "FS_NOT_FOUND" });
            const firstVersion = "原子写第一版\n中文无尾随换行";
            const created = await step("④a remote_write create", () => tool("remote_write").execute({ file_path: writeTarget, content: firstVersion }, { agent }), diagnostics) as { path: string; operation: string; before: string | null; after: string };
            expect(created.operation).toBe("create"); // 读数④a：create 语义
            expect(created.before).toBeNull();
            expect(created.after).toBe(firstVersion);
            const reread = await step("④b 回读", () => tool("remote_read").execute({ file_path: writeTarget }, { agent }), diagnostics) as { lines: Array<{ number: number; text: string }>; totalLines: number };
            expect(reread.lines.map((line) => line.text)).toEqual(["原子写第一版", "中文无尾随换行"]);
            // 独立于 fs 面的字节读数：挂具通道直接 wc -c，fs 自己骗不了这把尺。
            const bytes = await step("④b' wc -c 字节核对", () => remote.exec(opened.workspaceId, `wc -c < '${writeTarget}'`), diagnostics);
            expect(bytes.stdout.toString().trim()).toBe(String(Buffer.byteLength(firstVersion, "utf8")));
            // 原子性活体读数：同一读后版本两个并发写，恰好一个成功、一个 FS_STALE_VERSION。
            const race = await Promise.allSettled(["并发写A\n", "并发写B\n"].map((content) =>
                tool("remote_write").execute({ file_path: writeTarget, content }, { agent })));
            const won = race.filter((r) => r.status === "fulfilled");
            const lost = race.filter((r) => r.status === "rejected") as Array<PromiseRejectedResult>;
            expect(won).toHaveLength(1); // 读数④c：恰一个发布
            expect(lost).toHaveLength(1);
            expect((lost[0]!.reason as { code?: string }).code).toBe("FS_STALE_VERSION");

            // AC④ 正验读数：失败把远端 stderr 原文带回断言。chmod 000 拦不住
            // root ⇒ 先看 id -u，是 root 就响亮声明这条注入不成立。
            const uid = await remote.exec(opened.workspaceId, "id -u");
            if (uid.stdout.toString().trim() === "0") {
                console.warn("!! SKIP (loud): stderr 注入子断言 —— 本次远端登录用户是 root，chmod 000 拦不住 root，注入读数不成立");
            } else {
                await step("④d stderr 注入（AC④）", async () => {
                    await remote.exec(opened.workspaceId, `chmod 000 -- '${seedDir}/hello.txt'`);
                    const denied = await tool("remote_read").execute({ file_path: `${seedDir}/hello.txt` }, { agent }).then(
                        () => { throw new Error("chmod 000 后 remote_read 竟然成功——注入读数不成立"); },
                        (error: unknown) => error,
                    );
                    expect((denied as { code?: string }).code).toBe("FS_PERMISSION_DENIED");
                    expect(String((denied as Error).message)).toContain("Permission denied"); // 远端 stderr 原文进了断言
                }, diagnostics);
                await remote.exec(opened.workspaceId, `chmod 644 -- '${seedDir}/hello.txt'`);
            }

            // 收尾：清远端 seed（best-effort），再关工作区。
            await remote.exec(opened.workspaceId, `rm -rf -- '${seedDir}'`).catch(() => {});
            const closed = await step("⑤ remote_close_workspace", () => tool("remote_close_workspace").execute({ workspaceId: opened.workspaceId }, { agent }), diagnostics) as { closed: boolean; sessionIds: string[] };
            expect(closed.closed).toBe(true); // 读数⑤：工作区整体关闭
            expect(closed.sessionIds).toEqual([]);
            const afterClose = await tool("remote_list").execute({}, { agent }) as { workspaces: unknown[] };
            expect(afterClose.workspaces).toHaveLength(0); // 读数⑤：登记簿已空
            const idempotent = await tool("remote_close_workspace").execute({ workspaceId: opened.workspaceId }, { agent }) as { closed: boolean };
            expect(idempotent.closed).toBe(false); // 读数⑤：重复关闭幂等
        },
    );

    // AC⑥：并发两个挂具互不打架 —— 端口/容器名全随机，两个挂具同时在线、
    // 各回各的读数。镜像 tag 是共享缓存键（票面限的是端口/主机名，不含 tag）。
    // 资源收尾走 startTracked：启动成功即注册 teardown，超时/部分失败也不泄漏。
    // 真实主机模式下无挂具可言，跳过。
    it.skipIf(HOST !== undefined)(
        "并发两个 sshd 挂具互不打架（无固定端口/主机名）",
        { timeout: 300_000 },
        async () => {
            // 两个挂具并发起（镜像 `image exists` 命中即跳过 build；各占各的随机端口）。
            // 失败聚合成一条 loud 行；成功者已被 startTracked 注册 teardown，不泄漏。
            const attempts = await Promise.all([1, 2].map(async () => {
                try {
                    return await startTracked();
                } catch (error) {
                    return error instanceof Error ? error : new Error(String(error));
                }
            }));
            const [a, b] = attempts;
            if (a instanceof Error || b instanceof Error) {
                const reasons = attempts.filter((entry): entry is Error => entry instanceof Error).map((error) => error.message);
                warnHarnessUnavailable(`并发用例挂具启动失败：${reasons.join("; ")}`);
                return;
            }
            expect(a.port).not.toBe(b.port); // 无固定端口
            expect(a.container).not.toBe(b.container); // 无固定容器名
            // 两个挂具同时在线：各自探针各回各的容器身份（容器 hostname 互异）。
            const [hostA, hostB] = await Promise.all([a.exec("hostname"), b.exec("hostname")]);
            expect(hostA.stdout.trim()).toBeTruthy();
            expect(hostB.stdout.trim()).toBeTruthy();
            expect(hostA.stdout.trim()).not.toBe(hostB.stdout.trim());
            // 各自的通道互不串线：A 上写的文件在 B 上不存在。
            await a.exec(`mkdir -p -- '${SSHD_REMOTE_ROOT}' && printf live-a > '${SSHD_REMOTE_ROOT}/only-a.txt'`);
            const cross = await b.exec(`ls '${SSHD_REMOTE_ROOT}' 2>&1 || true`);
            expect(cross.stdout).not.toContain("only-a.txt");
        },
    );
});

/** 无环境依赖的门禁自检：`DSH_SSHD_TEST_RUNTIME` 错值响亮拒绝，不静默回落。 */
describe("挂具门禁自检（#141）", () => {
    it("DSH_SSHD_TEST_RUNTIME 非法值响亮拒绝（不静默回落默认顺序）", async () => {
        const previous = process.env.DSH_SSHD_TEST_RUNTIME;
        process.env.DSH_SSHD_TEST_RUNTIME = "containerd";
        try {
            await expect(detectContainerRuntime()).rejects.toThrow(/DSH_SSHD_TEST_RUNTIME/);
        } finally {
            if (previous === undefined) delete process.env.DSH_SSHD_TEST_RUNTIME;
            else process.env.DSH_SSHD_TEST_RUNTIME = previous;
        }
    });
});

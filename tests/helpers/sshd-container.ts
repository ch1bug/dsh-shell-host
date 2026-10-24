/**
 * #141 的 Docker sshd 挂具（`tests/fixtures/remote-sshd/Dockerfile`）——
 * 让"开工作区 → remote_ls → remote_read → 原子 remote_write → 关闭"这条
 * 真实 ssh 往返在本机可复跑，不必等一台真实 ssh 主机。
 *
 * 票面 AC 的落点：
 *  - 固定测试密钥：挂具**现场生成**专用 ed25519 对（`ssh-keygen`，写入临时目录，
 *    用完即删）。"固定"指它是一次性的**专用测试密钥、绝不触碰用户 `~/.ssh`**，
 *    而不是把私钥提交进 PUBLIC 仓——后者是反模式，本挂具刻意不这么做。
 *  - 非 22 端口 / 无固定主机名：宿主端口每次 `listen(0)` 随机取，容器名带
 *    pid + 随机后缀 ⇒ 并发两个挂具互不打架（AC⑥，由 spec 的并发用例实测）。
 *    镜像 tag 是共享的 `dsh-sshd-live:test`——票面限的是端口/主机名，tag 是
 *    缓存键：公钥走 `exec -i` stdin 注入而非 COPY 进镜像，镜像内容与钥匙无关，
 *    并发 build 同 tag 也是同一份 Dockerfile 的幂等产物。
 *  - 等就绪：用真实 `ssh` 客户端轮询探针（BatchMode + 专用密钥），deadline 内
 *    不就绪 ⇒ 带最后一次探针的 stderr 原文响亮失败（AC④：不吞远端 stderr）。
 *  - 用完即收且失败也收：`startSshdContainer` 的 catch 与 harness.close() 都走
 *    同一个 `cleanup`（rm 容器 → 删密钥目录；幂等），收尾失败只 warn 不抛。
 *    镜像**不**随用例删除：复审实测每用例 `rmi -f` 会把层缓存一并蒸发，下一轮
 *    并发 build 从零起、把 300s 用例预算烧穿——镜像留作缓存（tag 可辨识），
 *    要显式清理设 `DSH_SSHD_TEST_PRUNE_IMAGE=1` 或手动
 *    `<runtime> rmi dsh-sshd-live:test`。
 *
 * 运行时探测顺序：`DSH_SSHD_TEST_RUNTIME`（显式覆盖）→ `docker` → `podman`；
 * 判"可用" = `--version` 成功**且** `info` 成功（daemon 真的可达，排除装了 CLI
 * 但 machine 未启动的 podman）。**覆盖值错就响亮失败**（throw，不静默回落）——
 * 拼错的覆盖值会静默失去"强制指定运行时"的语义，与本仓 loud-failure 口径相悖。
 * 都不在位 ⇒ 返回 null，由 spec 落 `!! SKIP (loud)`。
 *
 * @module tests/helpers/sshd-container
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 挂具构建目录（含 Dockerfile；不含密钥——公钥走 exec stdin 注入）。 */
export const SSHD_FIXTURES_DIR = fileURLToPath(new URL("../fixtures/remote-sshd", import.meta.url));

/** 共享镜像 tag（缓存键；内容由本仓 Dockerfile 唯一决定）。 */
export const SSHD_IMAGE_TAG = "dsh-sshd-live:test";

/** 容器内的登录用户与远端根（镜像里由 Dockerfile 建好）。路径由用户名拼接、不写字面
 * `/home/…`——privacy-scan 的字面家目录规则是机械的，容器内路径也不该触发它（#141）。 */
export const SSHD_USER = "dsh";
export const SSHD_HOME = `/home/${SSHD_USER}`;
export const SSHD_REMOTE_ROOT = `${SSHD_HOME}/live`;

interface RunResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** spawn 一个 CLI，收齐 stdout/stderr；`input` 非空时写入 stdin 后收口。 */
function runCapture(command: string, args: readonly string[], timeoutMs = 60_000, input?: string): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${command} 超过 ${timeoutMs}ms 未结束`));
        }, timeoutMs);
        timer.unref();
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        if (input !== undefined) child.stdin?.end(input);
        child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
        });
    });
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

/** stderr 里第一条非空行（收尾诊断只留能读的那一句）。 */
function firstLine(text: string): string {
    return text.split(/\r?\n/u).find((line) => line.trim() !== "")?.trim() ?? "";
}

/**
 * 探测可用的容器运行时：`--version` 与 `info` 都要成功（`info` 排除"CLI 在位
 * 但 daemon/machine 没起来"的 podman——本机实测正是这个形态）。
 * `DSH_SSHD_TEST_RUNTIME` 显式覆盖候选；**值限 docker/podman，错值响亮 throw**
 * （不静默回落——静默会让"强制指定运行时"的语义在拼错时无声消失）。
 */
export async function detectContainerRuntime(): Promise<"docker" | "podman" | null> {
    const override = process.env.DSH_SSHD_TEST_RUNTIME;
    if (override !== undefined && override !== "docker" && override !== "podman") {
        throw new Error(`DSH_SSHD_TEST_RUNTIME=${JSON.stringify(override)} 不是可识别的容器运行时（只认 docker/podman）；覆盖值错了就响亮失败，不静默回落默认顺序`);
    }
    const candidates: Array<"docker" | "podman"> = override !== undefined ? [override] : ["docker", "podman"];
    for (const runtime of candidates) {
        try {
            const version = await runCapture(runtime, ["--version"], 15_000);
            if (version.exitCode !== 0) continue;
            const info = await runCapture(runtime, ["info", "--format", "{{.Host.Arch}}"], 60_000);
            if (info.exitCode === 0) return runtime;
        } catch { /* 下一个候选 */ }
    }
    return null;
}

/** 随机临时端口（listen(0) 拿到后立刻释放；端口竞态窗口与业界做法同量级）。 */
function randomFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => (port > 0 ? resolve(port) : reject(new Error("randomFreePort: 拿不到临时端口"))));
        });
    });
}

/** 挂具探针 / harness.exec 的 ssh 参数（程序名由 runCapture 的 command 提供）。 */
function sshArgv(harness: { port: number; keyPath: string; knownHosts: string; user: string }, remoteCommand: string): string[] {
    return [
        "-p", String(harness.port),
        "-i", harness.keyPath,
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", `UserKnownHostsFile=${harness.knownHosts.replaceAll("\\", "/")}`,
        "-o", "IdentitiesOnly=yes",
        "-o", "ConnectTimeout=5",
        "-o", "LogLevel=ERROR",
        `${harness.user}@127.0.0.1`,
        "--",
        remoteCommand,
    ];
}

/** 给产品通道（remote_open 的 options 参数）用的 -o 原子：与探针同一把钥匙。 */
export function sshdSshOptions(harness: { keyPath: string; knownHosts: string }): string[] {
    return [
        `IdentityFile=${harness.keyPath.replaceAll("\\", "/")}`,
        `UserKnownHostsFile=${harness.knownHosts.replaceAll("\\", "/")}`,
        "StrictHostKeyChecking=no",
        "IdentitiesOnly=yes",
        "BatchMode=yes",
        "LogLevel=ERROR",
    ];
}

/** 一台已就绪的 sshd 挂具。 */
export interface SshdHarness {
    readonly runtime: "docker" | "podman";
    /** 容器名（带 pid+随机后缀，并发互不打架）。 */
    readonly container: string;
    /** 共享镜像 tag（缓存键，不随挂具唯一化）。 */
    readonly image: string;
    /** 宿主侧随机端口（绝非常规 22）。 */
    readonly port: number;
    readonly keyPath: string;
    readonly knownHosts: string;
    readonly user: typeof SSHD_USER;
    readonly host: "127.0.0.1";
    /** 供 remote_open 的 `options` 参数：同一把测试密钥的 -o 原子。 */
    sshOptions(): string[];
    /** 在挂具远端跑一条命令（seed / 清理 / 探针复用）；非零退出带 stderr 原文抛出。 */
    exec(command: string, timeoutMs?: number): Promise<RunResult>;
    /** 用完即收：rm 容器 → 删密钥目录；幂等；收尾失败只 warn。镜像默认留作缓存。 */
    close(): Promise<void>;
}

/**
 * 失败也收的公共收尾：每步独立 best-effort，失败汇总成一行 warn（不抛）。
 * 镜像只在 `DSH_SSHD_TEST_PRUNE_IMAGE=1` 时删——默认留着当层缓存
 * （复审实测：逐用例 rmi 蒸发层缓存，下一轮并发 build 从零起烧穿用例预算）。
 */
async function cleanup(runtime: "docker" | "podman", container: string | undefined, keyDir: string): Promise<void> {
    const failures: string[] = [];
    if (container !== undefined) {
        const rm = await runCapture(runtime, ["rm", "-f", container], 60_000)
            .catch((error: unknown): RunResult => ({ exitCode: 1, stdout: "", stderr: String(error) }));
        if (rm.exitCode !== 0) failures.push(`rm 容器 ${container}: ${firstLine(rm.stderr)}`);
    }
    if (process.env.DSH_SSHD_TEST_PRUNE_IMAGE === "1") {
        const rmi = await runCapture(runtime, ["rmi", "-f", SSHD_IMAGE_TAG], 60_000)
            .catch((error: unknown): RunResult => ({ exitCode: 1, stdout: "", stderr: String(error) }));
        if (rmi.exitCode !== 0) failures.push(`rmi 镜像 ${SSHD_IMAGE_TAG}: ${firstLine(rmi.stderr)}`);
    }
    try { rmSync(keyDir, { recursive: true, force: true }); }
    catch (error) { failures.push(`删密钥目录 ${keyDir}: ${String(error)}`); }
    if (failures.length > 0) console.warn(`!! sshd 挂具收尾未全净（不阻断用例）：${failures.join("; ")}`);
}

/** 挂具容器的最近日志（失败诊断用，AC④ 的"不吞"素材之一）。 */
export async function containerLogs(harness: Pick<SshdHarness, "runtime" | "container">, tail = 40): Promise<string> {
    const result = await runCapture(harness.runtime, ["logs", "--tail", String(tail), harness.container], 30_000)
        .catch((error: unknown): RunResult => ({ exitCode: 1, stdout: "", stderr: String(error) }));
    const text = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
    return text === "" ? "(容器日志为空)" : text;
}

/**
 * 起一台就绪的 sshd 容器：现场生成专用测试密钥 → 确保共享镜像在位（
 * `image exists` 命中即跳过 build）→ 随机端口起唯一名容器 → `exec -i` 把
 * 授权公钥注进 dsh 的 authorized_keys → 轮询真实 ssh 探针到就绪。任何一步
 * 失败，已启动的资源全部收掉后再把带 stderr 原文的错误抛回（AC④）。
 */
export async function startSshdContainer(): Promise<SshdHarness> {
    const runtime = await detectContainerRuntime();
    if (runtime === null) {
        throw new Error("容器运行时不可用：docker/podman 都不在位（或 daemon/machine 未启动）");
    }
    const keyDir = mkdtempSync(join(tmpdir(), "dsh-sshd-live-"));
    const keyPath = join(keyDir, "live_test_key");
    const knownHosts = join(keyDir, "known_hosts");
    let container: string | undefined;
    try {
        // 固定测试密钥：现场生成的专用 ed25519 对，绝不触碰用户 ~/.ssh。
        const keygen = await runCapture("ssh-keygen",
            ["-t", "ed25519", "-N", "", "-q", "-C", "dsh-shell-host#141 live test", "-f", keyPath], 30_000);
        if (keygen.exitCode !== 0) throw new Error(`ssh-keygen 生成测试密钥失败：${firstLine(keygen.stderr)}`);
        if (process.platform === "win32") {
            // Windows OpenSSH 会校验私钥 ACL；temp 目录的默认 ACL 带继承项，
            // 收敛到仅当前用户可读，ssh 客户端才肯用这把钥匙。
            const acl = await runCapture("icacls",
                [keyPath, "/inheritance:r", "/grant:r", `${userInfo().username}:R`], 30_000);
            if (acl.exitCode !== 0) {
                console.warn(`!! sshd 挂具：icacls 收敛私钥 ACL 未成功（ssh 客户端可能拒绝该密钥）：${firstLine(acl.stderr)}`);
            }
        }
        // 共享镜像：`image exists` 命中即跳过 build（层缓存保住，并发用例不再
        // 从零 build——复审实测那是 300s 超时的直接机理）。build context 是
        // fixtures 目录本身，不含密钥；同一 Dockerfile 并发 build 是幂等产物。
        const exists = await runCapture(runtime, ["image", "exists", SSHD_IMAGE_TAG], 15_000);
        if (exists.exitCode !== 0) {
            const build = await runCapture(runtime, ["build", "-q", "-t", SSHD_IMAGE_TAG, SSHD_FIXTURES_DIR], 240_000);
            if (build.exitCode !== 0) {
                throw new Error(`构建 sshd 挂具镜像失败（${runtime} build ${SSHD_IMAGE_TAG}）：${firstLine(build.stderr)}`);
            }
        }
        const port = await randomFreePort();
        const name = `dsh-sshd-live-${process.pid}-${randomBytes(6).toString("hex")}`;
        const up = await runCapture(runtime, ["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:22`, SSHD_IMAGE_TAG], 120_000);
        if (up.exitCode !== 0) throw new Error(`启动 sshd 容器失败（${name}，端口 ${port}）：${firstLine(up.stderr)}`);
        container = name;
        // 授权公钥经 exec stdin 注入（不进镜像、不跨 VM 卷挂载）。
        const inject = await runCapture(runtime, ["exec", "-i", name, "sh", "-c",
            `mkdir -p ${SSHD_HOME}/.ssh && cat > ${SSHD_HOME}/.ssh/authorized_keys && chown -R ${SSHD_USER}:${SSHD_USER} ${SSHD_HOME}/.ssh && chmod 700 ${SSHD_HOME}/.ssh && chmod 600 ${SSHD_HOME}/.ssh/authorized_keys`,
        ], 30_000, `${readFileSync(`${keyPath}.pub`, "utf8")}`);
        if (inject.exitCode !== 0) throw new Error(`向容器注入授权公钥失败：${firstLine(inject.stderr)}`);
        const harness: { port: number; keyPath: string; knownHosts: string; user: typeof SSHD_USER } = { port, keyPath, knownHosts, user: SSHD_USER };
        // 等就绪：真实 ssh 客户端轮询，deadline 内不就绪 ⇒ 带最后一次探针的
        // stderr 原文失败（AC④：不吞）。
        const deadline = Date.now() + 90_000;
        let lastReading = "";
        for (;;) {
            const probe = await runCapture("ssh", sshArgv(harness, "echo dsh-sshd-ready"), 30_000);
            if (probe.exitCode === 0 && probe.stdout.trim() === "dsh-sshd-ready") break;
            lastReading = `${firstLine(probe.stderr) || firstLine(probe.stdout) || "(无输出)"} (exit ${probe.exitCode})`;
            if (Date.now() > deadline) {
                throw new Error(`sshd 挂具 ${name} 在 90s 内未就绪；最后一次探针读数：${lastReading}`);
            }
            await sleep(1_000);
        }
        let closed = false;
        return {
            runtime,
            container: name,
            image: SSHD_IMAGE_TAG,
            port,
            keyPath,
            knownHosts,
            user: SSHD_USER,
            host: "127.0.0.1",
            sshOptions: () => sshdSshOptions({ keyPath, knownHosts }),
            async exec(command: string, timeoutMs = 30_000): Promise<RunResult> {
                const result = await runCapture("ssh", sshArgv(harness, command), timeoutMs);
                if (result.exitCode !== 0) {
                    throw new Error(`sshd 挂具远端命令失败（exit ${result.exitCode}）：${firstLine(result.stderr) || firstLine(result.stdout) || "(无输出)"}\n命令：${command}`);
                }
                return result;
            },
            close: async () => {
                // 幂等：onTestFinished 与 afterAll 兜底可能都调到。
                if (closed) return;
                closed = true;
                await cleanup(runtime, name, keyDir);
            },
        };
    } catch (error) {
        // 失败也收：已启动的容器 / 密钥目录收掉（镜像留缓存），再抛原文。
        await cleanup(runtime, container, keyDir);
        throw error;
    }
}

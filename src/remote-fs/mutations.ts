/** #139：远程mutation临界区；只使用文件服务与工作区exec，不接触本地fs。
 * 上游语义来源：687f282e，packages/fs/fs-local/src/{index,fsio}.ts。
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { posixQuote } from "../posix-quote.ts";
import { FsError, type FsTarget, type FsWriteIntent, type FsWriteOutcome, type FsEditOutcome, type FsEditRequest, type FsSandboxPolicy, type RemoteFileSystem } from "./contract.ts";
import type { RemoteResult } from "../remote/channel.ts";
import { sandboxDenialMarker } from "@deepseek-ai/dsh-sandbox";
const normalize = (text: string) => text.replaceAll("\r\n", "\n");
/** 后端内部的opaque版本序列化，stat/lstat与最终guard共享；工具不可解析。 */
export const REMOTE_STAT_VERSION_FORMAT = "%d:%i:%s:%y:%z";
const chunkBytes = 48 * 1024; // base64嵌套帧仍有界，且不撞常见exec argv限制。
const diffLimit = 10 * 1024 * 1024;
function aborted(signal?: AbortSignal): void {
    if (signal?.aborted)
        throw new FsError("remote mutation aborted", "FS_ABORTED");
}
export function assertRemoteMutationPolicy(policy?: FsSandboxPolicy): void {
    // 本机文件沙箱不能约束远端路径；不能把workspaceRoot伪装成远端confinement。
    if (policy && policy.mode !== "danger-full-access")
        throw new FsError(`${sandboxDenialMarker(policy.mode)}\nremote filesystem cannot enforce a local sandbox policy; this mutation requires danger-full-access`, "FS_SANDBOX_DENIED");
}
function errorFor(result: RemoteResult, what: string): FsError {
    const detail = result.stderr.toString().trim() || `exit ${result.exitCode}`;
    const code = result.exitCode === 73 ? "FS_STALE_VERSION" : result.exitCode === 74 ? "FS_NOT_OBSERVED" : result.exitCode === 75 ? "FS_NOT_REGULAR_FILE" : result.exitCode === 126 || result.exitCode === 127 ? "FS_IO_ERROR" : /Permission denied/iu.test(detail) ? "FS_PERMISSION_DENIED" : /No such file or directory|Not a directory/u.test(detail) ? "FS_NOT_FOUND" : "FS_IO_ERROR";
    return new FsError(`${what}: ${detail}`, code);
}
/** 一份provider内的FIFO目标锁；不宣称跨外部进程的OS级CAS。 */
export function createRemoteMutations(fs: RemoteFileSystem, execFor: (target: FsTarget, command: string) => Promise<RemoteResult>, pathFor: (target: FsTarget) => string) {
    const locks = new Map<string, Promise<void>>();
    async function locked<T>(target: FsTarget, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
        const key = target.targetKey, previous = locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        locks.set(key, current);
        try {
            await previous;
            aborted(signal);
            return await operation();
        }
        finally {
            release();
            if (locks.get(key) === current)
                locks.delete(key);
        }
    }
    async function execute(target: FsTarget, command: string): Promise<RemoteResult> {
        try {
            const result = await execFor(target, "LC_ALL=C; export LC_ALL; " + command);
            if (result.exitCode !== 0)
                throw errorFor(result, `mutation ${target.displayPath}`);
            return result;
        }
        catch (cause) {
            if (cause instanceof FsError)
                throw cause;
            throw new FsError(`mutation ${target.displayPath}: remote request failed`, "FS_IO_ERROR", { cause });
        }
    }
    async function check(target: FsTarget, expected?: FsWriteIntent) {
        const info = await fs.stat(target);
        if (info && info.type !== "file")
            throw new FsError(`cannot modify ${target.displayPath}: not a regular file`, "FS_NOT_REGULAR_FILE");
        if (expected?.kind === "replaceIfVersion" && info?.version !== expected.version)
            throw new FsError(`cannot modify ${target.displayPath}: file changed since it was read`, "FS_STALE_VERSION");
        if (expected?.kind === "createIfAbsent" && info)
            throw new FsError(`cannot overwrite ${target.displayPath} without reading it first`, "FS_NOT_OBSERVED");
        return info;
    }
    /** 同目录private staging。失败清理不得掩盖原错误；成功发布后清理失败不伪报写失败。 */
    async function publish(target: FsTarget, content: string, expected: FsWriteIntent | undefined, signal?: AbortSignal) {
        const path = pathFor(target), dir = posix.dirname(path);
        const stage = posix.join(dir, `.dsh-write-${randomUUID()}`), temp = stage + "/content";
        let created = false, published = false;
        try {
            aborted(signal);
            await execute(target, `mkdir -p -- ${posixQuote(dir)} && (umask 077; mkdir -- ${posixQuote(stage)} && : > ${posixQuote(temp)})`);
            created = true;
            const bytes = Buffer.from(content, "utf8");
            for (let at = 0; at < bytes.length; at += chunkBytes) {
                aborted(signal);
                const encoded = bytes.subarray(at, at + chunkBytes).toString("base64");
                await execute(target, `printf '%s' ${posixQuote(encoded)} | base64 -d >> ${posixQuote(temp)}`);
            }
            aborted(signal);
            // 在发布脚本中再次判版本和权限。missing仅由stat诊断认定，不能test -e吞EACCES。
            const guard = expected?.kind === "replaceIfVersion"
                ? `if [ "$present" != 1 ] || [ "$version" != ${posixQuote(expected.version)} ]; then printf '%s' 'file changed since it was read' >&2; exit 73; fi`
                : expected?.kind === "createIfAbsent"
                    ? `if [ "$present" = 1 ]; then printf '%s' 'file already exists' >&2; exit 74; fi` : ":";
            const script = [
                `p=${posixQuote(path)}`, `t=${posixQuote(temp)}`,
                `version=$(stat -L -c ${posixQuote(REMOTE_STAT_VERSION_FORMAT)} -- "$p" 2>&1); code=$?; present=1`,
                `if [ "$code" -ne 0 ]; then case "$code:$version" in 126:*|127:*) printf '%s' "$version" >&2; exit "$code";; *"No such file or directory"*) present=0;; *) printf '%s' "$version" >&2; exit "$code";; esac; fi`,
                `if [ "$present" = 1 ] && [ ! -f "$p" ]; then printf '%s' 'not a regular file' >&2; exit 75; fi`, guard,
                `if [ "$present" = 1 ]; then chmod --reference="$p" -- "$t" || exit $?; fi`,
                expected?.kind === "createIfAbsent"
                    ? `if ! ln -T -- "$t" "$p"; then if [ -e "$p" ] || [ -L "$p" ]; then exit 74; else exit 1; fi; fi`
                    : `mv -fT -- "$t" "$p" || exit $?`,
            ].join("; ");
            await execute(target, script);
            published = true;
        }
        catch (cause) {
            if (!created) {
                // mkdir可能已成功但后续创建内容失败；已知随机路径仍需清理。
                created = true;
            }
            throw cause;
        }
        finally {
            if (created) {
                try {
                    await execute(target, `rm -f -- ${posixQuote(temp)} && rmdir -- ${posixQuote(stage)}`);
                }
                catch (cleanup) {
                    // 通道已死时清理不可能完成；显式读数，不能吞掉并声称临时文件已清理。
                    console.warn(`remote mutation cleanup ${published ? "after publication" : "after failure"}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
                }
            }
        }
        // createIfAbsent删除staging硬链接会更新目标ctime，必须在清理后取最终版本。
        const final = await fs.stat(target);
        if (!final)
            throw new FsError(`mutation ${target.displayPath}: target missing after publication`, "FS_STALE_VERSION");
        if (final.type !== "file")
            throw new FsError(`mutation ${target.displayPath}: not a regular file after publication`, "FS_NOT_REGULAR_FILE");
        return final.version;
    }
    return {
        async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: FsSandboxPolicy): Promise<FsWriteOutcome> {
            assertRemoteMutationPolicy(policy);
            return locked(target, signal, async () => {
                const existing = await check(target, expected);
                let before: string | null = null;
                if (existing && (existing.size ?? Infinity) < diffLimit && Buffer.byteLength(content) < diffLimit) {
                    try {
                        const bytes = await fs.readBytes(target, signal, diffLimit - 1);
                        if (!bytes.includes(0)) {
                            try {
                                before = normalize(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
                            }
                            catch (error) {
                                if (!(error instanceof TypeError))
                                    throw error;
                            }
                        }
                    }
                    catch (error) {
                        if (!(error instanceof FsError) || error.code === "FS_ABORTED")
                            throw error;
                        // 仅presentation的可选basis；发布脚本仍检查权威guard与写权限。
                    }
                }
                const version = await publish(target, content, expected, signal);
                return { operation: existing ? "update" : "create", version, before, after: normalize(content) };
            });
        },
        async editText(target: FsTarget, edit: FsEditRequest, expected?: {
            version: FsWriteOutcome["version"];
        }, signal?: AbortSignal, policy?: FsSandboxPolicy): Promise<FsEditOutcome> {
            assertRemoteMutationPolicy(policy);
            return locked(target, signal, async () => {
                const intent: FsWriteIntent | undefined = expected ? { kind: "replaceIfVersion", version: expected.version } : undefined;
                const existing = await check(target, intent);
                if (!existing)
                    throw new FsError(`cannot edit ${target.displayPath}: file no longer exists`, "FS_STALE_VERSION");
                const raw = await fs.readText(target, signal), before = normalize(raw);
                if (raw.includes("\0"))
                    throw new FsError(`cannot edit ${target.displayPath}: binary file`, "FS_NOT_TEXT");
                const old = normalize(edit.oldString), replacement = normalize(edit.newString);
                if (!old)
                    throw new FsError("oldString must not be empty", "FS_EDIT_NOT_FOUND");
                const at = before.indexOf(old);
                if (at === -1)
                    throw new FsError(`cannot edit ${target.displayPath}: old string not found`, "FS_EDIT_NOT_FOUND");
                if (!edit.replaceAll && before.indexOf(old, at + old.length) !== -1)
                    throw new FsError(`cannot edit ${target.displayPath}: old string matches multiple locations`, "FS_AMBIGUOUS_EDIT");
                const after = edit.replaceAll ? before.split(old).join(replacement) : before.slice(0, at) + replacement + before.slice(at + old.length);
                const sample = raw.slice(0, 4096), crlf = sample.split("\r\n").length - 1;
                const lf = sample.split("\n").length - 1 - crlf;
                const content = crlf > lf ? normalize(after).replaceAll("\n", "\r\n") : after;
                const version = await publish(target, content, { kind: "replaceIfVersion", version: existing.version }, signal);
                return { version, before, after };
            });
        },
    };
}

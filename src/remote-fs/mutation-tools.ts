/** #139：远程write/edit薄适配。上游deepseek-ai/deepseek-harness 687f282e，
 * packages/fs/tool-fs/src/{write,edit,error,mutation-result,diff}.ts；不混用本地fs身份。 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolExecution, FileDiff, DiffCallView, DiffResultView, ToolResult } from "@deepseek-ai/dsh-tools";
import { structuredPatch } from "diff";
import { FsError, type RemoteFileSystem } from "./contract.ts";
import type { RemoteObservations } from "./observation.ts";
/** 上游diff helper：一张卡一个hunk，左右3行context；不输出patch的无末尾换行标记。 */
function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
    const patch = structuredPatch("", "", before, after, undefined, undefined, { context: 3 });
    return patch.hunks.map(hunk => {
        const oldLines: string[] = [], newLines: string[] = [];
        for (const line of hunk.lines) {
            if (line.startsWith("\\"))
                continue;
            const text = line.slice(1);
            if (!line.startsWith("+"))
                oldLines.push(text);
            if (!line.startsWith("-"))
                newLines.push(text);
        }
        return { path, oldText: oldLines.length > 0 ? oldLines.join("\n") : null, newText: newLines.join("\n") };
    });
}
function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta))
        return undefined;
    const diffs = (meta as Record<string, unknown>).diffs;
    if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every((value): value is FileDiff => {
        if (typeof value !== "object" || value === null || Array.isArray(value))
            return false;
        const { path, oldText, newText } = value as Record<string, unknown>;
        return typeof path === "string" && (oldText === null || typeof oldText === "string") && typeof newText === "string";
    }))
        return undefined;
    return diffs;
}
function pathFromMeta(meta: unknown): string | undefined {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta))
        return undefined;
    const path = (meta as Record<string, unknown>).path;
    return typeof path === "string" && path.length > 0 ? path : undefined;
}
function remediate(error: unknown, path: string): unknown {
    if (!(error instanceof FsError))
        return error;
    if (error.code === "FS_NOT_OBSERVED")
        return new FsError(`cannot modify "${path}": file has not been read — read the file, then retry`, error.code, { cause: error });
    if (error.code === "FS_STALE_VERSION")
        return new FsError(`${error.message} — re-read the file, then retry`, error.code, { cause: error });
    return error;
}
/** 父入口注入同一份远程观察源与session cwd，不做额外stat/read。 */
export function registerRemoteMutations(ctx: {
    tools: {
        register: (tool: ToolDefinition) => unknown;
    };
}, fs: RemoteFileSystem, cwd: (exec: ToolExecution) => Promise<string | undefined>, observations: RemoteObservations, authorize: (exec: ToolExecution) => void | Promise<void>): void {
    ctx.tools.register(defineTool({
        name: "remote_write",
        description: "Create or fully replace a UTF-8 text file in the REMOTE workspace.",
        parameters: {
            file_path: { type: "string", required: true, description: "Path to write, resolved by the filesystem backend. Provide `file_path` before `content` in the arguments." },
            content: { type: "string", required: true, description: "Full UTF-8 text content to write." },
        },
        output: {
            schema: { type: "object", additionalProperties: false, properties: {
                    path: { type: "string", required: true }, operation: { type: "string", required: true, enum: ["create", "update"] },
                    before: { required: true, oneOf: [{ type: "string" }, { type: "null" }] }, after: { type: "string", required: true },
                } },
            render: (_args, value) => [{ type: "text", text: `<path>${value.path}</path>\n<type>file</type>\n<content>\n${value.operation === "create" ? "Created" : "Updated"} file\n</content>` }],
            presentationMeta: (_args, value) => ({
                operation: value.operation, path: value.path,
                diffs: value.before === null ? [] : computeHunkDiffs(value.path, value.before, value.after).map(({ path, oldText, newText }) => ({ path, oldText, newText })),
            }),
        },
        async execute(args, exec) {
            if (args.file_path.trim().length === 0)
                throw new Error("file_path must be a non-empty string");
            await authorize(exec);
            const target = await fs.resolve(args.file_path, { cwd: await cwd(exec), signal: exec.signal });
            let outcome;
            try {
                outcome = await fs.writeText(target, args.content, observations.writeIntent(target, exec), exec.signal);
            }
            catch (error) {
                throw remediate(error, target.displayPath);
            }
            const { version, ...result } = outcome;
            observations.record(target, { kind: "present", version }, exec);
            return { path: fs.processPath(target), ...result };
        },
        presentCall(args): DiffCallView {
            return { card: "diff", title: `Write ${args.file_path}`, diffs: [{ path: args.file_path, oldText: null, newText: args.content }], locations: [{ path: args.file_path }] };
        },
        presentResult(args, result: ToolResult): DiffResultView | undefined {
            if (result.isError)
                return undefined;
            const diffs = diffsFromMeta(result.meta) ?? [{ path: pathFromMeta(result.meta) ?? args.file_path, oldText: null, newText: args.content }];
            return { card: "diff", title: `Write ${args.file_path}`, diffs };
        },
    }));
    ctx.tools.register(defineTool({
        name: "remote_edit",
        description: "Edit an existing UTF-8 text file in the REMOTE workspace by replacing literal text.",
        parameters: {
            file_path: { type: "string", required: true, description: "Path to edit, resolved by the filesystem backend. Provide `file_path` before `old_string` and `new_string` in the arguments." },
            old_string: { type: "string", required: true, description: "Literal text to replace." },
            new_string: { type: "string", required: true, description: "Literal replacement text. Use an empty string to delete the match." },
            replace_all: { type: "boolean", description: "Replace all matches. Defaults to false; when false, old_string must appear exactly once." },
        },
        output: {
            schema: { type: "object", additionalProperties: false, properties: {
                    path: { type: "string", required: true }, before: { type: "string", required: true }, after: { type: "string", required: true },
                } },
            render: (args, value) => [{ type: "text", text: args.replace_all
                        ? `The file ${value.path} has been updated. All occurrences were successfully replaced.`
                        : `The file ${value.path} has been updated successfully.` }],
            presentationMeta: (_args, value) => ({
                path: value.path,
                diffs: computeHunkDiffs(value.path, value.before, value.after).map(({ path, oldText, newText }) => ({ path, oldText, newText })),
            }),
        },
        async execute(args, exec) {
            if (args.file_path.trim().length === 0)
                throw new Error("file_path must be a non-empty string");
            if (args.old_string.length === 0)
                throw new Error("old_string must be a non-empty string");
            if (args.old_string === args.new_string)
                throw new Error("old_string and new_string must differ");
            await authorize(exec);
            const target = await fs.resolve(args.file_path, { cwd: await cwd(exec), signal: exec.signal });
            let outcome;
            try {
                outcome = await fs.editText(target, { oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false }, observations.editIntent(target, exec), exec.signal);
            }
            catch (error) {
                throw remediate(error, target.displayPath);
            }
            const { version, ...result } = outcome;
            observations.record(target, { kind: "present", version }, exec);
            return { path: fs.processPath(target), ...result };
        },
        presentCall(args): DiffCallView {
            return { card: "diff", title: `Edit ${args.file_path}`, diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }], locations: [{ path: args.file_path }] };
        },
        presentResult(args, result: ToolResult): DiffResultView | undefined {
            if (result.isError)
                return undefined;
            const diffs = diffsFromMeta(result.meta);
            return diffs === undefined ? undefined : { card: "diff", title: `Edit ${args.file_path}`, diffs };
        },
    }));
}

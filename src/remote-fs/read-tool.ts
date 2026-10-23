/** #138：上游read/read-render的远程工具移植，不混用本地观察身份。
 * 来源：deepseek-ai/deepseek-harness，687f282e，
 * packages/fs/tool-fs/src/{read,read-render}.ts（0.2.1-rc.2）。
 * 保留参数、窗口、footer及卡片形状；固定上游默认caps，不复制语言后缀表。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { GenericCallView, ReadResultView, ToolDefinition, ToolExecution, ToolResult } from "@deepseek-ai/dsh-tools";
import { FsError, type RemoteFileSystem } from "./contract.ts";
import type { RemoteObservations } from "./observation.ts";
/** 上游read默认的单行字符上限；远程工具沿用此固定值。 */
export const READ_MAX_LINE_LENGTH = 2000;
/** 上游read默认的选中文本字节上限；不含行号与外层envelope。 */
export const READ_MAX_BYTES = 50 * 1024;
/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface ReadWindow {
    /** 1-based first line to return. */
    offset: number;
    /** Maximum number of lines to return. */
    limit: number;
    /** Maximum characters returned for a single line; overflow is truncated with a suffix. */
    maxLineLength: number;
    /** Maximum bytes of selected output; overflow stops the scan and marks `truncatedByBytes`. */
    maxBytes: number;
}
/** One line returned from a text file. */
export interface FileTextLine {
    /** 1-based line number in the file. */
    number: number;
    /** Line text without its trailing newline. */
    text: string;
}
/** The windowed result {@link buildWindow} produces from a file's decoded text. */
export interface WindowResult {
    /** Returned lines, already numbered. */
    lines: FileTextLine[];
    /** Exact total line count in the file. */
    totalLines: number;
    /** Whether selected output hit the byte cap. */
    truncatedByBytes: boolean;
}
/** Outcome of a bounded text read — what {@link formatReadOutput} renders. */
export interface FileReadOutcome {
    /** 1-based first line requested. */
    offset: number;
    /** Returned lines, already numbered. */
    lines: FileTextLine[];
    /** Exact total line count in the file. */
    totalLines: number;
    /** Whether selected output hit the byte cap. */
    truncatedByBytes?: true;
}
interface WindowAccumulator {
    lines: FileTextLine[];
    totalLines: number;
    outputBytes: number;
    truncatedByBytes: boolean;
}
function newAccumulator(): WindowAccumulator {
    return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false };
}
function truncateLine(line: string, maxLineLength: number): string {
    return line.length > maxLineLength ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line;
}
function lineByteSize(line: string, currentLineCount: number): number {
    return Buffer.byteLength(line, "utf8") + (currentLineCount > 0 ? 1 : 0);
}
function consumeLine(acc: WindowAccumulator, rawLine: string, request: ReadWindow): void {
    acc.totalLines += 1;
    if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit)
        return;
    const text = truncateLine(rawLine, request.maxLineLength);
    const bytes = lineByteSize(text, acc.lines.length);
    if (acc.outputBytes + bytes > request.maxBytes) {
        acc.truncatedByBytes = true;
        return;
    }
    acc.outputBytes += bytes;
    acc.lines.push({ number: acc.totalLines, text });
}
function stripCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}
function finish(acc: WindowAccumulator, request: ReadWindow, displayPath: string): WindowResult {
    if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
        throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, "FS_NOT_FOUND");
    }
    return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes };
}
/**
 * Build one window from streamed or whole-file chunks, enforcing line and byte caps while still
 * scanning to an exact total line count, and throwing `FS_NOT_FOUND` when the requested offset is
 * past EOF.
 * @param chunks - decoded text chunks in file order; chunk boundaries carry no meaning.
 * @param request - the resolved window; the caller has already applied its defaults and caps.
 * @param displayPath - the caller-facing path used in the offset-out-of-range error.
 * @returns the numbered window lines, the total line count seen, and the byte-cap truncation flag.
 */
export async function buildWindow(chunks: AsyncIterable<string> | Iterable<string>, request: ReadWindow, displayPath: string): Promise<WindowResult> {
    const acc = newAccumulator();
    // One char past the truncation point is enough to prove a line overflows.
    const lineBufferCap = request.maxLineLength + 1;
    let lineBuffer = "";
    function appendToLineBuffer(segment: string): void {
        if (lineBuffer.length >= lineBufferCap)
            return;
        lineBuffer += segment;
        if (lineBuffer.length > lineBufferCap)
            lineBuffer = lineBuffer.slice(0, lineBufferCap);
    }
    function flushLine(): void {
        consumeLine(acc, stripCarriageReturn(lineBuffer), request);
        lineBuffer = "";
    }
    for await (const chunk of chunks) {
        let startPos = 0;
        let newlinePos: number;
        while ((newlinePos = chunk.indexOf("\n", startPos)) !== -1) {
            appendToLineBuffer(chunk.slice(startPos, newlinePos));
            flushLine();
            startPos = newlinePos + 1;
        }
        appendToLineBuffer(chunk.slice(startPos));
    }
    if (lineBuffer.length > 0)
        flushLine();
    return finish(acc, request, displayPath);
}
/**
 * Format a read outcome as one OpenCode-style line-numbered text block body.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param outcome - the windowed read to render.
 * @returns the model-facing envelope: numbered lines plus a continuation or end-of-file footer.
 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
    const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1);
    let footer: string;
    if (outcome.truncatedByBytes) {
        footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`;
    }
    else if (endLine < outcome.totalLines) {
        footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`;
    }
    else {
        footer = `(End of file - total ${outcome.totalLines} lines)`;
    }
    const body = outcome.lines.length > 0
        ? `${outcome.lines.map(line => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`
        : footer;
    return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`;
}
/**
 * The `read` tool's private `tool/result` `meta` payload: the structured
 * line-numbered window a capable UI renders as a code view. Attached opaquely (as
 * `unknown`) on the tool result and persisted with the session log — it must be
 * JSON-serializable (the session validates this at `append`), so `presentResult`
 * reproduces the read card on replay when the raw structured output is no longer
 * on the wire. The producing tool owns and narrows this opaque shape.
 */
export interface FsReadMeta {
    /** The read file's model-facing path. */
    path: string;
    /** The 1-based first line the window requested, kept even when `lines` is empty. */
    offset: number;
    /** The returned window's lines, each keeping its file line number. */
    lines: FileTextLine[];
    /** Exact total line count in the file. */
    totalLines: number;
    /** Syntax-highlighting language hint from the extension, or omitted for plain text. */
    lang?: string;
}
/**
 * Whether `value` is a valid {@link FileTextLine} (defensive narrowing from
 * opaque `meta`). `number` must be a 1-based integer line number, since a card
 * rendered from a zero, fractional, or non-finite line number would violate the
 * 1-based numbering contract the read window promises.
 */
function isFileTextLine(value: unknown): value is FileTextLine {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const { number, text } = value as Record<string, unknown>;
    return typeof number === "number" && Number.isInteger(number) && number >= 1 && typeof text === "string";
}
/**
 * Narrow opaque live or replayed result metadata to a structured read window.
 * Malformed metadata returns `undefined` so presentation can fall back to the
 * generic text card instead of throwing during replay. Beyond shape, the
 * semantic contract of a read window is enforced against replayed JSON that is
 * well-typed but out of range: `offset` must be a 1-based integer, `totalLines`
 * must be a non-negative integer, each line number must be a 1-based integer no
 * less than `offset`, the line numbers must strictly increase, and no line number
 * may exceed `totalLines`. Any violation declines to the generic fallback rather
 * than emitting a card that misnumbers or overcounts.
 * @param meta - result metadata.
 * @returns the validated read window, or `undefined` for absent, malformed, or semantically invalid data.
 */
export function readMetaFromMeta(meta: unknown): FsReadMeta | undefined {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta))
        return undefined;
    const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>;
    if (typeof path !== "string" || typeof totalLines !== "number" || typeof offset !== "number")
        return undefined;
    if (!Number.isInteger(offset) || offset < 1)
        return undefined;
    if (!Number.isInteger(totalLines) || totalLines < 0)
        return undefined;
    if (!Array.isArray(lines) || !lines.every(isFileTextLine))
        return undefined;
    if (lang !== undefined && typeof lang !== "string")
        return undefined;
    let previous = offset - 1;
    for (const { number } of lines) {
        if (number <= previous || number > totalLines)
            return undefined;
        previous = number;
    }
    return { path, offset, lines, totalLines, ...lang === undefined ? {} : { lang } };
}
/** Default and maximum number of lines returned by one `read` call (the `readLimit` config). */
export const READ_LIMIT = 2000;
/**
 * Default streaming threshold (the `readStreamMinSize` config): files at or
 * above this size stream; smaller files read whole into memory.
 */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024;
/** 远程读取工具固定采用上游默认上限，不从入口Config读取。 */
export interface ReadToolCaps {
    /** Default and maximum number of lines returned by one call. */
    limit: number;
    /** Maximum characters returned for a single line. */
    maxLineLength: number;
    /** Maximum bytes returned for selected file lines. */
    maxBytes: number;
    /** Files at or above this size stream; smaller files read whole into memory. */
    streamMinSize: number;
}
/** Validated `read` arguments after defaulting. */
interface ReadInput {
    filePath: string;
    offset: number;
    limit: number;
}
function parsePositiveInteger(value: number, name: string): number {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
/**
 * Validate value constraints the schema DSL can't express. `maxLimit` is the deployment's line cap.
 * @param args - the schema-validated raw tool arguments; `offset`/`limit` must be positive integers when given.
 * @param maxLimit - the configured line cap: both the default `limit` and the largest one accepted.
 * @returns the validated input with `offset` defaulted to 1 and `limit` to `maxLimit`.
 */
export function parseReadArgs(args: {
    file_path: string;
    offset?: number;
    limit?: number;
}, maxLimit: number): ReadInput {
    if (args.file_path.trim().length === 0)
        throw new Error("file_path must be a non-empty string");
    const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, "offset");
    const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, "limit");
    if (limit > maxLimit)
        throw new Error(`limit must be less than or equal to ${maxLimit}`);
    return { filePath: args.file_path, offset, limit };
}
/** #138：纯工具注册；父入口负责会话 cwd，所有读取只经远程 fs。 */
export function registerRemoteRead(ctx: {
    tools: {
        register: (tool: ToolDefinition) => unknown;
    };
}, fs: RemoteFileSystem, cwd: (exec: ToolExecution) => Promise<string | undefined>, observations?: RemoteObservations): void {
    const caps: ReadToolCaps = { limit: READ_LIMIT, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES, streamMinSize: STREAM_MIN_SIZE };
    ctx.tools.register(defineTool({
        name: "remote_read",
        description: "Read a UTF-8 text file in the REMOTE workspace and return line-numbered content. Uses only the remote filesystem; local anchors are not copies of remote files.",
        parameters: {
            file_path: { type: "string", required: true, description: "Path to read, resolved by the filesystem backend." },
            offset: { type: "number", description: "1-based first line to return. Defaults to 1." },
            limit: { type: "number", description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    path: { type: "string", required: true, description: "Canonical absolute path in the filesystem execution world." },
                    offset: { type: "integer", required: true },
                    lines: {
                        type: "array",
                        required: true,
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                number: { type: "integer", required: true },
                                text: { type: "string", required: true },
                            },
                        },
                    },
                    totalLines: { type: "integer", required: true },
                },
            },
            render: (args, value) => {
                const input = parseReadArgs(args, caps.limit);
                const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1);
                const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines;
                return [{
                        type: "text",
                        text: formatReadOutput(value.path, {
                            offset: value.offset,
                            lines: value.lines,
                            totalLines: value.totalLines,
                            ...truncatedByBytes ? { truncatedByBytes: true } : {},
                        }),
                    }];
            },
            // Project the structured window into persisted `meta` so a UI's read card
            // survives replay: the raw canonical output object is not on the wire, only
            // the model-facing text, from which the line/lang data cannot be recovered.
            presentationMeta: (_args, value) => {
                return {
                    path: value.path,
                    offset: value.offset,
                    lines: value.lines.map(({ number, text }) => ({ number, text })),
                    totalLines: value.totalLines,
                };
            },
        },
        // 只读工具；不修改父上下文。
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const input = parseReadArgs(args, caps.limit);
            // 一次 stat 同时判定类型与路由；不向本地观察策略发送远程身份。
            const target = await fs.resolve(input.filePath, { cwd: await cwd(exec), signal: exec.signal });
            const info = await fs.stat(target, exec.signal);
            if (info === undefined) {
                observations?.record(target, { kind: "absent" }, exec);
                throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
            }
            if (info.type !== "file")
                throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
            // Stream when the file is large OR size is unknown, so a size-less backend
            // never buffers an arbitrarily large file.
            const chunks = info.size === undefined || info.size >= caps.streamMinSize
                ? await fs.streamText(target, exec.signal)
                : [await fs.readText(target, exec.signal)];
            const window = await buildWindow(chunks, { offset: input.offset, limit: input.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes }, target.displayPath);
            const outcome = {
                path: fs.processPath(target),
                offset: input.offset,
                lines: window.lines,
                totalLines: window.totalLines,
            };
            // 只有完整流与窗口均成功才观察；保留读取前stat的版本，不伪造读后新鲜度。
            observations?.record(target, { kind: "present", version: info.version }, exec);
            return outcome;
        },
        // Result-time display: a `read` card carrying the structured line window a
        // capable UI renders as a line-numbered, syntax-highlighted view. The
        // structured data is narrowed from the persisted `meta` (replay-safe); the
        // envelope-stripped model-facing text rides along as `content` so a UI without
        // the read capability still shows the file text. A malformed or absent meta,
        // or a result whose text is not the read envelope, declines to `undefined`
        // (the generic fallback), never throwing on replay of obsolete logged output.
        presentResult(_args, result: ToolResult): ReadResultView | undefined {
            if (result.isError)
                return undefined;
            const meta = readMetaFromMeta(result.meta);
            if (meta === undefined)
                return undefined;
            const only = result.content.length === 1 ? result.content[0] : undefined;
            const text = only?.type === "text" ? only.text : undefined;
            if (text === undefined)
                return undefined;
            // Group 1 always captures (possibly empty) when the envelope matches.
            const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1];
            if (body === undefined)
                return undefined;
            return {
                card: "read",
                path: meta.path,
                offset: meta.offset,
                lines: meta.lines,
                totalLines: meta.totalLines,
                ...meta.lang === undefined ? {} : { lang: meta.lang },
                content: [{ type: "text", text: body }],
            };
        },
        // Pure display: a generic card titled by the file with the read window appended (`Read
        // foo.txt (5 - 8)`), `read` kind (icon), and a follow-along location whose line is the
        // read's offset (defaulting to 1). The window reflects raw args, so an omitted limit keeps
        // the title bare instead of smuggling config into this pure presenter.
        presentCall(args): GenericCallView {
            const { offset, limit } = args;
            const window = limit !== undefined && limit > 0
                ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
                : offset !== undefined ? ` (from line ${offset})` : "";
            return {
                card: "generic",
                title: `Read ${args.file_path}${window}`,
                kind: "read",
                locations: [{ path: args.file_path, line: offset ?? 1 }],
            };
        },
    }));
}

/**
 * 远端帧循环的**真 sh** 取证（#137，machine 车道）：把 `REMOTE_FRAME_LOOP`
 * 原样交给一个真 bash 跑，验证客户端编解码器与远端循环确实是**同一份** codec。
 *
 * 为什么必须在真实层：unit 档的假通道用 JS 复刻了远端循环的**语义**，
 * 因此它能证明通道的终态，却证明不了"发出去的那段 sh 真的能跑" ——
 * 拼错一个 `printf` 或漏一层引号，unit 全绿而真通道全废。
 *
 * 判据覆盖票面点名的形态：正例（退出码 + 两股字节）、半包（请求行分两次写）、
 * 粘包（一次写两帧）、错误帧（非 base64 请求体 ⇒ `E`）、以及命令里带换行/引号的往返。
 *
 * 缺席时**响亮跳过**（`!! SKIP (loud)` + 原因）：本机无 bash 就不是"验过了"。
 *
 * @module tests/remote-frame-machine.spec
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FrameDecoder, REMOTE_FRAME_LOOP, encodeRequest, type DecodedFrame } from "../src/remote/frame.ts";
import { detectPlainBash } from "../src/detect.ts";

/** The bash this lane drives: `detectPlainBash` on win32 (WSL System32 stub excluded), bare `bash` on POSIX. */
const BASH = process.platform === "win32" ? detectPlainBash() : "bash";

if (BASH === undefined) {
  console.warn("  !! SKIP (loud) remote-frame-machine: 本机找不到可用的 bash —— 真 sh 帧循环未验证（unit 档的假通道不能代替）");
}

/** Drive the real loop: write the raw bytes, close stdin, decode everything it answered. */
function runLoop(chunks: string[], timeoutMs = 20_000): Promise<{ frames: DecodedFrame[]; exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH as string, ["-c", REMOTE_FRAME_LOOP], { stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new FrameDecoder();
    const frames: DecodedFrame[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`remote frame loop did not settle in ${String(timeoutMs)}ms (frames so far: ${JSON.stringify(frames)})`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { frames.push(...decoder.feed(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const autoHandshake = !chunks[0]?.startsWith('R 0 ');
    const failed = (error: Error) => { clearTimeout(timer); child.kill(); reject(error); };
    child.once('error', failed);
    child.stdin.on('error', failed);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (autoHandshake) {
        const hello = frames.shift();
        if (hello?.kind !== 'response' || hello.id !== 0 || hello.exitCode !== 0 || hello.stdout.toString() !== '1 real-loop-client') {
          reject(new Error(`real loop handshake failed: ${JSON.stringify(hello)}`)); return;
        }
      }
      resolve({ frames, exitCode: code, stderr });
    });
    if (autoHandshake) child.stdin.write(encodeRequest(0, 'DSH-HELLO 1 real-loop-client'));
    for (const chunk of chunks) child.stdin.write(chunk);
    child.stdin.end();
  });
}

describe.skipIf(BASH === undefined)("远端帧循环（真 sh）：与客户端编解码器是同一份 codec", () => {
  it('真循环拒绝不兼容协议版本，不执行握手体为shell命令', async () => {
    const { frames } = await runLoop([encodeRequest(0, 'DSH-HELLO 999 stale-client')]);
    expect(frames[0]?.kind).toBe('error');
    if (frames[0]?.kind === 'error') expect(frames[0].message).toMatch(/version/u);
  });

  it('子命令不能吞掉后续协议帧（stdin 与协议输入隔离）', async () => {
    const { frames } = await runLoop([encodeRequest(1, 'cat'), encodeRequest(2, 'printf kept')]);
    expect(frames.map((frame) => frame.kind === 'response' ? [frame.id, frame.stdout.toString()] : null)).toEqual([[1, ''], [2, 'kept']]);
  });

  it("正例：一条命令 ⇒ 一帧响应，退出码/两股字节都是命令自己的", async () => {
    const { frames } = await runLoop([encodeRequest(1, "printf 'out'; printf 'err' >&2; exit 3")]);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame?.kind).toBe("response");
    if (frame?.kind !== "response") throw new Error("expected a response frame");
    expect(frame.id).toBe(1);
    expect(frame.exitCode).toBe(3);
    expect(frame.stdout.toString()).toBe("out");
    expect(frame.stderr.toString()).toBe("err");
  });

  it("粘包：两帧一次写 ⇒ 两条各自正确的响应（互不串味）", async () => {
    const { frames } = await runLoop([encodeRequest(1, "printf a") + encodeRequest(2, "printf b")]);
    expect(frames.map((frame) => (frame.kind === "response" ? [frame.id, frame.stdout.toString()] : null))).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
  });

  it("半包：请求行分两次写 ⇒ 仍然只按一整行执行一次（sh read 的行语义）", async () => {
    const wire = encodeRequest(7, "printf half");
    const cut = Math.floor(wire.length / 2);
    const { frames } = await runLoop([wire.slice(0, cut), wire.slice(cut)]);
    expect(frames).toHaveLength(1);
    if (frames[0]?.kind !== "response") throw new Error("expected a response frame");
    expect(frames[0].id).toBe(7);
    expect(frames[0].stdout.toString()).toBe("half");
  });

  it("错误帧：请求体不是 base64 ⇒ `E` 帧（不是静默丢弃这条请求）", async () => {
    const { frames } = await runLoop(["R 5 !!!not-base64!!!\n"]);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe("error");
    if (frames[0]?.kind === "error") expect(frames[0].message).toMatch(/not base64/u);
  });

  it("命令里带换行 / 引号 / 变量 ⇒ 经 base64 往返后原样执行", async () => {
    const command = "X=42\nprintf '%s\\n' \"$X\"\nprintf \"it's fine\\n\"";
    const { frames } = await runLoop([encodeRequest(9, command)]);
    if (frames[0]?.kind !== "response") throw new Error("expected a response frame");
    expect(frames[0].exitCode).toBe(0);
    expect(frames[0].stdout.toString()).toBe("42\nit's fine\n");
  });

  it("每条请求一个独立 sh（cwd 不跨请求泄漏；ADR-0017 决策 1 的语义地基）", async () => {
    // 第一条 cd 到别处，第二条必须仍从当前目录起（每条命令自己的 sh 进程）。
    const { frames } = await runLoop([encodeRequest(1, "cd / && pwd"), encodeRequest(2, "pwd")]);
    const pwds = frames.map((frame) => (frame.kind === "response" ? frame.stdout.toString().trim() : ""));
    expect(pwds[0]).toBe("/");
    expect(pwds[1]).not.toBe("/");
  });

  it("stderr 与 stdout 不混流（命令失败时两股字节各自回来）", async () => {
    const { frames } = await runLoop([encodeRequest(1, "printf only-out; printf only-err >&2; exit 9")]);
    if (frames[0]?.kind !== "response") throw new Error("expected a response frame");
    expect(frames[0].stdout.toString()).toBe("only-out");
    expect(frames[0].stderr.toString()).toBe("only-err");
    expect(frames[0].exitCode).toBe(9);
  });
});
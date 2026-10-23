/**
 * 帧编解码（#137）：正例 / 半包 / 粘包 / 错误帧 / 不可解析行 / 超长行。
 *
 * 判据形态说明：这四条是 ADR-0016 决策 2 明确要求"必须测"的传输故障，且**只有解码器这一层**
 * 能真判 —— 通道层（`channel.ts`）只负责把解码结果翻成终态（失败/超时/重连）。故本档
 * 只喂字节、只读帧，不启动任何进程。
 *
 * 反向判据（避免"解码器什么都不判也全绿"）：每条正例都配一条"同形状但被改坏"的断言 ——
 * 比如粘包用例同时证明"把两帧拆开喂也得到同样两帧"，半包用例同时证明"只喂半帧时**没有**
 * 帧被吐出"（若实现把半行当整行解析，就会立刻吐出一个 malformed）。
 *
 * @module tests/remote-frame.spec
 */

import { describe, expect, it } from "vitest";
import {
  FRAME_MAX_LINE_BYTES,
  FrameDecoder,
  REMOTE_FRAME_LOOP,
  encodeError,
  encodeRequest,
  encodeResponse,
  type DecodedFrame,
} from "../src/remote/frame.ts";

describe("帧编解码：线路形态", () => {
  it("请求是 `R <id> <base64>`，命令里的换行不破帧（一帧仍是一行）", () => {
    const encoded = encodeRequest(7, "printf 'a\\nb'\ntrue\n");
    expect(encoded.startsWith("R 7 ")).toBe(true);
    expect(encoded.endsWith("\n")).toBe(true);
    // 关键：正文里的换行被 base64 吸收 —— 线路上一行就是一帧。
    expect(encoded.slice(0, -1)).not.toContain("\n");
    const payload = encoded.slice("R 7 ".length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("printf 'a\\nb'\ntrue\n");
  });

  it("响应的 stdout / stderr 都是 base64：NUL 与控制字节原样回来（二进制安全）", () => {
    const decoder = new FrameDecoder();
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x0a, 0x0d, 0x7f]);
    const frames = decoder.feed(encodeResponse(1, 3, bytes, "boom"));
    expect(frames).toEqual([
      { kind: "response", id: 1, exitCode: 3, stdout: bytes, stderr: Buffer.from("boom", "utf8") },
    ]);
  });

  it("空 stdout / 空 stderr 是合法帧（空命令不产出字节）", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed(encodeResponse(9, 0))).toEqual([
      { kind: "response", id: 9, exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    ]);
  });
});

describe("帧编解码：半包 / 粘包", () => {
  it("半包：一帧分两半喂 ⇒ 第一次 0 帧、第二次 1 帧（不得把半行当整行）", () => {
    const decoder = new FrameDecoder();
    const wire = encodeResponse(1, 0, "hello");
    const cut = Math.floor(wire.length / 2);
    expect(decoder.feed(wire.slice(0, cut)), "半帧就吐帧 = 把半行当整行解析").toEqual([]);
    expect(decoder.retained).toBe(wire.slice(0, cut));
    expect(decoder.feed(wire.slice(cut))).toEqual([
      { kind: "response", id: 1, exitCode: 0, stdout: Buffer.from("hello"), stderr: Buffer.alloc(0) },
    ]);
    expect(decoder.retained).toBe("");
  });

  it("半包（逐字节）：一帧按字节喂完才吐出，且只吐一次", () => {
    const decoder = new FrameDecoder();
    const wire = encodeResponse(42, 0, "x");
    const emitted: DecodedFrame[] = []
    for (const byte of Buffer.from(wire, "utf8")) {
      emitted.push(...decoder.feed(Buffer.from([byte])))
    }
    expect(emitted).toEqual([
      { kind: "response", id: 42, exitCode: 0, stdout: Buffer.from("x"), stderr: Buffer.alloc(0) },
    ]);
  });

  it("粘包：一次喂两帧 ⇒ 同一次调用返回两帧、按线路顺序", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed(encodeResponse(1, 0, "a") + encodeResponse(2, 1, "b"))
    expect(frames.map((frame) => (frame.kind === "response" ? frame.id : -1))).toEqual([1, 2]);
    // 反向判据：拆开喂得到同一组帧（否则"两帧"可能来自别的路径）。
    const split = new FrameDecoder();
    expect(split.feed(encodeResponse(1, 0, "a"))).toHaveLength(1);
    expect(split.feed(encodeResponse(2, 1, "b"))).toHaveLength(1);
  });

  it("粘包 + 半包混合：两整帧 + 半帧 ⇒ 本轮回两帧、残留半帧", () => {
    const decoder = new FrameDecoder();
    const full = encodeResponse(1, 0, "a") + encodeResponse(2, 0, "b")
    const half = encodeResponse(3, 0, "c")
    const frames = decoder.feed(full + half.slice(0, 5))
    expect(frames).toHaveLength(2);
    expect(decoder.retained).toBe(half.slice(0, 5));
    expect(decoder.feed(half.slice(5))).toHaveLength(1);
  });
});

describe("帧编解码：错误帧 / 不可解析 / 超长", () => {
  it("错误帧 `E <id> <base64 reason>` ⇒ kind=error，reason 原样", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed(encodeError(5, "request payload is not base64"))).toEqual([
      { kind: "error", id: 5, message: "request payload is not base64" },
    ]);
  });

  it("真不是帧的行 ⇒ malformed（带原因），**不静默跳过**", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed("hello world\n")
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe("malformed");
    if (frames[0]?.kind === "malformed") {
      expect(frames[0].line).toBe("hello world");
      expect(frames[0].reason).toMatch(/frame id|frame marker|unknown frame marker/u);
    }
  });

  it("远端反向发请求（`R`）被判 malformed：两端对方向的认知不一致", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed(encodeRequest(1, "true"))
    expect(frames[0]?.kind).toBe("malformed");
    if (frames[0]?.kind === "malformed") expect(frames[0].reason).toMatch(/direction|请求/u);
  });

  it("操作数个数不对 / 非整数 id / 非 base64 ⇒ 各自一条 malformed（错因不混成一句）", () => {
    const decoder = new FrameDecoder();
    const reasons = decoder
      .feed(["K 1 0", "K x 0 ", "K 1 0 !!! !!", "Q 1 x"].join("\n") + "\n")
      .map((frame) => (frame.kind === "malformed" ? frame.reason : "NOT-MALFORMED"));
    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toMatch(/expected 4/u);
    expect(reasons[1]).toMatch(/id is not a non-negative integer/u);
    expect(reasons[2]).toMatch(/stdout is not base64/u);
    expect(reasons[3]).toMatch(/unknown frame marker/u);
  });

  it('完整但超大的一行同样拒绝，不能绕过帧上限', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed('K 1 0 ' + 'A'.repeat(FRAME_MAX_LINE_BYTES + 4) + ' \n');
    expect(frames[0]?.kind).toBe('malformed');
  });

  it('拒绝不可逆的base64和非十进制id，而不是解出截断数据', () => {
    for (const line of ['K 1 0 A ', 'K 1 0 AB== ', 'K 1e2 0  ', 'K 9007199254740992 0  ']) {
      expect(new FrameDecoder().feed(line + '\n')[0]?.kind).toBe('malformed');
    }
  });

  it("超长行（无终止符）⇒ malformed + 之后仍报同一条（流已不可信）", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed("K 1 0 " + "A".repeat(FRAME_MAX_LINE_BYTES + 10))
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe("malformed");
    if (frames[0]?.kind === "malformed") expect(frames[0].reason).toMatch(/ceiling/u);
    // 溢出之后不再尝试"续上"：继续喂也报同一件事（调用方据此失败整个通道）。
    expect(decoder.feed("K 1 0 \n")[0]?.kind).toBe("malformed");
  });

  it("CRLF 尾巴与空行被容忍（PTY 侧回显/换行翻译的形态）", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed("\r\n" + encodeResponse(1, 0, "a").replace("\n", "\r\n"))
    expect(frames).toEqual([
      { kind: "response", id: 1, exitCode: 0, stdout: Buffer.from("a"), stderr: Buffer.alloc(0) },
    ]);
  });
});

describe("远端循环脚本：与客户端同一份 codec", () => {
  it("脚本用两种帧前缀拼响应 / 错误帧，并把命令包进 `sh -c`", () => {
    // 线路形态的单一来源：脚本里的前缀必须是导出常量，而不是另写的字面量。
    expect(REMOTE_FRAME_LOOP).toContain("printf 'K %s %s %s %s\\n'");
    expect(REMOTE_FRAME_LOOP).toContain("printf 'E %s %s\\n'");
    // 每条请求一个独立 sh（ADR-0017 决策 1：cwd 不在共享 shell 里记账）。
    expect(REMOTE_FRAME_LOOP).toContain('sh -c "$dsh_cmd"');
    // stdout / stderr 分开取字节，退出码紧跟命令之后取（读的是命令自己的码）。
    expect(REMOTE_FRAME_LOOP).toContain('>"$dsh_out" 2>"$dsh_err"');
    expect(REMOTE_FRAME_LOOP).toContain("dsh_code=$?");
    // base64 -d 失败要变成 E 帧，而不是静默丢弃这条请求。
    expect(REMOTE_FRAME_LOOP).toContain("request payload is not base64");
  });
});
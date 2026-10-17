/**
 * 离线用例：machine 车道探针 needle 的**命中判据**（`#99`）。
 *
 * 判据本体、`#99` 的成因与口径写在 `tests/helpers/probe-needle.ts`（单一来源）；本档只钉
 * 两件可离线断言的事：
 *
 * 1. pwsh 探针 needle 在**回声帧**上不命中、在**展开帧**到达后命中 —— 真 send 后的分帧到达
 *    是时序相关的（现场因此只偶发撞上一次），本档是它的**确定性形态**；
 * 2. 判据按 needle 类型分派，且不受 `/g` 的 `lastIndex` 状态影响（轮询会反复调用它，
 *    状态化命中会在帧与帧之间忽真忽假）。
 *
 * **层级**：本档是离线层（合成帧），不证明真实 ConPTY 的回声形态 —— 那只由 machine 车道的
 * 活体用例覆盖（`tests/terminal-machine.spec.ts`）。
 *
 * @module tests/probe-needle.spec.ts
 */

import { describe, expect, it } from "vitest";
import { matchesNeedle, PWSH_PROBE_COMMAND, PWSH_PROBE_NEEDLE } from "./helpers/probe-needle.ts";

/** 回声帧的**合成**形态：`pty_send` 那行字面命令被原样回显（前面是渲染出的提示符）。
 * 真实 ConPTY 帧前面还带 ANSI 提示符 / 括号粘贴标记（见 `#99` 现场读数的 `…> "PSV-…"`），
 * 本档只取与判据相关的那部分。 */
function echoFrame(command: string): string {
  return `> ${command}\n`;
}

describe("探针 needle 的命中判据（#99）", () => {
  it("离线复现形态：回声帧单独存在时 pwsh needle 不命中", () => {
    const echo = echoFrame(PWSH_PROBE_COMMAND);
    // 反证（修前形态）：裸前缀 needle 恰恰**会**被回声满足 —— 于是 waitFor 在回声帧就返回，
    // 紧随的结果断言在展开输出到达前判红。这就是 #99 的偶发红机制。
    expect(matchesNeedle(echo, "PSV-")).toBe(true);
    expect(echo).not.toMatch(/PSV-\d+\.\d+/);
    // 本票的判据：回声**不能单独**满足真 needle。
    expect(matchesNeedle(echo, PWSH_PROBE_NEEDLE)).toBe(false);
  });

  it("展开帧到达后才命中 —— needle 不是永假，结果断言仍然有力", () => {
    // 展开帧 = 那行命令的**求值结果**（`PSV-` + 版本值），不是裸版本号。
    const text = echoFrame(PWSH_PROBE_COMMAND) + "PSV-1.2.3\r\n";
    expect(matchesNeedle(text, PWSH_PROBE_NEEDLE)).toBe(true);
    expect(text).toMatch(/PSV-\d+\.\d+/);
  });

  it("判据分派：字符串 = 子串，正则 = 命中；跨帧累计文本照常命中", () => {
    const frame1 = "PROBE-42\r\n";
    const frame2 = "kernel: Linux x86_64\r\n";
    expect(matchesNeedle(frame1, "PROBE-42")).toBe(true);
    expect(matchesNeedle(frame1, "PROBE-43")).toBe(false);
    // 组合形状依赖"累计文本"：跨两帧的正则照样命中（轮询逐帧喂的就是累计文本）。
    expect(matchesNeedle(frame1 + frame2, /PROBE-42[\s\S]*Linux/u)).toBe(true);
    expect(matchesNeedle(frame1, /PROBE-42[\s\S]*Linux/u)).toBe(false);
  });

  it("判据不受 /g 的 lastIndex 状态影响（轮询会重复调用它）", () => {
    const text = "PROBE-42\r\n";
    // 反证：`RegExp.prototype.test` 在 /g 下第二次调用会因 lastIndex 前进而假阴性。
    const stateful = /PROBE-42/g;
    expect(stateful.test(text)).toBe(true);
    expect(stateful.test(text)).toBe(false);
    // 判据本身每次都判同一个问题 —— 同一枚带 /g 的 needle 重复调用结果相同。
    const needle = /PROBE-42/g;
    expect(matchesNeedle(text, needle)).toBe(true);
    expect(matchesNeedle(text, needle)).toBe(true);
  });
});
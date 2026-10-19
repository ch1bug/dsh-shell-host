/**
 * 离线用例：machine 车道**展开值探针**的命中判据（判据由 `#99` 落地，`#103` 改成表驱动）。
 *
 * 判据本体、成因与边界写在 `tests/helpers/probe-needle.ts`（单一来源）；本档只钉两件可离线
 * 断言的事：
 *
 * 1. 表里**每一条**展开值探针，回声帧单独存在时**不**命中它的 needle、展开帧到达后**命中**
 *    —— 真 `pty_send` 后的分帧到达是时序相关的（现场因此只偶发撞上一次），本档是它的
 *    **确定性形态**；新增一条探针只需在表里加一行，本档不用改；
 * 2. 判据按 needle 类型分派，且不受 `/g` 的 `lastIndex` 状态影响（轮询会反复调用它，
 *    状态化命中会在帧与帧之间忽真忽假）。
 *
 * **层级**：本档是离线层（合成帧），不证明真实 ConPTY 的回声形态 —— 那只由 machine 车道的
 * 活体用例覆盖（`tests/terminal-machine.spec.ts`）。
 *
 * @module tests/probe-needle.spec.ts
 */

import { describe, expect, it } from "vitest";
import { EXPANDED_PROBES, matchesNeedle } from "./helpers/probe-needle.ts";

/** 回声帧的**合成**形态：`pty_send` 那行字面命令被原样回显（前面是渲染出的提示符）。
 * 真实 ConPTY 帧前面还带 ANSI 提示符 / 括号粘贴标记（见 `#99` 现场读数的 `…> "PSV-…"`），
 * 本档只取与判据相关的那部分。 */
function echoFrame(command: string): string {
  return `> ${command}\n`;
}

describe.each(EXPANDED_PROBES)("展开值探针 $id", (probe) => {
  it("回声帧里确有该探针的痕迹（手填样本），而真 needle 不被回声单独满足", () => {
    const echo = echoFrame(probe.command);
    // 反证**样本**：`echoSatisfiable` 是手填的「修前 / 变异形态」，只证明「回声帧里确有这条探针
    // 的痕迹」—— 它不从 needle 推导，所以不会因为 needle 改坏而自动变红（那条由 `#103` AC2 的
    // 变异实测与复核守）。没有它，「回声不命中」就可能只是因为回声帧里压根没有该探针的痕迹。
    expect(matchesNeedle(echo, probe.echoSatisfiable)).toBe(true);
    // 本票的判据：回声**不能单独**满足真 needle。
    expect(matchesNeedle(echo, probe.needle)).toBe(false);
  });

  it("展开 / 输出帧到达后才命中 —— needle 不是永假", () => {
    const text = echoFrame(probe.command) + probe.expandedFrame;
    expect(matchesNeedle(text, probe.needle)).toBe(true);
  });

  it("行尾形态不影响命中（LF / CRLF 两套帧都命中；A1 的对照见下一条）", () => {
    // 本仓结构上同时存在 LF 权威树与 CRLF 部署副本 ⇒ 判据不能按树出两套结论。
    const crlf = echoFrame(probe.command) + probe.expandedFrame;
    const lf = crlf.replaceAll("\r\n", "\n");
    expect(matchesNeedle(crlf, probe.needle)).toBe(true);
    expect(matchesNeedle(lf, probe.needle)).toBe(true);
  });
});

describe("展开值探针表（#103）", () => {
  it("既有四条探针仍在表里（删掉一条会红；**新增一条不用改本档**）", () => {
    const ids = EXPANDED_PROBES.map((p) => p.id);
    // 故意**不**写成 `toEqual([四个 id])`：那会让「表里加一行」把本档打红，与模块头注
    // 「新增一条 = 表里加一行」的承诺自相矛盾 —— 正是本票要消的「同一形状两处各写一遍」。
    for (const id of ["msys2-ucrt", "pwsh", "cmd", "wsl"]) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marker / 往返探针**不在**表内（它们的 needle 本来就该被回声满足）", () => {
    // 边界来自 #103：MARK-* 与 SSHOPEN-42 证的是「本会话看得到自己的标记 / 往返通了」，
    // 断言的是隔离与到达，不是「展开发生了」 ⇒ 不进表、语义不动。
    const commands = EXPANDED_PROBES.map((p) => p.command).join("\n");
    expect(commands).not.toContain("MARK-");
    expect(commands).not.toContain("SSHOPEN");
  });
});

describe("命中判据 matchesNeedle（#99）", () => {
  it("A1 对照：以 `$` 收尾的**逐行**判据在 CRLF 帧里假红、LF 帧里为真", () => {
    // 上一条 invariance 用例的意义就在这条对照：判据若不锚行尾，行尾形态就翻不动它；
    // 反过来，`split("\n")` 之后的 CRLF 行带尾随 `\r`，而 JS 的 `$`（无 m）收不下它 ⇒
    // 同一份内容按树出两套结论（批 D 聚合 A1 的翻车形态，`#126` 实测）。
    const firstLine = (text: string) => text.split("\n")[0];
    expect(/PSV-\d+\.\d+$/.test(firstLine("PSV-1.2\n"))).toBe(true); // LF：真
    expect(/PSV-\d+\.\d+$/.test(firstLine("PSV-1.2\r\n"))).toBe(false); // CRLF：假红
    expect(/PSV-\d+\.\d+\r?$/.test(firstLine("PSV-1.2\r\n"))).toBe(true); // 收下 `\r` 才成立
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
/**
 * 探针 needle 的命中判据 + pwsh 探针常量（`#99`）。
 *
 * 为什么单独成模块：真实层（machine 车道）的探针靠"轮询 pty_tail 直到 needle 出现"判到达，
 * 而 needle 命中的必须是**被测终端吐出的输出**，绝不能是测试自己敲进去那行命令的**回声**
 * （判据原文见 `#99`：「回声不能单独满足 needle」，不是"把断言放松"）。
 *
 * pwsh 用例原先栽在这里：`pty_send` 的字面命令
 * `"PSV-$($PSVersionTable.PSVersion.ToString())"` 被原样回显，回显里就含裸前缀 `PSV-`，
 * 于是 `waitFor(..., "PSV-")` 在回声帧就返回，紧随的结果断言 `/PSV-\d+\.\d+/` 在 PowerShell
 * 的展开输出到达之前判红（帧序相关 → 偶发）。同文件的 msys2 用例早已用组合 needle 避开同形
 * 陷阱（`tests/terminal-machine.spec.ts`）。
 *
 * 判据抽成纯函数后，「回声不能单独满足 needle」就有**离线用例**守着：
 * `tests/probe-needle.spec.ts` 用本模块的 pwsh 常量造回声帧 / 展开帧断言判据取值 ——
 * 真 send 后的分帧到达在集成层是时序相关的，离线层才是可复现的那一半。
 *
 * @module tests/helpers/probe-needle
 */

/** 探针 needle：裸字符串（子串语义）或正则（命中语义，见 `matchesNeedle`）。 */
export type ProbeNeedle = string | RegExp;

/**
 * 命中判据 —— machine 车道 `waitFor` 轮询的**唯一**判据，故意保持极小：
 * 字符串 = 子串包含，正则 = 命中（用 `search` 而非 `test`：见下）。
 *
 * 判据本身不认识"回声"，是 needle 的**选法**在躲回声。
 *
 * 用 `String.prototype.search` 而不是 `RegExp.prototype.test`：两者对同一个问题给同一个
 * 答案，但 `test` 在 `/g` 旗标下是**有状态**的（`lastIndex` 在多次调用间前进），而轮询
 * 会拿同一枚 needle 反复判累计文本 —— 一旦谁加了 `/g`，命中就会在帧之间忽真忽假。
 * `search` 忽略 `lastIndex`（也不修改它），于是判据与调用次数无关。
 */
export function matchesNeedle(text: string, needle: ProbeNeedle): boolean {
  return typeof needle === "string" ? text.includes(needle) : text.search(needle) >= 0;
}

/** pwsh 探针敲进去的那行命令（`pty_send` 的 data，逐字）。离线用例据此造回声帧。 */
export const PWSH_PROBE_COMMAND = '"PSV-$($PSVersionTable.PSVersion.ToString())"';

/**
 * pwsh 探针的 needle：只认 PowerShell **展开后**的版本值。
 *
 * 字面命令里 `PSV-` 后面跟的是 `$(`，永远匹配不上 `\d` —— 所以回声帧单独存在时本 needle
 * 恒不命中，只有展开输出到达才可能命中（`#99` 的判据）。machine 的 pwsh 用例消费本常量，
 * 离线用例用同一条常量钉"回声不命中"，两边不会漂移。
 */
export const PWSH_PROBE_NEEDLE: RegExp = /PSV-\d+\.\d+/;
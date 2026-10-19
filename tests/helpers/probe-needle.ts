/**
 * 探针 needle 的命中判据 + **展开值探针表**（判据由 `#99` 落地，`#103` 收全表）。
 *
 * 为什么单独成模块：真实层（machine 车道）的探针靠"轮询 pty_tail 直到 needle 出现"判到达，
 * 而 needle 命中的必须是**被测终端吐出的输出**，绝不能是测试自己敲进去那行命令的**回声**
 * （判据原文见 `#99`：「回声不能单独满足 needle」，不是"把断言放松"）。
 *
 * pwsh 用例原先栽在这里：`pty_send` 的字面命令
 * `"PSV-$($PSVersionTable.PSVersion.ToString())"` 被原样回显，回显里就含裸前缀 `PSV-`，
 * 于是 `waitFor(..., "PSV-")` 在回声帧就返回，紧随的结果断言在 PowerShell 的展开输出到达
 * 之前判红（帧序相关 → 偶发）。同文件的 msys2 用例早已用组合 needle 避开同形陷阱。
 *
 * `#99` 只把 pwsh 一条收进来并把判据抽成纯函数 —— 三条展开值探针（msys2 / cmd / wsl）仍是
 * **用例里的内联对**，于是判据只被单例覆盖，同族教训（逐例各写一套 → 漏学）还在。`#103` 把
 * **展开值探针全集**的 command + needle **成对**收进本表：machine 用例只引用常量，离线用例
 * 表驱动地逐条断言。
 *
 * **边界（不算展开值探针的，别收进来）**：marker / 往返探针的 needle **本来就该**被回声满足
 * ——coexistence 的 `MARK-MSYS` / `MARK-PWSH` / `MARK-CMD` / `MARK-WSL` 与 ssh 的 `SSHOPEN-42`
 * 证的是「本会话看得到自己的标记 / 往返通了」，断言的是隔离与到达、不是「展开发生了」
 * ⇒ 不进表、语义不动。本表**不是**「所有 `waitFor` 的 needle 都收进来」。
 *
 * **命名（照实说明，别让名字骗人）**：本表沿用票面的「展开值探针」口径。其中 cmd 的 `ver`
 * 严格说是**命令输出**、不是变量展开 —— 它与展开值探针同属「needle 不该被回声单独满足」的
 * 那一类（回声帧里是裸命令名 `ver`），且票面把三者列在同一集合里，故沿用该词并在 `CMD_PROBE`
 * 上写明差别。
 *
 * **离线档**（`tests/probe-needle.spec.ts`）对表里**每一条**断言同一对性质：回声帧**不**命中
 * needle（且**命中它的回声可满足形态** —— 否则前一条只是同义反复）、展开帧到达后命中。
 * 真 `pty_send` 后的分帧到达在集成层是时序相关的，离线层才是确定性形态；活体用例
 * （`tests/terminal-machine.spec.ts`）只消费本模块的常量，不在用例里各写一套。
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

/**
 * 一条**展开值探针**：敲进去的那行命令、判到达的 needle，以及离线复现它的三段样本。
 *
 * command 与 needle **同住一条记录**：两处各写一遍正是 `#99`–`#103` 要消掉的形态
 * （msys2 学了、pwsh 漏了，就是因为它们不在一起）。
 */
export interface ExpandedProbe {
  /** preset id —— 与 machine 用例 `shell_open` 的目标同名，便于逐行对照。 */
  readonly id: string;
  /** `pty_send` 的 data（逐字）。离线用例据此造**回声帧**。 */
  readonly command: string;
  /** 判到达的 needle：只在展开 / 输出到达后才可能命中。 */
  readonly needle: ProbeNeedle;
  /**
   * 该 needle 的**回声可满足形态样本**（修前 / 变异形态，如裸前缀）。
   *
   * 离线用例断言它**确实**命中回声帧 —— 但它是**手填样本**，用途只是证明「回声帧里确有这条
   * 探针的痕迹」：没有它，「回声不命中」可能只是因为回声帧里压根没有该探针的任何痕迹（那样的
   * 绿是同义反复）。它**不从 needle 推导**，改坏 needle 不会让它自动变红 —— 那条由变异实测
   * 与复核守（`#103` AC2）。
   */
  readonly echoSatisfiable: ProbeNeedle;
  /**
   * 展开 / 输出到达后追加的**累计文本样本**（Windows 侧输出是 CRLF；离线用例另用它造 LF
   * 形态，钉住 needle 与行尾无关）。
   */
  readonly expandedFrame: string;
}

/**
 * msys2-ucrt：**展开值 + 那条命令自身输出行**的组合 needle。
 * 字面命令里 `$MSYSTEM` 未展开 ⇒ 回声里没有 `PROBE-UCRT64`；`uname -a` 的输出行是另一半。
 * （组合形状依赖"累计文本"：轮询逐帧喂的就是累计文本。）
 */
export const MSYS2_PROBE: ExpandedProbe = {
  id: "msys2-ucrt",
  command: "echo PROBE-$MSYSTEM && uname -a",
  needle: /PROBE-UCRT64[\s\S]*\b(MSYS|MINGW|UCRT)/i,
  echoSatisfiable: "PROBE-",
  expandedFrame:
    "PROBE-UCRT64\r\nMINGW64_NT-10.0-26100 host 3.5.4.x86_64 2024-01-01 00:00 UTC x86_64 Msys\r\n",
};

/** pwsh：**展开值正则** —— 字面命令里 `PSV-` 后面跟的是 `$(`，永远匹配不上 `\d`。 */
export const PWSH_PROBE: ExpandedProbe = {
  id: "pwsh",
  command: '"PSV-$($PSVersionTable.PSVersion.ToString())"',
  needle: /PSV-\d+\.\d+/,
  echoSatisfiable: "PSV-",
  expandedFrame: "PSV-7.4.6\r\n",
};

/**
 * cmd：`ver` 的**命令输出**横幅（不是变量展开 —— 票面把它与展开值探针列在同一集合，差别见模块
 * 头注「命名」）。回声帧里出现的是**命令名本身**，所以它的回声可满足形态样本是裸命令名 `ver`；
 * 票面举的「把 needle 的方括号去掉」并不制造回声命中（`Version` 只出现在输出行），此处按回声帧
 * 的实际形态取值。
 *
 * needle 比旧形（`/\[Version|版本/`）**更强**：要求 `Microsoft` 前缀。这是为了让用例里那条
 * 更强的横幅断言（`/Microsoft \[Version|Microsoft Windows|Microsoft \[版本/`）**并进 needle**
 * —— 判别力不降，而用例里不再重写一遍字面正则（`#103` AC3）。
 */
export const CMD_PROBE: ExpandedProbe = {
  id: "cmd",
  command: "ver",
  needle: /Microsoft (?:\[Version|Windows|\[版本)/,
  echoSatisfiable: "ver",
  expandedFrame: "Microsoft Windows [Version 10.0.26100.1]\r\n",
};

/** wsl：**展开值子串** —— 字面命令里是 `WSLPROBE-$(uname -sr)`，只有展开后才出现 `-Linux`。 */
export const WSL_PROBE: ExpandedProbe = {
  id: "wsl",
  command: "echo WSLPROBE-$(uname -sr)",
  needle: "WSLPROBE-Linux",
  echoSatisfiable: "WSLPROBE-",
  expandedFrame: "WSLPROBE-Linux 6.6.87.2-microsoft-standard-WSL2\r\n",
};

/**
 * 展开值探针**表** —— 离线档逐行断言同一对性质，machine 用例逐条消费。
 *
 * **新增一条展开值探针 = 加一段常量 + 在这里加一行**；离线档不需要改（断言是表驱动的）。
 */
export const EXPANDED_PROBES: readonly ExpandedProbe[] = [
  MSYS2_PROBE,
  PWSH_PROBE,
  CMD_PROBE,
  WSL_PROBE,
];
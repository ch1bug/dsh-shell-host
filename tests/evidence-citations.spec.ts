/**
 * 证据引用守卫（`#132`；决定记录 `docs/adr/0015-evidence-citation-guard-surface.md`）。
 *
 * ## 它守什么
 *
 * `#130` 的表里第 1 次那类缺陷 —— **结论为真、证据为假**：落地文档里写着
 * 「证据文件 X、`exit=0`」，而点开 X 根本看不出那个读数（或 X 压根不存在）。
 * 本守卫把这一半机械化：**扫落地文档里的「证据路径 × 退出码声称」配对，再打开那个载体核对**。
 *
 * ## 数据源与判定面（ADR-0015 Decision 1 / 2 / 3 / 4）
 *
 * - **数据源 = `.scratch/`**（`#132` grill 拍的第四条路，票面三选一之外）：
 *   守卫把 `.scratch/` 当**数据源读**，不搬任何产物进仓、不改 `.gitignore`。
 *   代价是显式的：干净 clone / msys 部署副本 / pre-push 车道上它恒 `!! SKIP (loud)`
 *   （汇总里表现为 `PASS*`）—— **绿不等于验过**，牙齿只落在"有 `.scratch/` 的那棵树"。
 * - **判定面 = 只判「不存在」与「矛盾」**（Q2=A）：
 *   ① 被引证据文件不存在 ⇒ 红；
 *   ② 载体里**有**退出码读数且与声称**相反** ⇒ 红；
 *   ③ 载体里**没有**任何退出码读数 ⇒ **响亮声明不判**（`!! SKIP (loud)`）：
 *      「不含」≠「相反」，照 `#130` 字面判据会在今日面上假红（ADR-0015 Decision 2 的读数）。
 * - **多声称行整行出判定面**（Q3=D）：一行出现 ≥2 个**不同**退出码时不做就近配对
 *   （误配对的代价是假红），同样**响亮声明**（`!! SKIP (loud)`）。
 * - **多读数载体响亮不判**（#153，ADR-0015 修订 2026-10-26）：一个载体去重后出现
 *   ≥2 个**不同**读数时，该载体对**任何**声称都判不了「相反 ⇒ 红」——
 *   旧判据 `exitReadings.includes(claim)` 会让矛盾声称**静默变绿**（#146 实测：
 *   `t146-unit.log` 同时含 0 与 1 两种读数，对两个矛盾声称都判 ok）。
 *   三种候选修法（边车配对 / 取首或最近 / 多读数响亮不判）里选了第三种：与
 *   Decision 2 的「没有读数 ⇒ 响亮不判」同构、牙齿只缩到真正判不了的判位上；
 *   「只认边车」会把现存 `.log` 内合法读数一次性全降级，「取首/最近」恰是
 *   Q3=D 明言要躲的就近配对假红家族。降级形态是**新状态 `ambiguous`**：
 *   不进红清单、必打 `!! SKIP (loud)` 并点名该载体。
 * - **扫描面 = 有证据行义务的三类**（Q4=B）：`.scratch/<NN>-landing.md`（落地文档）、
 *   `.scratch/batch-state.md`（批次进度）、`.scratch/retro/*.md`（retro 候选）。
 *   归档 / 交接文档 / issue 回读**不纳入**（它们没有证据行义务，且归档沿用"红 → 绿"取证文体）。
 *
 * ## 载体的约定（ADR-0015 Decision 5 的 ⚠️ 落实）
 *
 * 本仓约定是 stdout 落 `.log`、退出码落**同名 `.exit` 边车**，而边车窗内容本身也写成
 * `…EXIT=0` / `exit=0` 形态（纯数字是少数）⇒ 边车同样走声称文法，另对 `.exit` 保留
 * "裸数字也算读数"的兜底。**被引文件是 `.log` 且同名边车存在时，边车一并当载体** ——
 * 只读 `.log` 会让一半以上的判位退化成「无读数、不判」；接入前后的读数与"救回了多少"
 * 落档在 `.scratch/132-landing.md` §7.3（每条都带可核的 `.exit` 边车）。
 *
 * ## 豁免与基础设施（`#112` AC5 / `#127`）
 *
 * 取块与 `[History: …]` 点名制**不是本文件实现的**：`blocksOf` 家族在
 * `tests/helpers/scan-blocks.ts`（spec 之间不能互相 import —— Vitest 里 import 一个 spec
 * 会把那份 spec 的用例在本文件里重新注册一遍，计数会涨）。故本守卫**自动继承**点名制豁免：
 * 括号里被反引号点名的 token 出判定面，块内其余内容照扫；语义的单一来源是
 * `tests/doc-references.spec.ts` 头注「豁免粒度的沿革」。
 * 「引述失败」类（引一条**已经被覆盖掉**的旧读数）按 ADR-0015 的裁决**只能**复用
 * `[History: …]` 点名该路径，不得新造第二套豁免词汇。
 *
 * ## 覆盖面的诚实声明
 *
 * 全 `.scratch/` 里还有大量声称行**没有任何具体证据路径**（行内读数形态；ADR-0015
 * Consequences 记的当时读数是 218 行）—— 它们结构上进不了本判据的面，只按行计数并打进
 * 汇总。要给那一半上闸得另立判据（ADR-0015 Consequences 已写明）。
 *
 * @module tests/evidence-citations.spec.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blocksOf, blocksOfLine, type ScanBlock } from "./helpers/scan-blocks.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** `.scratch/` 的绝对路径（数据源根；**相对仓库根**，与家目录无关 —— ADR-0015）。 */
const scratchRoot = join(repoRoot, ".scratch");

/**
 * 退出码声称的文法（ADR-0015 Decision 5，本票落地的实现细节）：
 * `[A-Za-z_]*EXIT` 词形、大小写不敏感、**分隔符必填** —— `=` / `:`（两侧允许空白）或一段空白；
 * 值取数字串。
 *
 * 三条都是复核留痕的改变（首版更宽，被两轴点名）：
 * - **分隔符不许省**：首版写成 `\s*[=:：]?\s*`，于是 `exit0` 也算声称 —— ADR 只允许
 *   `=` / `:` / 空格三种分隔，故收紧，并由合成用例锁住 `exit0` 不进面。
 * - **不收全角冒号 `：`**：ADR 的字面是 `=` / `:` / 空格，多收一种形态就是悄悄放宽判据。
 * - **值取 `(\d+)` 而非 `(\d)`**：后者把 `exit=10` 读成末位的 `0`（合成用例已锁）。
 */
const EXIT_CLAIM = /[A-Za-z_]*[Ee][Xx][Ii][Tt](?:[ \t]*[=:][ \t]*|[ \t]+)(\d+)\b/gu;

/** 证据单元格：反引号包住的一段（本仓落地文档的表格 / 叙述都这样写路径）。 */
const BACKTICK = /`([^`\n]+)`/gu;

/** "像证据档名"的扩展名。`.md` 不在面内：文档之间的互链不是证据载体（由同族路径判据守）。 */
const EVIDENCE_EXT = /\.(?:log|exit|txt|json|mjs)$/iu;

/** 占位 / 模式形态（`<NAME>.log` / `*.log` / `t1-{1..5}.log`）不是具体载体，不进面。 */
const PLACEHOLDER = /[<{*]/u;

/** 文本里的退出码声称（原样收集；去重留给判据层，去重后的个数决定"多声称行"）。 */
export function exitClaimsIn(text: string): string[] {
  return [...text.matchAll(EXIT_CLAIM)].map((match) => match[1]);
}

/**
 * 同一段文本里的**证据单元格**（具体的、可打开的载体名）。
 *
 * 排除三类：占位 / 模式形态（`<NAME>.log`、`*.log`）、不是证据扩展名的（`.md` / `.ts`）、
 * 以及说明性的假 token（`.log` / `.exit` 单独出现只是后缀说明；含 `=` 或空白的不是路径）。
 */
export function evidenceTokensIn(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(BACKTICK)) {
    const token = match[1].replace(/[.,;:!?、。）\s]+$/u, "");
    if (token.includes("=") || /\s/u.test(token)) continue;
    if (PLACEHOLDER.test(token)) continue;
    if (!EVIDENCE_EXT.test(token)) continue;
    if (token === ".log" || token === ".exit") continue;
    tokens.push(token);
  }
  return tokens;
}

/**
 * 证据 token → 绝对路径。三种形态（grill 实测的落地文档写法）：
 *
 * 1. `.scratch/…` ⇒ 相对**仓库根**（ADR-0015 的基准，不涉及家目录）；
 * 2. `tests/` `docs/` `scripts/` `src/` 前缀 ⇒ 相对仓库根（被引的也可能是仓内脚本 / 台账）；
 * 3. 裸档名（`t103-unit.log`）⇒ 相对 `.scratch/`（落地文档的默认落点）。
 *
 * ⚠️ **不做 `~` 展开**（ADR-0015 的硬约束）：`#128` 的基准只活在波浪号族里，本守卫不得
 * 引入第三套路径基准 —— 同一条 `~/x` 在两个守卫里落点不同就是事故。
 */
export function resolveEvidenceToken(root: string, token: string): string {
  if (token.startsWith(".scratch/")) return join(root, token);
  if (/^(?:tests|docs|scripts|src)\//u.test(token)) return join(root, token);
  return join(root, ".scratch", token);
}

/** 被引载体的读数：`found` = 被引文件本身在盘上；`exitReadings` = 载体里能读到的退出码。 */
export interface EvidenceCarrier {
  readonly found: boolean;
  readonly exitReadings: readonly string[];
}

/** 注入式文件系统读入（合成用例用内存 Map，活体用 `node:fs` —— 判据同一份，不许分叉）。 */
export interface EvidenceFs {
  readonly exists: (abs: string) => boolean;
  readonly read: (abs: string) => string;
}

/**
 * 载体文本里的退出码读数 —— **只走声称文法**。
 *
 * 裸数字兜底**只给 `.exit` 边车**（那正是"边车窗里就是退出码"的约定形态）：若对所有载体都收，
 * 一份只含一个数字的 `.log` / `.json` 会把 `no-info` 静默翻成 `ok` 或 `contradict`（复核发现）。
 */
function readingsOfText(text: string, allowBareNumber: boolean): string[] {
  const readings = exitClaimsIn(text);
  const trimmed = text.trim();
  if (allowBareNumber && /^\d+$/u.test(trimmed)) readings.push(trimmed);
  return readings;
}

/** 该路径是否 `.exit` 边车形态（裸数字兜底的唯一入口）。 */
function isExitSidecarPath(abs: string): boolean {
  return abs.endsWith(".exit");
}

/**
 * 造一个"打开载体"的函数：路径解析 + 读数提取，**含同名 `.exit` 边车**（ADR-0015 §5 的 ⚠️）。
 *
 * 边车只在**被引文件存在**且是 `.log` 时并入 —— 被引 `.log` 不在盘上时那条引用本身就该红
 * （"边车还在"不能替一份缺失的日志洗白）。
 */
export function makeEvidenceOpener(
  root: string,
  fs: EvidenceFs,
): (token: string) => EvidenceCarrier {
  return (token) => {
    const abs = resolveEvidenceToken(root, token);
    const found = fs.exists(abs);
    const readings = found ? readingsOfText(fs.read(abs), isExitSidecarPath(abs)) : [];
    if (found && abs.endsWith(".log")) {
      const sidecar = `${abs.slice(0, -".log".length)}.exit`;
      if (fs.exists(sidecar)) readings.push(...readingsOfText(fs.read(sidecar), true));
    }
    return { found, exitReadings: readings };
  };
}

/** 一条判位（一个声称 × 一个证据单元格）的结果。 */
export interface EvidenceJudgment {
  /** 块在文件里的序号 + 1：`.md` 的块就是行，故它**就是行号**（活体面全是 `.md`）。 */
  readonly line: number;
  readonly token: string;
  readonly claim: string;
  readonly state: "ok" | "contradict" | "missing" | "no-info" | "ambiguous";
  readonly readings: readonly string[];
}

/** 一次判定的读数汇总（`pairs` 里只含**进了判定面**的配对）。 */
export interface EvidenceScan {
  readonly pairs: EvidenceJudgment[];
  /** 多声称行（≥2 个不同退出码）的**行号**：整行出判定面，但必须响亮声明。 */
  readonly multiClaimLines: readonly number[];
  /** 有声称但没有具体载体可打开的**行号**（结构上进不了面 —— ADR-0015 的诚实声明）。 */
  readonly claimLinesWithoutCarrier: readonly number[];
}

/**
 * 判定一组文本块（`blocksOf` 的产物；`.md` 里一块 = 一行）。
 *
 * 逐条按 ADR-0015 Decision 2/3（+ `#153` 修订）：不存在 ⇒ `missing`；读数与声称相反 ⇒
 * `contradict`；读数里含声称值 ⇒ `ok`；载体没有任何读数 ⇒ `no-info`（**响亮声明、不判**）；
 * 载体去重后 ≥2 个**不同**读数 ⇒ `ambiguous`（**响亮声明、不判** —— 多读数载体判不了
 * 「相反」，旧判据在这里会让矛盾声称静默变绿，`#146` 实测）。
 * **多声称行在"无载体"判定之前**先出局 —— 否则"两个不同声称 + 没有载体"的行会被记成
 * "无载体"，把 D3 的声明数吞掉（复核发现）。`[History: …]` 点名的 token 已在点名池里，此处过滤。
 */
export function judgeEvidence(
  blocks: readonly ScanBlock[],
  open: (token: string) => EvidenceCarrier,
): EvidenceScan {
  const pairs: EvidenceJudgment[] = [];
  const multiClaimLines: number[] = [];
  const claimLinesWithoutCarrier: number[] = [];
  blocks.forEach((block, index) => {
    const claims = [...new Set(exitClaimsIn(block.text))];
    if (claims.length === 0) return;
    const line = index + 1;
    if (claims.length > 1) {
      multiClaimLines.push(line);
      return;
    }
    const tokens = [
      ...new Set(evidenceTokensIn(block.text).filter((token) => !block.exempt.has(token))),
    ];
    if (tokens.length === 0) {
      claimLinesWithoutCarrier.push(line);
      return;
    }
    const claim = claims[0];
    for (const token of tokens) {
      const carrier = open(token);
      if (!carrier.found) pairs.push({ line, token, claim, state: "missing", readings: [] });
      else if (carrier.exitReadings.length === 0) {
        pairs.push({ line, token, claim, state: "no-info", readings: [] });
      } else if (new Set(carrier.exitReadings).size > 1) {
        // #153：多读数载体判不了「相反 ⇒ 红」，降级为响亮不判 —— 不是 ok。
        pairs.push({ line, token, claim, state: "ambiguous", readings: carrier.exitReadings });
      } else if (carrier.exitReadings.includes(claim)) {
        pairs.push({ line, token, claim, state: "ok", readings: carrier.exitReadings });
      } else {
        pairs.push({ line, token, claim, state: "contradict", readings: carrier.exitReadings });
      }
    }
  });
  return { pairs, multiClaimLines, claimLinesWithoutCarrier };
}

/** 判定面（ADR-0015 Decision 4：三类有证据行义务的文档）。 */
export function evidenceSurface(): string[] {
  const landings = readdirSync(scratchRoot)
    .filter((name) => /^\d+-landing\.md$/u.test(name))
    .map((name) => `.scratch/${name}`);
  const batchState = existsSync(join(scratchRoot, "batch-state.md"))
    ? [".scratch/batch-state.md"]
    : [];
  const retroRoot = join(scratchRoot, "retro");
  const retrospectives = existsSync(retroRoot)
    ? readdirSync(retroRoot)
        .filter((name) => name.endsWith(".md"))
        .map((name) => `.scratch/retro/${name}`)
    : [];
  return [...landings, ...batchState, ...retrospectives].sort();
}

/** 判定结果里"该红"的那些（不存在 / 读数相反），活体与合成用例共用同一条文案。 */
export function redLinesOf(rel: string, scan: EvidenceScan): string[] {
  return scan.pairs
    .filter((pair) => pair.state === "missing" || pair.state === "contradict")
    .map((pair) =>
      pair.state === "missing"
        ? `${rel}:${String(pair.line)} ${pair.token} 声称 exit=${pair.claim}（被引证据不存在）`
        : `${rel}:${String(pair.line)} ${pair.token} 声称 exit=${pair.claim}（载体里的读数是 ${pair.readings.join("/")}）`,
    );
}

/**
 * 「不判」的**响亮声明**（ADR-0015 Decision 2/3 的字面要求）：`no-info` 判位与多声称行
 * 都必须以 `!! SKIP (loud)` 打出，并说明"缺什么"（`TESTING.md` 的 loud-skip 口径）——
 * 只在一行汇总里报数是不够的：汇总会被忽略，"没判"与"判过且干净"读起来一样。
 */
export function skipDeclarationsOf(rel: string, scan: EvidenceScan): string[] {
  const declarations: string[] = [];
  const noInfo = scan.pairs.filter((pair) => pair.state === "no-info");
  if (noInfo.length > 0) {
    declarations.push(
      `  !! SKIP (loud) — ${String(noInfo.length)} 个判位的载体里**没有**退出码读数` +
        `（「不含」≠「相反」，不判）：${noInfo
          .slice(0, 3)
          .map((pair) => `${rel}:${String(pair.line)} ${pair.token}`)
          .join(" / ")}${noInfo.length > 3 ? " …" : ""}`,
    );
  }
  const ambiguous = scan.pairs.filter((pair) => pair.state === "ambiguous");
  if (ambiguous.length > 0) {
    declarations.push(
      `  !! SKIP (loud) — ${String(ambiguous.length)} 个判位的载体含 ≥2 个不同读数` +
        `（多读数载体判不了「相反」，#153 起响亮不判）：${ambiguous
          .slice(0, 3)
          .map((pair) => `${rel}:${String(pair.line)} ${pair.token}（读数 ${[...new Set(pair.readings)].join("/")}）`)
          .join(" / ")}${ambiguous.length > 3 ? " …" : ""}`,
    );
  }
  if (scan.multiClaimLines.length > 0) {
    declarations.push(
      `  !! SKIP (loud) — ${String(scan.multiClaimLines.length)} 行多声称行（≥2 个不同退出码）` +
        `整行出判定面（就近配对会假红）：${scan.multiClaimLines
          .slice(0, 3)
          .map((line) => `${rel}:${String(line)}`)
          .join(" / ")}${scan.multiClaimLines.length > 3 ? " …" : ""}`,
    );
  }
  return declarations;
}

describe("证据引用守卫 · 声称文法（合成）", () => {
  it("认 `EXIT` 词形的全部大小写 / 分隔符写法，多位数不被截成末位", () => {
    expect(exitClaimsIn("`node --run test` exit=0")).toEqual(["0"]);
    expect(exitClaimsIn("EXIT=1")).toEqual(["1"]);
    expect(exitClaimsIn("FROZEN_EXIT=0")).toEqual(["0"]);
    expect(exitClaimsIn("docs-spec exit: 2")).toEqual(["2"]);
    expect(exitClaimsIn("exit 0")).toEqual(["0"]);
    expect(exitClaimsIn("T_100_EXIT = 1")).toEqual(["1"]);
    // 取 `(\d+)` 而不是 `(\d)` 的前车之鉴：后者会把 `exit=10` 读成末位的 `0`。
    expect(exitClaimsIn("exit=10")).toEqual(["10"]);
  });

  it("分隔符必填，且不收全角冒号（ADR 只许 `=` / `:` / 空格）", () => {
    // 首版写成 `\s*[=:：]?\s*`，`exit0` 也会被当成声称 —— 复核发现后收紧。
    for (const text of ["exit0", "EXIT0", "frozen_exit0", "exit：0"]) {
      expect(exitClaimsIn(text), `${JSON.stringify(text)} 不是 ADR 允许的声称形态`).toEqual([]);
    }
    // 对照：三种合法分隔都照认（判据没被收紧到哑）。
    expect(exitClaimsIn("exit=0 / exit:1 / exit 2")).toEqual(["0", "1", "2"]);
  });

  it("非声称形态不进面（否则整族判据会被叙述文字带偏）", () => {
    for (const text of ["退出码 exitcode 0 的说明", "`exit` 这个词本身", "exit=abc", "exited 0 是过去式"]) {
      expect(exitClaimsIn(text), `不该把 ${JSON.stringify(text)} 当声称`).toEqual([]);
    }
  });
});

describe("证据引用守卫 · 证据单元格（合成）", () => {
  it("只收具体、可打开的载体名：反引号包裹 + 证据扩展名", () => {
    expect(evidenceTokensIn("- `.scratch/t1-fulltest.log` exit=0")).toEqual([
      ".scratch/t1-fulltest.log",
    ]);
    expect(evidenceTokensIn("- `t1-fulltest.log` 与 `t2.exit`")).toEqual(["t1-fulltest.log", "t2.exit"]);
    // 尾随全角/半角标点剥掉后仍是同一个 token。
    expect(evidenceTokensIn("见 `.scratch/t1.log`，另有 `.scratch/t2.json`。")).toEqual([
      ".scratch/t1.log",
      ".scratch/t2.json",
    ]);
  });

  it("占位 / 模式 / 说明形态不进面（否则每一条「该怎么写」的示范都会假红）", () => {
    for (const text of [
      "`<NAME>.log`",
      "`*.log`",
      "`t1-{1..5}.log`",
      "`.log`",
      "`.exit`",
      "`exit=0`",
      "`docs/adr/0015-x.md`",
      "`tests/doc-references.spec.ts`",
    ]) {
      expect(evidenceTokensIn(text), `不该把 ${JSON.stringify(text)} 当载体`).toEqual([]);
    }
  });
});

describe("证据引用守卫 · 判定语义（合成）", () => {
  const root = join("C:\\", "repo");
  const at = (name: string): string => join(root, ".scratch", name);

  /** 合成树：内存 Map，不碰真盘（合成用例不该依赖本机 `.scratch/` 长什么样）。 */
  const treeOf = (files: Readonly<Record<string, string>>): EvidenceFs => {
    const map = new Map(Object.entries(files).map(([name, body]) => [at(name), body]));
    return {
      exists: (abs) => map.has(abs),
      read: (abs) => map.get(abs) ?? "",
    };
  };

  it("路径解析：`.scratch/` 与仓内前缀相对仓库根，裸档名落 `.scratch/`；不展开 `~`", () => {
    expect(resolveEvidenceToken(root, ".scratch/a.log")).toBe(at("a.log"));
    expect(resolveEvidenceToken(root, "tests/a.log")).toBe(join(root, "tests", "a.log"));
    expect(resolveEvidenceToken(root, "t1.log")).toBe(at("t1.log"));
    // ADR-0015 的硬约束：不引入第三套路径基准（`~` 的基准只活在 #128 的波浪号族里）。
    expect(resolveEvidenceToken(root, "~/a.log")).toBe(at("~/a.log"));
  });

  it("三类结果各判一次：含声称值 ⇒ ok；读数相反 ⇒ contradict；没有读数 ⇒ no-info（不判）", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({
        "ok.log": "OK — 28/29 通过\n",
        "ok.exit": "exit=0\n",
        "contradict.log": "FAIL 1 test\n",
        "contradict.exit": "exit=1\n",
        "noinfo.log": "private path scan: 0 hits\n",
      }),
    );
    const scan = judgeEvidence(
      blocksOfLine(
        [
          "- `.scratch/ok.log` exit=0",
          "- `.scratch/contradict.log` exit=0",
          "- `.scratch/noinfo.log` exit=0",
        ].join("\n"),
      ),
      open,
    );
    expect(scan.pairs.map((pair) => [pair.line, pair.token, pair.state])).toEqual([
      [1, ".scratch/ok.log", "ok"],
      [2, ".scratch/contradict.log", "contradict"],
      [3, ".scratch/noinfo.log", "no-info"],
    ]);
    // 「不含」不等于「相反」：只有 contradict 进红清单（而且点得出载体里的读数）。
    const reds = redLinesOf(".scratch/x-landing.md", scan);
    expect(reds).toHaveLength(1);
    expect(reds[0]).toContain("x-landing.md:2");
    expect(reds[0]).toContain("载体里的读数是 1");
  });

  it("被引文件不存在 ⇒ missing（边车还在也不能替缺失的日志洗白）", () => {
    const open = makeEvidenceOpener(root, treeOf({ "gone.exit": "exit=0\n" }));
    const scan = judgeEvidence(blocksOfLine("- `.scratch/gone.log` exit=0"), open);
    expect(scan.pairs.map((pair) => pair.state)).toEqual(["missing"]);
    expect(redLinesOf(".scratch/x-landing.md", scan)[0]).toContain("被引证据不存在");
  });

  it("边车接入：被引 `.log` 的读数在边车里，边车形态 `…EXIT=0` 与裸数字 `0` 都认", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({
        "a.log": "RUN v4（stdout 里没有退出码）\n",
        "a.exit": "T132_EXIT=0\r\n",
        "b.log": "RUN v4\n",
        "b.exit": "0\r\n",
      }),
    );
    expect(open("a.log").exitReadings).toEqual(["0"]);
    expect(open("b.log").exitReadings).toEqual(["0"]);
    // 边车载着的读数同样能判矛盾（日志本身没读数 ⇒ 只靠边车）。
    expect(judgeEvidence(blocksOfLine("- `b.log` exit=1"), open).pairs[0]?.state).toBe("contradict");
  });

  it("裸数字兜底只给 `.exit`：`.log` 里孤零零一个数字不算退出码读数", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({
        "lonely.log": "0\n",
        "lonelymable.exit": "1\n",
      }),
    );
    // `.log` 只有裸数字 ⇒ 不进读数面 ⇒ 判 no-info（不是 ok，更不是 contradict）。
    expect(open("lonely.log").exitReadings).toEqual([]);
    expect(judgeEvidence(blocksOfLine("- `lonely.log` exit=0"), open).pairs[0]?.state).toBe(
      "no-info",
    );
    // 对照：`.exit` 自己的裸数字**是**读数（边车窗的约定形态）。
    expect(open("lonelymable.exit").exitReadings).toEqual(["1"]);
  });

  it("多声称行整行出判定面（Q3=D），且**先于**「无载体」判定（D3 的声明数不被吞）", () => {
    const open = makeEvidenceOpener(root, treeOf({ "a.log": "exit=0\n" }));
    const scan = judgeEvidence(
      blocksOfLine(
        [
          "- `.scratch/a.log` typecheck exit=0 / privacy EXIT=1",
          "- 没有载体但两个不同声称：exit=0 与 exit=1",
        ].join("\n"),
      ),
      open,
    );
    expect(scan.pairs).toEqual([]);
    expect(scan.multiClaimLines).toEqual([1, 2]);
    expect(scan.claimLinesWithoutCarrier).toEqual([]);
  });

  it("有声称但没有载体可打开 ⇒ 只计数（结构上进不了面，ADR-0015 的诚实声明）", () => {
    const open = makeEvidenceOpener(root, treeOf({}));
    const scan = judgeEvidence(blocksOfLine("- 验完 `node --run test` exit=0，没写日志路径"), open);
    expect(scan.pairs).toEqual([]);
    expect(scan.claimLinesWithoutCarrier).toEqual([1]);
  });

  it("同行把同一个 token 写两次 ⇒ 只出一个判位（去重，否则判位虚高）", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({ "a.log": "OK\n", "a.exit": "exit=0\n" }),
    );
    const scan = judgeEvidence(
      blocksOfLine("- `.scratch/a.log` 与 `.scratch/a.log` 都声称 exit=0"),
      open,
    );
    expect(scan.pairs).toHaveLength(1);
  });

  it("`.md` 的块 = 行：同一文档的多行各自判定，行号与块序一致", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({
        "ok.log": "OK\n",
        "ok.exit": "exit=0\n",
        "bad.log": "FAIL\n",
        "bad.exit": "exit=1\n",
      }),
    );
    const scan = judgeEvidence(
      blocksOfLine(["- `.scratch/ok.log` exit=0", "", "- `.scratch/bad.log` exit=0"].join("\n")),
      open,
    );
    expect(scan.pairs.map((pair) => [pair.line, pair.state])).toEqual([
      [1, "ok"],
      [3, "contradict"],
    ]);
  });

  it("`[History: …]` 点名制豁免原样继承（#127）：点名 ⇒ 出判定面，未点名 / 空池 ⇒ 照扫", () => {
    const open = makeEvidenceOpener(root, treeOf({}));
    // ① 点名 ⇒ 该路径不产生配对（这正是「引述失败」的法定逃逸口 —— ADR-0015）。
    expect(
      judgeEvidence(
        blocksOfLine(
          "- 旧读数 `.scratch/gone.log` exit=1（[History: `.scratch/gone.log` 已被同名绿步覆盖]）",
        ),
        open,
      ).pairs,
    ).toEqual([]);
    // ② 空池 / 叙述型标记是 no-op ⇒ 照扫（`#127` 的破坏性语义变更）。
    for (const marker of ["[historical]", "[History: 旧布局已废止]"]) {
      expect(
        judgeEvidence(blocksOfLine(`- 旧读数 \`.scratch/gone.log\` exit=1（${marker}）`), open).pairs.map(
          (pair) => pair.state,
        ),
        `${marker} 是空池，不该豁免载体`,
      ).toEqual(["missing"]);
    }
    // ③ 点名**别的** token 时，同行的死路径照红（豁免是精确字符串，不是整行丢弃）。
    expect(
      judgeEvidence(
        blocksOfLine("- 旧读数 `.scratch/gone.log` exit=1（[History: `.scratch/other.log` 无关]）"),
        open,
      ).pairs.map((pair) => pair.state),
    ).toEqual(["missing"]);
  });

  it("行尾形态不影响判定：LF / CRLF 两树同结果（`TESTING.md` E11 的 (b) 不锚行尾）", () => {
    const open = makeEvidenceOpener(root, treeOf({ "a.log": "exit=0\r\n" }));
    const lf = "- `.scratch/a.log` exit=0";
    expect(judgeEvidence(blocksOfLine(lf + "\r"), open).pairs).toEqual(
      judgeEvidence(blocksOfLine(lf), open).pairs,
    );
    // 锚行尾对照（A1 的翻车形态）：`$` 收不住 CRLF 的 `\r` —— 本判据不落在这一类里。
    expect(/exit=0$/u.test(lf + "\r")).toBe(false);
    expect(/exit=0$/u.test(lf)).toBe(true);
  });

  it("多读数载体（#146 实测形态：同时含 `exit 0` 与 `exit 1` 的 `.log`）⇒ ambiguous 响亮不判，矛盾声称不再静默变绿", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({
        // #146 的实测样本形态：日志里同时出现 0 与 1 两种退出码读数（被 echo 进来的其它文本所致）。
        "t146-unit.log": "… 上一行写 `exit 0` …\n… 后面又出现 exit 1 的叙述 …\n",
      }),
    );
    expect(open("t146-unit.log").exitReadings).toEqual(["0", "1"]);
    const scan = judgeEvidence(
      blocksOfLine(["- `.scratch/t146-unit.log` exit=0", "- `.scratch/t146-unit.log` exit=1"].join("\n")),
      open,
    );
    // 关键回归位：before 判据（includes）对两个**矛盾**声称都判 ok —— 现在两条都降级。
    expect(scan.pairs.map((pair) => [pair.line, pair.state])).toEqual([
      [1, "ambiguous"],
      [2, "ambiguous"],
    ]);
    // 不进红清单（不是矛盾），但必须响亮（与 no-info 同一条纪律）。
    expect(redLinesOf(".scratch/x-landing.md", scan)).toEqual([]);
    const declarations = skipDeclarationsOf(".scratch/x-landing.md", scan);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toContain("!! SKIP (loud)");
    expect(declarations[0]).toContain("2 个判位");
    expect(declarations[0]).toContain("读数 0/1");
  });

  it("同值重复读数不算多读数（去重后再数）：单值载体照常判 ok / contradict", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({
        "same.log": "exit=0\n",
        "same.exit": "T_EXIT=0\n",
      }),
    );
    // 读数 ["0","0"] 去重后只有 1 个 ⇒ 判据不变。
    expect(new Set(open("same.log").exitReadings).size).toBe(1);
    expect(judgeEvidence(blocksOfLine("- `.scratch/same.log` exit=0"), open).pairs[0]?.state).toBe("ok");
    expect(judgeEvidence(blocksOfLine("- `.scratch/same.log` exit=1"), open).pairs[0]?.state).toBe(
      "contradict",
    );
  });

  it("边车与 .log 读数分歧（#153 AC1 形态：.exit=1 + .log 另含 exit 0）⇒ ambiguous 而非 ok（候选 3 下的边界锁定）", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({
        "split.log": "叙述里提到 exit 0\n",
        "split.exit": "T_EXIT=1\n",
      }),
    );
    // opener 合并两源读数 ⇒ 去重后 2 个不同值 ⇒ 判不了「相反」，响亮不判（不判 ok）。
    // 顺序不做硬断言（opener 先 .log 后 .exit，判定只看去重集合），只锁「两个源都在」。
    expect([...new Set(open("split.log").exitReadings)].sort()).toEqual(["0", "1"]);
    const scan = judgeEvidence(
      blocksOfLine(["- `.scratch/split.log` exit=1", "- `.scratch/split.log` exit=0"].join("\n")),
      open,
    );
    expect(scan.pairs.map((pair) => pair.state)).toEqual(["ambiguous", "ambiguous"]);
    expect(redLinesOf(".scratch/x-landing.md", scan)).toEqual([]);
    expect(skipDeclarationsOf(".scratch/x-landing.md", scan)[0]).toContain("!! SKIP (loud)");
  });

  it("「不判」必须响亮（`!! SKIP (loud)` + 说明缺什么），不能只在一行汇总里报数", () => {
    const open = makeEvidenceOpener(
      root,
      treeOf({ "noinfo.log": "RUN v4\n" }),
    );
    const scan = judgeEvidence(
      blocksOfLine(
        [
          "- `.scratch/noinfo.log` exit=0",
          "- 多声称：exit=0 与 exit=1",
        ].join("\n"),
      ),
      open,
    );
    const declarations = skipDeclarationsOf(".scratch/x-landing.md", scan);
    expect(declarations).toHaveLength(2);
    expect(declarations[0]).toContain("!! SKIP (loud)");
    expect(declarations[0]).toContain("1 个判位");
    expect(declarations[1]).toContain("1 行多声称行");
    // 对照：全 ok / 全红的判定面**不**喊 loud（否则标记会变成背景噪音）。
    const clean = judgeEvidence(blocksOfLine("- `.scratch/x.log` exit=0"), makeEvidenceOpener(root, treeOf({ "x.log": "OK\n", "x.exit": "exit=0\n" })));
    expect(skipDeclarationsOf(".scratch/x-landing.md", clean)).toEqual([]);
  });
});

describe("证据引用守卫 · 活体 .scratch/（#132，ADR-0015）", () => {
  it("落地文档 / 批次状态 / retro 里的证据载体都存在，退出码声称不与载体矛盾", () => {
    // 数据源缺席 ⇒ 响亮跳过，绝不静默当绿（干净 clone / 部署副本 / pre-push 车道）。
    if (!existsSync(scratchRoot)) {
      console.warn(
        "  !! SKIP (loud) — 没有 .scratch/ 目录（干净 clone / 部署副本 / pre-push 车道）—— 证据引用未验证",
      );
      return;
    }
    const files = evidenceSurface();
    if (files.length === 0) {
      console.warn("  !! SKIP (loud) — .scratch/ 下没有落地文档 / 批次状态 / retro —— 证据引用未验证");
      return;
    }
    const open = makeEvidenceOpener(repoRoot, {
      exists: existsSync,
      read: (abs) => readFileSync(abs, "utf8"),
    });
    const judged = files.map((rel) => ({ rel, scan: judgeEvidence(blocksOf(rel), open) }));
    const pairs = judged.flatMap(({ rel, scan }) => scan.pairs.map((pair) => ({ rel, pair })));
    const reds = judged.flatMap(({ rel, scan }) => redLinesOf(rel, scan));
    const count = (state: string): number =>
      pairs.filter(({ pair }) => pair.state === state).length;
    const multi = judged.reduce((sum, { scan }) => sum + scan.multiClaimLines.length, 0);
    const withoutCarrier = judged.reduce(
      (sum, { scan }) => sum + scan.claimLinesWithoutCarrier.length,
      0,
    );
    // ADR-0015 Decision 2/3 的"响亮声明不判"：no-info 判位与多声称行逐条打出（`!! SKIP (loud)`）。
    for (const { rel, scan } of judged) {
      for (const declaration of skipDeclarationsOf(rel, scan)) console.warn(declaration);
    }
    console.log(
      `  #132 证据引用面：${String(files.length)} 档 / ${String(pairs.length)} 判位` +
        `（${String(count("ok"))} 含 / ${String(count("no-info"))} 无 exit 信息 / ${String(
          count("ambiguous"),
        )} 多读数不判 / ${String(count("missing") + count("contradict"))} 红）` +
        `· 多声称行 ${String(multi)} · 无载体声称行 ${String(withoutCarrier)}`,
    );
    // 牙齿自检：空面 / 全「无读数」的 0 红不证明任何事。
    expect(pairs.length, "判定面为空 ⇒ 0 红不证明任何事").toBeGreaterThan(0);
    expect(count("ok"), "一条真读数都没判到 ⇒ 守卫的牙齿没咬住").toBeGreaterThan(0);
    expect(
      reds,
      "落地文档里的证据引用与载体矛盾或载体不存在：修正读数、改引能打开的载体，" +
        "确属「引述一条已被覆盖的旧读数」才用 [History: `路径` …] 点名（ADR-0015）",
    ).toEqual([]);
  });
});
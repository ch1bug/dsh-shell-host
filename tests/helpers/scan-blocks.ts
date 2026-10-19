/**
 * 参与引用判定的**文本块**（`.md` = 逐行；`.ts` = 注释块），每块自带 `[History: …]` 的点名池。
 *
 * ## 为什么在这里（`#132`）
 *
 * 这套基础设施原在 `tests/doc-references.spec.ts` 里。`#132` 的守卫
 * （`tests/evidence-citations.spec.ts`）是**同族的下一条判据**（`doc-references` 的七条之外），
 * 按 `#112` AC5「同族守卫别各写一套」必须共用同一份取块 / 豁免实现，否则两处豁免语义会各自漂移。
 * 而 **spec 之间不能互相 import**：Vitest 里 import 一个 spec 会把它的用例在本文件里重新注册
 * （`#132` 交接陷阱 8 实测：计数会涨），故抽到 `tests/helpers/`（本仓既有做法：
 * `probe-needle.ts` / `lib-snapshot.ts` 等）。
 *
 * 本模块**只做**"取块 + 点名池"，不含任何判定（路径存在与否、声称是否矛盾等都留给各守卫）。
 * **豁免语义的单一来源** = `tests/doc-references.spec.ts` 头注「豁免粒度的沿革」（`#127` 的点名制）；
 * 为什么这样取块 = `docs/adr/0015-evidence-citation-guard-surface.md`（ADR 只记决定，实现在这里）。
 *
 * @module tests/helpers/scan-blocks
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** 仓库根（本文件在 `tests/helpers/` 下，故退两级）。 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 历史豁免标记的**括号体**（`#127` 的粒度改革）：`[History: …]` / `[historical]`。
 *
 * 标记只提供一个**点名池**（括号内被反引号包住的 token），**不**豁免整块/整行文本；
 * 规则全文与三态语义（点名 ⇒ 豁免 / 未点名 ⇒ 照扫 / 同块外 ⇒ 不豁免）见
 * `tests/doc-references.spec.ts` 头注「豁免粒度的沿革」—— 此处不重复（单一来源 + 指针）。
 *
 * ⚠️ 括号体必须**在同一块内闭合**（`.md` 同一行 / `.ts` 同一注释块）：没写 `]` 就等于没点名。
 */
const HISTORICAL_BODY = /\[histor(?:y|ical)\b([^\]]*)\]/giu;

/** 标记括号体里的 token 形态：一对反引号包住、**不跨行**（跨行的反引号多半是围栏，不是点名）。 */
const BACKTICK_TOKEN = /`([^`\n]+)`/gu;

/**
 * 参与扫描的**文本块**：正文 + 该块的点名池（`exempt`，精确字符串）。
 *
 * 逐族比对是**精确字符串**（`#127` Q2=A）：路径族拿路径 token 去池里查、哈希族拿哈希 token
 * 去池里查 —— 故 `[History: `c74b2d5`]` 只豁免那条哈希，不影响路径族。
 */
export interface ScanBlock {
  readonly text: string;
  readonly exempt: ReadonlySet<string>;
}

/** 空池：合成用例直接喂字符串时等价于"没有点名池"。 */
const NO_EXEMPT: ReadonlySet<string> = new Set();

/** 统一入参形态：合成用例可继续直接喂字符串（等价于空池）。 */
function asBlock(block: string | ScanBlock): ScanBlock {
  return typeof block === "string" ? { text: block, exempt: NO_EXEMPT } : block;
}

/** 取出参与判定的**正文**（围栏判据只要正文，不吃点名池 —— 见 `doc-references.spec.ts`
 * 头注「豁免粒度的沿革」第 5 条）。 */
export function blockTexts(blocks: readonly (string | ScanBlock)[]): string[] {
  return blocks.map((block) => asBlock(block).text);
}

/** 该块的点名池：标记括号内被反引号包住的 token（`[historical]` ⇒ 空集）。 */
function exemptTokensIn(block: string): ReadonlySet<string> {
  const pool = new Set<string>();
  for (const marker of block.matchAll(HISTORICAL_BODY)) {
    for (const token of marker[1].matchAll(BACKTICK_TOKEN)) pool.add(token[1]);
  }
  return pool;
}

/** 由一个文本块造 `ScanBlock`（点名池从**该块自己**的括号体里取，故块外不豁免）。 */
function blockOf(text: string): ScanBlock {
  return { text, exempt: exemptTokensIn(text) };
}

/**
 * 一段源码文本里的注释 **range**（按文档顺序、去重）。
 *
 * 走 AST 的 leading / trailing comment ranges（不是裸 `ts.createScanner`：后者对含
 * `${}` 的模板串会错位，把模板后面的 `//` 误当注释——已由 `doc-references.spec.ts`
 * 的回归用例锁住）。字符串字面量与模板串天然不是注释。
 */
function commentRanges(text: string, fileName = "probe.ts"): { pos: number; end: number }[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const seen = new Set<string>();
  const ranges: { pos: number; end: number }[] = [];
  const add = (rangesOfNode: readonly ts.CommentRange[] | undefined) => {
    for (const range of rangesOfNode ?? []) {
      const key = `${range.pos}:${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push({ pos: range.pos, end: range.end });
    }
  };
  const visit = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(sf.text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(sf.text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(sf.text, sf.endOfFileToken.getFullStart()));
  return ranges.sort((a, b) => a.pos - b.pos);
}

/**
 * 该注释是否**独占行首**（前面只有缩进）—— 行尾注释（`code(); // …`）不算。
 *
 * 用于 `mergeAdjacentLineComments` 的边界：行尾注释不并入下一行，否则**代码行尾**的
 * 死路径会被下一行标记的括号顺带豁免（那是"远处藏毒"的入口，`#127` Q2 明确否决同文件级）。
 */
function startsOwnLine(text: string, pos: number): boolean {
  return /^[ \t]*$/u.test(text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos));
}

/**
 * 把相邻的**整行 `//` 注释**并成**一个注释块**（两块之间只允许"换行 + 缩进"）。
 *
 * 为什么必须并：标记的括号体可以跨行（`[History: `x` dropped in` 换行接着写哈希），而
 * `ts.get*CommentRanges` 对每个 `//` 行各报一个 range —— 不并，括号体就被切断、点名池
 * 静默变空。块注释与 JSDoc 本来就是单个 range，不参与合并（中间隔了代码或空行也不并）。
 * **行尾注释不并入**（见 `startsOwnLine`）。
 */
function mergeAdjacentLineComments(
  text: string,
  ranges: readonly { pos: number; end: number }[],
): { pos: number; end: number }[] {
  const merged: { pos: number; end: number }[] = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (
      prev !== undefined &&
      text.startsWith("//", range.pos) &&
      text.startsWith("//", prev.pos) &&
      startsOwnLine(text, range.pos) &&
      startsOwnLine(text, prev.pos) &&
      /^[ \t]*\r?\n[ \t]*$/u.test(text.slice(prev.end, range.pos))
    ) {
      merged[merged.length - 1] = { pos: prev.pos, end: range.end };
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/** 一段源码文本里参与扫描的注释块（`#127`：每块自带点名池，不再整块豁免）。 */
export function commentBlocks(text: string, fileName = "probe.ts"): ScanBlock[] {
  return mergeAdjacentLineComments(text, commentRanges(text, fileName)).map((range) =>
    blockOf(text.slice(range.pos, range.end)),
  );
}

/** 一个文件里参与扫描的文本块：代码看注释，`.md` 看逐行（点名池按注释块 / 按行构建）。 */
export function blocksOf(rel: string): ScanBlock[] {
  const text = readFileSync(join(repoRoot, rel), "utf8");
  return rel.endsWith(".md") ? blocksOfLine(text) : commentBlocks(text, rel);
}

/**
 * 合成用例版：对**一段 markdown 文本**套用与 `blocksOf` **同一套**行级规则。
 *
 * 存在的意义：让"`.md` 的块 = 标记所在行"这条语义能被合成用例直接锁住，而不必去动产品树
 * 里的文档（合成用例不该依赖某个真实文件恰好长什么样）。判据必须与 `blocksOf` 同源 ——
 * `blocksOf` 对 `.md` 走的就是这个函数，否则锁住的就不是真规则。
 */
export function blocksOfLine(text: string): ScanBlock[] {
  return text.split("\n").map(blockOf);
}

/**
 * 逐块提取引用并**按点名池过滤**（`#127`）：每族拿自己的 token 去池里查（精确字符串）。
 *
 * 合成用例可以直接喂字符串（`asBlock` 视作空池），故所有 `*RefsIn` 都走这一个形状 ——
 * 六族共用同一条豁免语义，不各写一套（`#112` AC5 的落地形态）。
 */
export function collectRefs(
  blocks: readonly (string | ScanBlock)[],
  extract: (text: string) => string[],
): string[] {
  return blocks.flatMap((block) => {
    const { text, exempt } = asBlock(block);
    return extract(text).filter((token) => !exempt.has(token));
  });
}
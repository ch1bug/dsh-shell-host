/**
 * 文档引用腐烂检查（`#78`；第 2 条断言是 `/retro` 2026-10-16 的扩展，
 * 第 3 条是**历史重写**同日会话的扩展，第 4 条是 `#112` 的扩展）。
 *
 * 为什么：两轮 code-review 才扫完 6 处引用"已被 ADR-0013 删掉的文件的注释"
 * （`backends.ts` / `wsl-bridge.ts` / `src/client` / `src/remote` …）。机械模式 → 确定检查。
 *
 * 四条断言：
 *
 * 1. **仓内路径引用必须存在**（`#78` 的验收面）：扫 `src/**`、`tests/**` 的**注释**，
 *    凡是形如 `src/<path>.ts` / `tests/<path>.ts` 的引用，目标文件必须在仓内。
 * 2. **本仓脚本的调用一律写 `node --run <script>`**（扩展）：`#79` 把入口从 pnpm shim
 *    换成 `node --run`，却残留 4 处旧写法，本会话靠人肉 grep 才发现。只认**本仓
 *    package.json 的脚本名** —— `pnpm add` / `npm publish` 这类生态命令不在此列
 *    （它们出现在 ADR 与调研文档里是正当的）。
 * 3. **提交哈希引用必须可解析**（历史重写后的扩展）：历史重写会改写**所有**提交 SHA，
 *    文档 / 注释里对旧提交的引用会集体失效。人肉逐条 `git cat-file -t` 才发现过 6 处
 *    （还写错过一轮"中间态"哈希）—— 机械掉它。口径：引用优先写 `git log -S '<符号>'`
 *    （本仓 handoff 就是这条），要写 SHA 就必须能解；跨仓的引用（宿主锚点）进
 *    `HASH_ALLOWLIST`，显式留档。
 * 4. **docs 与根文档里的 markdown 链接目标必须存在**（`#112` 的扩展）：`[label](target)` 的目标
 *    按 markdown 真实语义**相对所在文件目录**解析（不是仓库根）—— 基准写错一级是本仓
 *    实测过的缺陷（`docs/code-review-brief.md` §3 曾有 6 条这样的死链）。
 *    **扫描面 = `docs` 下全部 `.md` + `ROOT_DOCS`**（`AGENTS.md` / `README.md` / `GLOSSARY.md`）。
 *    **显式规则**：带 scheme 的 URL（`https:` / `mailto:` …）与**协议相对 URL**（`//host/x`）、
 *    纯锚点（`#…`）**不进面**；锚点后缀（`path.md#sec`）只取 `#` 前的路径部分；
 *    目标允许尾随标题（`](p.md "标题")`）与尖括号包裹（`](<a b.md>)`）；
 *    **图片 `![alt](target)` 按同一规则进面**（图片路径同样会腐烂，不因 `!` 豁免；
 *    本仓当前无图片，故活体 0 命中）；目标解析到检出之外（`..` 越过仓库根）
 *    或没指向任何文件（空目标）**算断链**，不是"逃逸豁免"。
 *
 * **豁免**：历史性提及（被删除的实现、旧命令叙述）在该注释/该行写 `[History: …]`
 * （也接受 `[historical]`）——沿用 `src/wsl-plugin/index.ts` 的既有写法。
 * `docs/adr/**` 是决定记录，整体排除在扫描面外（按惯例不回头改）。
 *
 * **复用面**（`#112` AC5：同族守卫别各写一套）：`linkRefsIn` 只做"取目标"、
 * `resolveLinkTarget` 只做"按基准解析"，后续守卫在**同一份文本块**上加自己的判定，
 * 不另起一套扫描/豁免基础设施（`blocksOf` / `walk` / `HISTORICAL` 都共用）。
 *
 * ⚠️ **给 #93 的边界说明**（复核发现，别照抄）：`linkRefsIn` 锚的是 markdown `](…)` 语法，
 * 而 #93 要扫的是**文档全文的绝对路径**（`<盘符>:\…`），它不出现在 `](…)` 里 ——
 * 那一票应从 `blocksOf(rel)` 的文本块层另起提取。`resolveLinkTarget` 对 #93 也**不适用**：
 * 绝对路径不需要基准，且它对"指向仓外"返回 `null`（本票当**断链**），
 * 而 #93 的 AC 明写"不处理相对路径指向仓外的形态"—— 两票在该语义上**取向相反**，
 * 故不要把它当 #93 的公共前置。
 *
 * 边界：路径与命令只看**注释**（TS scanner 取 trivia，字符串字面量天然不进来）、
 * `docs/**` 看全文；排除 `node_modules`、`lib/`；外部检出里的路径（宿主树的 CLI 入口）
 * 不算仓内引用。检查器自身的边界有合成文本用例守着，见第一个 describe。
 *
 * @module tests/doc-references.spec.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * 历史性提及的豁免标记。沿用仓内既有写法 `[History: …]`（见 `src/wsl-plugin/index.ts`），
 * 也接受 `#78` brief 举例的 `[historical]`。标记所在**注释整块**（`.md` 为该行）豁免。
 */
const HISTORICAL = /\[histor(?:y|ical)\b/iu;

/** 根目录下参与扫描的文档。 */
const ROOT_DOCS = ["AGENTS.md", "README.md", "GLOSSARY.md"].filter((f) =>
  existsSync(join(repoRoot, f)),
);

/**
 * 注释里的仓内路径引用。前缀边界 `(?<![\w/.-])` 排除外部检出路径：
 * 宿主树里的 `apps/cli/<path>` 不会被当成本仓路径。
 */
const PATH_REF = /(?<![\w/.-])((?:src|tests)\/[\w./-]*?\.(?:ts|tsx|mjs|js|json|md))/gu;

/**
 * 取一段源码文本里的注释正文。
 *
 * 走 AST 的 leading / trailing comment ranges（不是裸 `ts.createScanner`：后者对含
 * `${}` 的模板串会错位，把模板后面的 `//` 误当注释——已由下面的回归用例锁住）。
 * 字符串字面量与模板串天然不是注释。
 */
function commentTexts(text: string, fileName = "probe.ts"): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const seen = new Set<string>();
  const comments: string[] = [];
  const add = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      const key = `${range.pos}:${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push(sf.text.slice(range.pos, range.end));
    }
  };
  const visit = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(sf.text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(sf.text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(sf.text, sf.endOfFileToken.getFullStart()));
  return comments;
}

/** 一段源码文本里参与扫描的注释块（带历史标记的注释整块豁免）。 */
export function commentBlocks(text: string, fileName = "probe.ts"): string[] {
  return commentTexts(text, fileName).filter((c) => !HISTORICAL.test(c));
}

/** 一个文件里参与扫描的文本块：代码看注释，`.md` 看逐行（行内历史标记豁免该行）。 */
function blocksOf(rel: string): string[] {
  const text = readFileSync(join(repoRoot, rel), "utf8");
  return rel.endsWith(".md")
    ? text.split("\n").filter((line) => !HISTORICAL.test(line))
    : commentBlocks(text, rel);
}

/** 文本块里的仓内路径引用。 */
export function pathRefsIn(blocks: string[]): string[] {
  return blocks.flatMap((block) => [...block.matchAll(PATH_REF)].map((m) => m[1]));
}

/** 文本块里本仓脚本的 pnpm/npm 调用写法（返回命中片段）。 */
export function runnerRefsIn(blocks: string[], scripts: string[]): string[] {
  const names = scripts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  const pattern = new RegExp("`(?:pnpm|npm)\\s+(?:run\\s+)?(?:" + names + ")`", "gu");
  return blocks.flatMap((block) => [...block.matchAll(pattern)].map((m) => m[0]));
}

/**
 * 引用哈希的**允许清单**：跨仓引用，本仓历史里必然解析不到，故显式留档。
 * `687f282e` = **宿主**仓现锚 `dsh-v0.2.1-rc.2`；`1600d8a1` = 前一锚 `dsh-v0.2.1-rc.1`；
 * `639ed015` / `639ed01539` = 旧锚 `dsh-v0.2.0-rc.2`（历史引用仍在，见 dev-environment.md §2）。
 */
export const HASH_ALLOWLIST = new Set(["687f282e", "1600d8a1", "639ed015", "639ed01539"]);

/** 文本块里的提交哈希引用（7–40 位 hex；纯数字的版本号片段 / 权限位不算）。 */
export function hashRefsIn(blocks: string[]): string[] {
  return blocks.flatMap((block) =>
    [...block.matchAll(/\b[0-9a-f]{7,40}\b/gu)].map((m) => m[0]).filter((t) => !/^[0-9]+$/u.test(t)),
  );
}

/**
 * markdown 链接目标：`[label](target)` 与 `![alt](target)`。
 *
 * 判定面是**目标本身**，标签（`[...]`）不参与 —— 本仓实测踩过标签与目标不同步的档
 * （`docs/code-review-brief.md` §3 的标签写 `docs/agents/TESTING.md`、目标写 `TESTING.md`），
 * 那种错只能靠解析目标才发现。
 *
 * **显式规则**（#112 AC1）—— 哪些目标进存在性判定、哪些不进：
 *
 * 1. **URL 不进面**：带 scheme 的目标（`https:` / `http:` / `mailto:` …，形如
 *    `^[a-z][a-z0-9+.-]*:`）**以及协议相对 URL**（`//host/path`，形如 `^//`）
 *    都不是仓内路径，无从查存在性。
 * 2. **纯锚点不进面**：以 `#` 开头的目标是同文档内跳转，没有文件可查。
 * 3. **图片进面**（`![alt](target)`）：图片目标同样是路径引用、同样会腐烂，
 *    不该因为 `!` 就豁免 —— 故它按**同一规则**处理。本仓当前无图片，故活体面 0 命中。
 *
 * **markdown 目标语法**（`](…)` 内允许的形态，按 CommonMark）：
 * - 尖括号包裹（`](<path with space.md>)`）—— 剥括号，**内部空格保留**；
 * - 尾随标题（`](path.md "标题")` / `](path.md '标题')`）—— 只取 `"` 前那段；
 * - 两者都没写时，遇空白即止（`](path.md   )` 取 `path.md`）。
 *
 * 锚点后缀（`path.md#section`）只取 `#` 之前的路径部分。
 */
const LINK_REF = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gu;

/**
 * 文本块里的 markdown 链接目标（未解析、原样；URL 与纯锚点已排除）。
 *
 * 顺序有意：先剥尖括号 → 再剥锚点后缀 → 再排除空目标与 URL。
 * 剥锚点放在空目标过滤**之前**，故 `#sec` 先变成 `""` 被滤掉，
 * 不再需要单独的 `startsWith("#")` 分支。
 */
export function linkRefsIn(blocks: string[]): string[] {
  return blocks.flatMap((block) =>
    [...block.matchAll(LINK_REF)]
      .map((m) => m[1])
      .map((raw) => (raw.startsWith("<") ? raw.slice(1, -1) : raw))
      .map((raw) => raw.split("#")[0])
      .filter((target) => target !== "")
      .filter((target) => !/^[a-z][a-z0-9+.-]*:/iu.test(target))
      .filter((target) => !target.startsWith("//")),
  );
}

/**
 * 把一个链接目标按 **markdown 真实语义**解析成仓库相对路径：
 * 目标是相对**所在文件目录**解析的（不是仓库根）。
 *
 * **基准写错一级是本仓实测缺陷**（`docs/code-review-brief.md` §3 曾有 6 条死链：
 * 标签按 `docs/` 写、目标按 `docs/agents/` 写），故基准必须显式参数化，
 * 不能隐含"从仓库根数"。这是 `#93` / `#94` 的公共前置：它们在解析结果上加自己的判定。
 *
 * **返回 `null` 的两种情况**（都表示"仓内必不存在"，调用方一律当断链）：
 *
 * 1. `..` 越过仓库根（解析到检出之外）—— 若放任空栈弹出，`../../AGENTS.md` 从 `docs/`
 *    出发会绕回 `AGENTS.md`（存在），那是**假绿**（本票实测：不处理时活体只报 3 条、
 *    漏掉 3 条真断链）。
 * 2. **目标不含任何路径段**（`""` / `"."` / `"."` 重复）—— 它没指向任何条目，
 *    解析结果会退化成**所在目录本身**，而 `existsSync` 对目录也返回 true ⇒ **另一处假绿**
 *    （复核发现；当前 `LINK_REF` 恰好滤掉这些形态，但那是上游正则的巧合，不是本函数的保证）。
 *
 * **注意 `..` 结尾是合法目标**：`[上级](..)` 指向的是**目录**，应当照常解析
 * （`docs/agents/x.md` + `..` → `docs`），故判据是"贡献了 0 段"而非"结果为空串"。
 */
export function resolveLinkTarget(fromFile: string, target: string): string | null {
  const out = fromFile.split("/").slice(0, -1);
  let contributed = 0; // 目标贡献的段数（`..` 也算，它是真实的目录导航）
  for (const part of target.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null; // 越过仓库根 ⇒ 仓外，仓内必不存在
      out.pop();
      contributed += 1;
      continue;
    }
    out.push(part);
    contributed += 1;
  }
  // 目标一段都没贡献 ⇒ 没指向任何条目（退化成所在目录，目录 existsSync 也是 true）。
  if (contributed === 0) return null;
  return out.join("/");
}

/** 递归收集某目录下的相对路径（正斜杠、排除 node_modules 与 lib/）。 */
function walk(dir: string, exts: string[]): string[] {
  return readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
    .map((p) => String(p).replaceAll("\\", "/"))
    .filter((p) => exts.some((e) => p.endsWith(e)))
    .filter((p) => !p.includes("node_modules") && !p.startsWith("lib/"))
    .map((p) => `${dir}/${p}`)
    .sort();
}

/** package.json 里声明的脚本名（第 2 条断言的判定面）。 */
function scriptNames(): string[] {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  return Object.keys(pkg.scripts ?? {});
}

describe("引用腐烂检查器自身的边界（合成文本）", () => {
  it("只认注释：字符串字面量里的路径不算引用", () => {
    const source = ['const sample = "src/ghost.ts";', "// 引用 src/real/thing.ts 见下"].join("\n");
    expect(pathRefsIn(commentBlocks(source))).toEqual(["src/real/thing.ts"]);
  });

  it("含 ${} 的模板串不会让注释提取错位", () => {
    // 裸 ts.createScanner 会在这里失步，把模板后面的 // 当成注释正文。
    const source = [
      "const dir = `${base}/nested`;",
      "const other = `a ${b} c`;",
      "// 引用 src/real/thing.ts",
    ].join("\n");
    expect(pathRefsIn(commentBlocks(source))).toEqual(["src/real/thing.ts"]);
  });

  it("只认仓内路径：外部检出里的路径不算", () => {
    expect(pathRefsIn(commentBlocks("// host checkout: apps/cli/src/bin.ts"))).toEqual([]);
    expect(pathRefsIn(commentBlocks("// 本仓 tests/helpers/e2e-install.ts"))).toEqual([
      "tests/helpers/e2e-install.ts",
    ]);
  });

  it("历史标记（[History: …] / [historical]）的注释整块豁免", () => {
    for (const marker of ["[historical]", "[History: ADR-0013 删除了该文件]"]) {
      expect(pathRefsIn(commentBlocks(`// （src/removed.ts，已删除）${marker}`))).toEqual([]);
    }
    expect(pathRefsIn(commentBlocks("// （src/removed.ts，已删除）"))).toEqual([
      "src/removed.ts",
    ]);
  });

  it("命令检查只认本仓脚本名，且不碰字符串字面量", () => {
    const scripts = ["test", "build"];
    expect(runnerRefsIn(commentBlocks("// 跑 `pnpm test` 与 `pnpm run build`"), scripts)).toEqual([
      "`pnpm test`",
      "`pnpm run build`",
    ]);
    expect(runnerRefsIn(commentBlocks('const cmd = "pnpm test"'), scripts)).toEqual([]);
    expect(runnerRefsIn(commentBlocks("// `pnpm add x` / `npm publish`"), scripts)).toEqual([]);
  });

  it("哈希引用只认 7–40 位 hex；纯数字（版本号片段 / 权限位）不算", () => {
    expect(hashRefsIn(["见 6ac27a2 与 639ed015；版本 1048576，权限 0000644"])).toEqual([
      "6ac27a2",
      "639ed015",
    ]);
    expect(hashRefsIn(["无引用"])).toEqual([]);
  });

  it("链接目标只认相对路径：URL 与纯锚点不误报", () => {
    const block = [
      "- [上游](https://github.com/ch1bug/dsh-shell-host/issues/80)",
      "- [锚点](#3-standards-源)",
      "- [协议](mailto:dev@example.invalid)",
      "- [协议相对](//example.com/x.md)",
      "- [真链接](../dev-environment.md)",
    ].join("\n");
    expect(linkRefsIn([block])).toEqual(["../dev-environment.md"]);
  });

  it("链接目标剥掉锚点后缀；图片按同一规则进面", () => {
    const block = [
      "- [带锚点](agents/TESTING.md#证据纪律)",
      "- ![截图](../assets/shot.png)",
    ].join("\n");
    expect(linkRefsIn([block])).toEqual(["agents/TESTING.md", "../assets/shot.png"]);
  });

  it("markdown 目标的标题语法与尖括号形态都要取到路径", () => {
    // CommonMark 的 `](…)` 允许尾随标题与尖括号包裹；漏掉就是**静默漏面**。
    const block = [
      '- [带标题](docs/a.md "标题")',
      "- [单引号](docs/b.md '标题')",
      "- [尖括号空格](<docs/c d.md>)",
      "- [多余空白](docs/e.md   )",
    ].join("\n");
    expect(linkRefsIn([block])).toEqual(["docs/a.md", "docs/b.md", "docs/c d.md", "docs/e.md"]);
  });

  it("链接目标按所在文件目录解析，不是仓库根", () => {
    // 同一个目标串从两个不同基准出发，落点是两处 —— 基准写错一级正是
    // docs/code-review-brief.md §3 那 6 条死链的根因。
    expect(resolveLinkTarget("docs/dev-environment.md", "agents/TESTING.md")).toBe(
      "docs/agents/TESTING.md",
    );
    expect(resolveLinkTarget("docs/agents/TESTING.md", "../dev-environment.md")).toBe(
      "docs/dev-environment.md",
    );
    // 目录目标（本仓 `[adr/](adr/)` 即此形）同样解析。
    expect(resolveLinkTarget("docs/agents/TESTING.md", "../../GLOSSARY.md")).toBe("GLOSSARY.md");
  });

  it("解析逃出检出（.. 越过仓库根）返回 null，不算存在", () => {
    // 若放任 `..` 空栈弹出，`../../AGENTS.md` 从 docs/ 出发会绕回 `AGENTS.md` —— 假绿
    // （本票实测：不处理时活体扫描只报 3 条，漏掉 3 条真断链）。
    expect(resolveLinkTarget("docs/code-review-brief.md", "../../AGENTS.md")).toBeNull();
    expect(resolveLinkTarget("docs/code-review-brief.md", "../../../README.md")).toBeNull();
    expect(resolveLinkTarget("docs/adr/0001-x.md", "../../../AGENTS.md")).toBeNull();
    // 对照：`..` 只到仓库根、没越出去 —— 返回仓内路径，交给 existsSync 判在不在。
    expect(resolveLinkTarget("docs/code-review-brief.md", "../dev-environment.md")).toBe(
      "dev-environment.md",
    );
  });

  it("不含任何路径段的目标解析为 null（别假绿成所在目录）", () => {
    // 目标退化成所在目录时 `existsSync` 对目录也返回 true —— 不挡住就是假绿。
    // 当前 `LINK_REF` 恰好滤掉这些形态，但那是**上游正则的巧合**，不是本函数的保证；
    // #93/#94 拿它当共享前置时会直接踩到。
    //
    // 注意分层：锚点剥离（`#sec` → `""`）是 `linkRefsIn` 的职责，
    // 本函数只认"路径"，故这里不喂 `#…`（喂了会当普通文件名，那是调用方越层）。
    for (const target of ["", ".", "./", "./."]) {
      expect(resolveLinkTarget("docs/a.md", target), `目标 ${JSON.stringify(target)}`).toBeNull();
    }
    // 对照 1：正常目标照常解析。
    expect(resolveLinkTarget("docs/a.md", "b.md")).toBe("docs/b.md");
    // 对照 2：**以 `..` 结尾是合法目标**（指向目录），不能被上面的规则误伤。
    expect(resolveLinkTarget("docs/agents/TESTING.md", "..")).toBe("docs");
    expect(resolveLinkTarget("docs/agents/TESTING.md", "../")).toBe("docs");
    // 对照 3：`..` 越过仓库根仍是断链。
    expect(resolveLinkTarget("docs/a.md", "../..")).toBeNull();
  });

  it("合成断链真的判红：普通链接与图片链接都会被点名", () => {
    // AC2 的「断链红」在合成层的证据（不只活体扫描那一处）。
    const danglingIn = (block: string, from: string) =>
      linkRefsIn([block])
        .map((target) => resolveLinkTarget(from, target))
        .filter((resolved) => resolved === null || !existsSync(join(repoRoot, resolved)));
    expect(danglingIn("- [断链](nope-404.md)", "docs/a.md")).toEqual(["docs/nope-404.md"]);
    expect(danglingIn("- ![断图](nope-404.png)", "docs/a.md")).toEqual(["docs/nope-404.png"]);
    // 对照：现存链接绿（`docs/dev-environment.md` 真在仓内，基准 = 所在目录）。
    expect(danglingIn("- [现存](dev-environment.md)", "docs/a.md")).toEqual([]);
    // 对照 2：`../GLOSSARY.md` 从 docs/ 出发正好落在仓库根，存在 ⇒ 绿。
    // （注意 `../../GLOSSARY.md` 从 `docs/a.md` 出发会**越过根**，那是断链、不是绿。）
    expect(danglingIn("- [根文件](../GLOSSARY.md)", "docs/a.md")).toEqual([]);
  });
});

describe("文档引用腐烂（活体仓库扫描）", () => {
  it("docs/**/*.md 与根文档的相对链接目标都存在（#112）", () => {
    // 根文档的链接相对**仓库根**解析（它们就在根上），与 docs/ 下的文件同一个函数即可。
    const files = [...walk("docs", [".md"]), ...ROOT_DOCS];
    const dangling = files.flatMap((rel) =>
      linkRefsIn(blocksOf(rel))
        .map((target) => ({ target, resolved: resolveLinkTarget(rel, target) }))
        // resolved 为 null = 逃出检出 / 没指向任何文件 ⇒ 仓内必不存在，算断链。
        .filter(({ resolved }) => resolved === null || !existsSync(join(repoRoot, resolved)))
        .map(({ target, resolved }) => `${rel} -> ${target}（解析为 ${resolved ?? "检出之外"}）`),
    );
    expect(
      dangling,
      "markdown 链接指向不存在的仓内路径（目标相对所在文件目录解析）：" +
        "修正目标、或历史提及在同一条注释里标 [History: …]",
    ).toEqual([]);
  });

  it("src/** 与 tests/** 注释里的仓内路径引用都存在（#78）", () => {
    const files = [...walk("src", [".ts", ".tsx"]), ...walk("tests", [".ts"])];
    const dangling = files.flatMap((rel) =>
      pathRefsIn(blocksOf(rel))
        .filter((ref) => !existsSync(join(repoRoot, ref)))
        .map((ref) => `${rel} -> ${ref}`),
    );
    expect(dangling, "注释引用了不存在的仓内路径；历史提及请在同一条注释里标 [History: …]").toEqual([]);
  });

  it("本仓脚本一律按 node --run 书写（`pnpm <script>` 只在 [historical] 处）", () => {
    const scripts = scriptNames();
    const files = [
      ...walk("src", [".ts", ".tsx"]),
      ...walk("tests", [".ts"]),
      ...walk("scripts", [".mjs"]),
      // docs/adr/** 是决定记录，整体排除（历史命令原样保留）
      ...walk("docs", [".md"]).filter((p) => !p.startsWith("docs/adr/")),
      "vitest.config.ts",
      ...ROOT_DOCS,
    ];
    const stale = files.flatMap((rel) =>
      runnerRefsIn(blocksOf(rel), scripts).map((hit) => `${rel}: ${hit}`),
    );
    expect(stale, "本该 node --run 的调用写成了 pnpm/npm；历史叙述请加 [historical]").toEqual([]);
  });

  it("注释 / 文档里引用的提交哈希必须能在本仓解析（历史重写后的回归）", () => {
    try {
      execFileSync("git", ["--version"], { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      // 没有 git 就没法判"能不能解析"：响亮跳过，绝不静默当绿。
      console.warn(`  !! SKIP (loud) — 本机没有可用的 git（${String(error)}）—— 引用哈希未验证`);
      return;
    }
    const resolvable = (token: string): boolean => {
      try {
        execFileSync("git", ["cat-file", "-t", token], { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
        return true;
      } catch {
        return false;
      }
    };
    const files = [
      ...walk("src", [".ts", ".tsx"]),
      ...walk("tests", [".ts"]),
      ...walk("scripts", [".mjs"]),
      // docs/adr/** 是决定记录，整体排除（与上一条同口径）
      ...walk("docs", [".md"]).filter((p) => !p.startsWith("docs/adr/")),
      "vitest.config.ts",
      ...ROOT_DOCS,
    ];
    const dangling = files.flatMap((rel) =>
      hashRefsIn(blocksOf(rel))
        .filter((token) => !HASH_ALLOWLIST.has(token) && !resolvable(token))
        .map((token) => `${rel} -> ${token}`),
    );
    expect(
      dangling,
      "引用了本仓解析不到的提交哈希（历史重写会改写全部 SHA）：重映射到终态、或改用 `git log -S '<符号>'`；" +
        "跨仓引用（宿主锚点）请登记进 HASH_ALLOWLIST",
    ).toEqual([]);
  });
});
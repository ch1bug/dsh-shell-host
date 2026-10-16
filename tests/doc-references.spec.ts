/**
 * 文档引用腐烂检查（`#78`；第 2 条断言是 `/retro` 2026-10-16 的扩展）。
 *
 * 为什么：两轮 code-review 才扫完 6 处引用"已被 ADR-0013 删掉的文件的注释"
 * （`backends.ts` / `wsl-bridge.ts` / `src/client` / `src/remote` …）。机械模式 → 确定检查。
 *
 * 两条断言：
 *
 * 1. **仓内路径引用必须存在**（`#78` 的验收面）：扫 `src/**`、`tests/**` 的**注释**，
 *    凡是形如 `src/<path>.ts` / `tests/<path>.ts` 的引用，目标文件必须在仓内。
 * 2. **本仓脚本的调用一律写 `node --run <script>`**（扩展）：`#79` 把入口从 pnpm shim
 *    换成 `node --run`，却残留 4 处旧写法，本会话靠人肉 grep 才发现。只认**本仓
 *    package.json 的脚本名** —— `pnpm add` / `npm publish` 这类生态命令不在此列
 *    （它们出现在 ADR 与调研文档里是正当的）。
 *
 * **豁免**：历史性提及（被删除的实现、旧命令叙述）在该注释/该行写 `[History: …]`
 * （也接受 `[historical]`）——沿用 `src/wsl-plugin/index.ts` 的既有写法。
 * `docs/adr/**` 是决定记录，整体排除在扫描面外（按惯例不回头改）。
 *
 * 边界：只看**注释**（TS scanner 取 trivia，字符串字面量天然不进来）；`docs/**` 看全文；
 * 排除 `node_modules`、`lib/`；外部检出里的路径（宿主树的 CLI 入口）不算仓内引用。
 * 检查器自身的三条边界有合成文本用例守着，见第一个 describe。
 *
 * @module tests/doc-references.spec.ts
 */

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
});

describe("文档引用腐烂（活体仓库扫描）", () => {
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
});
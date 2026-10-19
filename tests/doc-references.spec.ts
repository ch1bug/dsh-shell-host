/**
 * 文档引用腐烂检查（`#78`；第 2 条断言是 `/retro` 2026-10-16 的扩展，
 * 第 3 条是**历史重写**同日会话的扩展，第 4 条是 `#112` 的扩展，
 * 第 5 条是 `#93` 的扩展，**第 6 条是 `#94` 的扩展**）。
 *
 * 为什么：两轮 code-review 才扫完 6 处引用"已被 ADR-0013 删掉的文件的注释"
 * （`backends.ts` / `wsl-bridge.ts` / `src/client` / `src/remote` …）。机械模式 → 确定检查。
 *
 * **六条断言**：
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
 * 5. **外部绝对路径引用必须在本机存在**（`#93` 的扩展，见 `absPathRefsIn` 头注）：
 *    `docs/**` + 根文档全文里的 `<盘符>:\…` / `<盘符>:/…`，目标是**本机文件系统**上的
 *    条目（`existsSync` 直吃原串）。票面记的两条死指针（`<old-work>\deepseek-harness` 等）
 *    结构上都不在旧四条判据的扫描面内，只能靠这条守。
 *    **本票实际覆盖的形态 = 盘符族**；**波浪号族（`~/…`）只出提取器与合成用例、
 *    不做活体存在性** —— 理由见 `tildeRefsIn` 头注的「显式未覆盖声明」。
 *
 * 6. **裸写（无 `tests/` 前缀）的 spec 文件名必须能在 `tests/` 下找到同名**（`#94` 的扩展，
 *    见 `bareSpecRefsIn` 头注）：第 1 条断言只认 `src/…` / `tests/…` **前缀**，故注释里
 *    裸写的文件名结构上落在它的面外 —— 票面标本（`tests/detect.spec.ts` 头注曾指一个
 *    随 ADR-0013 被删的 detector spec）正是这样全程无人管的。
 *    **扫描面**与第 4/5 条一致（`src` + `tests` + `scripts` + `docs`（除 `adr/`）+
 *    根文档 + `vitest.config.ts`）；**模式/占位符形态**（`<base>.spec.ts` / `*.spec.ts` /
 *    `xxx.spec.ts`）出豁免面，否则文档里写"新脚本请配对 `xxx.spec.ts`"会**假红**。
 *
 * 7. **`docs/**\/*.md` 的代码围栏必须配对**（`#126` 的扩展，见 `unclosedFencesOf` 头注）：奇数个围栏
 *    会把其后的正文**整段吞进代码块**（渲染错乱），而 `node --run test` 全绿 —— 这类缺陷
 *    在 #108 文档审计里被观测到过。判据是**CommonMark 围栏状态机**，不是数 ` ``` ` 出现次数
 *    （嵌套反例见 `unclosedFencesOf` 头注）。**扫描面 = `docs` 下全部 `.md`（含 `adr/`）**，
 *    与第 4/5/6 条的 `docs`（除 `adr/`）**不同** —— 取票面 `#126` 的 `docs/**` 字面
 *    （human 2026-10-18 拍板），理由与代价见 `unclosedFencesOf` 头注「扫描面的取舍」。
 *    本判据与第 4 条**共用 `blocksOf` 文本块面**（`#126` AC4），故照样受 `[History: …]`
 *    的**整行豁免**约束 —— 那意味着行级豁免在这里的语义是"该行免受围栏配对判定"。
 *
 * ⚠️ **AC1 与 AC2 的结构性分歧**（`#93` 实测 + 两轴复核，human 2026-10-18 拍"写清楚"）：
 * 票面 AC2 要求给 `GLOSSARY.md:12` 加 `[History: …]`，而票面 AC1 点名的标本
 * （`<old-work>\deepseek-harness`）**正落在那一行上**。豁免粒度是**整行**
 * （`.md` 逐行过滤）⇒ **两条 AC 在同一行上互相抵消**：加豁免后，写在那行的死路径
 * 再也抓不到。实测 A/B 见 `.scratch/t93-mut2.log`（同一死路径：带标记行→绿/漏报，
 * 非标记行→红并点名）。故本票的**变异验证改用非豁免行做载体**，并用合成用例
 * （`blocksOfLine`）把"整行豁免"这条语义本身锁住 —— 它是**有意的语义**，
 * 不是 bug；要改窄属跨票判据变更（会影响 `#78` / `#112`），须单独立票。
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
import { ALLOWED_USERS } from "../scripts/privacy-scan.mjs";

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

/**
 * 合成用例版：对**一段 markdown 文本**套用与 `blocksOf` **同一套**行级豁免规则。
 *
 * 存在的意义：让"整行豁免"这条语义能被合成用例直接锁住，而不必去动产品树里的文档
 * （合成用例不该依赖某个真实文件恰好长什么样）。判据必须与 `blocksOf` 同源，
 * 否则锁住的就不是真规则 —— 故这里复用同一个 `HISTORICAL` 常量与同一行过滤式。
 */
function blocksOfLine(text: string): string[] {
  return text.split("\n").filter((line) => !HISTORICAL.test(line));
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

/**
 * 外部**绝对路径引用**（`#93`）：`<盘符>:\…` / `<盘符>:/…`，目标必须在本机存在。
 *
 * 与 `PATH_REF`（仓内相对路径）互补：那个管"仓里有没有这个文件"，这个管
 * "本机有没有这个外部目标"。两条实测死指针（`<old-work>\deepseek-harness` 等）
 * 都不是仓内路径，故结构上落在旧判据的扫描面外。
 *
 * **形态边界**（票面 AC3，逐条有合成用例）：
 *
 * 1. **只认盘符前缀**：`^[A-Za-z]:[\\/]` —— 盘符后**必须是**分隔符，故
 *    `C:foo`（驱动器相对）不进面；`https://…` 的 `s://` 也不匹配（前面不是单字母+冒号）。
 * 2. **URL 不进面**：`https://host/C:/x` 里的 `C:/x` 前面紧邻 `/`，由否定环视挡住。
 * 3. **UNC 不进面**：`\\server\share` 没有盘符，形态上就不匹配。
 * 4. **`node_modules` 不进面**：本机存在与否与仓库无关，且常是第三方路径。
 * 5. **行内代码块 `…` **在面内****（票面要求写清的口径）：本仓实测 `#93` 的两条死指针
 *    都写在行内代码里，若把行内代码整块豁免，标本会漏网 ⇒ **假绿**。故行内代码照扫。
 * 6. **占位符不进面**：目标是"该怎么写"的示例（`C:\Users\<user>`、`C:/…`、
 *    `<盘符>:\Work`、`C:\Users\me`）时豁免 —— 它们**本机不存在是正当的**，
 *    进面就是**假红**。这与 PUBLIC 仓纪律同向：文档本就该用占位符表达个人路径。
 *    判据见 `isPlaceholder`（复用 privacy-scan 的词表）。
 *
 * **⚠️ 两个实测踩到的坑**（都由合成用例锁住）：
 *
 * - **占位符必须在匹配串里保留**：若字符类把 `<` 当终止符，`C:\Users\<user>` 会匹配成
 *   `C:\Users\` —— 占位符被正则吃掉、过滤层看不见它，而 `C:\Users\` 在本机**存在**，
 *   连存在性都拦不住 ⇒ **假红**。故字符类**不**排除 `<` / `%` / `…`，只排除真正终止
 *   路径的换行、引号与括号，把占位符交给 `isPlaceholder` 判；匹配后**再**剥尾部标点。
 * - **路径里的空格是路径的一部分，但不能吃进正文**：`'C:/Program Files/nodejs/node.exe'`
 *   若在空白处截断会得到 `C:/Program`（本机不存在）⇒ **假红**；但反过来若允许任意空白，
 *   `` `C:\x → /mnt/c/x` `` 会把后面的正文一起吞进来（实测）。故**只**允许
 *   "空格 + 仍像路径段的片段"（不含空白、非 `→`/`/` 起头的散文），
 *   这正是 `C:\Program Files\…` 与 `C:\x → …` 的判别式。
 *
 * **只判存在性**（票面 AC4）：不校验内容、不要求是文件（目录也算存在）。
 * Windows 文件系统天然大小写不敏感、`/` 与 `\` 等价，故 `existsSync` 直接吃原串即可
 * —— 实测 `C:\MSYS64` / `c:/msys64` / `C:/Windows/Temp` 三形全部 EXISTS，
 * **不需要额外归一化**；该性质由合成用例锁住，免得日后有人"优化"出一层多余的归一化。
 */
const ABS_PATH_REF = /(?<![\w/.\\:-])[A-Za-z]:[\\/](?:[^\n `"'()\[\]|]| (?![\s→])[^\n `"'()\[\]|])*/gu;

/**
 * 该命中是否其实是**带 scheme 的 URL**（`https://…`、`s://x`）。
 *
 * ⚠️ 本票实测的**假绿**：只靠"盘符后必须是分隔符"并不能排除 URL —— 单字母 scheme
 * （`s://x` / `x://y`）**与盘符形态完全同形**，实测两者都会被匹配。真正的判别式是
 * 冒号**前面跟着一个词字符**（`https:` 的 `s` 前是 `p`），而真盘符前面是边界。
 * 故必须显式判 scheme，不能把巧合当机制。
 */
const URL_SCHEME = /^[A-Za-z][\w+.-]*:\/\//u;

/** 该命中是否是**光杆盘符根**（`C:\` / `C:/`）—— 没有可判存在性的目标路径。 */
const BARE_DRIVE_ROOT = /^[A-Za-z]:[\\/]$/u;

/** 占位符判据：**复用 `scripts/privacy-scan.mjs` 的既有词表**，不另立一套
 * （`#112` AC5「同族守卫别各写一套」的落地形态）。
 *
 * 三类，覆盖票面 AC3 的占位符要求：
 * 1. 尖括号 / 省略号 / `%VAR%` 形态（`<user>`、`C:/…`、`%USERPROFILE%`）；
 * 2. **家目录段是通用账户名**（`C:\Users\me`、`C:/Users/x`）—— `ALLOWED_USERS` 是
 *    privacy-scan 导出的权威词表，其头注明写 `C:\Users\me`（README）是本仓既有写法；
 * 3. 运行期派生形态（`$(whoami)` / `${USER}` / `*`）。
 *
 * 为什么 #2 必须复用而不是自判：`C:\Users\me` 在本机**不存在**，但它是**正当的
 * 脱敏写法**（AGENTS.md 明令个人路径要用 `me` / `x` / `<user>` 表达）。判它红等于
 * 要求文档写真名 —— 方向恰好反了。用隐私守卫自己的词表，两处口径天然同步。
 */
function isPlaceholder(target: string): boolean {
  if (/<[^<>]*>|…|%[A-Za-z_]\w*%|\$\{?\w+\}?/u.test(target)) return true;
  // 家目录段（`…/Users/<seg>` 或 `…/home/<seg>`）落在通用账户词表里 ⇒ 占位符。
  const seg = /[\\/](?:Users|home)[\\/]([A-Za-z0-9._-]+)/iu.exec(target);
  if (seg !== null) {
    const user = seg[1].toLowerCase();
    if (ALLOWED_USERS.has(user) || /[$%{}()+*<>…]/u.test(seg[1])) return true;
  }
  return false;
}

/**
 * 命中是否是 **`node_modules` 内的路径**（任意层级）。
 *
 * ⚠️ 大小写**必须**折叠：Windows 文件系统天然大小写不敏感，本判据却在同一份实现里
 * 靠"大小写不敏感"吃 `existsSync`（AC4）；实测 `C:\NODE_MODULES\x` 与
 * `C:/a/Node_Modules/b` 都会因精确小写比较而**漏网**，与票面 AC3 的边界承诺矛盾。
 */
function inNodeModules(target: string): boolean {
  return target
    .replaceAll("\\", "/")
    .split("/")
    .some((seg) => seg.toLowerCase() === "node_modules");
}

/**
 * 文本块里的外部绝对路径引用（占位符形态已排除）。
 *
 * 剥尾部标点：路径常被写在句中被 `。`/`,`/`)` 收尾，尾缀不是路径的一部分。
 * 但**保留** `…`（它是占位符信号，要在下一步滤掉整条）。
 */
export function absPathRefsIn(blocks: string[]): string[] {
  return blocks.flatMap((block) =>
    [...block.matchAll(ABS_PATH_REF)]
      .map((m) => m[0].replace(/[.,;:!?、。）+]*$/u, ""))
      .filter((target) => !URL_SCHEME.test(target))
      .filter((target) => !BARE_DRIVE_ROOT.test(target))
      .filter((target) => !isPlaceholder(target))
      .filter((target) => !inNodeModules(target)),
  );
}

/**
 * 文本块里的**波浪号**路径引用（`~/…`）—— `#93` 的第二族。
 *
 * 为什么并列成第二族：实测 `~/dsh-host-src` 这类路径才是本仓**真正的舵机面**
 * （34 条命中，且票面点名的那条死指针改完后落到的正是这个形态）。
 * 盘符族与波浪号族的**提取**同属"外部绝对路径"，但**存在性基准不同**（见下），
 * 故拆成两个纯函数、各自配判定，不硬塞进一个返回 `string[]` 的函数。
 *
 * **⚠️ 活体存在性未覆盖（human 2026-10-18 拍 D）**：`~` 的基准在本机有两套且不一致 ——
 * `os.homedir()` = `C:\Users\<user>`，而文档里的 `~` 全是 **msys 语义**
 * （`C:\msys64\home\<user>`）。实测 `~/dsh-host-src` / `~/dsh-shellhost-src` /
 * `~/dsh-matt-home` / `~/dsh-shellhost-home` 在 `homedir()` 下**全部 MISSING**、
 * 在 msys home 下才存在 ⇒ 按 `homedir()` 判会把 **22 行正确文档**判红；
 * 而按 msys home 判需要探测用户名，**硬编码用户名违反 PUBLIC 仓纪律**。
 * 故本族**只出提取器 + 合成用例**（形态与占位符判据已锁住），
 * 活体存在性留给后续票 —— 这是**显式未覆盖声明**，不是静默漏面。
 * **`~` 后只收"段"**：段的字符集收紧为 `[\w.$-]`，**不允许空格**。
 * ⚠️ 这是实测修正：用 `[^\s…]*` 时 `` ~/dsh-host-src grep -c foo `` 会把**命令与参数
 * 一起吞进来**（实测），而波浪号族一旦接上存在性判定，这些串会直接变成假红。
 * 路径段里本来就没有空格（要空格得引号包裹），故收紧是安全的。
 */
const TILDE_REF = /(?<![\w/.\\:-])~\/(?:[\w.$-]+\/?)*/gu;

/** 文本块里的波浪号路径引用（`~/…`；`~user` 与孤立 `~` 不匹配）。 */
export function tildeRefsIn(blocks: string[]): string[] {
  return blocks.flatMap((block) =>
    [...block.matchAll(TILDE_REF)]
      .map((m) => m[0].replace(/[.,;:!?、。）+]*$/u, ""))
      .filter((target) => !isPlaceholder(target)),
  );
}

/**
 * **裸 spec 文件名**引用（`#94`）：`[\w-]+\.spec\.ts`，它必须能在 `tests/` 下找到同名。
 *
 * 为什么需要：`PATH_REF` 只认 `src/…` / `tests/…` **前缀**，故注释里**裸写**的文件名
 * （无前缀）结构上落在扫描面外 —— 票面标本正是这条：
 * `tests/detect.spec.ts` 的头注曾指**已删的那个 detector spec**（随 ADR-0013
 * 移除执行器世界时删除），全程无人管。
 *
 * 本段**只准出现真实存在的文件名**：注释里裸写的每个 `*.spec.ts` 都会被本判据自己
 * 读一遍（本文件在扫描面内），写一个已删的名字就会当场判红。故此处刻意**不**复写那个
 * 已删文件名 —— 它的沿革记在 `.scratch/94-landing.md` 与本票正文里（tracker 不在本判据
 * 的读取面内，票面 Out of scope 已明写）。
 * ⚠️ **这就是 `#93` 那条硬提醒的第二次实证**：豁免是整块/整行粒度，为了"说清楚一个已删
 * 文件名"而在本块加 `[History: …]`，会把**整块**判据说明一起移出扫描面 —— 得不偿失。
 * **与 `PATH_REF` 的分工**（不重复覆盖）：带前缀的写法归 `PATH_REF`（第 1 条断言），
 * 本判据**只收无前缀**的裸文件名 —— 靠否定环视 `(?<![\w/.-])` 把带 `tests/` 前缀的写法
 * 整体挡在外面。否则同一个引用会被两条断言各报一次，点名口径也会打架。
 *
 * **形态边界**（票面 AC2，逐条有合成用例）：
 *
 * 1. **占位符 / 模式形态不进面**：`<base>.spec.ts`、`*.spec.ts`、`xxx.spec.ts` 是
 *    "该怎么写"的**模式**，不是具体文件名 —— 文档里写"新脚本请配对 `xxx.spec.ts`"
 *    时若判红就是**假红**。判据见 `isSpecPlaceholder`。
 * 2. **`*` 必须收进字符类才谈得上排除**：实测 `tests/verify-all.spec.ts` 有 3 处**裸**
 *    `*.spec.ts`（`:146` / `:235` / `:239`，星号前无 `tests/` 前缀），而票面字面的
 *    `[\w-]+` **收不到**星号形态（`*` 不在字符类里）—— 那样"排除 `*.spec.ts`"就成了一句
 *    收不到东西的空话，而那三处会直接**假红**。故字符类放宽为 `[\w*-]+`，
 *    把星号收到手上、**再**用占位符规则真排除它。
 *    ⚠️ 复核期间有人主张"那 3 处都在带前缀语境、左边界已挡住"——**实测证伪**：
 *    原始正则在那三行上返回 `["*.spec.ts"]`（见 `.scratch/t94-probe-tmp7.log`）；
 *    带前缀的是**同一行里的** `tests/helper.ts`，与 `*.spec.ts` 是两个 token。
 * 3. **右边界 `(?![\w.-])` 是必需的**（两轴复核发现 c2，**实测有洞**）：没有它时
 *    一个 spec 文件名后面再跟 `.bak` / `x` 后缀（同目录下另有其文件）都会被**截断**成
 *    前半段 ⇒ 把**别的文件**当成本文件判，既可能假红、也可能把真断链错判成存在
 *    （本仓实测三形态全部命中）。右边界必须把 `.` 也排掉，否则 `.bak` 拦不住。
 * 4. **跨仓引用**（上游宿主树的 `optional-bundles.spec.ts` 这类）走 `BARE_SPEC_ALLOWLIST`
 *    显式留档，与 `HASH_ALLOWLIST` / `PATH_ALLOWLIST` 同形。
 *
 * ⚠️ **本判据只判"能不能在 `tests/` 下找到同名文件"**，不判用例数/内容/是否真跑
 * （票面 Out of scope 明写）。
 */
const BARE_SPEC_REF = /(?<![\w/.-])([\w*-]+\.spec\.ts)(?![\w.-])/gu;

/**
 * 该命中是否是**模式 / 占位符**形态（不是具体文件名）。
 *
 * 三类，覆盖票面 AC2 点名的三种：
 *
 * 1. **含 `*`**（`*.spec.ts` / `pty-*.spec.ts`）—— 通配模式，本就没有"同名文件"可言。
 * 2. **尖括号包裹**（`<base>.spec.ts` / `<file>.spec.ts`）—— 参数占位符。
 * 3. **基名是 `x+`**（`x.spec.ts` / `xx.spec.ts` / `xxx.spec.ts`）—— 仓内约定俗成的
 *    "随便一个名字"写法（`docs/agents/issue-tracker.md` 举例的形态即此族；那里的实例带
 *    `tests/` 前缀，本已出本判据的面，但**别靠前缀兜底** —— 判据自己得站得住）。
 *
 * ⚠️ **两条边界都必须锚"整个基名"**，不能用"含某串"这类宽判据 —— 那会把**真文件名**
 * 假绿放过。两个方向的边界（在面的真名 / 出面的形态）都由下方合成用例锁住，
 * 且反例一律写成**字符串字面量**：注释会被本判据自己读到（本文件在扫描面内），
 * 在注释里凑反例会先把测试文件判红。
 *
 * **关于"含 `*` 即豁免"的诚实声明**（两轴复核发现 c1，**有意保留的口径**）：
 * `*` 是通配符，含它的串**根本不指向任何具体文件** —— 故整类出豁免面，而不是只豁免
 * 基名恰为 `*` 的形态。代价是该形态**前瞻性假绿**：若日后有人真写出
 * "名字里带星号的具体文件名"引用（本机文件系统里 `*` 本就是非法字符，故实际不可能存在
 * 这样的文件），它会漏报。**取舍依据**：AC2 要求排除的是**模式**（`*.spec.ts` 的语义就是
 * "任意文件"），把豁免面收窄到只认 `^\*\.spec\.ts$` 会把 `pty-*.spec.ts` 这类**真模式**
 * 重新放回面内 ⇒ 假红。两害相权取其轻，且 `*` 在文件名里非法使漏报不可达。
 */
function isSpecPlaceholder(name: string): boolean {
  if (name.includes("*")) return true;
  if (/^<[^>]*>\.spec\.ts$/u.test(name)) return true;
  // 基名整体是 `x` 的重复（`x` / `xx` / `xxx`…）：举例用的通用名字，不是真文件。
  // ⚠️ 大小写**必须**折叠（两轴复核发现 c3）：`X.spec.ts` / `XX.spec.ts` 是小写形态的
  // 大小写变体，同一族的举例写法；不折叠它们就会**假红**，而 Windows 文件系统本就
  // 大小写不敏感（`#93` 的 `inNodeModules` 踩过同一个坑，此处不重犯）。
  return /^x+\.spec\.ts$/u.test(name.toLowerCase());
}

/** 文本块里的裸 spec 文件名引用（占位符 / 模式形态已排除）。 */
export function bareSpecRefsIn(blocks: string[]): string[] {
  return blocks.flatMap((block) =>
    [...block.matchAll(BARE_SPEC_REF)].map((m) => m[1]).filter((name) => !isSpecPlaceholder(name)),
  );
}

/**
 * **代码围栏配对**检查（`#126`）：`docs/**\/*.md` 里的行，是否把围栏开闭配平。
 *
 * ## 为什么不能数偶数（票面 `#112` 的警告，本判据的立身之本）
 *
 * ````markdown
 * ```ts
 * code
 * ```
 * ````
 *
 * 上面这段在 CommonMark 下是**一个**围栏块（外层四个反引号包住内层三个）——
 * 单纯统计 ` ``` ` 出现次数会把**三个**反引号行都数成"围栏"（4 行里 4 个），
 * 于是"嵌套"被误判成不平衡，或（凑巧偶数时）把真不平衡**误判成绿**。
 * 本文件用 `unclosedFencesOf` 实测过这条：naive 计数对嵌套反例给出"balanced"是**碰巧**，
 * 对 `["````", "```", "````"]`（闭栏短于开栏、**不算闭栏**）给出"unbalanced"才是洞。
 * ⇒ 故本票实现**状态机**，不数个数。
 *
 * ## 状态机（票面四条的逐条落地）
 *
 * 1. **开栏**：行首缩进 ≤3 空格 + 连续 **≥3** 个 `` ` `` 或 `~`；
 * 2. **闭栏**：**同**字符、长度 **≥ 开栏**、且行内**除空白外无其他内容**（info string
 *    只出现在开栏行）；
 * 3. **围栏内的行不再解析** —— 嵌套由此天然成立（外层开栏后，内层的 ` ``` ` 因**短于**
 *    开栏而不满足闭栏条件，被当普通内容跳过）；
 * 4. **info string 只出现在开栏行**（闭栏带了内容就不是闭栏）。
 *
 * ## 三条 CommonMark 细节（都实测锁在合成用例里）
 *
 * - **反引号开栏的 info string 里不能有反引号**：``` ```a`b ``` 不是合法开栏
 *   （CommonMark 规定 backtick 围栏的 info string 不得含反引号）。少了这条，
 *   行内代码的反引号会**误开栏**，把其后正文吞掉 ⇒ 假红。波浪号围栏无此限制。
 * - **闭栏允许尾随空白**（` ```   ` 是闭栏），但**不允许**尾随其他字符。
 * - **闭栏的缩进上限是 3 空格，且不必与开栏的缩进匹配** —— ⚠️ 这条被本票的 Spec 轴
 *   复核**质疑过**（主张"应允许任意缩进"），我按 **commonmark-spec 一手原文**裁定为
 *   **实现正确、质疑不成立**：规格 §"Fenced code blocks" 明写
 *   「The closing code fence may be preceded by **up to three spaces** of indentation」
 *   并配参考例「their indentation **need not match** that of the opening fence」
 *   （0 缩进开栏 + **2 空格**闭栏 ⇒ 规格输出是**已闭合**）。
 *   ⇒ 闭栏正则**必须有**与开栏同口径的 `( {0,3})` 组。裁定过程与两种规则的对照读数
 *   留在 `.scratch/t126-adjudicate.mjs` / `.scratch/t126-adjudicate.log`。
 *   （复核引的规格例「Four spaces of indentation is too many」讲的是**开栏** 4 空格
 *   ⇒ 缩进代码块，**不**为"闭栏能否 4 空格"提供依据。）
 *
 * ## 扫描面的取舍（human 2026-10-18 拍板：含 `adr/`）
 *
 * 票面 `#126` 写的是 **`docs/**\/*.md` 每个文件**，**字面含 `docs/adr/`** ——
 * 而本文件第 4/5/6 条断言的 `docs` 面**排除 `adr/`**（"决定记录，按惯例不回头改"）。
 * 两条路径都问过 human：**取票面字面（含 adr）**。
 * - **代价（显式留档）**：日后 `adr/` 里出现围栏不平衡会判红，而该目录的惯例是
 *   "不回头改" —— 两者取向相反。取舍依据：围栏不平衡**破坏渲染**（读者看到的是
 *   被吞掉的正文），这与"改不改历史决定的**内容**"是两回事；且实测本仓 26 档
 *   （含 14 档 adr）**全部平衡**，故此刻不产生任何红。
 * - **与 `#112` 的关系**：`#126` AC4 要求"与 `#112` 的链接判据**共用 `blocksOf`
 *   文本块面**"—— 这条已照办（本函数只吃 `blocksOf` 的产物，不另起扫描）。
 *   但 `blocksOf` 的**行级豁免**（`[History: …]` 整行移出扫描面）在这里的语义是
 *   "**该行免受围栏配对判定**"—— 与第 4 条断言的"该行不受链接存在性判定"同族。
 *
 * ## 返回什么
 *
 * 返回**未闭合的开栏行号**（1-based）列表 —— 每个不平衡的档至少一条。
 * 空数组 = 该档配平。**只报未闭合的**，不报"多余的闭栏"：状态机里没有开栏时，
 * 一个围栏行必然是**开栏**（不是"多余闭栏"），所以"多出来的闭栏"这一形态在
 * CommonMark 语义下**根本不存在** —— 报它只会是假红。
 *
 * @param lines 参与扫描的文本块（与 `blocksOf` 同源；`.md` 已逐行过滤掉豁免行）
 */
export function unclosedFencesOf(lines: string[]): number[] {
  let open: { char: string; len: number; line: number } | null = null;
  const unclosed: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open === null) {
      const m = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
      // 反引号开栏的 info string 不得含反引号（CommonMark）——否则行内代码会误开栏。
      if (m !== null && !(m[2][0] === "`" && m[3].includes("`"))) {
        open = { char: m[2][0], len: m[2].length, line: i + 1 };
      }
      continue;
    }
    // 闭栏：同字符、长度 ≥ 开栏、行内除空白外无他物。
    const closer = new RegExp(
      "^( {0,3})(" + (open.char === "`" ? "`" : "~") + "{" + open.len + ",})[ \\t]*$",
      "u",
    );
    if (closer.test(line)) open = null;
  }
  if (open !== null) unclosed.push(open.line);
  return unclosed;
}

/**
 * 某档文档的**围栏配对**结果（`#126`）：返回未闭合的开栏行号列表。
 *
 * 与第 4/5/6 条断言**共用 `blocksOf`**（AC4）——不再另起一套读文件 / 豁免基础设施。
 * ⚠️ 这里显式**不**用 `blocksOfLine`：那个函数是"对任意一段合成文本套用同一套行级豁免"
 * 的合成用例入口，与 `blocksOf(rel)` 走的是同一条 `HISTORICAL` 过滤式；合成用例要
 * 直接喂内存文本，故走 `blocksOfLine`，活体档走 `blocksOf`。
 *
 * ## ⚠️ 行尾归一化（`#126` 的**真实缺陷**，由 pre-push 的 msys 车道暴露）
 *
 * `blocksOf` 走 `text.split("\n")`，故 **CRLF 档的每行都带一个尾随 `\r`**，而两个判据的
 * 收尾字符类**都不收 `\r`**：
 * - **开栏**判据以 `(.*)$` 收尾 —— JS 的 `$`（无 `m` 标志）匹配的是**串尾**，
 *   而该行以 `\r` 结尾 ⇒ `(.*)` 到不了串尾之后 ⇒ `` ```bash\r `` **匹配不上**；
 * - **闭栏**判据以 `[ \t]*$` 收尾 —— 同样**收不下 `\r`** ⇒ `` ```\r `` **匹配不上**。
 *
 * 实测（`.scratch/t126-crlf2.log`，三行 CRLF 档 `["```bash","echo hi","```"]`）：
 * ```
 * 行1 "```bash\r"  opener=false  closer=false
 * 行2 "echo hi\r"  opener=false  closer=false
 * 行3 "```"        opener=true   closer=true    <- 末行**没有** `\r`（split 的必然结果）
 * ```
 * ⇒ 第 1 行的开栏**没被认出来**，而**末行**（唯一不带 `\r` 的行）被当成开栏 ⇒
 * 状态机报"**第 3 行**未闭合"——**完全虚假的红**。
 *
 * 同一份 `docs/research/research-official-terminal-ralph-bundles.md`（权威树 LF / msys 副本 CRLF）：
 * - 按 CRLF 原样读 ⇒ `[395]`（**假红**，正是 msys 车道报的那条）；
 * - 归一化后读 ⇒ `[]`（正确）。证据：`.scratch/t126-crlf.mjs` → `.scratch/t126-crlf.log`。
 *
 * ⇒ 故这里**先归一化行尾**再交给状态机。这不是"为了过测试而打的补丁"：
 * 判据的对象是**文档的语义**（围栏配对），而行尾形态是**检出配置**的产物
 * （同一份内容在不同检出里是 LF / CRLF），**不该影响判定**。
 * ⚠️ 这也是 `blocksOf` 的既有消费者（第 4/5/6 条）**没有暴露**这个差异的原因：
 * 它们的判据（路径/链接/哈希）都**不**要求"匹配到行尾"，故 `\r` 对它们无害。
 */
export function fenceGapsIn(rel: string): number[] {
  // 归一化后再判：CRLF 档的尾随 `\r` 不该让闭栏判据失效（见头注）。
  return unclosedFencesOf(blocksOf(rel).map((line) => line.replace(/\r$/u, "")));
}

/**
 * 裸 spec 文件名引用的**允许清单**：**跨仓**引用，本仓 `tests/` 下必然找不到同名，
 * 故显式留档 —— 与 `HASH_ALLOWLIST`（跨仓提交哈希）/ `PATH_ALLOWLIST`（刻意举例的
 * 机器路径）同形，都是"经判断后显式放行"，而非静默放过。
 *
 * - `optional-bundles.spec.ts`：**上游宿主树**的文件 —— `docs/research/research-osc133-shell-integration.md`
 *   里有它的带前缀写法（被否定环视挡在面外），而**本文件的判据说明**需要举它的名字
 *   （讲"跨仓引用该走这条清单"时）。本仓 `scripts/` 下确无 `optional-bundles.*`，
 *   故它是"本仓注定没有"的典型：新增同类条目必须同样写明这条理由。
 *
 * 新增条目必须说明"为什么本仓注定没有它"。
 */
export const BARE_SPEC_ALLOWLIST = new Set<string>(["optional-bundles.spec.ts"]);

/**
 * 绝对路径引用的**允许清单**：文档里**刻意举例的机器路径**——
 * 讲的是"别的机器/别的布局可能长这样"，**本机不存在是正当的**，
 * 与 `HASH_ALLOWLIST` 同形（跨仓/外部引用的显式留档，而非静默放过）。
 *
 * - `C:\cygwin64` / `C:\cygwin`：`adr/0001` 列举候选 shell 位置时的**反例**
 *   （本机是 MSYS2 不是 Cygwin）。
 * - `C:\x`：`adr/0003` 讲 WSL 跨 VM 路径映射的**示意**（`C:\x → /mnt/c/x`）。
 *
 * 每条都带出处理由；新增条目必须同样说明"为什么它本该不存在"。
 */
export const PATH_ALLOWLIST = new Set(["C:\\cygwin64", "C:\\cygwin", "C:\\x"]);

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
  it("裸 spec 文件名只认 `[\\w*-]+.spec.ts`；占位符与模式形态不进面（#94）", () => {
    // 票面 AC2：`tests/<base>.spec.ts` / `*.spec.ts` / `xxx.spec.ts` 是**模式**不是具体文件名，
    // 必须明确排除，否则文档里每写一次"新脚本请配对 xxx.spec.ts"都会假红。
    //
    // ⚠️ 用例名里的字符类是 `[\w*-]+`（**含星号**），不是票面字面的 `[\w-]+` ——
    // 因为提取器刻意放宽收星号，好让"排除 `*.spec.ts`"有真判据可依（human 2026-10-18 拍 Q1）；
    // 名字写窄了会与实际实现不符（Standards 轴复核发现 S1）。
    for (const line of [
      "- 配对 `tests/<base>.spec.ts`",
      "- 收集口径 `tests/**/*.spec.ts` 无需登记",
      "- `tests/*.spec.ts` 用 vitest 按位置收集",
      "- 裸写 xxx.spec.ts 的陈旧指针",
      "- 非 *.spec.ts",
    ]) {
      expect(bareSpecRefsIn([line]), `占位符/模式行 ${JSON.stringify(line)} 不该进面`).toEqual([]);
    }
    // ⚠️ **上面五行里带 `tests/` 前缀的，靠的是左边界（前缀）而非占位符规则** ——
    // 只喂原文证明不了 `isSpecPlaceholder` 有牙齿。故这里**再喂去前缀的裸形态**，
    // 把两个机制分离：这些串没有前缀可言，唯一能挡住它们的就是占位符判据本身。
    // （复核发现 S1 的实质：不加这段，占位符规则的覆盖就是**未证明**的。）
    for (const bare of ["<base>.spec.ts", "*.spec.ts", "**/*.spec.ts", "x.spec.ts", "xx.spec.ts", "xxx.spec.ts"]) {
      expect(bareSpecRefsIn([`配对 ${bare}`]), `裸形态 ${JSON.stringify(bare)} 该被占位符判据挡住`).toEqual([]);
    }
    // 对照：真文件名照旧进面（判据没把裸文件名一起误伤）。
    expect(bareSpecRefsIn(["- 见 detect.spec.ts 与 doc-references.spec.ts"])).toEqual([
      "detect.spec.ts",
      "doc-references.spec.ts",
    ]);
    // 对照 2：**只是名字里含 `xxx` 子串**的真文件名照旧进面 —— 占位符判据锚的是整段基名，
    // 不是子串，否则"名字里含那串字母的真文件名"会被**假绿**放过（收紧边界的反例）。
    for (const real of ["abcxxx.spec.ts", "xxx-helper.spec.ts", "x-ray.spec.ts"]) {
      expect(bareSpecRefsIn([`曾指 ${real}`]), `${real} 是真文件名，不该被当占位符放过`).toEqual([real]);
    }
    // 对照 3：**含 `*` 的形态一律出豁免面**（不只基名恰为 `*` 的那种）。
    // ⚠️ 这是**有意保留**的宽口径，代价是前瞻性假绿 —— 取舍与理由见 `isSpecPlaceholder` 头注。
    // 锁住它，是为了让日后"顺手收窄"的人看见这里有一条**判断过的**决定，而不是遗漏。
    for (const pattern of ["*.spec.ts", "pty-*.spec.ts", "**/*.spec.ts", "a*b.spec.ts"]) {
      expect(bareSpecRefsIn([`模式 ${pattern}`]), `${pattern} 含通配符，该出豁免面`).toEqual([]);
    }
    // 对照 4：`x+` 占位符族**大小写不敏感**（两轴复核发现 c3）。
    // 不折叠时 `X.spec.ts` 会进面 ⇒ **假红**（它是小写形态的大小写变体）。
    for (const pattern of ["x.spec.ts", "X.spec.ts", "XX.spec.ts", "XXX.spec.ts", "Xx.spec.ts"]) {
      expect(bareSpecRefsIn([`配对 ${pattern}`]), `${pattern} 是同一占位符族，该出豁免面`).toEqual([]);
    }
  });

  it("裸 spec 文件名的右边界：`.spec.ts` 后面还有东西就不是它（#94 复核发现 c2）", () => {
    // 实测洞：没有右边界时，spec 文件名后面再跟 `.bak` 之类的后缀会被**截断**成前半段 ——
    // 把**别的文件**当成本文件判，可能把真断链错认成"存在"（假绿）。
    for (const [text, expected] of [
      ["曾指 descriptor.spec.ts", ["descriptor.spec.ts"]],
      ["曾指 descriptor.spec.tsx", []],
      ["曾指 descriptor.spec.ts.bak", []],
      ["曾指 a.spec.ts.map", []],
    ] as const) {
      expect(bareSpecRefsIn([text]), `右边界：${JSON.stringify(text)}`).toEqual([...expected]);
    }
  });

  it("裸 spec 文件名不因 `tests/` 前缀而重复进面（那是既有判据的面，#94）", () => {
    // 带 `tests/` 前缀的写法已被第 1 条断言（仓内路径存在性）覆盖，本判据**不重复**收它，
    // 否则同一个引用会有两条断言各自报错、点名口径也会打架。
    expect(bareSpecRefsIn(["见 tests/detect.spec.ts"])).toEqual([]);
    // 但**裸写**（无前缀）的已删文件名仍要被抓——这正是票面标本的形态。
    expect(bareSpecRefsIn(["曾指向 descriptor.spec.ts"])).toEqual(["descriptor.spec.ts"]);
  });

  it("豁免标记对裸 spec 文件名族同样生效（#94 AC3）", () => {
    // 票面 AC3「历史性提及可豁免（沿用既有 `[History: …]`）」。
    // 活体正例：`tests/patch-shape.spec.ts` 的 `[History: `c74b2d5`]` 注释块里正提到
    // 已删的那个 detector spec —— 那是**正当历史叙述**，不能判红。
    // `.ts` 的豁免粒度是**注释整块**（`commentBlocks`），故标记在注释里任一处即整块出豁免面。
    const marked = "// 曾与 descriptor.spec.ts 一起消失（[History: `c74b2d5`]）";
    const bare = "// 曾与 descriptor.spec.ts 一起消失";
    expect(bareSpecRefsIn(commentBlocks(marked))).toEqual([]);
    // 对照：同一句话去掉标记 ⇒ 照常进面（判据本身有效，不是"抓不到裸文件名"）。
    expect(bareSpecRefsIn(commentBlocks(bare))).toEqual(["descriptor.spec.ts"]);
  });

  it("合成断链真的判红：裸 spec 文件名在 tests/ 下找不到即点名（#94）", () => {
    // AC1 的「变红并点名」在合成层的证据（不只活体那一处）。
    const missingIn = (block: string) =>
      bareSpecRefsIn([block])
        .filter((name) => !existsSync(join(repoRoot, "tests", name)))
        .filter((name) => !BARE_SPEC_ALLOWLIST.has(name));
    expect(missingIn("曾指向 descriptor.spec.ts")).toEqual(["descriptor.spec.ts"]);
    // 对照：现存文件名绿（`detect.spec.ts` 真在 tests/ 下）。
    expect(missingIn("见 detect.spec.ts")).toEqual([]);
  });

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

  it("绝对路径只认盘符形态；URL 与 UNC 不误报（#93）", () => {
    // 票面 AC3 的显式边界：`C:\…` / `C:/…` 进面，URL 与 UNC 不进面。
    const block = [
      "- 本机布局见 `C:\\msys64\\usr\\bin\\bash.exe`",
      "- 也可以写 `C:/msys64/usr/bin/bash.exe`",
      "- 上游见 https://example.invalid/C:/fake/path.exe",
      "- UNC 见 `\\\\server\\share\\x`",
    ].join("\n");
    expect(absPathRefsIn([block])).toEqual([
      "C:\\msys64\\usr\\bin\\bash.exe",
      "C:/msys64/usr/bin/bash.exe",
    ]);
  });

  it("绝对路径里的占位符形态不进面（#93）", () => {
    // 占位符（`<…>` / `…` / `%VAR%`）的目标在本机**不存在是正当的** ——
    // 它们是"该怎么写"的示例，不是"本机哪里"的断言；进面就是假红。
    for (const line of [
      "- 家目录 `C:\\Users\\<user>`",
      "- 形态坑：必须是 Windows 形态 `C:/…`",
      "- 旧布局 `<old-work>\\deepseek-harness`",
      "- 环境变量 `%USERPROFILE%\\.dsh`",
      "- 检出 `<盘符>:\\Work`",
    ]) {
      expect(absPathRefsIn([line]), `占位符行 ${JSON.stringify(line)} 不该进面`).toEqual([]);
    }
    // 对照：**真用户名**（非通用账户名）照旧进面（词表只豁免通用账户名，不豁免一切家目录）。
    // ⚠️ 这里**必须**用非真名的替身：写本机用户名会当场被 `scripts/privacy-scan.mjs` 抓红
    // （PUBLIC 仓硬约束，本仓实测踩到过）。`realuser` 不在 `ALLOWED_USERS` 里，语义自明。
    expect(absPathRefsIn(["- 家目录 `C:\\Users\\realuser`"])).toEqual(["C:\\Users\\realuser"]);
  });

  it("波浪号路径只取 `~/…` 形态；`~user` 与行内 `~` 不误报（#93）", () => {
    const block = [
      "- 宿主树 `~/dsh-host-src` 与 `~/.dsh/profiles/desktop`",
      "- 波浪号后无斜杠 `~dsh` 不算路径",
      "- 句中 `~` 只是约等于",
    ].join("\n");
    expect(tildeRefsIn([block])).toEqual(["~/dsh-host-src", "~/.dsh/profiles/desktop"]);
  });

  it("路径里的空格与引号边界不能截断目标（#93 实测假红）", () => {
    // 实测踩到：`'C:/Program Files/nodejs/node.exe'` 若在空白处截断会得到 `C:/Program`
    // —— 本机不存在 ⇒ **假红**。空格是路径的一部分，引号才是边界。
    expect(absPathRefsIn(["- `C:/Program Files/nodejs/node.exe`"])).toEqual([
      "C:/Program Files/nodejs/node.exe",
    ]);
    expect(absPathRefsIn(["node = 'C:/Program Files/nodejs/node.exe'"])).toEqual([
      "C:/Program Files/nodejs/node.exe",
    ]);
    // 反引号仍然终止路径（它才是真的边界）。
    expect(absPathRefsIn(["- `C:/a/b` 与 `C:/c/d`"])).toEqual(["C:/a/b", "C:/c/d"]);
  });

  it("通用账户名形态的家目录也是占位符（复用 privacy-scan 词表，#93 实测假红）", () => {
    // README.md:160 既有 `C:\Users\me` —— 本机不存在，但 AGENTS.md 明令个人路径就该
    // 这样脱敏写；判红等于要求文档写真名，方向反了。
    expect(absPathRefsIn(["- 既接受 `C:\\Users\\me` 也接受 `/mnt/c/Users/me`"])).toEqual([]);
    expect(absPathRefsIn(["- 汇总挂具 `C:/Users/x/AppData`"])).toEqual([]);
    // 对照：**真用户名**照旧进面（词表只豁免通用账户名，不豁免一切家目录）。
    expect(absPathRefsIn(["- `C:\\Users\\realuser`"])).toEqual(["C:\\Users\\realuser"]);
    // 对照 2：无占位符、但**本机存在**的真实家目录形态照常进面。
    expect(absPathRefsIn(["- `C:/Windows/Temp`"])).toEqual(["C:/Windows/Temp"]);
  });

  it("豁免标记所在行对绝对路径族同样生效（#93 AC2 的形态）", () => {
    // GLOSSARY.md:12 的 `<old-work>\deepseek-harness` 是**正当历史叙述**，
    // 加 `[History: …]` 后整行出豁免面 —— 与 #78 的既有约定同一条 `HISTORICAL`。
    const live = "- 原政策为从本地源码库 `<old-work>\\deepseek-harness` 解析";
    expect(absPathRefsIn([live])).toEqual([]); // 占位符已令其出豁免面
    // 而**无占位符**的历史路径必须靠标记豁免，否则真红。
    const legacy = "- 原政策为从本地源码库 `D:\\old-work\\deepseek-harness` 解析";
    expect(absPathRefsIn([legacy])).toEqual(["D:\\old-work\\deepseek-harness"]);
  });

  it("存在性判定不因大小写与斜杠形态假红（#93 AC4，实测锁住）", () => {
    // 票面 AC4 明写「不因大小写 / `/` 与 `\` 的等价写法假红」。这是**文件系统性质**，
    // 不是本判据的代码 —— 故必须**实测锁住**，否则日后有人"顺手"加一层归一化
    // （或改判成字符串比较）就会把它破坏掉而无人察觉。
    // 实测：Windows 上四形态全部 EXISTS。
    for (const p of [
      "C:\\Windows\\Temp",
      "C:/Windows/Temp",
      "C:\\WINDOWS\\TEMP",
      "c:\\windows\\temp",
    ]) {
      expect(existsSync(p), `${JSON.stringify(p)} 应当存在（大小写/斜杠不敏感）`).toBe(true);
    }
    // 对照：这些形态**都进面**（判据不因形态差异把人挡在外面）。
    expect(absPathRefsIn(["- `C:\\WINDOWS\\TEMP`"])).toEqual(["C:\\WINDOWS\\TEMP"]);
    expect(absPathRefsIn(["- `c:/windows/temp`"])).toEqual(["c:/windows/temp"]);
    // 对照 2：真不存在的大小写变体仍会被判红（不是"大小写一律豁免"）。
    expect(absPathRefsIn(["- `C:\\WINDOWS\\NOPE-93`"])).toEqual(["C:\\WINDOWS\\NOPE-93"]);
  });

  it("URL 的 scheme 判据要真判 scheme，不能靠盘符形态的巧合（#93 实测假绿）", () => {
    // 实测：`s://x` 与 `x://y` 与盘符形态**完全同形**，只靠「盘符后必须是分隔符」
    // 排不掉它们 —— 之前那条 `https://…` 用例是"通过得理由不对"（真挡住它的是
    // `https:` 里 `s` 前紧邻 `p` 触发的否定环视）。故显式判 scheme 并锁住反例。
    for (const s of ["s://x", "x://y", "a://b/C:/d", "see s://server/share"]) {
      expect(absPathRefsIn([s]), `${JSON.stringify(s)} 是 URL，不该进面`).toEqual([]);
    }
    // 对照：真盘符照旧进面（判据没有把盘符族一起误伤）。
    expect(absPathRefsIn(["- `C:/Windows/Temp`"])).toEqual(["C:/Windows/Temp"]);
  });

  it("光杆盘符根（`C:\\`）进不了面：它没有可判存在性的目标（#93 实测）", () => {
    // 实测：`docs/adr/0013-tools-only-plugin.md:62` 的光杆 `` `C:\` `` 会匹配成功，
    // 而 `existsSync("C:\\") === true` ⇒ **纯靠侥幸不红**。根目录不是"引用目标"。
    for (const s of ["(hardcoded `C:\\` somewhere)", "prefix `C:\\` here", "- `C:/` 根"]) {
      expect(absPathRefsIn([s]), `${JSON.stringify(s)} 的光杆根不该进面`).toEqual([]);
    }
    // 对照：同一行里带路径的引用照旧进面。
    expect(absPathRefsIn(["- `C:\\` 与 `C:\\Windows\\Temp`"])).toEqual(["C:\\Windows\\Temp"]);
  });

  it("node_modules 边界大小写不敏感（#93 AC3 的边界，实测有洞）", () => {
    // 实测洞：精确小写比较会让 `C:\NODE_MODULES\x` / `C:/a/Node_Modules/b` 漏网。
    // Windows 文件系统本就大小写不敏感，同一份实现不该一处折叠一处不折叠。
    for (const s of ["C:\\node_modules\\x", "C:\\NODE_MODULES\\x", "C:/a/Node_Modules/b"]) {
      expect(absPathRefsIn([`- \`${s}\``]), `${JSON.stringify(s)} 在 node_modules 内，不该进面`).toEqual([]);
    }
    // 对照：只是名字里含 node_modules 的普通目录照旧进面。
    expect(absPathRefsIn(["- `C:\\my-node_modules\\x`"])).toEqual(["C:\\my-node_modules\\x"]);
  });

  it("波浪号提取不吞命令与参数（#93 实测）", () => {
    // 实测：`~/dsh-host-src grep -c foo` 会被旧写法整串吞下 ——
    // 波浪号族一旦接上存在性判定，这些串就是假红。段里本就不该有空格。
    expect(tildeRefsIn(["cd ~/dsh-host-src grep -c foo"])).toEqual(["~/dsh-host-src"]);
    expect(tildeRefsIn(["- 在 `~/dsh-shellhost-src` 里跑 `git fetch --prune origin`"])).toEqual([
      "~/dsh-shellhost-src",
    ]);
    // 对照：正常的深路径照旧完整取到。
    expect(tildeRefsIn(["- `~/.dsh/profiles/desktop` 与 `~/dsh-host-src`"])).toEqual([
      "~/.dsh/profiles/desktop",
      "~/dsh-host-src",
    ]);
  });

  it("豁免标记会连整行的绝对路径一起放过——这是它有意的语义（#93 AC1/AC2 的分歧）", () => {
    // ⚠️ 本票实测踩到的**结构性张力**，必须写清楚（human 2026-10-18 拍"写清楚"）：
    //
    // `blocksOf()` 的豁免粒度是**整行**（`.md` 逐行过滤），而票面 AC2 要求给
    // `GLOSSARY.md:12` 加 `[History: …]` —— 票面 AC1 点名的标本**正好落在那一行上**。
    // 两条 AC 在同一行上**互相抵消**：加了豁免，那条死路径就再也抓不到了。
    //
    // 实测 A/B（`.scratch/t93-mut2.log`）：同一条 `D:\old-work\deepseek-harness`，
    // 在带标记的行上探针**绿（漏报）**，在不带标记的行上探针**红并点名**。
    // ⇒ 故本票的变异验证改用**非豁免行**做载体，并把这条分歧写进落地文档。
    //
    // 这个用例锁住的就是"整行豁免"这个语义本身 —— 免得日后有人以为它是 bug 而改窄，
    // 改窄会影响 #78 / #112 的既有豁免行为（那是跨票判据变更，得单独立票）。
    const marked = "历史：原路径 `D:\\old-work-93\\deepseek-harness` [History: 旧布局，已废止]";
    const bare = "现路径 `D:\\old-work-93\\deepseek-harness`";
    // 带标记 ⇒ 整行出豁免面（即使里面有真实存在的死路径）。
    expect(absPathRefsIn(blocksOfLine(marked))).toEqual([]);
    // 不带标记 ⇒ 照常进面（判据本身是有效的，不是"抓不到盘符路径"）。
    expect(absPathRefsIn(blocksOfLine(bare))).toEqual(["D:\\old-work-93\\deepseek-harness"]);
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

describe("代码围栏配对检查器自身的边界（合成文本，#126）", () => {
  it("奇数围栏是真的不平衡：合成档必须点名未闭合的开栏行", () => {
    // 本票的主诉：奇数个围栏会把其后正文整段吞进代码块，而套件全绿。
    // 制造形态：开栏后正文没有闭栏。
    const lines = ["# 标题", "正文", "```bash", "echo hi", "这段正文会被吞进代码块"];
    expect(unclosedFencesOf(lines)).toEqual([3]);
    // 对照：补上闭栏即配平（判据不是"见到围栏就报"）。
    expect(unclosedFencesOf([...lines, "```"])).toEqual([]);
  });

  it("正常单层围栏配平（票面 AC2 的绿例）", () => {
    expect(unclosedFencesOf(["```ts", "const a = 1;", "```"])).toEqual([]);
    // 多块文档同样配平。
    expect(
      unclosedFencesOf(["```bash", "ls", "```", "中间正文", "```json", "{}", "```"]),
    ).toEqual([]);
    // 波浪号围栏按同一规则配平。
    expect(unclosedFencesOf(["~~~yaml", "a: 1", "~~~"])).toEqual([]);
  });

  it("四反引号包三反引号（嵌套）判绿 —— 数偶数会在这里翻车（票面 AC2 的关键反例）", () => {
    // 票面 `#112` 的 Possible directions 明确警告：嵌套围栏**不能靠数偶数**。
    // 这段在 CommonMark 下是**一个**围栏块（外层 4 个反引号包住内层 3 个）。
    const nested = ["````markdown", "```ts", "code", "```", "````"];
    expect(unclosedFencesOf(nested)).toEqual([]);
    // 而朴素计数（数所有"看起来像围栏"的行）在这段上给出的是**别的**结论 ——
    // 锁住它，免得日后有人用"个数"替换状态机。
    const naiveCount = nested.filter((l) => /^\s{0,3}[`~]{3,}/u.test(l)).length;
    expect(naiveCount, "嵌套档里像围栏的行确实有 4 条 —— 状态机才是判据").toBe(4);
    // 若把内层 3 反引号误当闭栏，剩下的 4 反引号会变成"未闭合开栏" ⇒ 假红。
    // 反向锁：真的不平衡的嵌套档仍要报（状态机没有把嵌套一律放过）。
    expect(unclosedFencesOf(["````markdown", "```ts", "code", "```"])).toEqual([1]);
  });

  it("闭栏必须不短于开栏、且行内无其他内容（票面状态机的两条硬条件）", () => {
    // 闭栏短于开栏 ⇒ **不是**闭栏，只是围栏内的内容 ⇒ 该档不平衡。
    // （这正是 [` ```` `, "```", "````"] 的反例形态：中间那行挡不住任何东西。）
    expect(unclosedFencesOf(["````", "```", "````"])).toEqual([]);
    expect(unclosedFencesOf(["````", "```"])).toEqual([1]);
    // 闭栏带 info string / 尾随非空白 ⇒ 不是闭栏（info string 只在开栏行）。
    expect(unclosedFencesOf(["```ts", "code", "```ts"])).toEqual([1]);
    expect(unclosedFencesOf(["```", "code", "``` more"])).toEqual([1]);
    // 对照：闭栏**允许**尾随空白（CommonMark）。
    expect(unclosedFencesOf(["```", "code", "```   "])).toEqual([]);
  });

  it("CRLF 档不该假报未闭合（#126 真实缺陷：pre-push 的 msys 车道暴露）", () => {
    // ⚠️ 这是本票**真实发生过**的缺陷，不是假想用例 —— 记在下以免日后被"简化"掉。
    //
    // 机理：`blocksOf` 走 `text.split("\n")` ⇒ CRLF 档每行带尾随 `\r`；
    // 闭栏判据 `[ \t]*$` **不收** `\r`，而开栏判据以 `(.*)$` 收尾（`.` 吃得下 `\r`）
    // ⇒ 开栏匹配、闭栏不匹配 ⇒ **假报未闭合**。
    // 实测：权威树是 LF、msys 副本被 core.autocrlf 转 CRLF，同一份档案在这两棵树里
    // 判定结果不同（`.scratch/t126-crlf.log`）。
    //
    // 故这里把**两种行尾**喂给同一套判据，要求结论**一致** —— 判据的对象是文档语义，
    // 行尾形态是检出配置的产物，不该影响判定。
    const lf = ["```bash", "echo hi", "```"].join("\n");
    const crlf = ["```bash", "echo hi", "```"].join("\r\n");
    // 归一化后（`fenceGapsIn` 的做法）两者都必须判绿。
    const normalize = (text: string) => text.split("\n").map((line) => line.replace(/\r$/u, ""));
    expect(unclosedFencesOf(normalize(lf))).toEqual([]);
    expect(unclosedFencesOf(normalize(crlf))).toEqual([]);
    // 未归一化时 CRLF 会**真的**假报（锁住机理本身，证明上面那条不是同义反复）。
    // ⚠️ 报的行号是 **3**（末行），**不是** 1 —— 实测（`.scratch/t126-crlf2.log`）：
    // CRLF 下第 1 行的开栏**匹配不上**（`$` 收不下尾随 `\r`），而 `split("\n")` 的必然
    // 结果是**末行不带 `\r`** ⇒ 末行被当成开栏且找不到闭栏 ⇒ 报"第 3 行未闭合"。
    // 这正是"虚假的红"的形状：**真开栏没认出来，末行反被认成开栏**。
    expect(unclosedFencesOf(crlf.split("\n")), "不归一化时 CRLF 会假报末行未闭合").toEqual([3]);
    // 对照：CRLF 下的**真不平衡**照旧要报（归一化没有把判据弄哑）。
    expect(unclosedFencesOf(normalize(["```bash", "echo hi"].join("\r\n")))).toEqual([1]);
  });

  it("缩进与反引号 info string 的两条边界（#126 实测假红）", () => {
    // 开栏允许 ≤3 空格缩进；4 空格是**缩进代码块**，不是围栏。
    expect(unclosedFencesOf(["   ```ts", "code", "   ```"])).toEqual([]);
    expect(unclosedFencesOf(["    ```ts", "code"])).toEqual([]);
    // ⚠️ 反引号开栏的 info string **不得含反引号**（CommonMark）——
    // 少了这条，文档里的行内代码 `` ```a`b `` 会**误开栏**，把它后面的正文吞掉 ⇒ 假红。
    expect(unclosedFencesOf(["```a`b", "正文不该被判成围栏内"])).toEqual([]);
    // 对照：波浪号围栏**没有**这条限制（info string 可含反引号）。
    expect(unclosedFencesOf(["~~~a`b", "正文"])).toEqual([1]);
  });

  it("闭栏的缩进上限是 3 空格、且**不必与开栏的缩进匹配**（#126 复核争点，按一手规格裁定）", () => {
    // ⚠️ **这是一条被复核者质疑过、并按 CommonMark 一手规格裁定过的语义** —— 详见本用例末注。
    //
    // 规格原文（`commonmark/commonmark-spec` spec.txt §"Fenced code blocks"，v0.31.2）：
    //   「The closing code fence may be preceded by up to three spaces of
    //     indentation, and may be followed only by spaces or tabs, which are ignored.」
    //   并配一条**参考例**（逐字）：
    //     「Closing fences may be preceded by up to three spaces of indentation, and
    //       their indentation need not match that of the opening fence:」
    //       开栏 0 缩进 + 闭合 `  ``` `（**2 空格**）⇒ 规格给出的输出是**已闭合**。
    //
    // ⇒ 故闭栏的正则里**必须**有 `( {0,3})` 缩进组（与开栏同口径），
    //   且**不**要求缩进相等（`0 缩进开栏 + 2 空格闭栏` 是合法配对）。
    expect(unclosedFencesOf(["```", "aaa", "  ```"]), "2 空格缩进的闭栏是合法闭栏（规格参考例）").toEqual([]);
    expect(unclosedFencesOf(["```", "aaa", "```"]), "0 缩进闭栏同样合法").toEqual([]);
    expect(unclosedFencesOf(["   ```", "aaa", " ```"]), "缩进不必与开栏匹配").toEqual([]);
    // 边界：**4 空格**缩进的行不是闭栏（规格明写 up to three）。
    // ⚠️ 注意规格里那条「Four spaces of indentation is too many」讲的是**开栏**被 4 空格缩进
    //    ⇒ 那是**缩进代码块**，不是围栏；它**不**为"闭栏能否 4 空格"提供依据。
    //    本行的判据来自上面那句 up to three spaces 的**字面**。
    expect(unclosedFencesOf(["```", "aaa", "    ```"])).toEqual([1]);
    expect(unclosedFencesOf(["    ```", "aaa"])).toEqual([]); // 4 空格开栏本就不是围栏
    // 对照：闭栏的**长度**下限与"行内无他物"两条照旧（别被缩进这条挤掉）。
    expect(unclosedFencesOf(["````", "aaa", "```"])).toEqual([1]);
    expect(unclosedFencesOf(["```", "aaa", "``` x"])).toEqual([1]);
  });

  it("围栏检查同样受 `[History: …]` 整行豁免（与 #112 共用 blocksOf 的语义）", () => {
    // AC4 要求与 #112 的链接判据共用 blocksOf 文本块面 —— 于是行级豁免在这里的语义是
    // "该行免受围栏配对判定"。免疫行被移出扫描面后，其后的围栏按剩下的行重新配对。
    const withMarker = ["[History: 旧例]```bash", "echo hi"];
    // 带标记那行被过滤掉 ⇒ 剩下的正文里没有开栏 ⇒ 配平。
    expect(unclosedFencesOf(blocksOfLine(withMarker.join("\n")))).toEqual([]);
    // 对照：同两行去掉标记 ⇒ 第一行是开栏且无闭栏 ⇒ 报第 1 行（证明判据本身有效）。
    expect(unclosedFencesOf(blocksOfLine(["```bash", "echo hi"].join("\n")))).toEqual([1]);
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

  it("docs/** 与根文档里的外部绝对路径在本机存在（#93）", () => {
    // 扫描面与 #112 一致（docs 全文 + 根文档），但判定面是**本机文件系统**：
    // 票面记的两条死指针结构上都在旧判据的扫描面外，只能靠这条守。
    //
    // ⚠️ **覆盖边界的诚实声明**（别把这条读成"票面点名的标本已被守住"）：
    // 票面 AC1 点名的标本 `<old-work>\deepseek-harness` 是**占位符形态** —— 按 AC3 的
    // 口径它本就该出豁免面（否则文档里每一条 `C:\Users\<user>` 都会假红）。而它所在的
    // `GLOSSARY.md:12` 又被 AC2 要求加了 `[History: …]`（整行豁免）⇒ **那一行的死路径
    // 抓不到，是两条 AC 相互抵消的结果，不是判据失效**。判据本身有效：换成非豁免行，
    // 同一条死路径会被红并点名（实测 `.scratch/t93-mut2.log`）。
    // 故本票的变异验证载体 = **非豁免行**；详见模块头注的「AC1 与 AC2 的结构性分歧」。
    const files = [...walk("docs", [".md"]), ...ROOT_DOCS];
    const missing = files.flatMap((rel) =>
      absPathRefsIn(blocksOf(rel))
        .filter((target) => !PATH_ALLOWLIST.has(target))
        .filter((target) => !existsSync(target))
        .map((target) => `${rel} -> ${target}`),
    );
    expect(
      missing,
      "文档引用了本机不存在的绝对路径：修正路径、在同一条注释/该行标 [History: …]，" +
        "或（确属「别的机器长这样」的举例）登记进 PATH_ALLOWLIST 并写明理由",
    ).toEqual([]);
  });

  it("注释 / 文档里裸写的 spec 文件名都能在 tests/ 下找到同名（#94）", () => {
    // 扫描面与 #112 / #93 一致（同族守卫同面）：src + tests + scripts + docs（除 adr）
    // + 根文档 + vitest.config.ts。
    //
    // 为什么这条存在：带前缀的写法（`tests/` + 文件名）由第 1 条断言守，
    // 而**裸写**的（无前缀）结构上落在它的面外 —— 票面标本
    // （`tests/detect.spec.ts` 头注曾指已删的那个 detector spec）正是这样漏掉的。
    const files = [
      ...walk("src", [".ts", ".tsx"]),
      ...walk("tests", [".ts"]),
      ...walk("scripts", [".mjs"]),
      // docs/adr/** 是决定记录，整体排除（与 #112 / #93 同口径）
      ...walk("docs", [".md"]).filter((p) => !p.startsWith("docs/adr/")),
      "vitest.config.ts",
      ...ROOT_DOCS,
    ];
    const missing = files.flatMap((rel) =>
      bareSpecRefsIn(blocksOf(rel))
        .filter((name) => !BARE_SPEC_ALLOWLIST.has(name))
        .filter((name) => !existsSync(join(repoRoot, "tests", name)))
        .map((name) => `${rel} -> ${name}`),
    );
    expect(
      missing,
      "注释 / 文档里裸写的 spec 文件名在 tests/ 下不存在：" +
        "修正文件名、写全 `tests/…` 前缀、在同一条注释/该行标 [History: …]，" +
        "或（确属跨仓引用）登记进 BARE_SPEC_ALLOWLIST 并写明理由",
    ).toEqual([]);
  });

  it("docs/**/*.md 的代码围栏都配对（#126）", () => {
    // 本票主诉：奇数个围栏会把其后正文**整段吞进代码块**（渲染错乱），而 `node --run test`
    // 全绿 —— #108 文档审计实测到过。判据 = CommonMark 围栏状态机（见 `unclosedFencesOf` 头注）。
    //
    // **扫描面与第 4/5/6 条不同**：这里取票面 `#126` 的 `docs/**` **字面（含 `adr/`）**，
    // 而第 4/5/6 条排除 `docs/adr/`（"决定记录，按惯例不回头改"）。human 2026-10-18 拍板
    // 取字面；取舍与代价见 `unclosedFencesOf` 头注「扫描面的取舍」。
    //
    // ⚠️ 本判据与第 4 条**共用 `blocksOf`**（AC4）⇒ 也吃 `[History: …]` 的**整行豁免**：
    // 带标记的行会被移出扫描面，故它**不再参与围栏配对**。这是有意的共用语义（AC4 明写），
    // 代价是"给一行加标记"可能顺带改变围栏配对结果 —— 合成用例已锁住该语义。
    const files = walk("docs", [".md"]);
    const unbalanced = files.flatMap((rel) =>
      fenceGapsIn(rel).map((line) => `${rel}:${line}（该开栏没有闭栏）`),
    );
    expect(
      unbalanced,
      "docs 下的 markdown 有未闭合的代码围栏：奇数个围栏会把其后正文吞进代码块（渲染错乱但套件全绿）；" +
        "补上闭栏（同字符、长度 ≥ 开栏、行内只有空白）",
    ).toEqual([]);
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
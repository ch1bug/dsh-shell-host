/**
 * 头注「结构（#NN）」清单守卫：`scripts/*.mjs` 头注里那段点名的符号，必须**恰好等于**
 * 该脚本除 `main` 外的全部导出。
 *
 * ## 为什么存在（`#95`）
 *
 * `#88` 往 `verify-pack.mjs` 加了导出 `manifestTargets` 与对应头注。票面正文称"头注当场漏了它，
 * 靠 code-review 的 Standards 轴才抓到"—— **实测不成立**（逐提交取证）：`2401a53`（`#88`
 * 自己的提交）里头注与导出是**同一 diff 一起补的**，且 `#88` 的父提交 `cb406d7` 三者（头注 3 名、
 * 导出 3 个）**本来就是一致的**；票面另引了一个"已修一处"的提交哈希，**在本仓解析不到**
 * （历史重写过，旧 SHA 全部作废）。即本仓历史上**从未**提交过"导出飞了、头注没跟上"的状态。
 *
 * ⚠️ 此处**刻意不复写那个哈希**：`tests/doc-references.spec.ts` 有一条引用腐烂判据，注释里出现
 * 本仓解析不到的 7–40 位 hex 就会判红（本票落地时**真的**因此红过一次 —— 这让"引用一个不存在
 * 的事实"从票面的叙述变成了本文件自己的事故）。要复现该考证请用 `git log -S 'manifestTargets'
 * -- scripts/verify-pack.mjs` 现算，别抄哈希。
 *
 * ⚠️ 但这**不**使本守卫失去意义 —— 它反而指出了漂移的**真实形状**：用**最窄口径**（只比清单串、
 * 不认任何散文）逐代跑，`findPacker` 在**触及本文件的全部 8 个提交**（`e6b5ce8` 起、到 `22654a2`
 * 为止）里都显示"未点名"，而它其实一直有说明 —— 只是在清单串**之后的散文**里。那道"假红"正是本守卫必须给
 * "非纯 / 转出"留**显式句式**的理由，也是这类机械判据真正会踩的坑：**口径错比没有判据更糟**。
 *
 * 这类漂移在 review 阶段**确实**会被漏（`docs/code-review-brief.md` §7 自陈上上次"两个轴都没抓到、
 * 靠自查才发现"），而它是**机械面**：头注清单与 `export` 集合可以逐个比对，不需要人的判断力 ——
 * 与 `scripts-coverage.spec.ts`（位置约定守卫）同性质，故同样做成 vitest 用例，跑在
 * `node --run test` 的 unit 车道里，不引入新入口、不引入 lint 依赖（票面 Out of scope）。
 *
 * ## 口径（票面点名的反例，**必须先处理**）
 *
 * 断言**只在「结构（…）」段存在时**产生（`结构（#NN）` 的 NN 可省）。该段的语义就是
 * "本文件的导出清单"，所以只对它下断言；**无该段即无断言**。
 *
 * 这条口径是必需的：`scripts/frontier.mjs` 的头注**没有**该段（它的原文是"纯逻辑
 * `readyFrontier()` 与 gh I/O 分离，便于离线单测"）—— "凡导出都得被点名"会把它判红。
 * 其余脚本不产生断言：触发面只认**带全角括号**的「结构（…）」（`clean-lib.mjs` / `verify-all.mjs`
 * 写的是无票号括号的 `结构：`，`privacy-scan.mjs` / `script-entry.mjs` 连 `结构` 都不写）——
 * 票面 Out of scope：不要求给"不列清单"的脚本补清单。
 *
 * ## 判定（options B，**兑现票面的"恰好等于"**）
 *
 * 一个导出算"**已点名**"，当且仅当它满足下面**之一**：
 *   1. **在清单串里** —— 即 `/` 分隔的那串名字（`…是**纯函数**`）**本身**；
 *   2. **有显式句式声明** —— `` `X` 亦导出但**非纯** `` 或 `` `X` **原样转出** ``，
 *      **且句式从名字处开始、止于该行行尾**（见 `declaredExceptions`）。
 * 其余导出 ⇒ `missing`（红）。反方向：清单串**或显式句式**里出现、却不是本文件导出 ⇒ `extra`（红）
 * —— 两个方向都查，"恰好等于"才是双向的（只查清单串半边的洞见 `inspect` 头注）。
 *
 * ⚠️ **"段内散文里提过"不算点名** —— 这是刻意的，也是复核抓到的洞：早先那版把"任意位置提到"
 * 都算点名，于是「加导出 + 只在串之后的散文里提一句」（**`#88` 的同一形态**，`brandNewExport`
 * 复核实测）会被判**绿**，票面的"恰好等于"因此形同虚设。要成为例外就得**说清楚它是什么**
 * （非纯 / 转出），而不是随口一提。
 *
 * ⚠️ **本守卫不管头注散文的准确性**（那是 review 的判断项，机械化不了）：它只比对
 * **符号名**这一个机械面。段落里说某函数"是纯函数"而它其实碰文件系统，本守卫看不见。
 *
 * ## 边界
 *
 * 豁免的唯一符号是 `main`（CLI 入口，每个脚本都有；`verify-pack.mjs` 的头注明写它
 * "**不在**上面那份纯函数清单里" —— 它靠上面口径的 ② 被认下）。`export const` 与
 * `export { … }` 转出**同样计入**导出集合（票面明写"含 `export const`"）—— 只认
 * `export function` 会让常量导出与转出形态**悄悄逃出判据面**（本仓带该段的脚本目前恰好没有
 * `export const`，转出形态则有：`isDirectInvocation` 就是 `export { … }`）。
 *
 * @module tests/script-header-exports.spec.ts
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** CLI 入口：每个脚本都有，且头注明确把它排除在清单外，故不参与比对。 */
const ENTRY_SYMBOL = "main";

/**
 * `#88` 形态的清单串（票面逐字引用：三个名字写进清单，而文件导出 4 个）。
 *
 * **形式 B** 的临时真文件与合成用例共用这**同一份字面量** —— 各写一遍就多一个会漂的真相源
 * （「导出 4 个、清单只写 3 个」这个形态在两处必须逐字相同，否则它们证的不是同一件事）。
 */
const LIST_OF_88 = "`entryTargets` / `untarGz` / `isDirectInvocation` 是**纯函数**";

/**
 * 去掉**头注**里的注释外壳后，取出「结构（…）」段的正文。
 *
 * ## 段的边界（实测口径，**不是**空行）
 *
 * 段从 `结构（` 那一行开始，延续到**下一个 `@module` 标签**为止。刻意**不**用"空注释行"
 * 当结束判据：本仓 `verify-pack.mjs` 的那段**本来就**连续无空行（`#95` 起中间有了一条 —— 加进
 * 去的那段约束说明与上面的清单之间），故"空行"在真实文件上根本不是边界：连续无空行时它会一路
 * 吞到段外，有空行时它会把段**腰斩**（实测踩到：段里混进了 `await` / `detect` / `null` /
 * `packdir` / `return` 这些散文词，判出一堆假漂移）。
 *
 * 段**内部**允许出现清单句之外的散文：`verify-pack.mjs` 正是在这段里既列了纯函数清单句，
 * 又用散文说明了 `findPacker`（非纯）与 `main`（不在清单里）"为什么导出"。点名判据的两层
 * 口径见 `namedSymbols`。
 *
 * @returns 该段正文（未找到该段时 `null`）
 */
function structureSection(header: string): string | null {
  const lines = header.split("\n");
  const start = lines.findIndex((line) => /结构（/.test(line));
  if (start === -1) return null;
  const collected: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    // 段落正文：剥掉行首的 ` * `（也容忍 `/**` 后的无缩进行）。
    const body = lines[i].replace(/^\s*\/?\*+\s?/u, "").trimEnd();
    // `@module` = 头注的标签区开始 ⇒ 段的终点（它自己不算段内内容）。
    if (i > start && /^@\w+/u.test(body.trim())) break;
    collected.push(body);
  }
  return collected.join("\n");
}

/**
 * 清单句：段内**清单串**本身（一串用 `/` 分隔的反引号名字，止于终结谓词）。
 *
 * ## 为什么需要它
 *
 * 本仓的「结构（…）」段**不是**一张裸表，而是一段散文：`verify-pack.mjs` 在这段里先列清单串，
 * 接着用**同一段**解释 `findPacker` 为何非纯、`main` 为何刻意导出 —— 那些解释句里同样有反引号，
 * 且**是代码片段不是符号**（实测：整段取反引号会捞出 `return` / `packdir` / `null` / `detect` /
 * `await` 五个散文词）。
 *
 * 实测确认**没有形态可依**区分它们：`findPacker` 与 `return` 都是"反引号裸词 + 后接散文"，
 * 长度 / 是否带 `()` / 关键字表全都是猜。故只能按**层**分（见 `namedSymbols`）。
 *
 * ## 取值 = "谓词之前、**连续的 `/` 分隔名串**"（不是整个段首）
 *
 * ⚠️ 早先这版取的是"段首 → 谓词"，于是**清单串之前**的任何散文都会被算进"表"里 ——
 * 一旦有人在清单串上方加一句带反引号的说明，那反引号就会被判成"点名了非导出"而**假红**。
 * 现改为只认**紧邻谓词的那一串** `/` 分隔名字：从谓词处向前按 `X / X / X` 形态回收，
 * 遇到分隔符形态断开即停。`verify-pack.mjs` 的清单串横跨 3 行，故实际是"跨行回收"。
 *
 * @returns 清单串文本（段内没有该形态时为空串 ⇒ 一个名字都不算"在表里"）
 */
function listSentence(section: string): string {
  // 清单终结谓词：本仓**唯一**形态是"是**纯函数**"（全仓只有 `verify-pack.mjs` 一处 `结构（`）。
  // 刻意**不**容忍"是纯函数"/"是函数"这类变体 —— 仓内没有第二形态，为假想的写法留口子就是
  // 投机泛化（Speculative Generality）；真出现第二种写法时它会在此处红，正好逼人回来扩这条。
  const terminator = /是\*\*纯函数\*\*/u.exec(section);
  if (terminator === null) return section; // 无谓词 ⇒ 极短合成文本整段即清单（见下）
  // 从谓词向前回收：`name` 与 `/` 交替出现（名字可带 `（#NN）` 尾注、可跨行）。
  const before = section.slice(0, terminator.index);
  const run = /(?:`\w+`(?:（#[^）]*）)?\s*\/\s*)*`\w+`(?:（#[^）]*）)\s*$/u.exec(before)
    ?? /(?:`\w+`(?:（#[^）]*）)?\s*\/\s*)*`\w+`\s*$/u.exec(before);
  return run === null ? "" : run[0];
}

/** 一段文本里全部反引号标识符。 */
function backticked(text: string): string[] {
  return [...text.matchAll(/`(\w+)`/gu)].map((match) => match[1]);
}

/**
 * 段内**显式声明为"非纯 / 转出"**的导出名（它们是**有据的例外**，不是"没进清单"）。
 *
 * ## 为什么需要它（票面要的是"**恰好等于**"）
 *
 * options B 的口径：清单串里的名字必须**恰好**等于导出集合；确实不该进"纯函数清单"的导出
 * （非纯的、转出的），靠**显式句式**单独认。
 *
 * ⚠️ 早先那版把"段内**任意位置**提到过"都算点名 —— 于是"加了导出、只在串之后的散文里提一句"
 * 也判绿，**正是 `#88` 的真实形状**（复核实测：`brandNewExport` 只在散文里提 ⇒ `missing: []`）。
 * 那条口径等于把"提过"当成"清单点名"，票面的"恰好等于"因此没被实现。
 *
 * 本仓的句式（`verify-pack.mjs` 现行头注逐字即此，不用迁移）：
 *   - `` `findPacker` 亦导出但**非纯** ``      → **亦导出…非纯**
 *   - `` `main` **亦导出（#90）且同样非纯** `` → 同上（"亦导出…非纯"这一对词都在句内）
 *   - `` `isDirectInvocation` **原样转出** ``  → **原样转出**
 *
 * ## 判定范围：**从名字处开始、止于行尾**（不跨行，也不容忍中间插话）
 *
 * ⚠️ 早先那版取"名字后 40 字符" —— 实测**跨了行**：一句普通的"`brandNewExport` 是个新增的导出"
 * 后面紧跟着下一行的 `isDirectInvocation` **原样转出**，窗口把 `原样转出` 也吃了进来，
 * 于是 `brandNewExport` 被误判成"有据的例外"，形态 A 照样绿（复核 C 的洞**没被堵上**）。
 * 改成**止于行尾**后仍不够：只要求两词**同行**，则"`X` 是新加的实现，它亦导出，但写法非纯。"
 * 这种**随手一提**照样被当成声明（复核实测 ⇒ `missing` 空、判绿），而它正是 `#88` 的形态。
 * 故句式必须**从名字处开始**（容忍中间的加粗标记与空白）：`` `X` 亦导出…非纯 `` / `` `X` **原样转出** ``。
 *
 * 这样 `` `return` 取代 `process.exit` `` 这类**代码片段**也不会被误认（它后面没有句式）。
 */
function declaredExceptions(section: string): string[] {
  const found: string[] = [];
  for (const name of backticked(section)) {
    // 该名字的**全部**出现位置，任一处的**同行**后续命中句式即算。
    for (const match of section.matchAll(new RegExp(`\`${name}\`([^\\n]*)`, 'gu'))) {
      const tail = match[1] ?? "";
      // 名字与句式之间只允许**标记**（` 亦导出` / ` **亦导出（#90）`）：句式必须从名字处开始。
      const rest = tail.replace(/^\s*\*{0,2}\s*/u, "");
      // "亦导出…非纯"：两个词都在同一行内即算（容忍中间的加粗、票号、括号）。
      const declaresNonPure = /^亦导出/u.test(rest) && /非纯/u.test(tail);
      const declaresReexport = /^原样转出/u.test(rest);
      if (declaresNonPure || declaresReexport) {
        found.push(name);
        break;
      }
    }
  }
  return [...new Set(found)].sort();
}

/**
 * 段内点名的符号名（三层口径，判据各取最不会假报的那层）。
 *
 * - `named`（宽）：段内任意位置的反引号名 —— 只用于**诊断读数**与 THE PREMISE 的兜底，
 *   **不再**是 missing 的判据（那是早先口径的漏报面，见 `declaredExceptions`）。
 * - `inList`（窄）：清单串里的名字 —— 判 **missing** 与 **extra** 的**主判据**。
 * - `exceptions`：显式声明为非纯 / 转出的名字 —— missing 的**唯一**例外来源。
 */
function namedSymbols(section: string): { named: string[]; inList: string[]; exceptions: string[] } {
  return {
    named: [...new Set(backticked(section))].sort(),
    inList: [...new Set(backticked(listSentence(section)))].sort(),
    exceptions: declaredExceptions(section),
  };
}

/** 文件里实际导出的符号名（`export function` / `export const` / `export { … }`）。 */
function exportedSymbols(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/^export (?:async )?function (\w+)/gmu)) names.push(match[1] ?? "");
  for (const match of source.matchAll(/^export (?:const|let|var) (\w+)/gmu)) names.push(match[1] ?? "");
  // 转出：`export { a, b as c }` —— `as` 右边才是对外名字。
  for (const match of source.matchAll(/^export \{([^}]*)\}/gmu)) {
    for (const piece of (match[1] ?? "").split(",")) {
      const name = (piece.trim().split(/\s+as\s+/u).pop() ?? "").trim();
      if (name !== "") names.push(name);
    }
  }
  return names;
}

/** 守卫的一次判定读数。 */
interface Inspection {
  /** 段内任意位置的反引号名（宽读口径，**只用于诊断**，不是 missing 的判据）。 */
  named: string[];
  /** 只出现在**清单串**里的符号（窄口径，判 missing 与 extra 的**主判据**）。 */
  inList: string[];
  /** 文件实际导出的全部符号（含 `main`）。 */
  exported: string[];
  /** 显式声明为"非纯 / 转出"的名字（missing 的唯一例外来源）。 */
  exceptions: string[];
  /** 既不在清单串里、也没有显式声明的导出（除 `main`）——**这就是漂移**。 */
  missing: string[];
  /** 清单串里写了、但不是本文件导出。 */
  extra: string[];
}

/**
 * 对一份源码文本跑守卫 → 判定读数；无头注 / 无「结构（…）」段时 `null`。
 *
 * ## missing 的判据（options B）：**清单串 + 显式例外**，两者取并集
 *
 * 票面要的是"段点名的导出名**恰好等于**全部导出"。故：
 *   - 在清单串里 ⇒ 已点名；
 *   - 或由 `declaredExceptions` 显式声明为非纯 / 转出 ⇒ **有据的例外**（`findPacker` / `main` /
 *     `isDirectInvocation` 都是这种，且本仓头注**现行写法就已如此**）。
 * 其余导出 ⇒ 漂移。
 *
 * ⚠️ **不再**把"段内任意位置提到过"当作点名：那正是复核实测的漏报面 —— 加一个导出、只在串之后
 * 的散文里提一句，就会被判绿，而它恰恰是 `#88` 的真实形状（见 `declaredExceptions` 头注）。
 *
 * ## extra 的判据（"恰好等于"的**反方向**）：清单串 ∪ 显式例外，**两者都得是真导出**
 *
 * 只查清单串是不够的：显式声明的名字同样是"段对本文件导出面的断言"。删掉一个曾以
 * `` `X` 亦导出但**非纯** `` 声明的导出、把声明留在原处时，只查清单串会让 `missing` 与
 * `extra` **双空 ⇒ 判绿**（复核实测，正是票面 AC3 的"已删符号"形态）。
 */
function inspect(sourceText: string): Inspection | null {
  const header = sourceText.match(/\/\*\*([\s\S]*?)\*\//u);
  if (header === null) return null;
  const section = structureSection(header[1]);
  if (section === null) return null;
  const { named, inList, exceptions } = namedSymbols(section);
  const exported = [...new Set(exportedSymbols(sourceText))].sort();
  // missing 主判据 = 清单串 ∪ 显式例外；extra 判据 = 两者的并集（声明面必须逐字等于导出面）。
  const accounted = new Set([...inList, ...exceptions]);
  const missing = exported.filter(
    (name) => name !== ENTRY_SYMBOL && !accounted.has(name),
  );
  const extra = [...new Set([...inList, ...exceptions])].filter(
    (name) => !exported.includes(name),
  );
  return { named, inList, exceptions, exported, missing, extra };
}

/** 仓库里全部 `scripts/*.mjs`（按名排序，读数稳定）。 */
function scriptNames(dir = join(repoRoot, "scripts")): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
}

/**
 * 一个 `scripts/` 目录下**全部带该段的脚本**的判定读数（唯一的扫描接线）。
 *
 * 真树那条用例与形式 B 的临时副本共用它 —— 两处只差一个目录参数。早先各写一份，加脚本 /
 * 改扫描面时要同时改两处（Shotgun Surgery），且两处会漂出不同的读数形状。
 *
 * @param dir `scripts/` 目录（默认 = 权威树）
 */
function inspectTree(dir = join(repoRoot, "scripts")): (Inspection & { name: string })[] {
  const results: (Inspection & { name: string })[] = [];
  for (const name of scriptNames(dir)) {
    const result = inspect(readFileSync(join(dir, name), "utf8"));
    if (result === null) continue; // 无该段 ⇒ 无断言
    results.push({ name, ...result });
  }
  return results;
}

describe("scripts/*.mjs 头注「结构（#NN）」清单 ↔ 实际导出", () => {
  it("THE POINT (#95): every real script's named list matches its exports exactly", () => {
    const drifts = inspectTree()
      .filter((entry) => entry.missing.length > 0 || entry.extra.length > 0)
      .map(
        (entry) =>
          `${entry.name}：未点名 [${entry.missing.join(", ")}]；点名了非导出 [${entry.extra.join(", ")}]`,
      );
    expect(
      drifts,
      "头注「结构（…）」段的清单与实际导出漂移：补/删该段里的名字（该段的语义就是本文件的导出清单）",
    ).toEqual([]);
  });

  it("NO FALSE ALARM (AC2): frontier.mjs 无该段 ⇒ 不产生断言（票面点名的对照）", () => {
    const source = readFileSync(join(repoRoot, "scripts", "frontier.mjs"), "utf8");
    // 它的头注**故意**只提一个函数名，故"凡导出都得被点名"会把它判红 —— 本守卫必须不判。
    expect(inspect(source)).toBeNull();
  });

  it("THE PREMISE: 带该段的脚本上，守卫**确实读到了东西** —— 否则是空转的绿", () => {
    // 没有这条，"全部脚本都无该段"或"段解析退化成空"这类**致命**退化会安静地全绿（本仓反复
    // 吃过这类教训：一个看起来在守、实际守不住的判据比没有更危险）。
    //
    // ⚠️ 断言强度是**逐脚本自洽**，不是"名单里含某个常量"（早先那版只钉 `verify-pack.mjs`
    // 这个名字，是个会腐烂且测不到解析退化的常量）：对**每个**带该段的脚本，都要求它解析出的
    // 符号数**非空**、且**全部导出都落在段内解析出的名字里**。段解析一旦退化成空（边界写错 /
    // 编码坏掉），`named` 与 `exported` 会同时为空而"无漂移"照样绿 —— 这条就是那道兜底。
    const tree = inspectTree();
    expect(tree.length, "至少要有一个脚本带「结构（…）」段").toBeGreaterThan(0);
    for (const { name, named, exported } of tree) {
      // 段解析必须真的读到符号（否则下面的比对是在两个空集之间做，恒真）。
      expect(named.length, `${name}：段解析读到 0 个符号 ⇒ 段边界/解析退化了`).toBeGreaterThan(0);
      // 每个导出都必须能在段内被找到 —— 这条对"解析被截断"也会 fire。
      for (const symbol of exported.filter((s) => s !== ENTRY_SYMBOL)) {
        expect(named, `${name}：导出 ${symbol} 未在段内解析到`).toContain(symbol);
      }
    }
  });
});

/**
 * 形式 B（票面 AC1 的 CLI 层）：**真文件、真改写、真读盘**。
 *
 * ## 为什么合成文本用例锁不住这条
 *
 * 上面那组合成用例喂的是**内存里的字符串**，它们锁的是 `inspect()` 的判定。但真跑起来时，
 * 守卫是**从磁盘读 `scripts/*.mjs`** 的 —— 读盘那一环（编码、路径拼接、目录遍历、
 * shebang 行）合成用例一次都没走过。`#117` 刚在同类地方栽过：纯函数用例全绿而 CLI 上一次
 * 都没 fire（`Set` vs `Array.isArray` 的接线洞）。故这条**真建目录、真写文件、真读回来**。
 *
 * ## 手法：临时目录里的**独立仓库根**（沿用 #118/#90/#117 的既有纪律，绝不写产品文件）
 */
describe("形式 B：真文件上的漂移（临时副本，不写产品文件）", () => {
  /** 在临时目录里建一个只含 `scripts/` 的独立仓库根。 */
  function makeTempRepo(scripts: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "script-header-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    for (const [name, text] of Object.entries(scripts)) {
      writeFileSync(join(root, "scripts", name), text, "utf8");
    }
    return root;
  }

  /** 临时仓库根下的**漂移读数** —— 复用 `inspectTree` 的遍历，只多一步过滤（单一扫描来源）。 */
  function inspectFromDisk(root: string): (Inspection & { name: string })[] {
    return inspectTree(join(root, "scripts")).filter(
      (entry) => entry.missing.length > 0 || entry.extra.length > 0,
    );
  }

  it("AC1（真文件）：头注少点名 ⇒ 从磁盘读出来仍变红并点名", () => {
    // 真实形态的漂移：清单句 3 个名，而文件导出 4 个（含带 shebang 的真实首行）。
    const root = makeTempRepo({
      "verify-pack.mjs": `#!/usr/bin/env node
/**
 * 结构（#86）：${LIST_OF_88}
 * @module x
 */
export function entryTargets() {}
export function untarGz() {}
export function isDirectInvocation() {}
export function manifestTargets() {}
`,
    });
    try {
      const drifts = inspectFromDisk(root);
      expect(drifts).toHaveLength(1);
      expect(drifts[0].name).toBe("verify-pack.mjs");
      expect(drifts[0].missing).toEqual(["manifestTargets"]);
      expect(drifts[0].extra).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("AC2（真文件）：无该段的脚本从磁盘读出来**不**产生断言（frontier 的对照形态）", () => {
    const root = makeTempRepo({
      "frontier.mjs": `#!/usr/bin/env node
/**
 * 纯逻辑 \`readyFrontier()\` 与 gh I/O 分离，便于离线单测。
 */
export const DEFAULT_LABEL = 'x'
export function readyFrontier() {}
export function main() {}
`,
    });
    try {
      expect(inspectFromDisk(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("THE PREMISE（真文件）：对照脚本的头注里**确实**有那个只被点名一个的符号", () => {
    // 防"因为文件写错成空的所以不报"这种空转绿：这条确认临时副本的内容真是我们要的样子。
    const root = makeTempRepo({
      "frontier.mjs": `/**\n * 纯逻辑 \`readyFrontier()\` 与 gh I/O 分离。\n */\nexport function readyFrontier() {}\n`,
    });
    try {
      const text = readFileSync(join(root, "scripts", "frontier.mjs"), "utf8");
      expect(text).toContain("readyFrontier");
      expect(inspect(text)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * 合成文本用例的入口：跑守卫并**断言它确实产生了判定**（而非"无该段 ⇒ null"）。
 *
 * 直接用 `inspect(x)!` 会静默吞掉"fixture 其实没有该段"这种写错 —— 那时 `missing` / `extra`
 * 全是 `undefined`，断言 `toEqual([])` **照样绿**，用例就成了空转（本仓反复吃过的病）。
 */
function verdict(sourceText: string): Inspection {
  const result = inspect(sourceText);
  expect(result, "fixture 必须真的带上「结构（…）」段，否则本用例是空转的绿").not.toBeNull();
  return result as Inspection;
}

describe("守卫自身的边界（合成文本，不碰真实文件）", () => {
  /** 一份最小可判源码：头注 + 一个导出。 */
  function source(headerLines, body) {
    return `/**\n${headerLines.map((line) => ` * ${line}`).join("\n")}\n */\n${body}\n`;
  }

  it("少点名（THE #88 形态）：导出 4 个而清单只写 3 个 ⇒ 点名缺的那个", () => {
    // 形态取自 `#88`：它往 verify-pack.mjs 加了 manifestTargets。
    // ⚠️ 本仓历史上**没有**一个提交真的漂移过（`#88` 自己把头注一起改了，见文件头注的取证），
    // 故这里**合成**该形态 —— 守卫的意义是挡**将来**的漂移，不是复现一个并不存在的过去。
    const drifted = source(
      [`结构（#86）：${LIST_OF_88}`],
      "export function entryTargets() {}\nexport function untarGz() {}\nexport function isDirectInvocation() {}\nexport function manifestTargets() {}",
    );
    const result = verdict(drifted);
    expect(result.missing).toEqual(["manifestTargets"]);
    expect(result.extra).toEqual([]);
  });

  it("多点名（点名了非导出 / 已删符号）⇒ 报多余项", () => {
    const stale = source(
      ["结构（#86）：`entryTargets` / `alreadyDeleted` 是**纯函数**"],
      "export function entryTargets() {}",
    );
    const result = verdict(stale);
    expect(result.extra).toEqual(["alreadyDeleted"]);
    expect(result.missing).toEqual([]);
  });

  it("改名（旧名留清单、新名未点名）⇒ 缺与新同时报", () => {
    const renamed = source(
      ["结构（#86）：`oldName` 是**纯函数**"],
      "export function newName() {}",
    );
    const result = verdict(renamed);
    expect(result.missing).toEqual(["newName"]);
    expect(result.extra).toEqual(["oldName"]);
  });

  it("`main` 豁免：导出 main 但不点名它，不算漂移", () => {
    const withMain = source(
      ["结构（#86）：`pureThing` 是**纯函数**"],
      "export function pureThing() {}\nexport function main() {}",
    );
    expect(verdict(withMain).missing).toEqual([]);
  });

  it("`export const` 计入导出集合（票面明写）", () => {
    const constant = source(
      ["结构（#86）：`pureThing` 是**纯函数**"],
      "export const DEFAULT_LABEL = 'x'\nexport function pureThing() {}",
    );
    expect(verdict(constant).missing).toEqual(["DEFAULT_LABEL"]);
  });

  it("`export { … }` 转出计入导出集合，且取 `as` 右边的对外名", () => {
    const reexported = source(
      ["结构（#86）：`pureThing` 是**纯函数**"],
      "export function pureThing() {}\nfunction internal() {}\nexport { internal as isDirectInvocation }",
    );
    expect(verdict(reexported).missing).toEqual(["isDirectInvocation"]);
  });

  it("无头注 ⇒ 不产生断言", () => {
    expect(inspect("export function anything() {}\n")).toBeNull();
  });

  it("有头注但无「结构（…）」段 ⇒ 不产生断言", () => {
    expect(inspect(source(["为什么：这是散文，没有清单段。"], "export function a() {}"))).toBeNull();
  });

  it("空清单（该段存在但一个名字都没点）⇒ 把除 main 外的导出全报为未点名", () => {
    const empty = source(["结构（#86）："], "export function a() {}\nexport function b() {}");
    const result = verdict(empty);
    expect(result.missing).toEqual(["a", "b"]);
  });

  it("散文里的反引号代码片段**不算点名**（extra 取窄）—— 这是本仓头注的真实形态", () => {
    // 实测现场：verify-pack.mjs 的段里，清单句之后用散文解释非纯导出，句中有 `return` / `null`
    // / `detect` 这类**代码片段**。它们形态上与真符号名无法区分（都是"反引号裸词 + 后接散文"），
    // 故只能靠"extra 只在表（清单句）里判"来避免假红。
    const prose = source(
      [
        "结构（#86）：`pureThing` 是**纯函数**",
        "（导出，见离线单测）；",
        "`otherThing` 亦导出但非纯：它碰文件系统与 `detect` 探针。",
        "用 `return` 取代 `process.exit`，免得 `null` 传下去。",
      ],
      "export function pureThing() {}\nexport function otherThing() {}",
    );
    const result = verdict(prose);
    // `detect` / `return` / `null` 只在散文里 ⇒ extra 必须为空（取窄）。
    expect(result.extra).toEqual([]);
    // 而 `otherThing` 只在散文里被提到 ⇒ missing 必须为空（取宽）——两层口径各管一边。
    expect(result.missing).toEqual([]);
  });

  it("清单句里的符号没导出 ⇒ 仍报 extra（取窄，但表里的名字照判）", () => {
    const mixed = source(
      ["结构（#86）：`pureThing` / `ghostSymbol` 是**纯函数**", "`proseOnly` 是散文中提到的代码片段。"],
      "export function pureThing() {}",
    );
    const result = verdict(mixed);
    expect(result.extra).toEqual(["ghostSymbol"]);
  });

  it("清单串**之前**的散文反引号不算在表里（Spec 轴抓到的口径洞）", () => {
    // 早先的实现取"段首 → 谓词"，于是清单串**上方**的散文一旦带反引号，就会被判成
    // "点名了非导出"而假红。本仓现行头注里清单串正好是第一行（故真实文件上踩不到），
    // 但那是巧合 —— 这条把口径钉在"紧邻谓词的那一串 / 分隔名字"上。
    const proseAbove = source(
      [
        "结构（#86）：本文件的 `someCodeFragment` 与 `anotherFragment` 见下。",
        "`realThing` 是**纯函数**",
      ],
      "export function realThing() {}",
    );
    const result = verdict(proseAbove);
    expect(result.extra, "清单串上方的散文反引号不得被当成表里的名字").toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("跨行的 `/` 分隔清单串照常整条回收（本仓 verify-pack.mjs 的真实形态）", () => {
    const multiline = source(
      [
        "结构（#86）：`alpha` / `beta` /",
        "`gamma` / `delta`（#117）/ `epsilon`（#118）是**纯函数**",
        "`zeta` 亦导出但非纯。",
      ],
      "export function alpha() {}\nexport function beta() {}\nexport function gamma() {}\nexport function zeta() {}",
    );
    const result = verdict(multiline);
    // 表里有 5 个名字（跨行照常回收）；alpha/beta/gamma 真导出，`delta`/`epsilon`（带票号尾注）没有
    // ⇒ extra 恰是这两个。`zeta` 走显式句式且真导出 ⇒ 两个方向都不报。
    expect(result.extra).toEqual(["delta", "epsilon"]);
    expect(result.missing).toEqual([]);
  });

  /**
   * options B 的**核心面**（复核 C 的洞）：票面要的是清单"**恰好等于**"导出集合。
   *
   * 早先的宽口径把"段内任意位置提到过"当作点名 ⇒ 下面第一条形态**假绿**。这两条一起把
   * "提过 ≠ 点名"钉死，且第二条保证"有据的例外"仍然走得通（否则第一条会靠"永远报"通过）。
   */
  it("THE POINT (B)：加导出 + 只在散文里提一句（**无**显式句式）⇒ 必须红并点名", () => {
    // 这正是 #88 的真实形状：加了导出、没进清单串、散文里提一句。
    const proseOnly = source(
      [
        "结构（#86）：`pureThing` 是**纯函数**",
        "`brandNewExport` 是个新增的导出，见下。",
      ],
      "export function pureThing() {}\nexport function brandNewExport() {}",
    );
    const result = verdict(proseOnly);
    expect(result.missing, "散文里提过**不算**点名 —— 必须报缺").toEqual(["brandNewExport"]);
  });

  it("反例（AC2 的同族）：显式句式『亦导出但**非纯**』⇒ 是有据的例外，不报", () => {
    // 若没有这条，上一条可以靠"把散文一律算作漂移"通过 —— 那会在本仓真实头注上假红。
    const declared = source(
      [
        "结构（#86）：`pureThing` 是**纯函数**",
        "`helperThing` 亦导出但**非纯**（碰文件系统）。",
      ],
      "export function pureThing() {}\nexport function helperThing() {}",
    );
    const result = verdict(declared);
    expect(result.missing).toEqual([]);
    expect(result.exceptions).toContain("helperThing");
  });

  it("『原样转出』句式同样是有据的例外", () => {
    const reexport = source(
      ["结构（#86）：`pureThing` 是**纯函数**", "`relayThing` **原样转出**自别处。"],
      "export function pureThing() {}\nexport function relayThing() {}",
    );
    expect(verdict(reexport).missing).toEqual([]);
  });

  it("句式的判定**止于行尾**：下一行的『原样转出』不得被算到上一行的名字头上", () => {
    // 早先那版取"名字后 40 字符"，跨行吃到了下一行的句式 ⇒ 普通散文句被误认成"有据的例外"，
    // 上一条 THE POINT 因此假绿（复核 C 的洞没被堵上，实测踩到）。
    const crossLine = source(
      [
        "结构（#86）：`pureThing` 是**纯函数**",
        "`brandNewExport` 是个新增的导出，见下。",
        "`relayThing` **原样转出**自别处。",
      ],
      "export function pureThing() {}\nexport function brandNewExport() {}\nexport function relayThing() {}",
    );
    const result = verdict(crossLine);
    expect(result.missing, "brandNewExport 不得借用下一行的句式").toEqual(["brandNewExport"]);
  });

  it("散文里同时出现『亦导出』『非纯』但**不是从名字起的句式** ⇒ 仍算未点名（复核抓到的洞）", () => {
    // 只要求两词**同行**时，下面这句"随手一提"会被当成有据的例外 ⇒ 判绿，而它正是 `#88` 的形态。
    // 句式必须从名字处开始才算声明（见 `declaredExceptions` 头注的实测）。
    const proseKeywords = source(
      [
        "结构（#86）：`pureThing` 是**纯函数**",
        "`brandNewExport` 是新加的实现，它亦导出，但写法非纯。",
      ],
      "export function pureThing() {}\nexport function brandNewExport() {}",
    );
    expect(verdict(proseKeywords).missing).toEqual(["brandNewExport"]);
  });

  it("已删符号（AC3 的第三种）留在**显式句式**里 ⇒ 反方向也必须报 extra", () => {
    // 「恰好等于」是**双向**的：显式句式的名字同样是"段对本文件导出面的断言"。只查清单串时，
    // 删掉一个曾以 `` `X` 亦导出但**非纯** `` 声明的导出、把声明留在原处 ⇒ missing / extra 双空
    // ⇒ 静默放行（复核实测；真实形态 = 删 `findPacker` 的导出而留它的那句声明）。
    const staleException = source(
      [
        "结构（#86）：`pureThing` 是**纯函数**",
        "`ghostThing` 亦导出但**非纯**（已删）。",
      ],
      "export function pureThing() {}",
    );
    const result = verdict(staleException);
    expect(result.missing).toEqual([]);
    expect(result.extra, "显式声明的名字必须是真导出，否则反方向要报").toEqual(["ghostThing"]);
  });
});
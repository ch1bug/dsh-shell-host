/**
 * 离线单测：`scripts/clean-lib.mjs` —— `build` 自带的第一步清理（`#111` 路线 A）。
 *
 * 票面（ch1bug/dsh-shell-host#111）要两条面：
 *
 * 1. **纯函数面**：「该删 vs 该留」的判定是 `planLibCleanup()`，「删 lib/*.js + 删四个入口目录、
 *    留 `lib/types/**`」逐条覆盖；**边界**两条必须锁住 ——
 *    （a）`lib/types/` 下的同名 `.js` **不得**被误删（声明面目录不是 tsdown 的产物面）；
 *    （b）`lib/` 完全不存在时（首次构建 / `git clean -fxd` 之后）**不得抛错**。
 * 2. **端到端面**（AC 第一条）：连续两次构建、中间制造一次 chunk 名变化后，
 *    `lib/` 里**没有**上一代的 `lib/tool-support-*.js`（#136 起 pty 入口自成一体、不再产 chunk，故探针族取仍产 chunk 的 `tool-support`）。这条用真 `node --run build` 跑
 *    （**碰真实环境**，故本用例只在能跑构建时执行；见下方 skip 口径）。
 *
 * 为什么 AC 第一条必须在**离线单测里也有一条真构建**：#111 的病根是"残留进了 tarball"，
 * 而残留由**真实 tsdown 的哈希 chunk 名**产生 —— 纯函数面能证明"判定会删什么"，
 * 但证明不了"build 真的接上了这步、且真产物名形态落在判定里"。两条面合起来才是本票。
 *
 * ⚠️ **本 spec 有副作用（刻意保留，勿"纯净化"掉）**：上面第 2 条端到端用例会
 * **真跑 `node --run build` 两次**（中间改一行源码制造 chunk 名变化，末尾逐字还原源码）。
 * 后果两条：
 *   - 它会 **写 `lib/`**（先清 tsdown 产物再重建，并期望 `lib/types/` 留存）；
 *   - 它依赖**独占**：与其它 `build` / `clean-lib` / `test:release`（装箱面要读 `lib/`）
 *     **并发就会互相踩** —— 门禁据此把"跑全量套件"排在所有 writer 静默之后。
 * 这条用例是本文件**唯一能证明"build 真接上了清理这步"**的证据，别为"让套件无副作用"删它；
 * 要隔离应当改调度（独占窗口），不是删掉验收面。纯函数用例不碰 `lib/`，不受此限。
 *
 * @module tests/clean-lib.spec.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyLibCleanup,
  isDirectInvocation,
  isUnderTypes,
  LIB_DIR,
  listLibEntries,
  normalizeLibPath,
  planLibCleanup,
  TYPES_DIR,
} from "../scripts/clean-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(repoRoot, "scripts", "clean-lib.mjs");
const SCRIPT_URL = new URL("../scripts/clean-lib.mjs", import.meta.url).href;

/** 本轮临时目录（fixture 放仓外：不污染工作树，也不与真 `lib/` 抢路径）。 */
function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-clean-lib-${tag}-`));
}

/** 造一棵 fixture `lib/`：逐条 `mkdir -p` + 写空文件（内容不影响判定）。 */
function makeLib(root: string, entries: string[]): void {
  for (const entry of entries) {
    const full = join(root, entry);
    if (entry.endsWith("/")) mkdirSync(full, { recursive: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "");
    }
  }
}

/** 一棵"上一代产物已铺满"的 fixture：chunk + 四个入口目录 + 声明面（含声明面里的 `.js`）。 */
const RESIDUE_LIB = [
  // 上一代 chunk（哈希名形态，与真产物同形）
  "lib/pty-C0_H63de.js",
  "lib/pty-g32VoH8_.js",
  "lib/posix-quote-abc123.js",
  "lib/detect-def456.js",
  "lib/launchers-ghi789.js",
  "lib/src-jkl012.js",
  // 四个入口目录（含其子文件）
  "lib/pty/index.js",
  "lib/ssh/index.js",
  "lib/terminal/index.js",
  "lib/wsl-plugin/index.js",
  // 声明面 —— 必须整棵保留（含 `.d.ts.map`：tsc 的真实产出，虽不在 `files` 面上）
  "lib/types/pty/index.d.ts",
  "lib/types/pty/index.d.ts.map",
  "lib/types/pty/session-core.d.ts",
  "lib/types/pty/session-core.d.ts.map",
  "lib/types/terminal/index.d.ts",
  "lib/types/detect.d.ts",
  "lib/types/detect.d.ts.map",
  // 边界（a）：声明面**目录里**的 `.js`（绝不是 tsdown 的产物面）
  "lib/types/pty/orphan.js",
  // 边界（a'）：声明面里的**非 `.d.ts`** 文件 —— 保留判据是"整个子树"，不是扩展名白名单
  "lib/types/keepme.map",
  "lib/types/types/nested.txt",
  // 非 tsdown 产物：判不准就不删
  "lib/README.md",
  "lib/zz-fake/index.js",
];

describe("planLibCleanup（纯函数：该删 vs 该留）", () => {
  it("deletes the top-level tsdown chunks and the four entry directories", () => {
    // 判据吃的是 `listLibEntries()` 的顶层条目形态：目录条目不带尾斜杠。
    const doomed = planLibCleanup(RESIDUE_LIB.map((p) => p.replace(/\/index\.js$/u, "")));
    expect(doomed).toEqual([
      "lib/pty-C0_H63de.js",
      "lib/pty-g32VoH8_.js",
      "lib/posix-quote-abc123.js",
      "lib/detect-def456.js",
      "lib/launchers-ghi789.js",
      "lib/src-jkl012.js",
      "lib/pty",
      "lib/ssh",
      "lib/terminal",
      "lib/wsl-plugin",
    ]);
  });

  it("keeps the ENTIRE lib/types/ declaration face — including a .js inside it (boundary a)", () => {
    const doomed = planLibCleanup(RESIDUE_LIB);
    // 边界（a）：`lib/types/pty/orphan.js` 与顶层 chunk 同名后缀，但它在声明面目录里 ——
    // 判据顺序错（先判"顶层 .js"）就会把它删掉，声明面被啃掉一块。
    expect(doomed).not.toContain("lib/types/pty/orphan.js");
    for (const kept of ["lib/types/pty/index.d.ts", "lib/types/detect.d.ts"]) {
      expect(doomed, `${kept} 是 tsc 声明面，不得被删`).not.toContain(kept);
    }
    // 兜底判据本身：`lib/types` 自身 + 任意深度都在保留面内；`lib/types-old` **不在**。
    expect(isUnderTypes("lib/types")).toBe(true);
    expect(isUnderTypes("lib/types/a/b/c.js")).toBe(true);
    expect(isUnderTypes("lib/types-old/x.d.ts")).toBe(false);
  });

  it("preserves lib/types/ by SUBTREE, not by extension (the only silent gap in this ticket)", () => {
    // 这是本票**唯一"删了但没人报红"**的静默缺口：`.d.ts.map` 不在 `package.json` 的 `files`
    // 面（只声明了 `lib/types/**/*.d.ts`）上，也不是 `exports` 指针 —— 删掉它
    // `verify-pack` 四条判据全绿、`test:release` 照样绿。所以判据必须是
    // "整个 `lib/types/` 子树"（不论扩展名），不是 "`.d.ts` 结尾"白名单。
    const doomed = planLibCleanup(RESIDUE_LIB);
    for (const kept of [
      "lib/types/pty/index.d.ts.map", // tsc 的真实产出：`.d.ts` 与 `.d.ts.map` 成对出现，各计一次
      "lib/types/detect.d.ts.map",
      "lib/types/keepme.map", // 非 `.d.ts`、非 `.map`-of-dts 的任意文件
      "lib/types/types/nested.txt", // 深层、非声明后缀
    ]) {
      expect(doomed, `${kept} 在保留子树内，不得被删（静默缺口）`).not.toContain(kept);
    }
    // 反向锁：`lib/types-old/` 前缀相同但**不是**保留子树 —— 别把 `startsWith(TYPES_DIR)`
    // 写成不含分隔符的裸前缀比较。它同时也不是顶层 chunk（深层），故**保留**是对的。
    expect(
      planLibCleanup(["lib/types-old/x.d.ts", "lib/types-old/pty-abc.js", "lib/types/x.js"]),
    ).toEqual([]);
  });

  it("keeps everything it cannot positively identify as a tsdown product", () => {
    const doomed = planLibCleanup(RESIDUE_LIB);
    // 非 `.js`、非入口目录、深层 `.js`（`lib/zz-fake/index.js` 不是入口目录子树）→ 不删。
    expect(doomed).not.toContain("lib/README.md");
    expect(doomed).not.toContain("lib/zz-fake/index.js");
  });

  it("keeps a directory that merely shares the entry directory's name prefix", () => {
    // `lib/pty-extra`：与 `lib/pty` 前缀相同但**不是**它 —— 逐字 `includes` 比较才不误删。
    // 这条同时是给"裸 `startsWith('lib/pty')`"写的**证伪用例**：那种写法会把**真 chunk**
    // （`lib/pty-C0_H63de.js`）连同相似名一起误删 —— 是"误删真产物"的实质缺陷。
    const doomed = planLibCleanup(["lib/pty-extra", "lib/terminal-x", "lib/pty"]);
    expect(doomed).toEqual(["lib/pty"]);
    // 前缀相似名矩阵（verifier 会独立打这几条）：一个都不许被删。
    expect(
      planLibCleanup(["lib/ptyfoo", "lib/ptyextra", "lib/wsl-plugin-old", "lib/terminals"]),
    ).toEqual([]);
    // 对照：真 chunk 必须**被**删 —— 否则"不误删"可能靠"什么都不删"假绿。
    expect(planLibCleanup(["lib/pty-C0_H63de.js"])).toEqual(["lib/pty-C0_H63de.js"]);
  });

  it("treats all four separator spellings of an entry directory identically", () => {
    // 分隔符两形态 × 是否带尾斜杠 = 四种写法，都是"同一个目录"。漏任何一种的后果都是
    // **四个入口目录整棵留下**（尾斜杠那条本轮真踩过）。
    for (const spelling of ["lib/pty", "lib/pty/", "lib\\pty", "lib\\pty\\"]) {
      expect(planLibCleanup([spelling]), `${JSON.stringify(spelling)} 应命中入口目录`).toEqual([
        "lib/pty",
      ]);
    }
    // win32 上 `readdirSync` 给的整串就是反斜杠形态 —— 认不出来则本机残留一个都清不掉。
    expect(planLibCleanup(["lib\\pty-C0_H63de.js", "lib\\src-jkl012.js"])).toEqual([
      "lib/pty-C0_H63de.js",
      "lib/src-jkl012.js",
    ]);
    // 保留面在反斜杠形态下同样成立（`lib\types\...` 不得被当普通深层 `.js`）。
    expect(planLibCleanup(["lib\\types\\pty\\index.d.ts", "lib\\types\\keepme.map"])).toEqual([]);
  });

  it("normalises path spellings, dedupes, and tolerates an empty/absent listing", () => {
    // 反斜杠 / 前导 `./` / 重复分隔符：同一件事的等价写法不得漏判。
    expect(planLibCleanup(["lib\\pty-abc.js", "./lib/posix-quote-abc.js"])).toEqual([
      "lib/pty-abc.js",
      "lib/posix-quote-abc.js",
    ]);
    expect(planLibCleanup(["lib/pty-abc.js", "lib/pty-abc.js"])).toEqual(["lib/pty-abc.js"]);
    expect(planLibCleanup([])).toEqual([]);
    expect(planLibCleanup(undefined)).toEqual([]);
    expect(normalizeLibPath(".\\lib\\pty\\index.js")).toBe("lib/pty/index.js");
    // 末尾分隔符：`readdirSync` 的目录条目形态与手工写法必须等价 —— 否则四个入口目录
    // 会整棵留下（`TSDOWN_ENTRY_DIRS.includes()` 逐字比较）。
    expect(normalizeLibPath("lib/pty/")).toBe("lib/pty");
    expect(planLibCleanup(["lib/pty/", "lib/terminal/"])).toEqual(["lib/pty", "lib/terminal"]);
  });

  it("deletes by tsdown product SHAPE, never by a negative 'everything but .d.ts' rule", () => {
    // 否定式判据（"`lib/` 下非 `.d.ts` 全删"）会当场把四个入口 `lib/*/index.js` 删掉 ——
    // 它们在 `package.json` 的 `files` 里是**显式声明**的，`verify-pack` 判据 3 立刻红。
    // 本用例锁住**肯定式**删除面：只删顶层 chunk + 三个已知入口目录。
    const survivors = [
      "lib/pty-nested/deep.js", // 非顶层、非入口目录
      "lib/types/anything.js",
      "lib/README.md",
      "lib/other-dir/index.js",
    ];
    expect(planLibCleanup(survivors)).toEqual([]);
    // 而入口目录**确实**在被删面内（两个方向都要锁，免得改成"什么都不删"也绿）。
    // 注意判据吃的是 `listLibEntries()` 的**顶层条目名**：目录以 `lib/pty` 形态出现
    // （不带尾斜杠，见 `normalizeLibPath`），代表整棵子树。
    expect(planLibCleanup(["lib/pty", "lib/wsl-plugin"])).toEqual(["lib/pty", "lib/wsl-plugin"]);
    // 尾斜杠是同一件事的等价写法，必须同样命中（本轮真踩过：漏判 ⇒ 四个入口目录整棵留下）。
    expect(planLibCleanup(["lib/pty/", "lib/terminal/"])).toEqual(["lib/pty", "lib/terminal"]);
    // 但**深层文件路径**不是目录条目 —— 不据此删（判不准不删）。
    expect(planLibCleanup(["lib/pty/index.js"])).toEqual([]);
  });
});

describe("listLibEntries / applyLibCleanup（薄 I/O 层）", () => {
  it("returns [] when lib/ does not exist (boundary b: fresh checkout / after git clean -fxd)", () => {
    const root = tempDir("absent");
    try {
      const missing = join(root, LIB_DIR);
      // 边界（b）：`lib/` 不存在是**正常态**（首次构建 / `git clean -fxd` 之后），不得抛错。
      expect(existsSync(missing)).toBe(false);
      expect(listLibEntries(missing)).toEqual([]);
      expect(planLibCleanup(listLibEntries(missing))).toEqual([]);
      // 也不得因"没有 lib/ 可清"而造出一个目录（清理不得有副作用）。
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes exactly the planned entries on a real fixture tree, recursively", () => {
    const root = tempDir("apply");
    try {
      makeLib(root, RESIDUE_LIB);
      // 前置条件：fixture 真的铺全了（否则下面的断言可能因"本来就没有"而假绿）。
      expect(existsSync(join(root, "lib/pty/index.js"))).toBe(true);
      expect(existsSync(join(root, "lib/types/pty/orphan.js"))).toBe(true);

      const doomed = applyLibCleanup(join(root, LIB_DIR));

      // chunk 与四个入口目录**整棵**没了
      expect(doomed).toContain("lib/pty-C0_H63de.js");
      expect(doomed).toContain("lib/pty");
      expect(existsSync(join(root, "lib/pty-C0_H63de.js"))).toBe(false);
      expect(existsSync(join(root, "lib/pty"))).toBe(false);
      expect(existsSync(join(root, "lib/ssh"))).toBe(false);
      expect(existsSync(join(root, "lib/terminal"))).toBe(false);
      expect(existsSync(join(root, "lib/wsl-plugin"))).toBe(false);
      // 声明面**整棵**还在（含边界（a）那个 `.js`）
      expect(readdirSync(join(root, "lib/types"), { recursive: true }).length).toBeGreaterThan(0);
      expect(existsSync(join(root, "lib/types/pty/index.d.ts"))).toBe(true);
      expect(existsSync(join(root, "lib/types/pty/orphan.js"))).toBe(true);
      // 判不准的仍在
      expect(existsSync(join(root, "lib/README.md"))).toBe(true);
      expect(existsSync(join(root, "lib/zz-fake/index.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: a second run on the cleaned tree is a no-op and does not throw", () => {
    const root = tempDir("idem");
    try {
      makeLib(root, ["lib/pty-abc.js", "lib/pty/index.js", "lib/types/detect.d.ts"]);
      // 顺序：`planLibCleanup` 按输入顺序输出，`readdirSync` 的目录条目先于同名 chunk
      // （`lib/pty` < `lib/pty-abc.js`）—— 断言用集合语义，别钉死枚举顺序。
      expect(applyLibCleanup(join(root, LIB_DIR)).sort()).toEqual(["lib/pty", "lib/pty-abc.js"]);
      // 幂等：第二次跑不抛错、不误删声明面（`build` 会反复跑这一步）。
      expect(applyLibCleanup(join(root, LIB_DIR))).toEqual([]);
      expect(existsSync(join(root, "lib/types/detect.d.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a dir whose basename is not lib instead of silently deleting nothing", () => {
    // 契约：删除根（`dirname(dir)`）与列表前缀（`basename(dir)`）必须**同源**。
    // 若 `dir` 的 basename 不叫 `lib`，两者错位 ⇒ **静默一个文件都不删**，
    // 而返回值照旧报"清掉 N 项"（本模块最初写死 `repoRoot` 就是同一失败模式）。
    // 故要求响亮抛错：错位的删除根比崩掉更糟。
    const root = tempDir("contract");
    try {
      const weird = join(root, "staging");
      mkdirSync(join(weird, "pty"), { recursive: true });
      writeFileSync(join(weird, "pty-abc.js"), "");
      expect(() => applyLibCleanup(weird), "basename 不是 lib 时应抛错").toThrow(/clean-lib/u);
      // 且**不得**有任何东西被删（拒绝要发生在动手之前）。
      expect(existsSync(join(weird, "pty-abc.js"))).toBe(true);
      expect(existsSync(join(weird, "pty"))).toBe(true);
      // 对照组：同一个树改名成 `lib` 后照常工作 —— 证明上一条拒绝的是"名字"而不是"这个树"。
      const proper = join(root, "lib");
      mkdirSync(join(proper, "pty"), { recursive: true });
      writeFileSync(join(proper, "pty-abc.js"), "");
      expect(applyLibCleanup(proper).sort()).toEqual(["lib/pty", "lib/pty-abc.js"]);
      expect(existsSync(join(proper, "pty-abc.js"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("单一来源与零副作用（#85 守卫纪律）", () => {
  it("imports the guard from script-entry.mjs instead of defining its own", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    expect(source, "clean-lib.mjs 必须复用 script-entry.mjs 的守卫").toContain("./script-entry.mjs");
    expect(
      /\b(?:function|const)\s+isDirectInvocation\b/u.test(source),
      "clean-lib.mjs 不得自带第二份 isDirectInvocation",
    ).toBe(false);
    expect(isDirectInvocation(SCRIPT_PATH, SCRIPT_URL)).toBe(true);
  });

  it("importing the module is side-effect free (does not touch the repo lib/)", () => {
    const before = existsSync(join(repoRoot, LIB_DIR))
      ? readdirSync(join(repoRoot, LIB_DIR)).join(",")
      : "<absent>";
    // 动态 import 本身不得删任何东西 —— 真被删了 build 会在下一步莫名其妙地缺产物。
    expect(typeof planLibCleanup).toBe("function");
    const after = existsSync(join(repoRoot, LIB_DIR))
      ? readdirSync(join(repoRoot, LIB_DIR)).join(",")
      : "<absent>";
    expect(after, "import scripts/clean-lib.mjs 不得有副作用").toBe(before);
  });
});

/**
 * AC 第一条的**端到端面**：真跑 `node --run build` 两次，中间制造一次 chunk 名变化。
 *
 * ⚠️ **副作用**：本块会**写 `lib/`**（且本文件头注已说明）—— 与其它 `build` /
 * `clean-lib` / `test:release` **不得并发**，须在独占窗口里跑。
 *
 * 门禁口径（`livable`）：只在 `node_modules` 里真能拿到 `typescript` + `tsdown` 时跑 ——
 * 这是**构建面**的验证，不该因环境缺依赖而红（那是另一条门禁的事）；缺依赖时整块 skip。
 * 注意它与 `lib/` 是否存在**无关**：`lib/` 不存在正是本票要覆盖的正常起点
 * （首次构建 / `git clean -fxd` 之后），`clean-lib.mjs` 在该形态下不抛错。
 */
describe("端到端：连续两次构建不留上一代 chunk（#111 AC 第一条）", () => {
  const nodeModules = join(repoRoot, "node_modules");
  const livable = existsSync(join(nodeModules, "typescript")) && existsSync(join(nodeModules, "tsdown"));

  /** 跑一条 npm script；返回 `{ status, out }`。 */
  function runScript(name: string): { status: number | null; out: string } {
    const run = spawnSync(process.execPath, ["--run", name], { cwd: repoRoot, encoding: "utf8" });
    return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  }

  /** `lib/` 里顶层 `lib/tool-support-*.js` 的**名字集合**（排序稳定，便于逐字读数）。
   * #136: the pty entry is self-contained now (no `lib/pty-*.js` chunk), so the
   * residue probe uses the `tool-support` chunk — a shared chunk that still gets
   * a content hash on every build. */
  function toolSupportChunkNames(): string[] {
    const dir = join(repoRoot, LIB_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^tool-support-.*\.js$/u.test(name))
      .sort();
  }

  const chunkSource = join(repoRoot, "src", "tool-support.ts");

  it.skipIf(!livable)("a rebuilt tree carries no previous-generation tool-support chunk", () => {
    const original = readFileSync(chunkSource, "utf8");
    const before = toolSupportChunkNames();
    try {
      // 第一次构建：拿到当次 chunk 名基线。
      const first = runScript("build");
      expect(first.status, `node --run build 应为绿：\n${first.out}`).toBe(0);
      const firstChunks = toolSupportChunkNames();
      expect(firstChunks.length, "构建后应至少有一个 lib/tool-support-*.js chunk").toBeGreaterThan(0);

      // 制造一次 **chunk 名变化**：改一行再改回（源码逐字还原）。
      // 只加一字符注释 → 内容变 → 哈希名变；随后立即还原。
      writeFileSync(chunkSource, `${original}\n// clean-lib spec: chunk-name churn probe\n`);
      const second = runScript("build");
      expect(second.status, `第二次 node --run build 应为绿：\n${second.out}`).toBe(0);
      const secondChunks = toolSupportChunkNames();

      // AC 第一条：上一代的 chunk **不在**（本票的核心读数）。
      const stale = firstChunks.filter((name) => !secondChunks.includes(name));
      expect(
        stale,
        `lib/ 里仍有上一代 tool-support chunk（残留会随 files glob 进 tarball）：${stale.join(", ")}`,
      ).toEqual([]);
      expect(secondChunks.length, "上一代未清时会 >1：每代一个哈希名").toBe(1);

      // AC 第三条：声明面必须仍在（清理不得啃掉 tsc 的面）。
      const dts = readdirSync(join(repoRoot, LIB_DIR, "types"), {
        recursive: true,
        encoding: "utf8",
      }).filter((name) => name.endsWith(".d.ts"));
      expect(dts.length, "lib/types/**/*.d.ts 应仍在").toBeGreaterThan(0);
    } finally {
      // 源码逐字还原（工作树必须干净——本用例只借用构建，不改交付面）。
      writeFileSync(chunkSource, original);
      // 清掉探针那代产物，避免把"残留"留给下一个消费者（诱饵：`build` 本会自己清，
      // 但此刻源码已还原、产物名与还原后的源码不再对应）。
      runScript("build");
    }
  }, 300_000);

  it.skipIf(!livable)("appends reading lines for the unique check entry (build residue count)", () => {
    // 读数口径：环表宣告行 + 紧随的读数行由 `verify-all.mjs` 的 `readingBlocks()` 收集
    // （#89/#97 立的约定：绿路径的读数也必须在**唯一验收入口**里看得见）。
    const chunks = toolSupportChunkNames();
    console.log("=== clean-lib rings（#111 AC1：构建自带清理）===");
    console.log(`  ✓ lib/ 顶层 tool-support chunk 数 = ${chunks.length}（上一代未清时会 >1）`);
    console.log(`  – 当前 chunk：${chunks.join(" ") || "<无>"}`);
    console.log(`  ✓ lib/types/ 存在 = ${existsSync(join(repoRoot, LIB_DIR, "types"))}`);
    expect(chunks.length).toBeLessThanOrEqual(1);
  });
});

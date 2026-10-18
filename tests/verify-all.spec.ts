/**
 * 离线单测：`scripts/verify-all.mjs` 的**输出解析**与**状态判定**纯逻辑。
 *
 * 只测纯函数那半截（构造 vitest 输出文本 → 断言四态）；跑车道的 CLI 半截要真实环境
 * （spawn vitest 两个 project），属 `node --run test` 自身覆盖，不由本套件覆盖。
 *
 * 核心回归锁（`8e8fa9f` **之前**的缺陷）：车道级失败判定原先用**全局** `results`，
 * 于是先行车道的 FAIL 会挡住后行车道的车道级失败（反之亦然）——
 * 汇总结果**随车道执行顺序漂移**（本会话实测 12/14 vs 13/14，条目总数都不变）。
 * 另一处同源缺陷：「无收集到用例」分支漏了 `lane` 字段。
 *
 * 另守 `8094b0d` 的诊断行为：FAIL 时按标记提取失败块，而非盲切输出末尾
 * （票面把该修复记在 `629398c` 名下，但 `git log -S failureExcerpt` 指向的是 `8094b0d`——以 git 为准）。
 *
 * @module tests/verify-all.spec.ts
 */

import { rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectLane,
  entryStatus,
  failureExcerpt,
  formatEntry,
  hasLoudSkip,
  isDirectInvocation,
  laneLevelFailure,
  parsePerFileLine,
  parseVerifyArgs,
  partialBanner,
  partialSummaryNote,
  perFileEntries,
  pinnedRunnerEnv,
  readingBlocks,
  reportsTestCounts,
  summarize,
  summaryLine,
} from "../scripts/verify-all.mjs";

/** 被测脚本自己的路径与 URL（与 CLI 启动时 `process.argv[1]` / `import.meta.url` 同源）。 */
const SCRIPT_URL = pathToFileURL(join(process.cwd(), "scripts", "verify-all.mjs")).href;
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL);

/** 车道定义：与 CLI 里的 LANES 同形（name + why）。 */
const UNIT = { name: "unit", why: "纯逻辑与类型面" };
const MACHINE = { name: "machine", why: "串行；碰真实终端 / 真实实例 / 可选真实 LLM" };

/** 造一行 vitest 逐文件输出（真实形态：`  ✓ |unit| tests/<file>.spec.ts (7 tests) 20ms`）。 */
function line(mark: string, lane: string, file: string, detail = "") {
  return `  ${mark} |${lane}| ${file}${detail === "" ? "" : ` ${detail}`}`;
}

/** ANSI SGR 序列（本包实测是 truecolor 无参数形态：`ESC[<n>m`）。 */
const ESC = "\u001b";
function sgr(...codes: number[]) {
  return codes.map((c) => `${ESC}[${String(c)}m`).join("");
}

/**
 * 造一行**带色**的 vitest 逐文件输出 —— 逐字节对齐本机实测的原始输出
 * （`.scratch/t122-colored-vitest-raw.log`，实测单行即含以下五段 SGR）：
 *
 * ```
 *  ESC[32m✓ESC[39m ESC[30mESC[42m unit ESC[49mESC[39m tests/detect.spec.ts ...
 * ```
 *
 * **色块徽标取代了 `|unit|`**：带色时 vitest 的 project 徽标是一段反显色块
 * （`ESC[30m` 黑字 + `ESC[42m` 绿底 + 项目名 + `ESC[49m` 默认底），两侧没有 `|` ——
 * 实测带色行**剥完**残留 `|` 数为 **0**。
 *
 * **判别依据是"SGR 在不在"，不是空格数** —— 见 `scripts/verify-all.mjs` 的
 * `parsePerFileLine` 头注：按空格计数判别会让对齐填充静默改判（3 空格填充的合法裸行
 * 被丢、2 空格的非徽标文本被收），那正是本票要消灭的漂移。故本 helper 保留真实 SGR。
 * 这是 #122 的现象面：旧正则只认 `|lane|` ⇒ 整张逐文件表一条都解析不到。
 *
 * 注意 `✓` 徽记**不在**色块里（它是 `ESC[32m` 前景色），故为跨环境稳定的锚点。
 */
function colored(mark: string, lane: string, file: string, detail = "") {
  return ` ${sgr(32)}${mark}${sgr(39)} ${sgr(30, 42)} ${lane} ${sgr(49, 39)} ${file}${detail === "" ? "" : ` ${detail}`}`;
}

/** 带色的用例数汇总行（实测形态：`ESC[2m      Tests ESC[22m ESC[1mESC[32m52 passedESC[39mESC[22m...`）。 */
function coloredTestsSummary(text: string) {
  return `${sgr(2)}      Tests ${sgr(22)} ${sgr(1, 32)}${text}${sgr(39, 22)}`;
}

/** 带色的 `Test Files` 汇总行（真没跑用例的那条：`no test files found`）。 */
function coloredTestFilesSummary(text: string) {
  return `${sgr(2)} Test Files ${sgr(22)} ${text}`;
}

/** 造一个车道运行结果 —— 与 `runLane()` 的返回形态同为 `{ exitCode, out }`。 */
function run(exitCode: number | null, out: string) {
  return { exitCode, out };
}

describe("parsePerFileLine", () => {
  it("extracts mark / lane / file / detail from a passing line", () => {
    expect(parsePerFileLine(line("✓", "unit", "tests/detect.spec.ts", "(22 tests) 20ms"))).toEqual({
      mark: "✓",
      lane: "unit",
      file: "tests/detect.spec.ts",
      detail: "(22 tests) 20ms",
    });
  });

  it("reads the × and ↓ marks too, with file and detail intact", () => {
    expect(parsePerFileLine(line("×", "unit", "tests/a.spec.ts", "(1 test)"))).toEqual({
      mark: "×",
      lane: "unit",
      file: "tests/a.spec.ts",
      detail: "(1 test)",
    });
    expect(parsePerFileLine(line("↓", "unit", "tests/b.spec.ts", "(4 tests | 4 skipped)"))).toEqual({
      mark: "↓",
      lane: "unit",
      file: "tests/b.spec.ts",
      detail: "(4 tests | 4 skipped)",
    });
  });

  it("keeps the '(N tests | M skipped)' detail verbatim", () => {
    const parsed = parsePerFileLine(
      line("✓", "machine", "tests/terminal-machine.spec.ts", "(7 tests | 1 skipped) 24899ms"),
    );
    expect(parsed?.detail).toBe("(7 tests | 1 skipped) 24899ms");
  });

  it("accepts a row with no detail at all (detail becomes empty string)", () => {
    expect(parsePerFileLine(line("↓", "unit", "tests/x.spec.ts"))).toEqual({
      mark: "↓",
      lane: "unit",
      file: "tests/x.spec.ts",
      detail: "",
    });
  });

  it("returns null for anything that is not a per-file row", () => {
    for (const garbage of [
      "",
      " Test Files  2 passed (2)",
      "      Tests  29 passed (29)",
      "  ✓ |unit| tests/helper.ts (1 test)", // 非 *.spec.ts
      "  ✓ |unit| (7 tests)", // 缺文件名
      "  ✓ unit tests/a.spec.ts (1 test)", // 缺包裹符（且只有单空格）—— 保持既有边界
      "Duration  12.34s",
    ]) {
      expect(parsePerFileLine(garbage), garbage).toBeNull();
    }
  });

  it("THE POINT (#122): reads a COLORED row whose project badge is a colour block, not |lane|", () => {
    // 带色时 vitest 把 `|unit|` 打成反显色块（两侧没有 `|`）—— 旧正则整条不匹配，
    // 于是带色会话里**整张逐文件表一条都收不到**（全绿被读成"无收集到的用例"）。
    expect(parsePerFileLine(colored("✓", "unit", "tests/detect.spec.ts", "(22 tests) 20ms"))).toEqual({
      mark: "✓",
      lane: "unit",
      file: "tests/detect.spec.ts",
      detail: "(22 tests) 20ms",
    });
    expect(parsePerFileLine(colored("×", "machine", "tests/broken.spec.ts", "(1 test)"))).toEqual({
      mark: "×",
      lane: "machine",
      file: "tests/broken.spec.ts",
      detail: "(1 test)",
    });
    expect(parsePerFileLine(colored("↓", "machine", "tests/ssh-pty-live.spec.ts", "(4 tests | 4 skipped)"))).toEqual({
      mark: "↓",
      lane: "machine",
      file: "tests/ssh-pty-live.spec.ts",
      detail: "(4 tests | 4 skipped)",
    });
  });

  it("still reads the BARE (no-colour) `|lane|` form — one contract, two shapes", () => {
    // 契约 = 恰好两种形态：无 SGR 的裸 `|lane|`，与带 SGR 的色块徽标。
    expect(parsePerFileLine(`  ✓ |unit| tests/a.spec.ts (1 test)`)?.lane).toBe("unit");
    expect(parsePerFileLine(colored("✓", "unit", "tests/a.spec.ts", "(1 test)"))?.lane).toBe("unit");
  });

  it("THE POINT (#122): judge by SGR presence, NOT by space count (alignment padding must not change the verdict)", () => {
    // 复核发现的缺陷：早先按"剥完后是不是双空格"判别 ⇒ 对齐填充一变就静默改判。
    // 3 空格填充的**合法裸行**曾被丢（旧实现接受它），2 空格的**非徽标文本**曾被收。
    // 现在判据落在 SGR 上：无 SGR ⇒ 走裸形态（`\s+` 容忍填充），有 SGR ⇒ 走色块形态。
    expect(parsePerFileLine("  ✓   |unit|   tests/a.spec.ts (1 test)")?.lane).toBe("unit");
    expect(parsePerFileLine("  ✓ |unit| tests/a.spec.ts (1 test)")?.lane).toBe("unit");
    // 没有 SGR 的 `✓␣␣unit␣␣file` **不是**色块形态（那是空格计数认出来的假形态）⇒ 不收。
    expect(parsePerFileLine("  ✓  unit  tests/a.spec.ts (1 test)")).toBeNull();
    // 带 SGR 但徽标形状不对 ⇒ 也不收（交给汇总层的响亮兜底，不猜）。
    expect(parsePerFileLine(`  ${sgr(32)}✓${sgr(39)}  unit  tests/a.spec.ts (1 test)`)).toBeNull();
  });

  it("keeps the shape BOUNDED: a badge-less row stays rejected (no third '看运气' state)", () => {
    // 边界用例：既不是裸形态（无 `|`）也不是色块形态（无 SGR）⇒ 不收
    // （`returns null …` 那条守卫钉着它）。这条把"边界在哪"写死。
    expect(parsePerFileLine("  ✓ unit tests/a.spec.ts (1 test)")).toBeNull();
    expect(parsePerFileLine("  ✓ |unit tests/a.spec.ts (1 test)")).toBeNull();
    expect(parsePerFileLine("  ✓ unit| tests/a.spec.ts (1 test)")).toBeNull();
  });

  it("is robust against alignment padding on the COLOURED form too", () => {
    // 色块形态同样不该被填充左右：SGR 在那儿，徽标形状认得，就该读出来。
    const padded = `  ${sgr(32)}✓${sgr(39)}   ${sgr(30, 42)}  unit  ${sgr(49, 39)}   tests/a.spec.ts (1 test)`;
    expect(parsePerFileLine(padded)?.lane).toBe("unit");
    expect(parsePerFileLine(padded)?.file).toBe("tests/a.spec.ts");
  });

  it("THE POINT (#122 复核发现): repeated calls stay stable — no `/g` lastIndex alternation", () => {
    // 探针若用带 `/g` 的正则，`test()` 会推进 `lastIndex` ⇒ 连续调用**交替命中**
    // （复核轴实测第 7 次返回 false），带色行会被误判成裸形态。这里连调 12 次钉死稳定性。
    const coloredRow = colored("✓", "unit", "tests/a.spec.ts", "(1 test)");
    const bareRow = "  ✓ |unit| tests/a.spec.ts (1 test)";
    // 同一行连续问 12 次：交替命中会让其中某次掉成 null。
    for (let i = 0; i < 12; i += 1) {
      expect(parsePerFileLine(coloredRow), `same-row call ${String(i)}`).not.toBeNull();
    }
    // 再**交替**喂色块 / 裸行，证明两条路径的判定互不污染。
    for (let i = 0; i < 12; i += 1) {
      expect(parsePerFileLine(coloredRow)?.lane, `call ${String(i)} colored`).toBe("unit");
      expect(parsePerFileLine(bareRow)?.lane, `call ${String(i)} bare`).toBe("unit");
    }
  });

  it("colors never leak into lane / file / detail (the parse strips every SGR)", () => {
    const parsed = parsePerFileLine(colored("✓", "unit", "tests/a.spec.ts", "(1 test) 20ms"));
    expect(parsed?.lane).not.toContain("\u001b");
    expect(parsed?.file).not.toContain("\u001b");
    expect(parsed?.detail).not.toContain("\u001b");
  });

  it("returns null for a colored row that is not a per-file row either", () => {
    // 边界：色块徽标形态**不是**开放式的 —— 文件名仍必须是 *.spec.ts。
    for (const garbage of [
      coloredTestsSummary("29 passed (29)"),
      coloredTestFilesSummary("no test files found"),
      colored("✓", "unit", "tests/helper.ts", "(1 test)"), // 非 *.spec.ts
      colored("✓", "unit", "", "(7 tests)"), // 缺文件名
    ]) {
      expect(parsePerFileLine(garbage), garbage).toBeNull();
    }
  });
});

describe("perFileEntries", () => {
  it("collects only the per-file rows, in order", () => {
    const out = [
      " RUN  v4.1.8 <cwd>",
      line("✓", "unit", "tests/detect.spec.ts", "(22 tests) 20ms"),
      line("×", "unit", "tests/broken.spec.ts", "(1 test)"),
      " Test Files  1 failed | 1 passed (2)",
      line("↓", "unit", "tests/ssh-pty-live.spec.ts", "(4 tests | 4 skipped)"),
    ].join("\n");
    expect(perFileEntries(out).map((e: { file: string }) => e.file)).toEqual([
      "tests/detect.spec.ts",
      "tests/broken.spec.ts",
      "tests/ssh-pty-live.spec.ts",
    ]);
  });
});

describe("hasLoudSkip", () => {
  it("is true only when the lane printed a loud skip", () => {
    expect(hasLoudSkip("  !! SKIP (loud): DSH_SSH_LIVE_HOST 未设置")).toBe(true);
    expect(hasLoudSkip(line("✓", "unit", "tests/a.spec.ts", "(1 test)"))).toBe(false);
  });
});

describe("perFileEntries（#122：带色整表）", () => {
  it("THE POINT: a fully COLOURED lane output still yields the whole per-file table", () => {
    // 带色实测输出的形状：逐文件表 + 带色 Test Files / Tests 汇总行。
    // 旧实现下这里 entries 为 0 —— 整张表消失，只剩兜底的一条 FAIL。
    const out = [
      " RUN  v4.1.11 <cwd>",
      "",
      colored("✓", "unit", "tests/detect.spec.ts", "22 tests 20ms"),
      colored("✓", "unit", "tests/verify-all.spec.ts", "52 tests 39ms"),
      "",
      coloredTestFilesSummary("2 passed (2)"),
      coloredTestsSummary("74 passed (74)"),
    ].join("\n");
    expect(perFileEntries(out).map((e: { file: string }) => e.file)).toEqual([
      "tests/detect.spec.ts",
      "tests/verify-all.spec.ts",
    ]);
  });
});

describe("entryStatus", () => {
  it("maps '(N tests | M skipped)' to PASS* and '(N tests)' to PASS", () => {
    expect(entryStatus({ mark: "✓", detail: "(7 tests | 1 skipped)" })).toBe("PASS*");
    expect(entryStatus({ mark: "✓", detail: "(7 tests)" })).toBe("PASS");
  });

  it("maps × to FAIL and ↓ to SKIP", () => {
    expect(entryStatus({ mark: "×", detail: "(1 test)" })).toBe("FAIL");
    expect(entryStatus({ mark: "↓", detail: "(4 tests | 4 skipped)" })).toBe("SKIP");
  });

  it("a lane-wide loud skip upgrades PASS to PASS*", () => {
    expect(entryStatus({ mark: "✓", detail: "(1 test)", loud: true })).toBe("PASS*");
  });

  it("loud never downgrades FAIL or SKIP", () => {
    // 先判标记再判 loud：门禁跳过不因"车道里有别的 loud skip"变成 PASS*
    expect(entryStatus({ mark: "×", detail: "(1 test)", loud: true })).toBe("FAIL");
    expect(entryStatus({ mark: "↓", detail: "(4 tests | 4 skipped)", loud: true })).toBe("SKIP");
  });

  it("treats a detail-less pass as plain PASS", () => {
    expect(entryStatus({ mark: "✓", detail: "" })).toBe("PASS");
  });
});

describe("collectLane", () => {
  it("turns each per-file row into an entry (exit 0 adds nothing else)", () => {
    const out = [line("✓", "unit", "tests/a.spec.ts", "(2 tests)"), line("↓", "unit", "tests/b.spec.ts", "(1 test | 1 skipped)")].join("\n");
    const entries = collectLane({ lane: UNIT, run: run(0, out), results: [] });
    expect(entries.map((e: { label: string; status: string }) => [e.label, e.status])).toEqual([
      ["tests/a.spec.ts", "PASS"],
      ["tests/b.spec.ts", "SKIP"],
    ]);
  });

  it("records a lane-level FAIL when the lane exits non-zero but every row looks passing", () => {
    const out = [line("✓", "unit", "tests/a.spec.ts", "(2 tests)"), line("✓", "unit", "tests/b.spec.ts", "(3 tests)")].join("\n");
    const entries = collectLane({ lane: UNIT, run: run(1, out), results: [] });
    const laneExit = entries.find((e: { label: string }) => e.label === "project unit (lane exit)");
    expect(entries).toHaveLength(3);
    expect(laneExit?.status).toBe("FAIL");
    expect(laneExit?.lane).toBe("unit");
    expect(laneExit?.detail).toBe("exit 1");
    expect(laneExit?.output).toBe(out); // 车道级失败也要带输出，供 failureExcerpt 用
  });

  it("does not duplicate the lane-level FAIL when a row already failed", () => {
    const out = [line("×", "unit", "tests/a.spec.ts", "(1 test)"), line("✓", "unit", "tests/b.spec.ts", "(2 tests)")].join("\n");
    const entries = collectLane({ lane: UNIT, run: run(1, out), results: [] });
    expect(entries.filter((e: { status: string }) => e.status === "FAIL")).toHaveLength(1);
    expect(entries.some((e: { label: string }) => e.label === "project unit (lane exit)")).toBe(false);
  });

  it("falls back to the lane's 'why' when a row carries no detail", () => {
    const entries = collectLane({ lane: UNIT, run: run(0, line("↓", "unit", "tests/x.spec.ts")), results: [] });
    expect(entries[0]).toMatchObject({ label: "tests/x.spec.ts", status: "SKIP", detail: UNIT.why });
  });

  it("no collected cases + exit 0 → one SKIP entry that keeps its lane", () => {
    // 同源缺陷：这一分支原先漏了 lane 字段，会被车道过滤吞掉。
    // 它同时是 `#122` 兜底的**反例**（`no test files found` 没有用例数 ⇒ 不得误判成解析失败）。
    const entries = collectLane({ lane: UNIT, run: run(0, " Test Files  no test files found"), results: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "project unit", lane: "unit", status: "SKIP", detail: "无收集到的用例" });
  });

  it("THE POINT (#122): exit 0 + vitest reported test counts but zero parsed rows → FAIL, never 'no cases'", () => {
    // 兜底（`dbd8318` 落地）的**触发面**：解析真的 0 行、而汇总行 `Tests  387 passed` 在
    // ⇒ 响亮 FAIL，绝不读成"没跑"。
    //
    // 触发面怎么造成：**再换一种 vitest 未知形态**（这里 = 色块徽标但徽记变成 `❯`，
    // 或徽标词多了一个 token）。#122 修完以后，真实带色输出**不再**落进这条兜底
    // （它是失败兜底，不是常态路径）—— 所以这条用例必须用一个**真解析不动**的形态,
    // 否则它证不了兜底还活着。
    const out = [
      " RUN  v4.1.11 <cwd>",
      " ❯  unit  tests/verify-all.spec.ts (13 tests) 7ms", // 徽记 ×（未知）⇒ 这一行解析不动
      " ❯  unit  tests/verify-all.spec.ts (3 tests) 2ms",
      "",
      coloredTestsSummary("387 passed | 1 skipped (388)"),
    ].join("\n");
    const entries = collectLane({ lane: UNIT, run: run(0, out), results: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "project unit", lane: "unit", status: "FAIL", output: out });
    expect(entries[0]?.detail).toContain("#122");
  });

  it("THE POINT (#122 反例): a COLOURED lane with a full table stays a full table (not the FAIL fallback)", () => {
    // 本票要的**根因行为**：带色不再是"兜底接住"，而是表本来就在。
    // 判据 = 条目数 = 逐文件行数（此处 3），三态齐备，且**不含**兜底那条 FAIL。
    const out = [
      colored("✓", "unit", "tests/detect.spec.ts", "22 tests 20ms"),
      colored("✓", "machine", "tests/terminal-machine.spec.ts", "7 tests | 1 skipped 25049ms"),
      colored("↓", "machine", "tests/ssh-pty-live.spec.ts", "4 tests | 4 skipped"),
      "",
      coloredTestFilesSummary("3 passed (3)"),
      coloredTestsSummary("33 passed | 5 skipped (38)"),
    ].join("\n");
    const entries = collectLane({ lane: UNIT, run: run(0, out), results: [] });
    expect(entries.map((e: { label: string; status: string }) => [e.label, e.status])).toEqual([
      ["tests/detect.spec.ts", "PASS"],
      ["tests/terminal-machine.spec.ts", "PASS*"],
      ["tests/ssh-pty-live.spec.ts", "SKIP"],
    ]);
    expect(entries.some((e: { label: string }) => e.label.startsWith("project unit"))).toBe(false);
  });

  it("THE POINT (#122): the COLOURED shape is no longer what trips the fallback", () => {
    // 把"修好了"这件事本身钉住：同一份输出（带色 + 有用例数汇总行），
    // 修前 ⇒ 兜底 FAIL（表全丢）；修后 ⇒ 表完整。
    // 这条与上面那条配对：一个说表在，一个说兜底没被误触发。
    const coloredOut = [
      colored("✓", "unit", "tests/detect.spec.ts", "22 tests 20ms"),
      "",
      coloredTestsSummary("22 passed (22)"),
    ].join("\n");
    const entries = collectLane({ lane: UNIT, run: run(0, coloredOut), results: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "tests/detect.spec.ts", lane: "unit", status: "PASS" });
  });

  it("THE POINT (#122 反例): a COLOURED 'no test files found' lane (no numeric totals) is still SKIP", () => {
    // 批纪律：真没跑用例的车道不得被误判成解析失败 —— 带色版本同样成立
    // （色块里没有 `Tests  <数字>`，`reportsTestCounts` 不误触发）。
    const out = [coloredTestFilesSummary("no test files found"), "", "Duration  300ms"].join("\n");
    const entries = collectLane({ lane: UNIT, run: run(0, out), results: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "project unit", lane: "unit", status: "SKIP", detail: "无收集到的用例" });
  });

  it("reportsTestCounts only fires on a numeric vitest summary (the guard's own boundary)", () => {
    expect(reportsTestCounts("      Tests  387 passed | 1 skipped (388)")).toBe(true);
    expect(reportsTestCounts(" Test Files  no test files found")).toBe(false);
    expect(reportsTestCounts("")).toBe(false);
  });

  it("THE POINT (#122 同源缺陷): reportsTestCounts must strip SGR — a COLOURED summary still counts", () => {
    // 带色时这行是 `ESC[2m      Tests ESC[22m ESC[1mESC[32m52 passed…`：
    // `Tests` 与数字之间夹着着色序列。未剥色的正则**恒不命中** ⇒ 兜底在最需要它的
    // 场合（带色）恰好失效，把"解析失败"静默读成 SKIP（本会话实测踩到）。
    expect(reportsTestCounts(coloredTestsSummary("52 passed (52)"))).toBe(true);
    expect(reportsTestCounts(coloredTestsSummary("387 passed | 1 skipped (388)"))).toBe(true);
    // 反例仍成立：带色的 `no test files found` 没有数字 ⇒ 不得误判。
    expect(reportsTestCounts(coloredTestFilesSummary("no test files found"))).toBe(false);
  });

  it("no collected cases + non-zero exit → FAIL with the output attached", () => {
    const out = "Error: Cannot find module 'vitest'\n";
    const entries = collectLane({ lane: MACHINE, run: run(3, out), results: [] });
    expect(entries[0]).toMatchObject({ label: "project machine", lane: "machine", status: "FAIL", detail: "exit 3", output: out });
  });

  it("a loud skip anywhere in the lane output marks its passing rows PASS*", () => {
    const out = ["  !! SKIP (loud): 缺 DSH_SSH_LIVE_HOST", line("✓", "machine", "tests/a.spec.ts", "(1 test)")].join("\n");
    const entries = collectLane({ lane: MACHINE, run: run(0, out), results: [] });
    expect(entries[0]?.status).toBe("PASS*");
  });
});

describe("laneLevelFailure（回归锁：只认本车道条目）", () => {
  it("THE POINT: an earlier lane's FAIL cannot mask the later lane's lane-level failure", () => {
    // 旧实现在这里用全局 results.some(status === 'FAIL') → 返回 null，
    // machine 的退出码被吞、结果随车道顺序漂移。
    const results = [{ label: "tests/a.spec.ts", lane: "unit", status: "FAIL", detail: "(1 test)" }];
    const entry = laneLevelFailure({ lane: MACHINE, exitCode: 1, output: "out", results });
    expect(entry?.status).toBe("FAIL");
    expect(entry?.label).toBe("project machine (lane exit)");
  });

  it("…and the later lane's FAIL cannot mask the earlier lane's either", () => {
    const results = [{ label: "tests/b.spec.ts", lane: "machine", status: "FAIL", detail: "(1 test)" }];
    expect(laneLevelFailure({ lane: UNIT, exitCode: 1, output: "out", results })?.lane).toBe("unit");
  });

  it("returns null on a zero exit — a green lane gets no invented FAIL", () => {
    expect(laneLevelFailure({ lane: UNIT, exitCode: 0, output: "out", results: [] })).toBeNull();
  });

  it("returns null when this lane already has a FAIL of its own", () => {
    const results = [{ label: "tests/a.spec.ts", lane: "unit", status: "FAIL", detail: "(1 test)" }];
    expect(laneLevelFailure({ lane: UNIT, exitCode: 1, output: "out", results })).toBeNull();
  });

  it("end-to-end through collectLane: both lanes' failures coexist", () => {
    const results: Array<{ label: string; lane: string; status: string }> = [];
    results.push(
      ...collectLane({ lane: UNIT, run: run(0, line("×", "unit", "tests/a.spec.ts", "(1 test)")), results }),
    );
    results.push(
      ...collectLane({ lane: MACHINE, run: run(1, line("✓", "machine", "tests/b.spec.ts", "(2 tests)")), results }),
    );
    expect(results.filter((r) => r.status === "FAIL").map((r) => r.label)).toEqual([
      "tests/a.spec.ts",
      "project machine (lane exit)",
    ]);
  });
});

describe("summarize", () => {
  it("counts passed / partial / skipped / failed", () => {
    expect(
      summarize([{ status: "PASS" }, { status: "PASS*" }, { status: "FAIL" }, { status: "SKIP" }]),
    ).toEqual({ total: 4, passed: 2, partial: 1, skipped: 1, failed: 1 });
  });

  it("a fully green run has no partial / skipped / failed", () => {
    expect(summarize([{ status: "PASS" }, { status: "PASS" }])).toEqual({
      total: 2,
      passed: 2,
      partial: 0,
      skipped: 0,
      failed: 0,
    });
  });
});

describe("summaryLine", () => {
  it("says OK with no footnotes when everything passed", () => {
    expect(summaryLine([{ status: "PASS" }, { status: "PASS" }])).toBe("OK — 2/2 通过");
  });

  it("spells out what a PASS* means (环境侧断言未验证)", () => {
    expect(summaryLine([{ status: "PASS" }, { status: "PASS*" }])).toBe(
      "OK — 2/2 通过（其中 1 项为 PASS*：含 loud skip / 部分跳过，**其环境侧断言未验证**）",
    );
  });

  it("calls out whole-lane skips separately", () => {
    expect(summaryLine([{ status: "PASS" }, { status: "SKIP" }])).toBe(
      "OK — 1/2 通过，1 项整体跳过（门禁未开，见上）",
    );
  });

  it("says FAILED and keeps both footnotes in order", () => {
    expect(
      summaryLine([{ status: "FAIL" }, { status: "PASS*" }, { status: "SKIP" }, { status: "PASS" }]),
    ).toBe(
      "FAILED — 2/4 通过（其中 1 项为 PASS*：含 loud skip / 部分跳过，**其环境侧断言未验证**），1 项整体跳过（门禁未开，见上）",
    );
  });
});

describe("formatEntry", () => {
  it("renders the four status labels in a fixed-width column", () => {
    const head = ["PASS", "PASS*", "FAIL", "SKIP"].map((status) =>
      formatEntry({ status, label: "x", detail: "d" }).slice(0, 7),
    );
    expect(head).toEqual(["  PASS ", "  PASS*", "  FAIL ", "  SKIP "]);
  });

  it("pads the label column to 40 so details line up", () => {
    const rendered = formatEntry({ status: "FAIL", label: "tests/a.spec.ts", detail: "exit 1" });
    // 期望值按格式规范独立构造：2 空格缩进 + 5 宽状态列 + 1 空格 + **40 宽标签列** + 1 空格 + 详情
    const expected = `  FAIL  tests/a.spec.ts${" ".repeat(40 - "tests/a.spec.ts".length)} exit 1`;
    expect(rendered).toBe(expected);
    expect(rendered.indexOf("exit 1")).toBe(2 + 5 + 1 + 40 + 1);
  });
});

describe("failureExcerpt", () => {
  it("pulls the failure block out of the middle instead of tailing blindly", () => {
    // 8094b0d：vitest 把失败详情印在中段，末尾是汇总与耗时——
    // 盲切末尾 25 行看不到「哪条断言挂了」。
    const out = [
      " RUN  v4.1.8 <cwd>",
      " FAIL  tests/x.spec.ts > suite > case",
      "AssertionError: expected 'a' to be 'b'",
      "  - Expected  \"b\"",
      "  + Received  \"a\"",
      ...Array.from({ length: 40 }, (_, i) => `  duration line ${i}`),
      " Test Files  1 failed (1)",
    ].join("\n");
    const excerpt = failureExcerpt(out);
    expect(excerpt).toContain("AssertionError: expected 'a' to be 'b'");
    // 反证：盲切末尾确实会丢掉它（否则本用例证明不了什么）。
    expect(out.split("\n").slice(-25).join("\n")).not.toContain("AssertionError");
  });

  it("falls back to the last 25 lines when nothing matches (e.g. a crash)", () => {
    const excerpt = failureExcerpt(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    expect(excerpt.split("\n")).toHaveLength(25);
    expect(excerpt).toContain("line 39");
    expect(excerpt).not.toContain("line 10");
  });

  it("recognises × rows and module-resolution failures", () => {
    const out = ["  × |unit| tests/a.spec.ts (1 test)", "Error: Cannot find module 'missing-dep'"].join("\n");
    const excerpt = failureExcerpt(out);
    expect(excerpt).toContain("Cannot find module 'missing-dep'");
    expect(excerpt).toContain("tests/a.spec.ts");
  });

  it("returns the tail for empty output instead of crashing", () => {
    expect(failureExcerpt("")).toBe("");
  });
});

describe("readingBlocks（环表读数进汇总）", () => {
  // 真实宣告行（两档 e2e 各一条，逐字取自 spec 的 console.log）。
  const HEADING = "=== packed-delivery rings (pack → install → config → boot → turn → cleanup) ===";
  const REAL_HEADING = "=== real-LLM tier rings (install → credentials → boot → auth → session+model → turn → cleanup) ===";
  /** vitest 在每段 console 输出前打的标记行（读数块就挂在它后面）。 */
  const marker = (file: string) => `stdout | ${file} > suite > case`;

  it("collects the rows under a rings heading, verbatim and in order", () => {
    const out = [
      marker("tests/e2e-tarball-machine.spec.ts"),
      "",
      HEADING,
      "  ✓ 1 pack: the artifact carries the install face — 15 files unpacked",
      "  ✓ 2 install: the tarball is the recorded source",
      "  – Z cleanup: instance stopped — no instance was started",
      "  ✓ Z cleanup: temp tree removed — C:/Users/x/AppData/Local/Temp/dsh-shellhost-tarball-abc",
      "",
      " Test Files  1 passed (1)",
    ].join("\n");
    expect(readingBlocks(out)).toEqual([
      {
        heading: HEADING,
        rows: [
          "  ✓ 1 pack: the artifact carries the install face — 15 files unpacked",
          "  ✓ 2 install: the tarball is the recorded source",
          "  – Z cleanup: instance stopped — no instance was started",
          "  ✓ Z cleanup: temp tree removed — C:/Users/x/AppData/Local/Temp/dsh-shellhost-tarball-abc",
        ],
      },
    ]);
  });

  it("THE POINT: green-path readings survive even though collectLane drops passing output", () => {
    // #97/#89 的 AC（「清理读数在成功与失败两条路径都出现」）只有绿路径的输出能证；
    // 而 collectLane 对通过的文件把 output 置空 —— 读数必须由 readingBlocks 单独收。
    const out = [
      line("✓", "machine", "tests/e2e-real-llm-machine.spec.ts", "(1 test) 13102ms"),
      marker("tests/e2e-real-llm-machine.spec.ts"),
      "",
      REAL_HEADING,
      "  ✓ 1 install: the official commands leave all three faces",
      "  ✓ Z cleanup: temp tree removed — C:/Users/x/AppData/Local/Temp/dsh-shellhost-real-abc",
    ].join("\n");
    const entries = collectLane({ lane: MACHINE, run: run(0, out), results: [] });
    expect(entries[0]?.output).toBeUndefined(); // 反证：汇总条目里没有它
    expect(readingBlocks(out)).toEqual([
      {
        heading: REAL_HEADING,
        rows: [
          "  ✓ 1 install: the official commands leave all three faces",
          "  ✓ Z cleanup: temp tree removed — C:/Users/x/AppData/Local/Temp/dsh-shellhost-real-abc",
        ],
      },
    ]);
  });

  it("never mistakes vitest's own per-file rows for readings", () => {
    // 逐文件行也是「两空格 + ✓」，靠 `✓` 后必须不是 `|` 区分；红/绿都一样。
    const out = [
      line("✓", "machine", "tests/e2e-real-llm-machine.spec.ts", "(1 test) 13102ms"),
      line("×", "unit", "tests/broken.spec.ts", "(1 test)"),
      line("↓", "machine", "tests/ssh-pty-live.spec.ts", "(4 tests | 4 skipped)"),
    ].join("\n");
    expect(readingBlocks(out)).toEqual([]);
  });

  it("skips a heading with no rows and keeps several blocks in order", () => {
    const empty = ["=== empty tier rings (nothing) ===", "", " Test Files  no test files found"].join("\n");
    expect(readingBlocks(empty)).toEqual([]);

    const two = [
      HEADING,
      "  ✓ 1 pack: the artifact carries the install face",
      REAL_HEADING,
      "  ✗ 6 real turn: provider billed — the model attempt reported no failure",
      "  ✓ Z cleanup: instance stopped — SIGTERM → exit",
    ].join("\n");
    const blocks = readingBlocks(two);
    expect(blocks.map((b: { heading: string }) => b.heading)).toEqual([HEADING, REAL_HEADING]);
    expect(blocks[1]?.rows).toHaveLength(2);
    expect(blocks[1]?.rows[0]).toContain("✗ 6 real turn");
  });

  it("returns nothing when there is no rings heading (and never throws)", () => {
    expect(readingBlocks("")).toEqual([]);
    expect(readingBlocks("  ✓ |unit| tests/a.spec.ts (1 test)")).toEqual([]);
    expect(readingBlocks(undefined)).toEqual([]);
  });
});

describe("isDirectInvocation", () => {
  it("recognises the script's own path as direct execution", () => {
    expect(isDirectInvocation(SCRIPT_PATH, SCRIPT_URL)).toBe(true);
  });

  it("normalises equivalent path spellings (realpath, not string equality)", () => {
    // 不归一就会失配 → 脚本静默不跑却 exit 0（"唯一检查入口"假绿）。
    expect(isDirectInvocation(SCRIPT_PATH.replace(/\\/g, "/"), SCRIPT_URL)).toBe(true);
  });

  it("treats another file — or no argv[1] at all — as an import", () => {
    // 单测 import 时 argv[1] 是 vitest 自己的入口。
    expect(isDirectInvocation(join(process.cwd(), "scripts", "frontier.mjs"), SCRIPT_URL)).toBe(false);
    expect(isDirectInvocation(undefined, SCRIPT_URL)).toBe(false);
  });

  it("does not crash on a missing path or a non-file URL", () => {
    // 守卫自己崩掉 = 入口崩，比失配更糟；两种情况都该安静地判"非直接执行"。
    expect(isDirectInvocation(join(process.cwd(), "scripts", "nope.mjs"), SCRIPT_URL)).toBe(false);
    expect(isDirectInvocation(SCRIPT_PATH, "https://example.invalid/verify-all.mjs")).toBe(false);
  });

  it("counts a symlinked invocation as direct (the false-green mode the guard fixes)", () => {
    const link = join(tmpdir(), `verify-all-link-${String(process.pid)}.mjs`);
    try {
      symlinkSync(SCRIPT_PATH, link);
    } catch (error) {
      console.info(
        `!! SKIP (loud): 本机无法创建符号链接（${String(error)}）—— 该形态未验证；需要开发者模式/管理员权限`,
      );
      return;
    }
    try {
      expect(link).not.toBe(SCRIPT_PATH); // 前置条件：确实是另一条路径
      expect(isDirectInvocation(link, SCRIPT_URL)).toBe(true);
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe("pinnedRunnerEnv（#122：形态由 spawn 侧钉死）", () => {
  it("THE POINT: forces NO_COLOR=1 regardless of the caller's session", () => {
    // 读数稳定性不该靠调用者记得先设变量 —— 验收入口自己 spawn 时就把形态钉死。
    expect(pinnedRunnerEnv({ PATH: "x" })).toEqual({ PATH: "x", NO_COLOR: "1" });
    // 调用者会话带色（TERM/CLICOLOR_FORCE 之类）也一律压掉。
    expect(pinnedRunnerEnv({ TERM: "xterm-256color", FORCE_COLOR: "3" }).NO_COLOR).toBe("1");
    // 已经是别的值 ⇒ 覆盖成 1（不"尊重"一个会让表消失的取值）。
    expect(pinnedRunnerEnv({ NO_COLOR: "0" }).NO_COLOR).toBe("1");
  });

  it("does not mutate the caller's environment object", () => {
    const base = { PATH: "x" };
    pinnedRunnerEnv(base);
    expect(base).toEqual({ PATH: "x" });
  });
});

describe("parseVerifyArgs（--lane 迭代口径）", () => {
  it("defaults to no lane — the full gate", () => {
    expect(parseVerifyArgs([])).toEqual({});
  });

  it("selects a known lane", () => {
    expect(parseVerifyArgs(["--lane", "unit"])).toEqual({ lane: "unit" });
    expect(parseVerifyArgs(["--lane", "machine"])).toEqual({ lane: "machine" });
  });

  it("reports an unknown lane / missing value / unknown flag", () => {
    expect(parseVerifyArgs(["--lane", "nope"]).error).toContain("未知车道：nope");
    expect(parseVerifyArgs(["--lane"]).error).toContain("--lane 缺参数");
    expect(parseVerifyArgs(["--watch"]).error).toContain("未知参数：--watch");
  });

  it("THE POINT: 迭代口径必须自带两道「非验收」提示", () => {
    // 只跑一个车道很容易被当成"全绿"——横幅与汇总末尾都要说清口径。
    for (const notice of [partialBanner("unit"), partialSummaryNote("unit")]) {
      expect(notice).toContain("非验收口径");
      expect(notice).toContain("node --run test");
    }
  });
});
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
  readingBlocks,
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
      "  ✓ unit tests/a.spec.ts (1 test)", // 缺 |lane|
      "Duration  12.34s",
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
    const entries = collectLane({ lane: UNIT, run: run(0, " Test Files  no test files found"), results: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "project unit", lane: "unit", status: "SKIP", detail: "无收集到的用例" });
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
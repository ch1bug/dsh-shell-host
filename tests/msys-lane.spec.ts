/**
 * 车道形状守卫：`scripts/msys-lane.sh` 必须**先重建副本构件、再跑套件**（#101 retro 落地）。
 *
 * 为什么存在：这条车道是本仓唯一的推送闸门（无 CI，ADR-0014 的边界），却**零自动覆盖** ——
 * `tests/scripts-coverage.spec.ts` 的位置约定只管 `scripts/*.mjs`，`.sh` 不在内；此前 `tests/**`
 * 对 `msys-lane.sh` 的命中为零。而它刚刚新增的那一步（同步后 `node --run build`）正是为了堵住
 * 「新 spec + 旧构件 ⇒ 空心绿」：三档 e2e 安装/打包的都是副本 `lib/`，而 `lib/` 被 gitignore，
 * 同步搬不动它。**这一步没有任何回归守卫**：谁删掉它、或把它挪到跑套件之后，车道的读数都不会红，
 * 缺陷静默回归。这里把那条契约钉成形状判据（先例：`tests/patch-shape.spec.ts` 的活体仓扫描 +
 * 合成文本负例）。
 *
 * 契约四条（判据在 `laneViolations`，负例在第一个 describe）：
 *   1. 存在 `node --run build`；
 *   2. 它的行号**早于**首次 `vitest.mjs run`（先重建再跑）；
 *   3. 构建步之后、跑套件之前有 `lib/pty/index.js` 的存在性判据 —— 建不出来要**在这里响亮失败**，
 *      而不是退化成三档 e2e 的「门禁未开」loud skip（那会把构建坏了说成环境没开）；
 *   4. 跑套件那行同时给 `--reporter=json` 与 `--reporter=default`（`#133`）：读数里的 loud 行数
 *      与三档 e2e 环表都取自 `$log` 的**控制台**，而 json reporter 不记 console —— 只给 json 时
 *      这些读数结构性恒 0。机制 / 取舍 / 代价的**单一来源**：[dev-environment.md §0.1.1](../docs/dev-environment.md)
 *      （判据本处只钉形状，成因不复述）。
 *
 * @module tests/msys-lane.spec.ts
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 被守卫的车道脚本（与 `scripts/msys-lane.sh` 同名同位置）。 */
const LANE_URL = new URL("../scripts/msys-lane.sh", import.meta.url);

/**
 * 按四条契约扫一段脚本文本，返回违规说明（空数组 = 合规）。
 * 逐行判据而非整段正则：报错要能指出**第几行**，形状守卫才可执行。
 */
export function laneViolations(text: string): string[] {
  const lines = text.split("\n");
  const buildAt = lines.findIndex((line) => line.includes("node --run build"));
  const runAt = lines.findIndex((line) => /vitest\.mjs"? run/u.test(line));
  const problems: string[] = [];

  if (buildAt === -1) {
    problems.push("缺 `node --run build`：车道不再重建副本构件（同步搬不动 gitignore 的 lib/）");
  }
  if (runAt === -1) {
    problems.push("找不到 `vitest.mjs run` 调用行：本守卫的判据失效，先修守卫");
  }
  if (buildAt !== -1 && runAt !== -1 && buildAt > runAt) {
    problems.push(`构建步（第 ${String(buildAt + 1)} 行）在跑套件（第 ${String(runAt + 1)} 行）之后：被测的仍是旧构件`);
  }
  const artifactAt = lines.findIndex(
    (line, i) => i > buildAt && i < (runAt === -1 ? lines.length : runAt) && line.includes("lib/pty/index.js"),
  );
  if (buildAt !== -1 && artifactAt === -1) {
    problems.push("构建步之后没有 `lib/pty/index.js` 存在性判据：建不出来会退化成 e2e 的 loud skip");
  }
  // 契约 4（#133）：loud 计数读 `$log`，而 json reporter 不记 console（机制 / 代价见
  // docs/dev-environment.md §0.1.1）⇒ 跑套件那行必须同时给 default reporter。断言的是**两件必须
  // 同时成立的事**：计数行还在（否则读数能力被删）、reporter 组合还在（否则计数失去输入）。
  // 只看**非注释行**：脚本里解释这两个 reporter 的注释本身含 `--reporter=json` 字样。
  const isComment = (line: string): boolean => line.trimStart().startsWith("#");
  const loudAt = lines.findIndex(
    (line) => !isComment(line) && line.includes('"!! SKIP (loud)"') && line.includes("$log"),
  );
  if (loudAt === -1) {
    problems.push("缺 loud skip 计数行（`grep -c \"!! SKIP (loud)\" \"$log\"`）：读数汇总的 PASS* 信号无从取值");
  }
  const attribAt = lines.findIndex((line) => !isComment(line) && line.includes("含 loud 的档"));
  if (attribAt === -1) {
    problems.push("缺逐档归因行（`含 loud 的档：…`）：只剩总数就答不了票面「影响」要的那一档");
  }
  const jsonAt = lines.findIndex((line) => !isComment(line) && line.includes("--reporter=json"));
  if (jsonAt === -1) {
    problems.push("找不到 `--reporter=json`：本守卫的逐档表判据失效，先修守卫");
  } else if (!lines[jsonAt].includes("--reporter=default")) {
    problems.push(
      `第 ${String(jsonAt + 1)} 行（含 \`--reporter=json\` 的那行）只给了 json reporter：它不记 console ⇒ ` +
        "`$log` 里没有 `!! SKIP (loud)`，loud skip 行数会结构性恒 0（加 `--reporter=default`）",
    );
  }
  return problems;
}

/** 合成文本：形状正确的最小脚本（负例由它删/挪一处得到，**不依赖临时改真文件**）。 */
const HEALTHY = [
  "#!/bin/bash",
  'step "同步：副本 …"',
  'if ! (cd "$COPY" && node --run build) >"$buildlog" 2>&1; then',
  '  fail "副本重建失败"',
  "fi",
  '[ -f "$COPY/lib/pty/index.js" ] || fail "重建后仍没有构件"',
  'runner=(node node_modules/vitest/vitest.mjs run --project "$LANE")',
  '(cd "$COPY" && "${runner[@]}" --reporter=json --reporter=default --outputFile="$JSON_OUT") >"$log" 2>&1',
  'loud=$(grep -c "!! SKIP (loud)" "$log" || true)',
  'printf \'%s\\n\' "$loud_by_file" | sed \'s/^/  含 loud 的档：/\'',
].join("\n");

describe("车道形状检查器（合成文本）", () => {
  it("合规文本：0 违规", () => {
    expect(laneViolations(HEALTHY)).toEqual([]);
  });

  it("删掉构建步 → 报「缺 `node --run build`」", () => {
    const broken = ["#!/bin/bash", 'runner=(node node_modules/vitest/vitest.mjs run --project "$LANE")'].join("\n");
    expect(laneViolations(broken).join(" | ")).toContain("缺 `node --run build`");
  });

  it("构建步挪到跑套件之后 → 报顺序违规", () => {
    const lines = HEALTHY.split("\n");
    const moved = [...lines.slice(0, 2), ...lines.slice(6), ...lines.slice(2, 6)].join("\n");
    expect(laneViolations(moved).join(" | ")).toContain("之后：被测的仍是旧构件");
  });

  it("构建步之后没有构件存在性判据 → 报 loud skip 退化风险", () => {
    const noCheck = HEALTHY.split("\n")
      .filter((line) => !line.includes("lib/pty/index.js"))
      .join("\n");
    expect(laneViolations(noCheck).join(" | ")).toContain("没有 `lib/pty/index.js` 存在性判据");
  });

  // 变异（#133）：把修复**改回只给 json reporter**，守卫必须红 —— 否则新判据等于没牙。
  it("变异：只给 json reporter → 报 loud 计数会结构性恒 0", () => {
    const onlyJson = HEALTHY.split("\n")
      .map((line) => line.replace(" --reporter=default", ""))
      .join("\n");
    expect(laneViolations(onlyJson).join(" | ")).toContain("loud skip 行数会结构性恒 0");
  });

  it("删掉 loud 计数行 → 报「缺 loud skip 计数行」", () => {
    const noLoud = HEALTHY.split("\n")
      .filter((line) => !line.includes("!! SKIP (loud)"))
      .join("\n");
    expect(laneViolations(noLoud).join(" | ")).toContain("缺 loud skip 计数行");
  });

  it("删掉逐档归因行 → 报「缺逐档归因行」（只剩总数答不了「哪一档」）", () => {
    const noAttrib = HEALTHY.split("\n")
      .filter((line) => !line.includes("含 loud 的档"))
      .join("\n");
    expect(laneViolations(noAttrib).join(" | ")).toContain("缺逐档归因行");
  });

  // 契约 4 的判据**不锚行尾**（`includes`），按 `docs/agents/TESTING.md` 的 E11(b)：只需一条
  // LF/CRLF 都命中的 invariance + 一条**锚行尾对照**（展示 A1 的翻车形态），不硬造假报。
  it("E11(b) ①：CRLF 行尾下判据不误报（invariance）", () => {
    expect(laneViolations(HEALTHY.replaceAll("\n", "\r\n"))).toEqual([]);
  });

  it("E11(b) ②：锚行尾的判据在 CRLF 下会假报（对照：本判据为什么不锚 `$`）", () => {
    // A1 的真实形态：按 "\n" 切行，行尾仍带 "\r"。
    const crlfLines = HEALTHY.replaceAll("\n", "\r\n").split("\n");
    const invocation = crlfLines.find((line) => line.includes("--reporter=json")) ?? "";
    expect(/--outputFile="\$JSON_OUT"\)$/u.test(invocation)).toBe(false); // 锚 `$` ⇒ 假报
    expect(/--outputFile="\$JSON_OUT"\)/u.test(invocation)).toBe(true); // 不锚 ⇒ 正确
  });
});

describe("活体仓：scripts/msys-lane.sh", () => {
  it("同步后重建副本构件、构建步在跑套件之前、且 reporter 组合能让 loud 计数取到值", () => {
    const problems = laneViolations(readFileSync(LANE_URL, "utf8"));
    expect(problems, `scripts/msys-lane.sh 与车道契约不符：\n${problems.join("\n")}`).toEqual([]);
  });
});
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
 * 契约三条（判据在 `laneViolations`，负例在第一个 describe）：
 *   1. 存在 `node --run build`；
 *   2. 它的行号**早于**首次 `vitest.mjs run`（先重建再跑）；
 *   3. 构建步之后、跑套件之前有 `lib/pty/index.js` 的存在性判据 —— 建不出来要**在这里响亮失败**，
 *      而不是退化成三档 e2e 的「门禁未开」loud skip（那会把构建坏了说成环境没开）。
 *
 * @module tests/msys-lane.spec.ts
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 被守卫的车道脚本（与 `scripts/msys-lane.sh` 同名同位置）。 */
const LANE_URL = new URL("../scripts/msys-lane.sh", import.meta.url);

/**
 * 按三条契约扫一段脚本文本，返回违规说明（空数组 = 合规）。
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
  '"${runner[@]}"',
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
});

describe("活体仓：scripts/msys-lane.sh", () => {
  it("同步后重建副本构件，且构建步在跑套件之前", () => {
    const problems = laneViolations(readFileSync(LANE_URL, "utf8"));
    expect(problems, `scripts/msys-lane.sh 与车道契约不符：\n${problems.join("\n")}`).toEqual([]);
  });
});
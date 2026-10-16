/**
 * 位置约定守卫：`scripts/*.mjs` 必须配对 `tests/<base>.spec.ts`。
 *
 * 为什么存在：`#83` 补过一次"唯一检查入口自身零覆盖"（`verify-all.mjs`），
 * 而同一缺口在同目录**立刻还有一份**（`verify-pack.mjs`，见 `#86`）。这类缺口不该
 * 靠人肉发现：`vitest.config.ts` 已用位置约定收集测试（`tests/**`，见 #44），
 * 本用例守住它的**对称面** —— 脚本侧不许有"没有 spec 的脚本"。
 *
 * `PENDING` 是**显式欠账单**：每项带票号与理由。名单与事实**逐字相等**（棘轮）——
 * 新增未覆盖脚本会让本用例红；补上 spec 后也必须回来删条目，否则同样红。
 *
 * @module tests/scripts-coverage.spec.ts
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** 尚未配对 spec 的脚本 → 欠账理由（修完必须删条目，见文件头注）。 */
const PENDING: Record<string, string> = {
  "verify-pack.mjs": "#86 装箱检查器无测试，且 import 即执行（待按 #83 模式拆分后补测）",
};

/** 目录下按后缀收集文件名（递归；只取 basename，spec 放子目录也算配对）。 */
function names(dir: string, suffix: string): string[] {
  return readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
    .map((entry) => basename(entry))
    .filter((name) => name.endsWith(suffix))
    .sort();
}

describe("scripts/ ↔ tests/ 位置约定", () => {
  it("every scripts/*.mjs has a matching tests/<base>.spec.ts", () => {
    const specs = new Set(names("tests", ".spec.ts"));
    const uncovered = names("scripts", ".mjs").filter(
      (name) => !specs.has(`${name.replace(/\.mjs$/, "")}.spec.ts`),
    );
    const debt = Object.entries(PENDING)
      .map(([name, why]) => `${name}: ${why}`)
      .join("\n  ");
    expect(uncovered, `仍有脚本没有 spec（显式欠账）:\n  ${debt}`).toEqual(
      Object.keys(PENDING).sort(),
    );
  });
});
/**
 * payload 覆盖率守卫（批 R 批末 e2e 回归的类修复，2026-11-05）。
 *
 * ## 为什么存在
 *
 * `package.json` 的 `files` 字段是**显式枚举**（逐模块 pattern，见 #84 类的 payload
 * 形态）。批 R 的 session-core 重构让 bundler 为三入口（pty/ssh/terminal）共享的
 * session-core 产出了**哈希 chunk**（`lib/session-core-*.js`）——枚举没料到新形态，
 * chunk 不进 payload → 安装后五行 import 全断（真实例 e2e ring4/5 红，
 * `.scratch/verify-r/boot-stderr-probe.mts` 的 stderr 全文抓的现场）。
 *
 * 本守卫把「下一个共享 chunk」从**真实例红**变成**测试期响亮红**：构建产物
 * `lib/*.js`（扁平层，chunk 的住址）必须全部被 files 字段覆盖。
 *
 * ## 判据与边界（declare）
 *
 * - 覆盖判定 = files 的每个 pattern 转正则（`*`→段内任意、`**`→跨段任意），lib 下
 *   扁平 `.js` 逐个对——**显式边界**：只扫扁平 `lib/*.js`（chunk 的产出层）；嵌套
 *   `lib/pty/index.js` 类由逐条 exact pattern 管，`lib/types/*.d.ts` 由 d.ts pattern 管，
 *   都不在本判据面。
 * - lib/ 缺席（新检出没构建过）→ **响亮 skip**（#123 口径：等不到构件就说缺什么，
 *   绝不静默当 pass）。
 * - 负例用**合成输入**钉（files 少一条 → 未覆盖名单点名那个 chunk），不依赖改真文件。
 *
 * @module tests/payload-coverage.spec.ts
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = new URL("..", import.meta.url);
const LIB_DIR = new URL("./lib/", REPO);
const PKG_PATH = new URL("package.json", REPO);

/** files 的一个 pattern 是否覆盖一个 lib 相对路径（`*`→段内、`**`→跨段）。 */
export function patternCovers(pattern: string, relPath: string): boolean {
  const esc = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`).test(relPath);
}

/** 未覆盖的 lib 扁平 .js 名单（files 字段 × 磁盘实体的差集）。 */
export function uncoveredJs(files: string[], libFiles: string[]): string[] {
  return libFiles.filter((f) => !files.some((p) => patternCovers(p, `lib/${f}`)));
}

const libExists = existsSync(LIB_DIR);

describe("payload 覆盖率（lib/*.js ⊆ files 字段）", () => {
  it.skipIf(!libExists)("构建产物的每个 lib/*.js 都被 files 字段覆盖", () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { files?: string[] };
    const files = pkg.files ?? [];
    const libFiles = readdirSync(LIB_DIR).filter(
      (f) => f.endsWith(".js") && !f.endsWith(".d.js"),
    );
    const uncovered = uncoveredJs(files, libFiles);
    expect(
      uncovered,
      `files 枚举漏了构建 chunk（安装后 import 全断的 #186 批 R 形态）——补对应 pattern 或改用覆盖面更宽的形态: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  // 负例（合成输入钉判据，不依赖改真文件）：files 漏掉 session-core chunk 形态时
  // 必须点名它——这正是批 R 真实例红的重放。
  it("负例：files 漏 chunk pattern → 未覆盖名单点名该 chunk", () => {
    const files = ["lib/pty/index.js", "lib/pty-*.js"];
    const libFiles = ["pty/index.js", "pty-core-Ab12.js", "session-core-CO8x_kok.js"];
    // pty/index.js 与 pty-*.js 都不覆盖扁平 chunk（chunk 在 lib/ 扁平层）
    const uncovered = uncoveredJs(files, libFiles);
    expect(uncovered).toContain("session-core-CO8x_kok.js");
  });

  it("正例：补上 chunk pattern → 覆盖", () => {
    const files = ["lib/pty-*.js", "lib/session-core-*.js"];
    expect(uncoveredJs(files, ["session-core-CO8x_kok.js"])).toEqual([]);
  });

  it("patternCovers：`*` 不跨段、`**` 跨段、字面点号不吞", () => {
    expect(patternCovers("lib/pty-*.js", "lib/pty-core-Ab12.js")).toBe(true);
    expect(patternCovers("lib/pty-*.js", "lib/pty/x.js")).toBe(false);
    expect(patternCovers("lib/types/**/*.d.ts", "lib/types/a/b/x.d.ts")).toBe(true);
    expect(patternCovers("lib/pty/index.js", "lib/pty/index.js")).toBe(true);
    expect(patternCovers("lib/pty/index.js", "lib/pty/indexXjs")).toBe(false);
  });
});

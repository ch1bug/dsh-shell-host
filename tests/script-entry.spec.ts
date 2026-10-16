/**
 * 离线单测：`scripts/script-entry.mjs` —— 四个脚本**共用的一份**「直接执行」守卫。
 *
 * 为什么存在（`#85`）：此前 `frontier.mjs` 与 `privacy-scan.mjs` 各自写了一份**字面路径比对**
 * （`resolve(argv1) === fileURLToPath(moduleUrl)`）。经**符号链接**调用时 `argv[1]` 是链接路径而
 * `import.meta.url` 已被 ESM 解析成**真实路径**（Node 默认 `--preserve-symlinks-main` 关闭）→
 * 失配 → 脚本**静默什么都不做并 `exit 0`**。对排批消费者 = 「没跑」伪装成「没有阻塞」；
 * 对 `privacy-scan.mjs`（pre-commit 第 5 步）更刺眼：隐私守卫「没跑」被读成「干净」——
 * 正是本仓最忌的**静默假绿**。
 *
 * 两条验收面（票面 + 评论）：
 *
 * 1. **单元面**：判定是纯函数，realpath 语义 + 链接 / 相对路径两种调用形态都有断言；
 * 2. **端到端面**：真造符号链接跑子进程调用，输出与直接调用**一致**，绝不静默 `exit 0`。
 *
 * @module tests/script-entry.spec.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectInvocation } from "../scripts/script-entry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(repoRoot, "scripts", "script-entry.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href;

/** 本轮临时目录（链接放仓外：不污染工作树，也让「argv[1] 是另一条路径」真的成立）。 */
function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-script-entry-${tag}-`));
}

/**
 * 造一条指向 `target` 的**链接**。Windows 上文件符号链接要有开发者模式 / 管理员权限，
 * 所以拿不到就退到 **junction**（目录联接；同样让字面路径 ≠ 真实路径，同样由 `realpathSync` 解开）。
 * 两者都失败时抛错，由用例按 loud skip 处理。
 */
function linkTo(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath);
    return;
  } catch {
    // 拿不到符号链接权限 —— 落到下面的 junction 退路。
  }
  // 退路：junction（Windows 上的目录联接；拿不到符号链接权限时用它 —— 它同样让
  // `argv[1]` 是另一条路径、同样由 `realpathSync` 解开）。POSIX 上这一步也会抛错，
  // 由调用方按 loud skip 处理。
  symlinkSync(target, linkPath, "junction");
}

/** 跑一条 CLI 子进程；返回 stdout / stderr / status（`cwd` 固定为仓根，与手工调用同形）。 */
function runCli(argv: string[]): { out: string; err: string; status: number | null } {
  const run = spawnSync(process.execPath, argv, { cwd: repoRoot, encoding: "utf8" });
  return { out: run.stdout, err: run.stderr, status: run.status };
}

/** 造链接、跑两侧调用、比对输出；本机造不出链接时 loudly skip 并返回 `null`。 */
function compareDirectAndLinked(
  scriptRel: string,
  args: string[],
  tag: string,
): { direct: string; linked: string } | null | "SKIPPED" {
  const dir = tempDir(tag);
  const scriptPath = join(repoRoot, scriptRel);
  const linkPath = join(dir, "linked.mjs");
  try {
    try {
      linkTo(scriptPath, linkPath);
    } catch (error) {
      console.warn(
        `  !! SKIP (loud) — 本机无法创建符号链接/junction（${String(error)}）—— ` +
          `${scriptRel} 的链接调用形态未验证；需要开发者模式 / 管理员权限`,
      );
      return "SKIPPED";
    }
    const direct = runCli([scriptPath, ...args]);
    const linked = runCli([linkPath, ...args]);
    expect(linked.status, `${scriptRel} 经符号链接调用退出码应与直接调用一致`).toBe(direct.status);
    expect(linked.out, `${scriptRel} 经符号链接调用必须照常跑 CLI（不得静默无输出）`).toBe(direct.out);
    expect(linked.err, `${scriptRel} 经符号链接调用 stderr 应与直接调用一致`).toBe(direct.err);
    return { direct: direct.out, linked: linked.out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 源文件里 `isDirectInvocation` 的函数定义（`function isDirectInvocation(` / `const isDirectInvocation =`）。 */
function definesOwnGuard(source: string): boolean {
  return /\b(?:function|const)\s+isDirectInvocation\b/u.test(source);
}

describe("isDirectInvocation（realpath 语义）", () => {
  it("recognises the script's own path as direct execution", () => {
    expect(isDirectInvocation(SCRIPT_PATH, SCRIPT_URL)).toBe(true);
  });

  it("normalises equivalent path spellings (realpath, not string equality)", () => {
    expect(isDirectInvocation(SCRIPT_PATH.replace(/\\/g, "/"), SCRIPT_URL)).toBe(true);
  });

  it("treats another file — or no argv[1] at all — as an import", () => {
    expect(isDirectInvocation(join(repoRoot, "scripts", "frontier.mjs"), SCRIPT_URL)).toBe(false);
    expect(isDirectInvocation(undefined, SCRIPT_URL)).toBe(false);
  });

  it("compares a RELATIVE argv[1] against the caller's cwd (node does the same)", () => {
    // `node scripts/script-entry.mjs` 传进来的是相对路径；判定要照常认出来，
    // 否则排批脚本按相对路径调用时同样是静默 exit 0。
    const relativePath = relative(process.cwd(), SCRIPT_PATH);
    expect(relativePath).not.toBe(SCRIPT_PATH); // 前置条件：确实是相对形态
    expect(isDirectInvocation(relativePath, SCRIPT_URL)).toBe(true);
  });

  it("fails CLOSED on a missing path or a non-file URL (never crashes, never false-green)", () => {
    // 守卫自己崩掉 = 入口崩，比失配更糟；但判不准时一律判「非直接执行」——
    // 反过来的默认值会让 import 本模块的调用方误跑 CLI。
    expect(isDirectInvocation(join(repoRoot, "scripts", "nope.mjs"), SCRIPT_URL)).toBe(false);
    expect(isDirectInvocation(SCRIPT_PATH, "https://example.invalid/script-entry.mjs")).toBe(false);
    expect(isDirectInvocation(SCRIPT_PATH, "not-a-url")).toBe(false);
    expect(isDirectInvocation("", SCRIPT_URL)).toBe(false);
  });
});

describe("isDirectInvocation（符号链接：本票要修的假绿形态）", () => {
  it("counts a symlinked/linked invocation as direct", () => {
    const dir = tempDir("guard");
    const link = join(dir, "script-entry-link.mjs");
    try {
      try {
        linkTo(SCRIPT_PATH, link);
      } catch (error) {
        console.warn(
          `  !! SKIP (loud): 本机无法创建符号链接（${String(error)}）—— 该形态未验证；需要开发者模式/管理员权限`,
        );
        return;
      }
      expect(link).not.toBe(SCRIPT_PATH); // 前置条件：确实是另一条路径
      expect(isDirectInvocation(link, SCRIPT_URL)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("单一实现（#85：别出现第二/第三份守卫）", () => {
  const OWNERS = ["frontier.mjs", "privacy-scan.mjs", "verify-all.mjs", "verify-pack.mjs"];

  it("every CLI script imports the guard from script-entry.mjs instead of defining its own", () => {
    const offenders = OWNERS.filter((name) => {
      const source = readFileSync(join(repoRoot, "scripts", name), "utf8");
      return definesOwnGuard(source) || !source.includes("./script-entry.mjs");
    });
    expect(
      offenders,
      "仍有脚本自带一份 isDirectInvocation（守卫会再次漂移）：改成从 ./script-entry.mjs 导入",
    ).toEqual([]);
  });

  it("the previous realpath guards are gone from the outlier scripts (#85)", () => {
    // 旧形态的字面比对：`resolve(argv[1]) === fileURLToPath(import.meta.url)`。
    for (const name of ["frontier.mjs", "privacy-scan.mjs"]) {
      const source = readFileSync(join(repoRoot, "scripts", name), "utf8");
      expect(source, `${name} 仍留着字面路径比对`).not.toMatch(
        /resolve\(\s*(?:process\.)?argv\[1\][^\n]*fileURLToPath\(/u,
      );
    }
  });

  it("importing the module is side-effect free (no CLI run)", () => {
    const dir = tempDir("sideeffect");
    const probe = join(dir, "probe.mjs");
    try {
      writeFileSync(probe, `await import(${JSON.stringify(SCRIPT_URL)});\n`);
      const run = runCli([probe]);
      expect(run.status, "import 守卫模块不得因脚本自身 exit 非零").toBe(0);
      expect(run.out, "import 守卫模块不得产生任何输出").toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("端到端：链接调用照常跑 CLI，与直接调用同输出（#85 验收面）", () => {
  it("frontier.mjs --help prints the same usage through a link (was: silent exit 0)", () => {
    // 复现口径就是这条：`node <link-to-frontier.mjs>` **零输出 + exit 0**。
    // `--help` 让用例不依赖 PATH 上的 gh（CLI 取数那半截属环境门禁）。
    const compared = compareDirectAndLinked("scripts/frontier.mjs", ["--help"], "frontier");
    if (compared === "SKIPPED" || compared === null) return;
    expect(compared.direct, "直接调用应打出 usage").toContain("usage: node scripts/frontier.mjs");
    expect(compared.linked, "链接调用必须也打出 usage（不得静默 exit 0）").not.toBe("");
  });

  it("privacy-scan.mjs prints the same reading through a link (was: unverified guard = 'clean')", () => {
    const compared = compareDirectAndLinked(
      "scripts/privacy-scan.mjs",
      ["--root", repoRoot, "--no-history"],
      "privacy",
    );
    if (compared === "SKIPPED" || compared === null) return;
    expect(compared.direct, "直接调用应给出一次读数（干净 或 命中）").toMatch(
      /privacy-scan: (干净|命中)/u,
    );
    expect(compared.linked, "链接调用必须给出同一读数").toBe(compared.direct);
  });
});

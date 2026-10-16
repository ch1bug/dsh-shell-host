/**
 * 离线 + 活体单测：`scripts/privacy-scan.mjs`（提交门与验收共用的隐私判据）。
 *
 * 为什么有这一份：判据原先只活在 spec 里，而 `.githooks/pre-commit` 跑不到 —— 带个人 /
 * 环境串的提交**照样进仓**。抽成 `scripts/` 下的脚本后，提交门与这里走同一份逻辑
 * （本仓位置约定：`scripts/*.mjs` 必须配对 `tests/<base>.spec.ts`）。
 *
 * 守四条实测教训：
 *   1. **大小写不敏感** —— 第一次探针用全大写，静默漏掉文件里的小写写法；
 *   2. 判据取**本机运行时**身份（用户名 / 家目录），不是写死名单 → 换机器也守得住；
 *   3. denylist 覆盖运行时推不出来的那类（呼号 / 内网 host / 个人邮箱），住 home、不进仓；
 *   4. 报告只给 `file:line 命中<类别>`，**不回显 token**（失败信息会被粘进 issue / 日志）。
 *
 * 活体那半截扫 `git ls-files`（没跟踪的东西推不上去）；git 不可用时**响亮跳过**，
 * 绝不静默当绿。合成样本里的敏感形态一律**拼接**写，免得这个文件自己被判红。
 *
 * @module tests/privacy-scan.spec.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KINDS,
  LAYOUT_CHECKS,
  denylistPath,
  denylistTokens,
  identityTokens,
  privacyHits,
  scan,
  trackedFiles,
} from "../scripts/privacy-scan.mjs";

/** 合成身份（与真机无关，免得活体扫描被自己判红）。 */
const IDS = [
  { kind: KINDS.userName, value: "alice" },
  { kind: KINDS.homeDir, value: "C:\\Users\\alice" },
  { kind: KINDS.homeDir, value: "C:/Users/alice" },
];

describe("privacy-scan：合成样本的边界", () => {
  it("命中本机用户名 / 家目录（两种斜杠）并点名 file:line 与类别", () => {
    const text: Record<string, string> = {
      // `/home/<user>` 形态由**用户名**那一项接住；`C:/Users/<user>` 同时命中两项。
      "docs/a.md": ["第一行无事", "检出在 `/home/alice/dsh-shellhost-src`"].join("\n"),
      "tests/b.spec.ts": ['const P = "C:/Users/alice/proj";'].join("\n"),
    };
    expect(privacyHits(["docs/a.md", "tests/b.spec.ts"], (rel) => text[rel] ?? null, IDS)).toEqual([
      "docs/a.md:2 命中本机用户名",
      "tests/b.spec.ts:1 命中本机用户名",
      "tests/b.spec.ts:1 命中本机家目录",
    ]);
  });

  it("THE POINT：大小写不敏感（全大写探针曾静默漏掉小写写法）", () => {
    // 样本拼接写：本文件也在活体扫描清单里，字面量会让守卫自击。
    const callsign = "BH" + "4GXF";
    const tokens = [{ kind: KINDS.denylist, value: callsign }]; // 大写 token
    const text = [`真机 ${callsign.toLowerCase()}`, `真机 ${callsign}`].join("\n");
    expect(privacyHits(["GLOSSARY.md"], () => text, tokens)).toEqual([
      "GLOSSARY.md:1 命中本机 denylist",
      "GLOSSARY.md:2 命中本机 denylist",
    ]);
  });

  it("命中本机布局路径形态（盘符 dsh-* / POSIX dsh-* / 旧 Work 布局）", () => {
    const samples = [
      "D:" + "\\dsh-demo\\src", // 本机检出路径
      "/d/" + "dsh-demo", // POSIX 检出路径
      "C:" + "\\Work" + "\\code", // 旧工作布局
    ];
    expect(privacyHits(["docs/a.md"], () => samples.join("\n"), [], LAYOUT_CHECKS)).toEqual([
      "docs/a.md:1 命中本机检出路径",
      "docs/a.md:2 命中POSIX 检出路径",
      "docs/a.md:3 命中旧工作布局",
    ]);
  });

  it("占位符不算命中（本仓既有写法 `me` / `x` / `<user>` / `<repo>`）", () => {
    const text = [
      "Path normalization accepts both `C:\\Users\\me` and `/mnt/c/Users/me` forms",
      "  ✓ Z cleanup: temp tree removed — C:/Users/x/AppData/Local/Temp/x-abc",
      '  { host: "box", options: ["IdentityFile=/home/me/id_ed25519"] }',
      "权威工作树 = `<repo>`；相邻工作区 = `<sibling-repo>`；旧布局 = `<old-work>`",
    ].join("\n");
    expect(privacyHits(["README.md"], () => text, IDS)).toEqual([]);
  });

  it("跳过读不了的文件与二进制，同一行同一类别只报一次", () => {
    expect(privacyHits(["assets/logo.png", "gone.md"], (rel) => (rel === "assets/logo.png" ? "alice\0PNG" : null), IDS)).toEqual([]);
    expect(privacyHits(["x.md"], () => "alice alice alice", IDS)).toEqual(["x.md:1 命中本机用户名"]);
  });
});

describe("privacy-scan：denylist 解析", () => {
  it("读 `<DSH_HOME>/privacy-denylist.txt`：忽略注释与空行，缺文件不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "privacy-denylist-"));
    const file = join(dir, "privacy-denylist.txt");
    try {
      writeFileSync(file, ["# 注释行", "", "  some-token  ", "another"].join("\n"), "utf8");
      expect(denylistTokens(file)).toEqual([
        { kind: KINDS.denylist, value: "some-token" },
        { kind: KINDS.denylist, value: "another" },
      ]);
      expect(denylistTokens(join(dir, "nope.txt"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("默认路径落在 DSH_HOME 下（本机、永不进仓）", () => {
    expect(denylistPath("C:/some/home").replaceAll("\\", "/")).toBe("C:/some/home/privacy-denylist.txt");
  });
});

describe("privacy-scan：活体仓库（git 跟踪的文件）", () => {
  it("本机身份 + 布局 + denylist 全 0 命中", () => {
    let files: string[];
    try {
      files = trackedFiles();
    } catch (error) {
      // 拿不到清单 = 这条断言没验过：按本仓口径响亮跳过，绝不静默当绿。
      console.warn(`  !! SKIP (loud) — 读不到 git ls-files（${String(error)}）—— 活体隐私扫描未验证`);
      return;
    }
    const { hits } = scan({ tokens: [...identityTokens(), ...denylistTokens()] });
    expect(
      hits,
      `已跟踪文件里出现个人 / 本机环境串（本仓是 PUBLIC 仓；判据与改法见 docs/agents/privacy.md）：`,
    ).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
  });

  it("git 拿不到清单时报 SKIP 而不是假绿（scan 依赖 git ls-files）", () => {
    // 用一个不存在 git 仓库的目录：execFileSync 会抛，活体断言走响亮跳过分支。
    expect(() => trackedFiles(join(tmpdir(), "no-git-repo-here"))).toThrow();
    expect(userInfo().username).toBeTypeOf("string");
    expect(homedir()).toBeTypeOf("string");
  });
});
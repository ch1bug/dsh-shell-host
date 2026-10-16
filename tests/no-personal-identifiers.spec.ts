/**
 * 隐私守卫：**已跟踪文件里不得出现本机的个人标识**（#97 会话 retro 发现，2026-10-16）。
 *
 * 为什么：本仓是 **PUBLIC** 仓，而文档与测试默认值里带着本机用户名与家目录
 * （`/home/<user>/…`、`C:\Users\<user>\…`、`C:/msys64/home/<user>/…`）——推上去
 * 等于把机器布局与账号名一起公开；`tests/e2e-real-llm-machine.spec.ts` 那行更是
 * 直接写出凭据文件的**位置**。人肉发现过一次，就得有机械守卫接住下一次。
 *
 * 判据取**本机运行时**的 `os.userInfo().username` 与 `os.homedir()`，不是一份写死的
 * 名单：换台机器克隆，它守的是那台机器的身份；也不会把示例里的占位符
 * （`C:\Users\me`、`/home/me/…`、`C:/Users/x/…`）误判成本人。命中时**只报
 * file:line 与命中类别**，不把身份词本身写进输出（失败信息会被粘进 issue / 日志）。
 *
 * 边界：只看 **git 跟踪的**文件（没跟踪的东西推不上去）；二进制与读失败的文件跳过；
 * `git` 不可用时**响亮跳过**（`!! SKIP (loud)`），不静默当绿。
 *
 * @module tests/no-personal-identifiers.spec.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** 本机标识的类别（值不落进报告）。 */
type Kind = "本机用户名" | "本机家目录";

/** 本机身份：用户名 + 家目录（两种斜杠写法）；空值不猜。 */
function machineIdentifiers(): Array<{ kind: Kind; value: string }> {
  const user = userInfo().username;
  const home = homedir();
  return [
    ...(user.trim() === "" ? [] : [{ kind: "本机用户名" as Kind, value: user }]),
    ...(home.trim() === "" ? [] : [{ kind: "本机家目录" as Kind, value: home }]),
    ...(home.trim() === "" ? [] : [{ kind: "本机家目录" as Kind, value: home.replaceAll("\\", "/") }]),
  ];
}

/** git 跟踪的文件（本仓无 CI、无 lint，唯一清单来源就是 index）。 */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\0").filter((f) => f !== "");
}

/** 命中清单：`<file>:<line> 命中<类别>`（去重后按文件行序）。 */
export function identifierHits(files: string[], readText: (rel: string) => string | null, ids = machineIdentifiers()): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    const text = readText(rel);
    if (text === null || text.includes("\0")) continue; // 读不了 / 二进制
    text.split("\n").forEach((line, index) => {
      for (const id of ids) {
        if (!line.includes(id.value)) continue;
        const key = `${rel}:${String(index + 1)} 命中${id.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(key);
      }
    });
  }
  return hits;
}

/** 真实文件读取（相对 repoRoot）；读失败返回 null（不是本检查的面）。 */
function readTracked(rel: string): string | null {
  try {
    return readFileSync(join(repoRoot, rel), "utf8");
  } catch {
    return null;
  }
}

describe("隐私守卫自身的边界（合成文本）", () => {
  const IDS = [
    { kind: "本机用户名" as Kind, value: "alice" },
    { kind: "本机家目录" as Kind, value: "C:\\Users\\alice" },
    { kind: "本机家目录" as Kind, value: "C:/Users/alice" },
  ];

  it("命中本机用户名 / 家目录（两种斜杠）并点名 file:line 与类别", () => {
    const files = ["docs/a.md", "tests/b.spec.ts"];
    const text: Record<string, string> = {
      // `/home/<user>` 形态由**用户名**那一项接住；`C:/Users/<user>` 同时命中两项。
      "docs/a.md": ["第一行无事", "检出在 `/home/alice/dsh-shellhost-src`"].join("\n"),
      "tests/b.spec.ts": ["const P = \"C:/Users/alice/proj\";"].join("\n"),
    };
    expect(identifierHits(files, (rel) => text[rel] ?? null, IDS)).toEqual([
      "docs/a.md:2 命中本机用户名",
      "tests/b.spec.ts:1 命中本机用户名",
      "tests/b.spec.ts:1 命中本机家目录",
    ]);
  });

  it("占位符不算命中（本仓既有写法 `me` / `x` / `<user>`）", () => {
    const text = [
      "Path normalization accepts both `C:\\Users\\me` and `/mnt/c/Users/me` forms",
      "  ✓ Z cleanup: temp tree removed — C:/Users/x/AppData/Local/Temp/x-abc",
      "  { host: \"box\", options: [\"IdentityFile=/home/me/id_ed25519\"] }",
    ].join("\n");
    expect(identifierHits(["README.md"], () => text, IDS)).toEqual([]);
  });

  it("跳过读不了的文件与二进制，不因它们变红", () => {
    expect(identifierHits(["assets/logo.png", "gone.md"], (rel) => (rel === "assets/logo.png" ? "alice\0PNG" : null), IDS)).toEqual([]);
  });

  it("同一行命中同一类别只报一次", () => {
    expect(identifierHits(["x.md"], () => "alice alice alice", IDS)).toEqual(["x.md:1 命中本机用户名"]);
  });
});

describe("活体仓库：已跟踪文件里没有本机个人标识", () => {
  it("git 跟踪的每个文件都不含本机用户名 / 家目录", () => {
    let files: string[];
    try {
      files = trackedFiles();
    } catch (error) {
      // 拿不到清单 = 这条断言没验过：按本仓口径响亮跳过，绝不静默当绿。
      console.warn(`  !! SKIP (loud) — 读不到 git ls-files（${String(error)}）—— 隐私守卫未验证`);
      return;
    }
    const hits = identifierHits(files, readTracked);
    expect(
      hits,
      "已跟踪文件里出现本机个人标识（本仓是 PUBLIC 仓）：改用 `~` / `%USERPROFILE%` / `$HOME` / " +
        "`DSH_E2E_*` 覆盖或占位符（`me` / `x` / `<user>`）；位置：",
    ).toEqual([]);
  });
});
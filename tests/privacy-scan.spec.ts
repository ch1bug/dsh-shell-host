/**
 * 离线 + 夹具 + 活体单测：`scripts/privacy-scan.mjs`（提交门与验收共用的隐私判据）。
 *
 * 为什么有这一份：判据原先只活在 spec 里、且只看**文件内容** —— 带个人串的提交能进仓，
 * 提交消息 / 身份 / ref 名三个面根本没判。抽成 `scripts/` 下的脚本后，提交门与这里走
 * 同一份逻辑（本仓位置约定：`scripts/*.mjs` 必须配对 `tests/<base>.spec.ts`）。
 *
 * 非空洞口径：**每条断言都能说出红场景** —— 合成样本锁判定语义，真 git **夹具仓库**
 * 把个人串分别钉在文件 / 提交消息 / 身份 / ref 名 / 待提交消息五个面上，逐面断言命中；
 * 最后一条是**常驻守卫**：真实仓一旦有人提交这类串就红。夹具用完即删（本仓有临时目录
 * 泄漏的教训）。
 *
 * 守四条实测教训：
 *   1. **大小写不敏感** —— 第一次探针用全大写，静默漏掉文件里的小写写法；
 *   2. 判据取**本机运行时**身份（用户名 / 家目录），不是写死名单 → 换机器也守得住；
 *   3. 词表覆盖运行时推不出来的那类（呼号 / 内网 host / 个人邮箱），住 home、不进仓；
 *   4. 报告只给 `发布面:文件:行 命中<类别>`，**不回显 token 与行文**
 *      （输出也是发布面 —— 同一行里可能有第二个身份）。
 *
 * 本文件自己也在被扫清单里，所以样本里的敏感形态一律**拼接**写（`"/home/" + "someone/"`）。
 *
 * @module tests/privacy-scan.spec.ts
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ALLOW_MARKER,
  KINDS,
  defaultTokens,
  denylistPath,
  denylistTokens,
  identityTokens,
  main,
  scanRepo,
  scanText,
  scanTrackerItems,
} from "../scripts/privacy-scan.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** 合成身份（与真机无关，免得活体扫描被自己判红）；结构形态**拼接**写。 */
const SYNTH_USER = "alice";
const IDS = [
  { kind: KINDS.userName, value: SYNTH_USER },
  { kind: KINDS.homeDir, value: ["C:", "\\Users\\", SYNTH_USER].join("") },
  { kind: KINDS.homeDir, value: ["C:/Users/", SYNTH_USER].join("") },
];

const fixtures: string[] = [];
const disposeAll = () => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
};
afterAll(disposeAll);

/** 夹具参数。 */
interface FixtureOptions {
  files?: Record<string, string>;
  message?: string;
  name?: string;
  email?: string;
  branch?: string;
}

/** 造一个真 git 仓库夹具（一次提交；可选分支名 / 身份 / 消息）。 */
function fixture({ files = {}, message = "fixture", name = "Fixture Author", email = "fixture@example.com", branch }: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "privacy-scan-"));
  fixtures.push(root);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]);
  const entries = Object.entries(files);
  if (entries.length === 0) entries.push(["README.md", "fixture\n"]); // git 不能提交空树
  for (const [path, content] of entries) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content, "utf8");
  }
  git(["add", "-A"]);
  git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", message]);
  if (branch !== undefined) git(["branch", branch]);
  return root;
}

const kindsOn = (findings, surface) => findings.filter((f) => f.surface === surface).map((f) => f.kind);

/**
 * 跑 CLI 并**收走 stdout**：`main` 的 loud-skip / 命中行属于命令行输出，
 * 直接漏进车道会让 `verify-all` 把整条 unit 车道标成 `PASS*`（实测踩过）。
 */
function runMain(argv: string[]): { code: number; out: string } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const code = main(argv, REPO);
    const out = spy.mock.calls.map((call) => call.join(" ")).join("\n");
    return { code, out };
  } finally {
    spy.mockRestore();
  }
}

describe("scanText：判定语义（合成样本）", () => {
  it("命中本机用户名 / 家目录 / denylist，且**大小写不敏感**", () => {
    const callsign = "BH" + "4GXF"; // 拼接：本文件也在活体扫描清单里
    const user = "alice"; // 合成身份段；结构形态一律拼接写，免得本文件被自己的结构规则判红
    const tokens = [...IDS, { kind: KINDS.denylist, value: callsign }];
    const text = [
      ["检出在 `/home/", user, "/dsh-shellhost-src`"].join(""),
      ['const P = "C:/Users/', user, '/proj";'].join(""),
      `真机 ${callsign.toLowerCase()} 长流无跳读`,
    ].join("\n");
    expect(scanText(text, tokens)).toEqual([
      { kind: KINDS.userName, line: 1 },
      { kind: KINDS.homePath, line: 1 },
      { kind: KINDS.userName, line: 2 },
      { kind: KINDS.homeDir, line: 2 },
      // `/Users/` 落在 `C:/Users/` 里 → 与 Windows 家目录规则同属一类（规则重叠是有意的）。
      { kind: KINDS.homePath, line: 2 },
      { kind: KINDS.denylist, line: 3 },
    ]);
  });

  it("结构性规则：字面家目录 / Windows 家目录 / 检出 / 旧布局各命中", () => {
    const home = "/home/" + "someone/dsh-src";
    const winHome = "C:" + "\\Users\\" + "someone\\.dsh";
    const checkout = "D:" + "\\dsh-demo\\src";
    const posix = "/d/" + "dsh-demo";
    const work = "C:" + "\\Work" + "\\code";
    expect(scanText([home, winHome, checkout, posix, work].join("\n"), [])).toEqual([
      { kind: KINDS.homePath, line: 1 },
      { kind: KINDS.homePath, line: 2 },
      { kind: KINDS.layoutWin, line: 3 },
      { kind: KINDS.layoutPosix, line: 4 },
      { kind: KINDS.layoutWork, line: 5 },
    ]);
  });

  it("占位符与运行期派生形态豁免（本仓既有写法与容器/CI 路径）", () => {
    const text = [
      "Path normalization accepts both `C:\\Users\\me` and `/mnt/c/Users/me` forms",
      "  ✓ Z cleanup: temp tree removed — C:/Users/x/AppData/Local/Temp/x-abc",
      '  { host: "box", options: ["IdentityFile=/home/me/id_ed25519"] }',
      "WORKDIR /home/agent/workspace",
      "WINHOME=/c/Users/$(whoami)",
      "权威工作树 = `<repo>`；家目录 = `%USERPROFILE%\\.dsh`；DSH_HOME = `~/dsh-shellhost-home`",
      "路径：`C:/Users/<user>/.dsh`",
    ].join("\n");
    expect(scanText(text, IDS)).toEqual([]);
  });

  it("同一行同一类别只报一次", () => {
    expect(scanText("alice alice alice", IDS)).toEqual([{ kind: KINDS.userName, line: 1 }]);
  });

  it("行内 `pii-allow` 标记豁免整行（例外要写在行上、可 review）", () => {
    const text = [
      `真机 ${"BH" + "4GXF"} 长流无跳读 // ${ALLOW_MARKER}: 该行是守卫自身的红场景夹具`,
      "真机 alice 这行没有标记",
    ].join("\n");
    expect(scanText(text, [...IDS, { kind: KINDS.denylist, value: "BH" + "4GXF" }])).toEqual([
      { kind: KINDS.userName, line: 2 },
    ]);
  });
});

describe("denylist 解析", () => {
  it("读 `<DSH_HOME>/privacy-denylist.txt`：忽略注释与空行，缺文件不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "privacy-denylist-"));
    fixtures.push(dir);
    const file = join(dir, "privacy-denylist.txt");
    writeFileSync(file, ["# 注释行", "", "  some-token  ", "another"].join("\n"), "utf8");
    expect(denylistTokens(file)).toEqual([
      { kind: KINDS.denylist, value: "some-token" },
      { kind: KINDS.denylist, value: "another" },
    ]);
    expect(denylistTokens(join(dir, "nope.txt"))).toEqual([]);
  });

  it("默认路径落在 DSH_HOME 下（本机、永不进仓）", () => {
    expect(denylistPath("C:/some/home").replaceAll("\\", "/")).toBe("C:/some/home/privacy-denylist.txt");
  });
});

describe("发布面：真 git 夹具（逐面钉死）", () => {
  it("F1 净夹具：占位符 / 容器路径 / 动态派生 → 无命中", () => {
    const root = fixture({
      files: {
        "docs/guide.md": "安装：`$HOME/dsh-matt-src` 或 `%USERPROFILE%\\.dsh`\n",
        "container/Dockerfile": "WORKDIR /home/agent/workspace\n",
        "scripts/env.sh": "WINHOME=/c/Users/$(whoami)\n",
      },
    });
    const { findings, surfaces } = scanRepo({ root, tokens: [] });
    expect(findings).toEqual([]);
    expect(surfaces.files).toBe(3);
  });

  it("F2/F3 文件面：字面家目录（POSIX 与 Windows 两形）", () => {
    const root = fixture({
      files: {
        "docs/note.md": ["部署副本在 /home/" + "someone/dsh-src（旧机）", "凭据：C:" + "\\Users\\" + "someone\\.dsh"].join("\n"),
      },
    });
    const { findings } = scanRepo({ root, tokens: [] });
    expect(kindsOn(findings, "file")).toEqual([KINDS.homePath, KINDS.homePath]);
  });

  it("F4 提交消息面：消息里的词表 token（大小写不敏感）", () => {
    const root = fixture({ message: "note: SecretName 之后再 retro" });
    const { findings } = scanRepo({ root, tokens: [{ kind: KINDS.denylist, value: "secretname" }] });
    expect(kindsOn(findings, "message")).toEqual([KINDS.denylist]);
  });

  it("F5 身份面：author / committer 里的个人身份", () => {
    const root = fixture({ name: "SecretName", email: "secretname@example.com" });
    const { findings } = scanRepo({ root, tokens: [{ kind: KINDS.denylist, value: "secretname" }] });
    expect(kindsOn(findings, "identity")).toEqual([KINDS.denylist]);
  });

  it("F6 ref 名面：分支名也是发布面", () => {
    const root = fixture({ branch: "secretname-wip" });
    const { findings } = scanRepo({ root, tokens: [{ kind: KINDS.denylist, value: "secretname" }] });
    expect(kindsOn(findings, "ref")).toEqual([KINDS.denylist]);
  });

  it("F7 待提交消息面：pre-commit 窗口里的 `.git/COMMIT_EDITMSG`", () => {
    const root = fixture({ message: "clean fixture" });
    const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const pending = join(root, git(["rev-parse", "--git-path", "COMMIT_EDITMSG"]).trim());
    writeFileSync(pending, "feat: secretname 相关改动\n", "utf8");
    const { findings } = scanRepo({ root, tokens: [{ kind: KINDS.denylist, value: "secretname" }] });
    expect(kindsOn(findings, "pending-message")).toEqual([KINDS.denylist]);
  });

  it("F8 CLI 退出码：有命中 = 1、净 = 0（提交门就是靠这个退出码拦）", () => {
    const dirty = fixture({ files: { "docs/x.md": "副本 /home/" + "someone/dsh-src\n" } });
    const clean = fixture({ files: { "docs/x.md": "副本 $HOME/dsh-matt-src\n" } });
    expect(runMain(["--root", dirty]).code).toBe(1);
    expect(runMain(["--root", clean]).code).toBe(0);
  });

  it("F8b `--denylist <file>`：词表可外置（默认 `<DSH_HOME>/privacy-denylist.txt`）", () => {
    const root = fixture({ files: { "docs/x.md": "正文提到 secretname 就命中\n" } });
    const dir = mkdtempSync(join(tmpdir(), "privacy-denylist-flag-"));
    fixtures.push(dir);
    const file = join(dir, "terms.txt");
    writeFileSync(file, "secretname\n", "utf8");
    expect(runMain(["--root", root, "--denylist", file]).code).toBe(1);
    expect(runMain(["--root", root, "--denylist", join(dir, "missing.txt")]).code).toBe(0);
  });

  it("F9 非 git 目录：响亮跳过（不把缺环境装成通过）", () => {
    const dir = mkdtempSync(join(tmpdir(), "privacy-scan-nogit-"));
    fixtures.push(dir);
    const { code, out } = runMain(["--root", dir]);
    expect(code).toBe(0);
    expect(out).toContain("!! SKIP (loud)");
  });
});

describe("轨迹面（纯函数；gh 只是取件薄壳）", () => {
  it("issue 正文命中结构性规则、评论命中词表 token", () => {
    const home = "/home/" + "someone/dsh-src";
    const findings = scanTrackerItems(
      [
        { surface: "issue", id: "#9", text: `旧机副本 ${home}` },
        { surface: "comment", id: "comment 1 (#9)", text: "正文里提到 secretname 就命中" },
      ],
      [{ kind: KINDS.denylist, value: "secretname" }],
    );
    expect(findings.map((f) => `${f.surface}:${f.kind}`).sort()).toEqual([`comment:${KINDS.denylist}`, `issue:${KINDS.homePath}`]);
  });
});

describe("活体仓库：发布面全扫", () => {
  it("现仓（本机身份 + 布局 + denylist，含消息 / 身份 / ref）0 命中", () => {
    let scanned;
    try {
      scanned = scanRepo({ root: REPO, tokens: defaultTokens() });
    } catch (error) {
      // 拿不到 git = 这条断言没验过：按本仓口径响亮跳过，绝不静默当绿。
      console.warn(`  !! SKIP (loud) — 读不到 git（${String(error)}）—— 活体隐私扫描未验证`);
      return;
    }
    expect(scanned.findings, "已跟踪文件 / 提交消息 / 身份 / ref 里出现个人或本机环境串").toEqual([]);
    // 非空洞锚：三个面都真的扫到了东西（否则"全 0"可能只是没扫）。
    expect(scanned.surfaces.files).toBeGreaterThan(0);
    expect(scanned.surfaces.messages).toBeGreaterThan(0);
    expect(scanned.surfaces.identities).toBeGreaterThan(0);
    expect(identityTokens().length).toBeGreaterThan(0);
    expect(readFileSync(join(REPO, "AGENTS.md"), "utf8").length).toBeGreaterThan(0);
  });
});
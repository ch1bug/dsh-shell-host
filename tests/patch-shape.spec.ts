/**
 * patch 形状守卫：`cordis.patch.yml` 只允许**自有 id 的 insert 行**（`#77`；红线 = ADR-0012）。
 *
 * 为什么存在：这条红线此前**纯人肉守**——全仓唯一碰 `cordis.patch` 的断言随 ADR-0012/0013
 * 与 `tests/descriptor.spec.ts` 一起消失（[History: `06ded1e`]；那条是**正向钉住当时仍存在
 * 的接管行** —— 断言 `terminal-controller` 行的 config ——外加一句单 id 黑名单），此后
 * `tests/*.ts` 里 `cordis.patch` 零命中。它守的是 AGENTS.md 列出的高危面之一（loader 行 /
 * 组合树：*"Never mount a loader row that takes over an upstream row id (ADR-0012)"*）：
 * patch 顶层 `id` 行 = 同 id 接管上游 loader 行或重配其 config（ADR-0012 逐个点名清掉的
 * 三处接管就是这两种形状），本 bundle 只允许 `- insert:` 自有行（GLOSSARY D12/D13）。
 *
 * 红线有两种真实形状（`06ded1e~1:cordis.patch.yml` 里两种都在）：
 *   - **顶层 `id` 行**：`terminal-controller` 行 = 重配上游行的 config；
 *   - **以本包 entry 名 insert 一个上游行 id**：`permission` / `tool-pwsh` 两行 = 同 group
 *     同 id 后行覆盖（它们的 `name` 前缀是合规的，故只有口径 2 的行 id 集合能接住）。
 *
 * 三条形状口径（loader patch 语义 = `{id, insert, name, ...overrides}`，GLOSSARY
 * 『已验证事实』的 "loader patch 语义" 条）：
 *   1. 每个 op 都是 `- insert:` 形状，且**不带任何顶层兄弟字段**（顶层 `id` 即接管）；
 *   2. insert 行 id 集合恰好 `{pty, terminal}`（棘轮：现状已合规，改挂载面必须显式改这里）；
 *   3. 每行的 `name` 以 `dsh-shell-host/` 开头（挂载的是本包自有 entry：README 装配段
 *      写的就是 `name: 'dsh-shell-host/pty'`）。
 *
 * 检查器自身的边界用合成文本用例守着（第一个 describe，含 `!!js` 标签接线），活体仓
 * 扫描在第二个 describe —— 负例因此**不依赖临时改真文件**就能常驻证明有牙齿。
 *
 * @module tests/patch-shape.spec.ts
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

/** patch 文件位置（package.json 的 `dsh.bundle.patch` 指它）。 */
const PATCH_URL = new URL("../cordis.patch.yml", import.meta.url);

/** 允许挂载的行 id（ADR-0013 收窄后本 bundle 的挂载面恰好是这两行）。 */
const OWN_ROW_IDS = ["pty", "terminal"];

/** 自有行的 `name` 前缀（挂载的是本包自有 entry）。 */
const OWN_NAME_PREFIX = "dsh-shell-host/";

/**
 * `!!js` 标签按**原文**读回：patch 里允许出现平台守卫表达式（上游基座与历史写法都有）。
 * 守卫只看形状、不执行表达式，故解析成字符串即可。**接线是活的**：不注册该标签时
 * `yaml` 记为未解析标签告警（实测：值同为原文，差别只在告警）→ `parsePatch` 响亮抛出，
 * 合成用例因此变红。写法沿用随 ADR-0012/0013 删除的那份 descriptor spec 的
 * `customTags: [jsTag]` 块。
 */
const jsTag = {
  tag: "tag:yaml.org,2002:js",
  resolve: (value: string): string => value,
};

/**
 * 解析 patch 文本（`!!js` 按原文读回）→ 原始文档；形状判定见 `patchShapeFindings`。
 *
 * 解析面的告警与错误一律**响亮抛出**（含未注册标签的 `Unresolved tag`）：静默按
 * 降级语义读到的文档，可能和 loader 自己（注册了 js 标签）读到的不是同一份形状。
 */
function parsePatch(text: string): unknown {
  const doc = YAML.parseDocument(text, { customTags: [jsTag] });
  const problems = [...doc.errors, ...doc.warnings].map((problem) => problem.message);
  if (problems.length > 0) {
    throw new Error(`patch 解析有错误/告警：\n${problems.join("\n")}`);
  }
  return doc.toJS();
}

/**
 * 解析 patch 文本并逐条列出违例（空数组 = 合规）。
 *
 * 返回**全部**违例而不是首条：一次改动同时踩两三条口径时要报全（例如顶层 `id` 行
 * 既带兄弟字段、又没有 `insert`、还会改动行 id 集合）。
 */
function patchShapeFindings(text: string): string[] {
  const findings: string[] = [];
  const doc = parsePatch(text);
  if (!Array.isArray(doc)) {
    return [`patch 顶层不是 op 数组（读到 ${typeof doc}）`];
  }
  const rowIds: string[] = [];
  doc.forEach((op, opIndex) => {
    const at = `op[${opIndex}]`;
    if (op === null || typeof op !== "object" || Array.isArray(op)) {
      findings.push(`${at} 不是对象：每个 op 必须是 \`- insert:\` 形状`);
      return;
    }
    const record = op as Record<string, unknown>;
    const siblings = Object.keys(record).filter((key) => key !== "insert");
    if (siblings.length > 0) {
      findings.push(
        `${at} 带顶层字段 ${siblings.map((key) => `\`${key}\``).join(" / ")}：` +
          "只允许 `- insert:`（顶层 `id` 行 = 同 id 接管上游 loader 行或重配其 config，ADR-0012 红线）",
      );
    }
    const rows = record.insert;
    if (!Array.isArray(rows)) {
      findings.push(`${at} 的 \`insert\` 不是行数组：每个 op 必须是 \`- insert:\` 形状`);
      return;
    }
    rows.forEach((row, rowIndex) => {
      const rowAt = `${at}.insert[${rowIndex}]`;
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        findings.push(`${rowAt} 不是行对象：insert 行必须是 \`{id, name, ...}\``);
        return;
      }
      const { id, name } = row as Record<string, unknown>;
      if (typeof id !== "string" || id === "") {
        findings.push(`${rowAt} 缺字符串行 id`);
      } else {
        rowIds.push(id);
      }
      if (typeof name !== "string" || !name.startsWith(OWN_NAME_PREFIX)) {
        findings.push(
          `${rowAt} 的 name 必须是 \`${OWN_NAME_PREFIX}<entry>\` 前缀（读到 ${JSON.stringify(name)}）`,
        );
      }
    });
  });
  // 集合相等（而非计数相等）：多一行、少一行、重复 id 都会落在这一条上。
  const actual = [...rowIds].sort();
  const expected = [...OWN_ROW_IDS].sort();
  if (actual.join(",") !== expected.join(",")) {
    findings.push(
      `insert 行 id 集合 = {${actual.join(", ")}}，期望恰好 {${expected.join(", ")}}` +
        "（改挂载面必须显式改 OWN_ROW_IDS：棘轮口径见文件头注）",
    );
  }
  return findings;
}

/**
 * 合规 fixture 的 YAML 行：两行自有 `insert`，其中 `terminal` 行的 `config` 内容由参数给
 * （默认 `custom: []`）。换 config 的用例因此只需给那几行，不必复制整份 fixture
 * —— 复制会让 fixture 一改就静默漂移。
 */
function ownRows(terminalConfig: string[] = ["        custom: []"]): string[] {
  return [
    "- insert:",
    "    - id: pty",
    "      name: dsh-shell-host/pty",
    "- insert:",
    "    - id: terminal",
    "      name: dsh-shell-host/terminal",
    "      config:",
    ...terminalConfig,
  ];
}

/** 合规的两行自有 insert（负例都拿它当对照面拼）。 */
const OWN_ROWS = ownRows();

describe("形状检查器自身的边界（合成文本）", () => {
  it("合规形状（两行自有 insert、config 随行）返回空", () => {
    expect(patchShapeFindings(OWN_ROWS.join("\n"))).toEqual([]);
  });

  it("`!!js` 表达式按原文读回：不执行、不炸、形状照样合规", () => {
    // 与合规 fixture 只差 terminal 行的 config 内容。
    const withJs = ownRows([
      "        shell: !!js >-",
      "          existsSync('C:\\\\msys64')",
    ]).join("\n");
    const doc = parsePatch(withJs) as Array<{ insert: Array<{ config?: { shell?: unknown } }> }>;
    expect(doc[1].insert[0].config?.shell).toBe("existsSync('C:\\\\msys64')");
    expect(patchShapeFindings(withJs)).toEqual([]);
  });

  it("顶层 `id` 的接管行被拒（同 id 挂上游 loader 行）", () => {
    // 上游行 id 是别人的；本仓历史形状里这一类的实例 = 下一个用例的 `terminal-controller`。
    const takeover = [
      "- id: upstream-row",
      "  name: '@deepseek-ai/dsh-something'",
      ...OWN_ROWS,
    ].join("\n");
    const findings = patchShapeFindings(takeover);
    expect(findings.some((finding) => finding.includes("`id`"))).toBe(true);
  });

  it("顶层 `config` 的上游行重配被拒（config 覆盖不是自有行）", () => {
    const override = [
      "- id: terminal-controller",
      "  config:",
      "    shell: bash",
      ...OWN_ROWS,
    ].join("\n");
    const findings = patchShapeFindings(override);
    expect(findings.some((finding) => finding.includes("`config`"))).toBe(true);
  });

  it("以本包 entry 名 insert 上游行 id 的接管被行集合棘轮接住（`permission` 形状）", () => {
    // ADR-0012 清掉的另两处接管就是这个形状（`06ded1e~1:cordis.patch.yml`）：op 是 `- insert:`、
    // `name` 前缀也合规，故本用例里开火的**只有**口径 2 的行 id 集合（`name` 写成外来值的
    // 变体由后面的前缀用例接住）。
    const sameIdTakeover = [
      "- insert:",
      "    - id: permission",
      "      name: dsh-shell-host/permission-presets",
      "      config:",
      "        presets: {}",
      ...OWN_ROWS,
    ].join("\n");
    const findings = patchShapeFindings(sameIdTakeover).join("\n");
    expect(findings).toContain("行 id 集合");
    expect(findings).toContain("= {permission, pty, terminal}");
  });

  it("非 `- insert` 形状的 op 被拒（缺 insert / 只有兄弟字段）", () => {
    const shapeless = ["- name: dsh-shell-host/pty", ...OWN_ROWS].join("\n");
    const findings = patchShapeFindings(shapeless);
    expect(findings.some((finding) => finding.includes("`insert` 不是行数组"))).toBe(true);
    // 这里的 `name` 是 **op 的兄弟字段**（口径 1），不是行 name 前缀（口径 3）——消息须点名该字段，
    // 否则断言会因另一条口径的消息而"看似通过"。
    expect(findings.some((finding) => finding.includes("带顶层字段 `name`"))).toBe(true);
  });

  it("`insert` 是字符串（指装载容器的形态）被拒：只认数组形式的自有行", () => {
    // GLOSSARY 记的 record 形状 `{id, insert, name, …overrides}` 给 `insert` 留了「字符串 = 指容器」
    // 的解读空间：那种形态既不是自有行，也可能把行挪进上游容器 —— 本守卫只认行数组。
    const containerInsert = ["- insert: web-app", ...OWN_ROWS].join("\n");
    const findings = patchShapeFindings(containerInsert);
    expect(findings.some((finding) => finding.includes("`insert` 不是行数组"))).toBe(true);
  });

  it("顶层不是 op 数组被拒（防御分支）", () => {
    expect(patchShapeFindings("just a scalar").join("\n")).toContain("patch 顶层不是 op 数组");
  });

  it("op 本身是数组被拒（防御分支）", () => {
    expect(patchShapeFindings("- [a, b]").join("\n")).toContain("不是对象");
  });

  it("行 id 集合是棘轮：多一行 / 少一行都被拒", () => {
    const extra = [
      "- insert:",
      "    - id: extra",
      "      name: dsh-shell-host/extra",
      ...OWN_ROWS,
    ].join("\n");
    const extraText = patchShapeFindings(extra).join("\n");
    expect(extraText).toContain("行 id 集合");
    expect(extraText).toContain("= {extra, pty, terminal}");

    const missing = ["- insert:", "    - id: pty", "      name: dsh-shell-host/pty"].join("\n");
    const missingText = patchShapeFindings(missing).join("\n");
    expect(missingText).toContain("行 id 集合");
    expect(missingText).toContain("= {pty}");
    expect(missingText).toContain("期望恰好 {pty, terminal}");
  });

  it("重复行 id 被拒（集合相等而非计数相等）", () => {
    const duplicated = [
      "- insert:",
      "    - id: pty",
      "      name: dsh-shell-host/pty",
      "- insert:",
      "    - id: pty",
      "      name: dsh-shell-host/pty",
      "- insert:",
      "    - id: terminal",
      "      name: dsh-shell-host/terminal",
    ].join("\n");
    expect(patchShapeFindings(duplicated).join("\n")).toContain("= {pty, pty, terminal}");
  });

  it("`name` 前缀不是自有 entry 的被拒", () => {
    const foreign = [
      "- insert:",
      "    - id: pty",
      "      name: other-bundle/pty",
      "- insert:",
      "    - id: terminal",
      "      name: dsh-shell-host/terminal",
    ].join("\n");
    const findings = patchShapeFindings(foreign);
    expect(findings.some((finding) => finding.includes("name 必须是"))).toBe(true);
  });

  it("非对象行 / 缺字符串行 id 被拒", () => {
    const malformed = [
      "- insert:",
      "    - dsh-shell-host/pty",
      "- insert:",
      "    - name: dsh-shell-host/terminal",
    ].join("\n");
    const findings = patchShapeFindings(malformed);
    expect(findings.some((finding) => finding.includes("不是行对象"))).toBe(true);
    expect(findings.some((finding) => finding.includes("缺字符串行 id"))).toBe(true);
  });
});

describe("活体仓：cordis.patch.yml 的形状（`#77` 棘轮）", () => {
  it("只以自有 id 的 insert 行挂载：无顶层 id 接管、无上游行 config 覆盖（ADR-0012）", () => {
    const findings = patchShapeFindings(readFileSync(PATCH_URL, "utf8"));
    expect(findings, "cordis.patch.yml 踩到 ADR-0012 红线（findings 见上）").toEqual([]);
  });
});
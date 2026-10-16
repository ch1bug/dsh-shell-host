/**
 * 离线单测：`scripts/frontier.mjs` 的纯逻辑。
 *
 * 只测 `readyFrontier()` 与 `parseArgs()`（不碰 gh I/O）——CLI 那半截需要 PATH 上有
 * 已登录的 `gh`，属环境门禁，不由本套件覆盖。
 *
 * 最关键的一条是**正文文字不影响结果**：整个脚本的存在理由就是"别读票面文字"，
 * 若它悄悄回退到读正文，本用例必须红。
 *
 * @module tests/frontier.spec.ts
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_LABEL, parseArgs, readyFrontier } from "../scripts/frontier.mjs";

/** 造一张票；`body` 显式保留，用来证明它被忽略。 */
function issue(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `ticket ${number}`,
    labels: [DEFAULT_LABEL],
    assignees: [],
    state: "open",
    ...over,
  };
}

describe("readyFrontier", () => {
  it("keeps a labelled, unblocked, unassigned issue on the frontier", () => {
    const { frontier, gated } = readyFrontier([issue(1)], new Map());
    expect(frontier.map((i) => i.number)).toEqual([1]);
    expect(gated).toEqual([]);
  });

  it("gates an issue with an OPEN blocker and reports the blocker", () => {
    const { frontier, gated } = readyFrontier([issue(1)], new Map([[1, [2]]]));
    expect(frontier).toEqual([]);
    expect(gated.map((i) => i.number)).toEqual([1]);
    expect(gated[0]?.blockers).toEqual([2]);
  });

  it("does NOT gate on an already-satisfied (closed) edge", () => {
    // 调用方只把 open 阻塞放进 map；已关闭的边不进 map = 不 gate。
    // 这正是 issue_dependencies_summary.blocked_by 读不出来的形态。
    const { frontier } = readyFrontier([issue(1)], new Map());
    expect(frontier.map((i) => i.number)).toEqual([1]);
  });

  it("gates on assignee alone", () => {
    const { frontier, gated } = readyFrontier([issue(1, { assignees: ["someone"] })], new Map());
    expect(frontier).toEqual([]);
    expect(gated[0]?.assignees).toEqual(["someone"]);
  });

  it("ignores issues without the requested label", () => {
    const { frontier, gated } = readyFrontier([issue(1, { labels: ["bug"] })], new Map());
    expect(frontier).toEqual([]);
    expect(gated).toEqual([]);
  });

  it("accepts a custom label", () => {
    const issues = [issue(1, { labels: ["ready-for-human"] })];
    expect(readyFrontier(issues, new Map(), { label: "ready-for-human" }).frontier).toHaveLength(1);
    expect(readyFrontier(issues, new Map()).frontier).toEqual([]);
  });

  it("treats state case-insensitively (gh list gives OPEN, gh api gives open)", () => {
    // 实测差异：`gh issue list --json state` → "OPEN"；REST `gh api` → "open"。
    // 首版按小写比较会把全部票丢掉、frontier 输出 0。
    for (const state of ["open", "OPEN", "Open"]) {
      const { frontier } = readyFrontier([issue(1, { state })], new Map());
      expect(frontier.map((i) => i.number), `state=${state}`).toEqual([1]);
    }
  });

  it("drops closed issues", () => {
    for (const state of ["closed", "CLOSED"]) {
      const { frontier, gated } = readyFrontier([issue(1, { state })], new Map());
      expect(frontier).toEqual([]);
      expect(gated).toEqual([]);
    }
  });

  it("THE POINT: issue body text never affects the result", () => {
    // 脚本的存在理由：原生的依赖边是权威，正文只是叙述（会过期）。
    // 正文写满阻塞字样，只要边不存在，就该照常进 frontier。
    const body = [
      "## Blocked by",
      "- #59",
      "- #56, #57, #58",
      "Blocked by: #1, #2, #3",
    ].join("\n");
    const { frontier } = readyFrontier([issue(1, { body })], new Map());
    expect(frontier.map((i) => i.number)).toEqual([1]);
  });

  it("sorts both buckets by issue number", () => {
    const issues = [issue(5), issue(2), issue(9, { assignees: ["x"] }), issue(7)];
    const { frontier, gated } = readyFrontier(issues, new Map([[7, [1]]]));
    expect(frontier.map((i) => i.number)).toEqual([2, 5]);
    expect(gated.map((i) => i.number)).toEqual([7, 9]);
  });
});

describe("parseArgs", () => {
  it("defaults to no overrides", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("reads --label / --repo / --json", () => {
    expect(parseArgs(["--label", "ready-for-human", "--repo", "o/n", "--json"]))
      .toEqual({ label: "ready-for-human", repo: "o/n", json: true });
  });

  it("recognises --help and -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });
});
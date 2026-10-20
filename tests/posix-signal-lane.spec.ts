/**
 * 离线单测：`scripts/posix-signal-lane.mjs` 的**纯函数**面（`#144`）。
 *
 * 为什么这档值得存在：车道本身要在 Linux 容器里跑（`node:24-bookworm-slim` + 真
 * `@lydell/node-pty`），Windows 上跑不起来 —— 但**判据**（needle 的回声免疫、`/proc` 组归属、
 * 退出码三态、容器装配面、依赖锚的来源）全是纯逻辑，能在 unit 车道里确定性地锁住。
 * 判据一坏，车道的绿就变成**空洞的绿**（这正是本仓「绿 != 验过」那条纪律的反面样本）。
 *
 * 本档**不起容器、不碰 `/proc`、不 spawn 任何进程**：只 import 纯函数。车道被 import 时
 * （`isDirectInvocation` 之外的路径）**没有副作用** —— 那正是它进不了 Windows 默认车道的机制。
 *
 * @module tests/posix-signal-lane.spec.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  containerPlan,
  formatCheck,
  groupMembersIn,
  judgeChecks,
  parseArgs,
  scenarioCommand,
  trapPid,
} from "../scripts/posix-signal-lane.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** 一份「像真的」安装规格：单测不该依赖 `package.json` 此刻写了哪一版。 */
const NODE_PTY_SPEC = "@lydell/node-pty@1.2.0-beta.15";

describe("posix-signal-lane · CLI 形态（host / 容器内 probe / AC5 的守卫）", () => {
  it("默认走 host 半边；`--in-container` 只在 Linux 上认", () => {
    expect(parseArgs([], "win32")).toEqual({ mode: "host" });
    expect(parseArgs([], "linux")).toEqual({ mode: "host" });
    expect(parseArgs(["--in-container"], "linux")).toEqual({ mode: "probe" });
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });

  it("AC5：`--in-container` 在 win32 上被响亮拒绝（那半边要 /proc 与 POSIX 信号）", () => {
    const refused = parseArgs(["--in-container"], "win32");
    expect(refused.error).toBeDefined();
    expect(refused.error).toContain("Linux");
    // 对照：同一组参数在 Linux 上就是合法的 —— 拒绝的是平台，不是这个开关本身。
    expect(parseArgs(["--in-container"], "linux").mode).toBe("probe");
  });

  it("未知参数是 caller error（不静默忽略；退出码走「没跑」那一档）", () => {
    expect(parseArgs(["--nope"]).error).toContain("未知参数");
    expect(parseArgs(["--in-container", "extra"]).error).toContain("未知参数");
  });

  it("AC5：车道住在 scripts/ 下，而 unit 车道按位置只收集 tests/ 下的 spec ⇒ 结构上进不了默认车道", () => {
    // 真机制：`vitest.config.ts` 的 `specInclude = ["tests/**/*.spec.ts", …]`（按位置收集，
    // 见 #44），machine 车道是显式清单。两边都碰不到 `scripts/` 下的文件。
    const scriptAbs = fileURLToPath(new URL("../scripts/posix-signal-lane.mjs", import.meta.url));
    expect(existsSync(scriptAbs), "车道的收集面外还得真存在（不是靠改配置藏起来）").toBe(true);
    expect(scriptAbs.endsWith(".spec.ts"), "车道不是 spec（否则位置约定会把它收进 unit 车道）").toBe(false);
    const config = readFileSync(fileURLToPath(new URL("../vitest.config.ts", import.meta.url)), "utf8");
    expect(config).toContain("tests/**/*.spec.ts");
    expect(config).not.toContain("scripts/posix-signal-lane");
  });
});

describe("posix-signal-lane · 容器装配面", () => {
  it("只读挂 src/ 与 scripts/（不挂仓库根：win32 的 node_modules 会骗过 node-pty 的平台包）", () => {
    const plan = containerPlan({ repoRoot, nodePtySpec: NODE_PTY_SPEC });
    expect(plan.mounts).toHaveLength(2);
    expect(plan.mounts[0]).toMatch(/src:\/work\/src:ro$/u);
    expect(plan.mounts[1]).toMatch(/scripts:\/work\/scripts:ro$/u);
    for (const mount of plan.mounts) expect(mount).not.toMatch(/node_modules|\.scratch/u);
  });

  it("podman argv 的形态：`run --rm`、钉死镜像、不以提权换方便", () => {
    const plan = containerPlan({ repoRoot, nodePtySpec: NODE_PTY_SPEC });
    expect(plan.argv[0]).toBe("podman");
    expect(plan.argv).toContain("run");
    expect(plan.argv).toContain("--rm");
    expect(plan.argv).toContain("node:24-bookworm-slim");
    expect(plan.argv).not.toContain("--privileged");
    // 挂载以 `-v <spec>` 成对出现（argv 里不许出现「拼坏的」短选项）。
    expect(plan.argv.filter((arg) => arg === "-v")).toHaveLength(plan.mounts.length);
  });

  it("依赖锚是**单一来源**：版本串由调用方给，换一版命令跟着换（没有第二份字面量）", () => {
    const bumped = containerPlan({ repoRoot, nodePtySpec: "@lydell/node-pty@9.9.9-test" });
    expect(bumped.command).toContain("@lydell/node-pty@9.9.9-test");
    // 反证：如果脚本里还藏着一份 `1.2.0-beta.15` 的字面量，这条会红。
    expect(bumped.command).not.toContain("1.2.0-beta.15");
    // 缺了它就构造不出来（不许回落到硬编码版本）。
    expect(() => containerPlan({ repoRoot })).toThrow(/nodePtySpec/u);
  });

  it("容器内装配：最小 package.json 带 type=module、装给定版本的 node-pty、失败走 exit 2、再跑 probe", () => {
    const { command } = containerPlan({ repoRoot, nodePtySpec: NODE_PTY_SPEC });
    // `"type":"module"` 是必需的：`.ts` 的模块格式取自最近 package.json（缺了就是 CJS，import 直接炸）。
    expect(command).toContain('"type":"module"');
    expect(command).toContain("npm install --no-save");
    expect(command).toContain(NODE_PTY_SPEC);
    expect(command).toContain("LANE-UNAVAILABLE");
    expect(command).toContain("exit 2");
    expect(command).toContain("--in-container");
    // 失败分支必须在 probe 之前（否则「装不上」会被读成「判定为红」）。
    expect(command.indexOf("exit 2")).toBeLessThan(command.indexOf("--in-container"));
    // probe 的读数行要能自报版本（容器里没有本仓 package.json）。
    expect(command).toContain("LANE_PTY_SPEC");
  });

  it("不 exec node：probe 不能变成容器 PID 1（否则孤儿僵尸让「组已清空」永远不成立）", () => {
    const { command } = containerPlan({ repoRoot, nodePtySpec: NODE_PTY_SPEC });
    expect(command).not.toMatch(/exec node/u);
    expect(command).toMatch(/^node \/work\/scripts\/posix-signal-lane\.mjs/mu);
  });
});

describe("posix-signal-lane · 判据：回声帧不算命中（needle 纪律）", () => {
  it("命令文本里的 `pid=$$` 未展开 ⇒ 五个场景的回声帧都满足不了 needle", () => {
    for (const kind of ["leader", "exit-trap", "group-child", "job-control", "async-child"]) {
      const command = scenarioCommand(kind);
      expect(command, `${kind} 的命令必须带未展开的 $$（判据的另一半）`).toContain("$$");
      expect(trapPid(`  $ ${command}`, "leaderFired"), `${kind} 的回声帧不得命中`).toBeUndefined();
      expect(trapPid(`  $ ${command}`, "childFired"), `${kind} 的回声帧不得命中`).toBeUndefined();
    }
  });

  it("展开帧命中，并取回那个数字（true 读数）", () => {
    expect(trapPid("P-READY pid=23\r\n", "leaderReady")).toBe(23);
    expect(trapPid("P-FIRED pid=23\r\n", "leaderFired")).toBe(23);
    expect(trapPid("C-READY pid=37\r\n", "childReady")).toBe(37);
    expect(trapPid("C-FIRED pid=37\r\n", "childFired")).toBe(37);
  });

  it("领导者的 needle 不得被子进程的标记满足（反之亦然）", () => {
    expect(trapPid("C-FIRED pid=37", "leaderFired")).toBeUndefined();
    expect(trapPid("P-FIRED pid=23", "childFired")).toBeUndefined();
  });

  it("场景命令各自带对应的 trap 形态（sanity：exit / 前台 / 作业控制 / 异步 都在）", () => {
    expect(scenarioCommand("exit-trap")).toContain("exit 0");
    expect(scenarioCommand("job-control")).toMatch(/^set -m;/u);
    // 前台子命令：它**不是**异步命令（`& wait` 是 AC4 正向会假读的形态）。
    expect(scenarioCommand("group-child")).toContain("/bin/sh -c 'trap");
    expect(scenarioCommand("group-child")).not.toContain("& wait");
    // 异步：票面建议的形态（`& wait`）。
    expect(scenarioCommand("async-child")).toContain("& wait");
  });

  it("未知场景 / 未知 needle 都是响亮错误（不静默返回 undefined）", () => {
    expect(() => scenarioCommand("nope")).toThrow(/未知场景/u);
    expect(() => trapPid("P-FIRED pid=23", "nope")).toThrow(/未知 needle/u);
  });
});

describe("posix-signal-lane · /proc 组归属", () => {
  /**
   * 合成 `/proc/<pid>/stat`：`pid (comm) state ppid pgrp …`。
   * 第二个条目的 comm 里刻意带空格与右括号 —— 真机上（`(my (weird) comm)`）会踩。
   */
  const entries = [
    { pid: 23, stat: "23 (sh) S 16 23 23 34816 23 4194560 43 0 0 0 0 0 0 0 20 0 1 0 100 0 0" },
    { pid: 25, stat: "25 (my (weird) comm) S 23 23 23 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 100 0 0" },
    { pid: 31, stat: "31 (sleep) S 25 23 23 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 100 0 0" },
    { pid: 99, stat: "99 (other) S 1 99 99 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 100 0 0" },
  ];

  it("只收同一 pgrp，且 comm 里的空格 / 右括号不影响解析", () => {
    expect(groupMembersIn(entries, 23)).toEqual([23, 25, 31]);
    expect(groupMembersIn(entries, 99)).toEqual([99]);
    expect(groupMembersIn(entries, 12345)).toEqual([]);
    expect(groupMembersIn([], 23)).toEqual([]);
  });

  it("畸形 stat（没有 comm 的右括号）被跳过，不炸", () => {
    expect(groupMembersIn([{ pid: 7, stat: "garbage" }], 7)).toEqual([]);
  });
});

describe("posix-signal-lane · 判定与读数形态", () => {
  it("全部成立才 PASS；空读数是「没跑」，不是绿", () => {
    expect(judgeChecks([]).exitCode).toBe(1);
    expect(judgeChecks([]).ok).toBe(false);
    expect(judgeChecks([{ id: "a", ok: true, detail: "" }]).exitCode).toBe(0);
    const mixed = judgeChecks([
      { id: "a", ok: true, detail: "" },
      { id: "ac2-trap-fires", ok: false, detail: "未命中" },
    ]);
    expect(mixed.ok).toBe(false);
    expect(mixed.exitCode).toBe(1);
    expect(mixed.failures).toEqual(["ac2-trap-fires"]);
  });

  it("读数行形态：`[OK  ]` / `[FAIL]` + id + 实测细节（汇总里的固定读法）", () => {
    expect(formatCheck({ id: "ac2-trap-fires", ok: true, detail: "P-FIRED pid=23" })).toBe(
      "[OK  ] ac2-trap-fires — P-FIRED pid=23",
    );
    expect(formatCheck({ id: "ac2-trap-fires", ok: false, detail: "未命中" })).toBe(
      "[FAIL] ac2-trap-fires — 未命中",
    );
  });
});

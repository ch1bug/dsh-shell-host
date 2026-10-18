/**
 * `tests/helpers/lib-snapshot.ts` 的离线单测（#123）。
 *
 * 这个 helper 是**并发窗口免疫**的载体，故它自己必须被钉住 —— 否则"免疫"只是说法。
 * 三条判据对应票面 AC：
 *   - **AC1**（窗口免疫）：快照之后的读数**与活动树此后怎么变无关**（本文件用"复制完再删活动树"
 *     演示：读者仍读到完整快照）。这条反证了"轮询等就位"那版的老路 —— 老路在同一个场景下必红。
 *   - **AC2**（失败自报判据）：真前提缺失时的文案必须**点名"判据 1/1b"**，且不得把
 *     读者引向"没走到 loud skip"这个错误结论。
 *   - **AC3**（覆盖不静默丢）：复制到半棵树必须**响亮抛错**，不得静默返回半个快照。
 *
 * 全离线（自造 fixture + 临时目录），不碰权威树、不 spawn 任何东西。
 *
 * @module tests/lib-snapshot.spec.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIB_ENTRY_FILES,
  libLooksRebuilt,
  pointerMissReport,
  snapshotLib,
  waitForTreeReady,
  waitForTreeReadyBriefly,
} from "./helpers/lib-snapshot.ts";

/** 临时目录（调用方 finally 清）。 */
function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `lib-snapshot-spec-${tag}-`));
}

/** 在一棵 fixture 仓里铺出 `lib/` 的三个入口文件 + 一个 chunk（快照完整性的最小面）。 */
function seedLib(root: string): void {
  for (const relative of [...LIB_ENTRY_FILES, "lib/pty-C0_H63de.js"]) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `// ${relative}\n`);
  }
}

describe("snapshotLib：冻结快照", () => {
  it("THE POINT (#123 AC1)：快照之后的读数与活动树此后怎么变**无关**", () => {
    const repo = tempDir("freeze");
    try {
      seedLib(repo);
      const snapshot = snapshotLib(repo, LIB_ENTRY_FILES, "freeze");
      try {
        // 前置条件：快照真的存在（否则下面的断言可能因"本来就没有"而假绿）。
        expect(existsSync(join(snapshot.libDir, "pty", "index.js"))).toBe(true);

        // **写者动手**：删掉活动树整棵 `lib/`（模拟 clean-lib 的重建窗口全开）。
        rmSync(join(repo, "lib"), { recursive: true, force: true });
        expect(existsSync(join(repo, "lib", "pty", "index.js"))).toBe(false);

        // AC1：读者仍读到**完整**快照 —— 窗口对它已永久关闭。
        expect(existsSync(join(snapshot.libDir, "pty", "index.js"))).toBe(true);
        expect(existsSync(join(snapshot.libDir, "terminal", "index.js"))).toBe(true);
        expect(existsSync(join(snapshot.libDir, "wsl-plugin", "index.js"))).toBe(true);
        expect(readFileSync(join(snapshot.libDir, "pty", "index.js"), "utf8")).toContain(
          "lib/pty/index.js",
        );
        // 反证"老路的病"：活动树此刻确实读不到了 —— 若读者还在读活动树，这里就是那次红。
        expect(existsSync(join(repo, "lib", "pty", "index.js"))).toBe(false);
        // 快照**只读复制**，不得反过来改权威树（此刻它已被本用例自己删了，故只断言副本不写回）。
        expect(libLooksRebuilt(snapshot.libDir)).toBe(true);
      } finally {
        snapshot.dispose();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("AC3：复制到半棵树时**响亮抛错**，不静默返回半个快照", () => {
    // 半棵：只有 pty 入口，terminal / wsl-plugin 不在（这正是写者窗口里的真实形态）。
    const repo = tempDir("half");
    try {
      seedLib(repo);
      rmSync(join(repo, "lib", "terminal"), { recursive: true, force: true });
      expect(() => snapshotLib(repo, LIB_ENTRY_FILES, "half")).toThrow(/快照不完整/u);
      // 报错必须**点名缺了谁** —— 否则拿到红的人不知道是窗口还是真缺件。
      expect(() => snapshotLib(repo, LIB_ENTRY_FILES, "half")).toThrow(/lib\/terminal\/index\.js/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("AC3：抛错时**不留残留**副本（不留半个快照在 %TEMP%）", () => {
    const repo = tempDir("leak");
    const before = readTmpSnapshotNames();
    try {
      seedLib(repo);
      rmSync(join(repo, "lib", "wsl-plugin"), { recursive: true, force: true });
      expect(() => snapshotLib(repo, LIB_ENTRY_FILES, "leak")).toThrow();
      // 失败路径同样要回收 —— 否则每次窗口都往 %TEMP% 丢一个半个副本。
      expect(readTmpSnapshotNames()).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("dispose 删掉整棵副本根（幂等）", () => {
    const repo = tempDir("dispose");
    try {
      seedLib(repo);
      const snapshot = snapshotLib(repo, LIB_ENTRY_FILES, "dispose");
      expect(existsSync(snapshot.root)).toBe(true);
      snapshot.dispose();
      expect(existsSync(snapshot.root)).toBe(false);
      snapshot.dispose(); // 幂等：第二次不抛错
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/** `%TEMP%` 下本 helper 的快照目录名（快照残留判据用）。 */
function readTmpSnapshotNames(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("dsh-lib-snapshot-"))
    .sort();
}

describe("waitForTreeReady：等一次稳定读数", () => {
  it("指针一开始就齐 ⇒ 立刻返回空（不白等满上界）", async () => {
    const repo = tempDir("ready");
    try {
      seedLib(repo);
      const started = Date.now();
      const { missing, elapsedMs } = await waitForTreeReady(LIB_ENTRY_FILES, (rel) => join(repo, rel), {
        timeoutMs: 5_000,
        pollMs: 20,
      });
      expect(missing).toEqual([]);
      // 只需要一轮"确认仍齐"的复探，不该接近上界。
      expect(Date.now() - started).toBeLessThan(2_000);
      // 新增读数（#123 自查）：实际等待时长必须一并返回，供调用方如实报告。
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("指针中途出现 ⇒ 等到它就位后返回空（等待的是 main() 自己的前置条件）", async () => {
    const repo = tempDir("appears");
    try {
      seedLib(repo);
      rmSync(join(repo, "lib", "terminal"), { recursive: true, force: true });
      // 100 ms 后"重建"完成：这正是写者窗口关闭的形态。
      const timer = setTimeout(() => {
        mkdirSync(join(repo, "lib", "terminal"), { recursive: true });
        writeFileSync(join(repo, "lib", "terminal", "index.js"), "// rebuilt\n");
      }, 100);
      try {
        const { missing } = await waitForTreeReady(LIB_ENTRY_FILES, (rel) => join(repo, rel), {
          timeoutMs: 5_000,
          pollMs: 20,
        });
        expect(missing).toEqual([]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("指针始终不出现 ⇒ 返回仍缺失的清单，**不降级为 skip**（调用方据此响亮失败）", async () => {
    const repo = tempDir("absent");
    try {
      seedLib(repo);
      rmSync(join(repo, "lib", "wsl-plugin"), { recursive: true, force: true });
      const { missing, elapsedMs } = await waitForTreeReady(LIB_ENTRY_FILES, (rel) => join(repo, rel), {
        timeoutMs: 60,
        pollMs: 20,
      });
      expect(missing).toEqual(["lib/wsl-plugin/index.js"]);
      // 这条**没有**早退（不带 `absentRounds`）⇒ 实际等待 ≈ 上界。
      expect(elapsedMs).toBeGreaterThanOrEqual(40);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("waitForTreeReadyBriefly：缺席时提前收手（#123 的成本回退）", () => {
  it("THE POINT：一件都没出现 ⇒ 提前收手，**不耗满上界**（新检出的响亮跳过要立刻）", async () => {
    const repo = tempDir("brief-absent");
    try {
      // 整棵 lib/ 都没有 = 从没构建过。此时等满 60 s 毫无意义（结论与提前收手相同）。
      const started = Date.now();
      const { missing, elapsedMs } = await waitForTreeReadyBriefly(
        LIB_ENTRY_FILES,
        (rel) => join(repo, rel),
        { timeoutMs: 30_000, pollMs: 20, absentRounds: 3 },
      );
      // 结论与慢等的完全一致：仍然缺这三件（调用方据此**响亮**跳过）。
      expect(missing).toEqual([...LIB_ENTRY_FILES]);
      // 关键：提前收手。3 轮 × 20 ms ≈ 60 ms，离 30 s 上界差着三个数量级。
      expect(Date.now() - started).toBeLessThan(3_000);
      // **#123 自查的读数失真面**：`elapsedMs` 必须是**实测值**而不是上界 ——
      // 旧文案写死上界，于是打印"等了 60000 ms"而实际只等了 ~2 s（副本取证实测 2121 ms）。
      expect(elapsedMs).toBeLessThan(3_000);
      expect(elapsedMs).toBeLessThan(30_000); // 与上界明确区分（这就是那条失真的反例）
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("有动静（有一件出现）⇒ 不提前收手，继续等到齐（那是真重建，该等）", async () => {
    const repo = tempDir("brief-progress");
    try {
      // 一开始只有 pty 那一件在 ⇒ "有动静"，必须继续等到另两件（模拟重建进行中）。
      mkdirSync(join(repo, "lib", "pty"), { recursive: true });
      writeFileSync(join(repo, "lib", "pty", "index.js"), "// pty\n");
      const timer = setTimeout(() => {
        for (const rel of ["lib/terminal/index.js", "lib/wsl-plugin/index.js"]) {
          mkdirSync(dirname(join(repo, rel)), { recursive: true });
          writeFileSync(join(repo, rel), `// ${rel}\n`);
        }
      }, 150);
      try {
        const { missing } = await waitForTreeReadyBriefly(LIB_ENTRY_FILES, (rel) => join(repo, rel), {
          timeoutMs: 10_000,
          pollMs: 20,
          absentRounds: 3,
        });
        expect(missing).toEqual([]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("已经齐了 ⇒ 快路径立刻返回空", async () => {
    const repo = tempDir("brief-ready");
    try {
      seedLib(repo);
      const started = Date.now();
      const { missing } = await waitForTreeReadyBriefly(LIB_ENTRY_FILES, (rel) => join(repo, rel), {
        timeoutMs: 30_000,
        pollMs: 20,
      });
      expect(missing).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("pointerMissReport：失败自报判据（AC2）", () => {
  it("THE POINT (#123 AC2)：点名「判据 1/1b 指针存在性早退」，不把读者引向 loud skip", () => {
    const report = pointerMissReport(["lib/pty/index.js", "lib/wsl-plugin/index.js"], 60_000);
    // 必须点名那条判据 —— 这是本票 AC2 的字面要求。
    expect(report).toContain("判据 1/1b");
    // 必须点名缺了谁（拿到红的人要知道是哪几个指针）。
    expect(report).toContain("lib/pty/index.js");
    expect(report).toContain("lib/wsl-plugin/index.js");
    // 必须写进等待上界：读的人要能分辨"真缺件"与"窗口太久"。
    expect(report).toContain("60000 ms");
    // **不得**给出"没走到 loud skip / 注入没接上"这个错误结论（票面的原症状）。
    // 文案里确实提到这两个词，但都是**否定式**（"这不是…"）——故按"否定式出现"锁。
    expect(report).toMatch(/不是"注入没接上"/u);
    expect(report).toMatch(/根本没走到后面的分支/u);
    // 省略 `elapsedMs` 时（旧调用点）退回"配置上界"，不留空档。
    expect(report).toContain("配置上界");
  });

  it("THE POINT (#123 自查的读数失真)：给了实际时长就报**实测值**，不写死上界", () => {
    // 实测现场（AC3 副本取证）：`absentRounds` 让等待 2.1 s 就收手，而旧文案打印
    // "等构件 60000 ms 仍未就位" —— 读数与事实差一个数量级，正是本票要消灭的那类失真。
    const report = pointerMissReport(["lib/pty/index.js"], 60_000, 2121);
    expect(report).toContain("2121 ms"); // 实测值
    expect(report).toContain("实际等待");
    // 上界仍要写出来（两者**都**有，读的人才能分辨"早退"与"等满"）。
    expect(report).toContain("60000 ms");
    expect(report).toContain("配置上界");
    // 关键反例：不得让读者以为真的等了 60 s —— 实测值必须出现在上界**之前**。
    expect(report.indexOf("2121 ms")).toBeLessThan(report.indexOf("60000 ms"));
  });
});

describe("libLooksRebuilt：重建完成判据", () => {
  it("三个入口都在 ⇒ true；缺任一 ⇒ false（不假绿）", () => {
    const repo = tempDir("rebuilt");
    try {
      seedLib(repo);
      expect(libLooksRebuilt(join(repo, "lib"))).toBe(true);
      rmSync(join(repo, "lib", "pty"), { recursive: true, force: true });
      expect(libLooksRebuilt(join(repo, "lib"))).toBe(false);
      expect(libLooksRebuilt(join(repo, "does-not-exist"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

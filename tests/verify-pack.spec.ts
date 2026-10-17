/**
 * 离线单测：`scripts/verify-pack.mjs`（`node --run test:release` 的装箱检查器）的纯逻辑。
 *
 * 为什么存在（`#86`）：`#83` 刚给"唯一检查入口"补上纯函数拆分与离线单测，**同一类缺口立刻
 * 在同目录重现** —— 装箱检查器守着发布面（exports 指针存在性 / 自引用 import / tarball 内目标），
 * 自身零覆盖，且**import 即执行**（顶层 `await` 直接打包 + 写 `.scratch/` + spawn 打包器），
 * 连 import 它都无从下手。改前实测：`node -e "import('./scripts/verify-pack.mjs')"` 会真打包并
 * 打印 5 行 `verify-pack: …`。
 *
 * 本套件以**纯逻辑**那半截为主（`entryTargets` / `manifestTargets` / `untarGz` /
 * `compileFilesMatcher` / `chunkFamilyDeclarations` / `duplicateChunkFamilies` /
 * `unexpectedPackedFiles` / `guardSelfCheck` / `isDirectInvocation`），另有**三条**用例
 * 从 `main()` 的**注入缝 / 临时副本**驱动它（不依赖真实打包器与真实 `lib/` 的在场窗口）：
 *   - `#90` loud-skip 的 `packdir` 回收面 —— 注入 `detect` 制造"必然找不到打包器"；
 *   - `#118` 守卫自检的 CLI 通路 —— 在 `%TEMP%` 的**仓库副本**里改副本的 `files`，真跑副本入口。
 * 跑打包器的**完整** `main()` 要真实环境（先 `node --run build`），由 `node --run test:release` 自身覆盖。
 *
 * 两处刻意的写法：
 *   - **`import` 零副作用**由子进程实测（不是断言源码文本）：import 一次，要求零输出、退出码 0。
 *   - 解包 fixture 用 `node:zlib` 自造**合规 ustar**（含校验和），不引 `tar` 依赖 —— 仓里
 *     没有 `tar`，也不该为测试加一个。
 *
 * @module tests/verify-pack.spec.ts
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chunkFamilyDeclarations, compileFilesMatcher, duplicateChunkFamilies, emittedDeclarationOf, entryTargets, guardSelfCheck, isDirectInvocation, main, manifestTargets, strayTypeDeclarations, unexpectedPackedFiles, untarGz } from "../scripts/verify-pack.mjs";

/** 被测脚本自己的路径与 URL（与 CLI 启动时 `process.argv[1]` / `import.meta.url` 同源）。 */
const SCRIPT_URL = new URL("../scripts/verify-pack.mjs", import.meta.url).href;
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * 一个 ustar 头（512 字节）：填被测解析器会读的字段（name / size / typeflag / prefix），
 * 外加 magic·version 与**按规范算好的校验和** —— fixture 因此是真 ustar，而不是"长得像"。
 */
function ustarHeader(name: string, size: number, typeFlag: string, prefix = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii"); // mode
  header.write("0000000\0", 108, 8, "ascii"); // uid
  header.write("0000000\0", 116, 8, "ascii"); // gid
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii"); // size
  header.write("00000000000\0", 136, 12, "ascii"); // mtime
  header.write(typeFlag, 156, 1, "utf8"); // typeflag: '0' 文件 / '5' 目录 / 其它不建模
  header.write("ustar\0", 257, 6, "ascii"); // magic（POSIX ustar）
  header.write("00", 263, 2, "ascii"); // version
  header.write(prefix, 345, 155, "utf8");
  header.write("        ", 148, 8, "ascii"); // 校验和字段先填空格再求和
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/** 一个 tar 条目：512 字节头 + 内容（按 512 补齐）。 */
function tarEntry(name: string, data: string | Buffer = "", typeFlag = "0", prefix = ""): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([ustarHeader(name, body.length, typeFlag, prefix), body, padding]);
}

/** 最小 gzipped ustar 归档：条目 + 两个 512 零块收尾（tar 的结束标记）。 */
function tarGz(...entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/** 临时目录（用例自己 finally 清）。 */
function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `verify-pack-${tag}-`));
}

describe("entryTargets", () => {
  it("nested condition keys (types / default) keep their parent entry's name", () => {
    expect(
      entryTargets({
        "./pty": { types: "./lib/types/pty/index.d.ts", default: "./lib/pty/index.js" },
      }),
    ).toEqual([
      ["./pty", "./lib/types/pty/index.d.ts"],
      ["./pty", "./lib/pty/index.js"],
    ]);
  });

  it("an even deeper condition nesting still inherits the same parent entry's name", () => {
    expect(
      entryTargets({
        ".": { import: { types: "./lib/types/pty/index.d.ts", default: "./lib/pty/index.js" } },
      }),
    ).toEqual([
      [".", "./lib/types/pty/index.d.ts"],
      [".", "./lib/pty/index.js"],
    ]);
  });

  it("string values pass through verbatim — a `*` wildcard target is not expanded", () => {
    expect(
      entryTargets({ "./src/*": "./src/*", "./package.json": "./package.json" }),
    ).toEqual([
      ["./src/*", "./src/*"],
      ["./package.json", "./package.json"],
    ]);
  });

  it("an empty map flattens to an empty list", () => {
    expect(entryTargets({})).toEqual([]);
  });

  it("THE PREMISE (#92): the real exports map has no `./client` entry — the dead condition stays dead", () => {
    // `main()` 里 `importableEntries` 曾排除 `entry !== './client'`；ADR-0013 删掉 web bundle 后
    // `exports` 里**没有** `./client`，该半边恒真（本票的清理依据）。这条锁**前提**而不是锁那段
    // 代码：若将来有人把 `./client` 加回 `exports`，本用例立刻红，逼他重新审视那句排除到底还要不要
    // —— 否则那句被删掉的排除会**静默**地不再成立（import smoke 会去 import 一个 web bundle，
    // 在 node 侧必然失败）。
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(Object.keys(pkg.exports)).not.toContain("./client");
    // 顺带锁住本判据读取的那份真实输入形状：9 个 entry、5 个具名 entry（`./src/*` 被通配过滤掉）。
    const entries = entryTargets(pkg.exports).filter(([, target]) => !target.includes("*"));
    expect(entries).toHaveLength(9);
    expect([...new Set(entries.map(([entry]) => entry))]).toEqual([
      ".",
      "./package.json",
      "./pty",
      "./wsl",
      "./terminal",
    ]);
  });
});

describe("manifestTargets", () => {
  it("THE POINT (#88): main / types / dsh.bundle.patch are pointers too, in a fixed order", () => {
    expect(
      manifestTargets({
        main: "lib/pty/index.js",
        types: "lib/types/pty/index.d.ts",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }),
    ).toEqual([
      ["main", "lib/pty/index.js"],
      ["types", "lib/types/pty/index.d.ts"],
      ["dsh.bundle.patch", "./cordis.patch.yml"],
    ]);
  });

  it("an ordered array form is checked element by element, label carrying the index", () => {
    expect(manifestTargets({ dsh: { bundle: { patch: ["a.patch.yml", "nested/b.patch.yml"] } } })).toEqual([
      ["dsh.bundle.patch[0]", "a.patch.yml"],
      ["dsh.bundle.patch[1]", "nested/b.patch.yml"],
    ]);
  });

  it("a manifest without contract pointers yields nothing — no crash", () => {
    expect(manifestTargets({})).toEqual([]);
    expect(manifestTargets({ dsh: {} })).toEqual([]);
    expect(manifestTargets({ dsh: { bundle: {} } })).toEqual([]);
    expect(manifestTargets({ dsh: { bundle: { patch: [] } } })).toEqual([]);
  });

  it("out-of-contract shapes are skipped quietly — shape policing belongs to the host, not to this guard", () => {
    expect(manifestTargets({ main: 42, types: null, dsh: { bundle: { patch: 42 } } })).toEqual([]);
    // 但数组里合法的字符串元素照旧逐个校验（index 保持声明位置）——不因兄弟元素形状非法而整条漏检。
    expect(manifestTargets({ dsh: { bundle: { patch: [42, "b.patch.yml"] } } })).toEqual([
      ["dsh.bundle.patch[1]", "b.patch.yml"],
    ]);
  });
});

describe("chunkFamilyDeclarations", () => {
  it("picks the chunk-glob families out of the real `files` face — and only those", () => {
    const realFiles: string[] = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).files;
    expect(chunkFamilyDeclarations(realFiles)).toEqual([
      "lib/pty-*.js",
      "lib/posix-quote-*.js",
      "lib/detect-*.js",
      "lib/launchers-*.js",
      "lib/src-*.js",
    ]);
    // 具体文件名（`lib/pty/index.js`）与跨段通配（`lib/types/**/*.d.ts`）都不是族：前者点一个文件，
    // 后者的 `**` 不是哈希位。非 lib/ 声明（`cordis.patch.yml`）同样不是。
    expect(chunkFamilyDeclarations(["lib/pty/index.js", "lib/types/**/*.d.ts", "cordis.patch.yml"])).toEqual([]);
    expect(chunkFamilyDeclarations(undefined as never)).toEqual([]);
  });

  it("a family name containing `-` stays ONE family (the `posix-quote-` trap)", () => {
    // 族粒度取自 `files` 声明的 glob，故 `lib/posix-quote-*.js` 天然是一个族 —— 不需要（也不该）
    // 去猜"主干到哪个 `-` 为止"，那正是被 `src-v2-Ab12Cd34.js` 那类名字证伪的启发式。
    expect(chunkFamilyDeclarations(["lib/posix-quote-*.js"])).toEqual(["lib/posix-quote-*.js"]);
    expect(duplicateChunkFamilies(["lib/posix-quote-*.js"], ["lib/posix-quote-aaaa.js"])).toEqual([]);
  });
});

describe("duplicateChunkFamilies", () => {
  const realFiles: string[] = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).files;

  it("THE POINT (#111): two generations of the same chunk family ⇒ flagged, with names", () => {
    // 票面原始症状：当次 `lib/pty-C0_H63de.js` + 上一代 `lib/pty-g32VoH8_.js` 同行。
    expect(
      duplicateChunkFamilies(realFiles, ["lib/pty-C0_H63de.js", "lib/pty-g32VoH8_.js", "lib/pty/index.js"]),
    ).toEqual([{ family: "lib/pty-*.js", matches: ["lib/pty-C0_H63de.js", "lib/pty-g32VoH8_.js"] }]);
    // matches 排序稳定：输入顺序不影响读数（报告可比对）。
    expect(
      duplicateChunkFamilies(realFiles, ["lib/pty-g32VoH8_.js", "lib/pty-C0_H63de.js"]),
    ).toEqual([{ family: "lib/pty-*.js", matches: ["lib/pty-C0_H63de.js", "lib/pty-g32VoH8_.js"] }]);
  });

  it("exactly one member is green (the healthy build), and zero members is green too", () => {
    expect(duplicateChunkFamilies(realFiles, ["lib/pty-C0_H63de.js"])).toEqual([]);
    // 0 命中必须绿：`lib/posix-quote-*.js` 这类 helper 族当前一次构建都不产成员（实测四族均为 0），
    // "没产出"不是缺陷 —— 红在那里就是假红。
    expect(duplicateChunkFamilies(realFiles, [])).toEqual([]);
    expect(
      duplicateChunkFamilies(realFiles, ["lib/pty-C0_H63de.js", "lib/types/pty/index.d.ts", "package.json"]),
    ).toEqual([]);
  });

  it("two DIFFERENT families with one member each are both green (families never share a bucket)", () => {
    // 反证"族粒度"没有被实现成"凡 lib/*.js 数总数"：两个无关 chunk 各一个成员 → 全绿。
    expect(
      duplicateChunkFamilies(realFiles, ["lib/pty-C0_H63de.js", "lib/detect-Ab12Cd34.js"]),
    ).toEqual([]);
    expect(
      duplicateChunkFamilies(realFiles, [
        "lib/pty-C0_H63de.js",
        "lib/detect-Ab12Cd34.js",
        "lib/src-Ef56Gh78.js",
        "lib/launchers-Ij90Kl12.js",
      ]),
    ).toEqual([]);
  });

  it("multiple violating families are all reported, in `files` declaration order", () => {
    expect(
      duplicateChunkFamilies(realFiles, [
        "lib/pty-C0_H63de.js",
        "lib/pty-zzz-fake.js",
        "lib/detect-Ab12Cd34.js",
        "lib/detect-Zz99Yy88.js",
        "lib/src-Ef56Gh78.js",
      ]),
    ).toEqual([
      { family: "lib/pty-*.js", matches: ["lib/pty-C0_H63de.js", "lib/pty-zzz-fake.js"] },
      { family: "lib/detect-*.js", matches: ["lib/detect-Ab12Cd34.js", "lib/detect-Zz99Yy88.js"] },
    ]);
  });

  it("a `./`-prefixed packed path counts the same (no false green by spelling)", () => {
    expect(duplicateChunkFamilies(realFiles, ["./lib/pty-C0_H63de.js", "lib/pty-zzz-fake.js"])).toEqual([
      { family: "lib/pty-*.js", matches: ["lib/pty-C0_H63de.js", "lib/pty-zzz-fake.js"] },
    ]);
  });

  it("no chunk families declared ⇒ nothing to judge (no crash, no false red)", () => {
    expect(duplicateChunkFamilies(["lib/pty/index.js", "cordis.patch.yml"], ["lib/a.js", "lib/b.js"])).toEqual([]);
    expect(duplicateChunkFamilies(undefined as never, ["lib/a.js"])).toEqual([]);
  });
});

describe("guardSelfCheck", () => {
  const realFiles: string[] = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).files;

  it("THE POINT (#118): a `files` face widened to `lib/**` is reported, not silently green", () => {
    // 票面证据逐字（2026-10-17 实测）：`lib/**` 下两条判据**双双**返回空 —— 无族可数，
    // 无件在声明面之外。守卫因此全绿放行历史 chunk。本函数是那条"我这次没在守"的**可见信号**。
    const findings = guardSelfCheck(["lib/**"]);
    expect(findings.map((finding) => finding.code)).toEqual(["no-chunk-family"]);
    // 诊断必须点名**是哪条声明**把族面吃掉了 —— 否则拿到红的人不知道改哪一行。
    expect(findings[0].detail).toContain("lib/**");
  });

  it("deleting the family declarations wholesale is reported too — same silence, another spelling", () => {
    // 票面 Direction 1 的另一半：不是宽写，而是把族声明整行删掉只留具体名。
    const findings = guardSelfCheck(["lib/pty/index.js", "lib/types/**/*.d.ts", "cordis.patch.yml"]);
    expect(findings.map((finding) => finding.code)).toEqual(["no-chunk-family"]);
  });

  it("NO FALSE ALARM: the real `files` face is clean — the guard IS armed there", () => {
    // 变异验证的另一半（票面 AC2）：正常 `files` 下这条响亮路径**不得**触发。
    // 真实声明面有 5 条 chunk 族，判据可达且有效。
    expect(guardSelfCheck(realFiles)).toEqual([]);
  });

  it("a face with SOME families left is clean even if a wildcard is also present", () => {
    // `lib/**` 与族声明**共存**时不报：族判据仍有触发面 —— 逐族计数用的是**该族自己的 glob**，
    // `lib/**` 本身不是族（`chunkFamilyDeclarations` 排除含 `**` 的声明），故不会污染任何族的命中数。
    // 本判据只问"族面是否整体消失"，不越界管宽窄 —— 那是 #117 的面（`lib/types/` 下的内容盲声明）。
    expect(guardSelfCheck([...realFiles, "lib/**"])).toEqual([]);
    expect(guardSelfCheck(["lib/pty-*.js", "lib/**"])).toEqual([]);
  });

  it("an unreadable `files` shape is reported too — 'cannot parse' is not evidence of 'armed'", () => {
    // 与 `unexpectedPackedFiles` 的对比：那边形状不合法时**放行**（`[]`，为的是不假红）；
    // 这边若照抄成"放行"，就等于把**未知**当成**已守** —— 一份读不懂的 `files` 恰恰是最该响亮的形态。
    // 故方向相反：非数组 / 全非字符串一律报 `unreadable-files`。
    // ⚠️ 这比票面 AC 多守一格（票面只点"族清单为空"）：理由是它同属"守卫被架空"这一族，
    // 而非新增判据面 —— 实现里的取舍写在 `guardSelfCheck` 头注，此处只锁行为。
    for (const malformed of [undefined, null, 42, [], [42, null]] as never[]) {
      expect(guardSelfCheck(malformed).map((finding) => finding.code)).toEqual(["unreadable-files"]);
    }
  });
});

describe("strayTypeDeclarations", () => {
  /** 生产 `src/` 面的**真实**根相对路径（tsc 的 emit 根，`tsconfig.build.json`: rootDir=src）。 */
  const realSources = ["src/detect.ts", "src/launchers.ts", "src/posix-quote.ts", "src/pty/index.ts", "src/pty/session-core.ts", "src/terminal/index.ts", "src/wsl-plugin/index.ts"];

  it("THE POINT (#117): a hand-written `.d.ts` with no `src/` counterpart is flagged", () => {
    // 票面实测（2026-10-17）：`Set-Content lib/types/zz-not-real.d.ts 'declare const zz: never'`
    // ⇒ 该件**进 tarball**（`npm pack` 文件面含它），而四条判据**全不报警**：
    //   - 判据 3（声明目标在不在）只问 exports 指针，不问"多出来的 .d.ts"；
    //   - 判据 4（chunk 族）只认 `lib/*-*.js`；
    //   - 判据 5（多余件）视它为"落在 `lib/types/**/*.d.ts` 声明面之内" ⇒ 放行（实测 `[]`）。
    // 缺口来自**声明面的天然性质**：那条 glob 是**内容盲**的（只看路径不看内容），
    // 而 tsc 只会产出 `src/` 里真有源码对应的那些 —— 手写件没有对应源码，故可判。
    expect(
      strayTypeDeclarations(
        ["lib/types/zz-not-real.d.ts", "lib/types/pty/index.d.ts"],
        realSources,
      ),
    ).toEqual(["lib/types/zz-not-real.d.ts"]);
  });

  it("NO FALSE ALARM (AC2): the real build face — 7 `.d.ts` — is clean", () => {
    // 变异验证的另一半：正常构建（`src/` 下 7 个 `.ts` ⇒ `lib/types/` 下 7 个 `.d.ts`）
    // **不得**被该判据误报。这 7 条是真件、真路径，一一对应。
    expect(
      strayTypeDeclarations(
        [
          "lib/types/detect.d.ts",
          "lib/types/launchers.d.ts",
          "lib/types/posix-quote.d.ts",
          "lib/types/pty/index.d.ts",
          "lib/types/pty/session-core.d.ts",
          "lib/types/terminal/index.d.ts",
          "lib/types/wsl-plugin/index.d.ts",
        ],
        realSources,
      ),
    ).toEqual([]);
  });

  it("the declaration maps (`lib/types/**.d.ts.map`) are NOT judged — they are not in the `files` face", () => {
    // 边界（#111 已确立）：`lib/types/**` 整棵保留含 `.d.ts.map`，而 `files` 只声明了
    // `lib/types/**/*.d.ts`。`.d.ts.map` 没有 `.d.ts` 那个后缀，故本判据**不碰**它 ——
    // 收窄保留面会重现 `.d.ts.map` 静默缺口，那是 #111 明确不采纳的方向。
    expect(
      strayTypeDeclarations(
        ["lib/types/detect.d.ts", "lib/types/detect.d.ts.map", "lib/types/pty/index.d.ts.map"],
        realSources,
      ),
    ).toEqual([]);
  });

  it("a file outside the declared `.d.ts` face is left to `unexpectedPackedFiles` — no double reporting", () => {
    // 分工：`lib/types/xxx.js`（非 .d.ts）不在 `lib/types/**/*.d.ts` 的声明面上 ⇒ 由判据 5
    // 负责（`unexpectedPackedFiles` 会报它）。本判据**只**管声明面**之内**的 `.d.ts` 件，
    // 否则同一条路径会被两条判据各报一次，读数噪声化。
    const realFiles: string[] = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).files;
    const paths = ["lib/types/pty/orphan.js", "lib/types/pty/index.d.ts"];
    expect(strayTypeDeclarations(paths, realSources)).toEqual([]);
    expect(unexpectedPackedFiles(realFiles, paths)).toEqual(["lib/types/pty/orphan.js"]);
  });

  it("a nested stray file deep under `lib/types/` is flagged too (the glob really crosses directories)", () => {
    expect(
      strayTypeDeclarations(["lib/types/pty/deep/deeper/zz.d.ts"], realSources),
    ).toEqual(["lib/types/pty/deep/deeper/zz.d.ts"]);
  });

  it("findings are stably sorted, and a `./`-prefixed path counts the same", () => {
    expect(
      strayTypeDeclarations(
        ["lib/types/z-last.d.ts", "./lib/types/a-first.d.ts", "lib/types/m-mid.d.ts"],
        realSources,
      ),
    ).toEqual(["lib/types/a-first.d.ts", "lib/types/m-mid.d.ts", "lib/types/z-last.d.ts"]);
  });

  it("a `lib/types/` entry with no `src/` counterpart is reported even when sources are empty", () => {
    // 前提退化（`src/` 读不到）：**不**放行 —— "读不到源码面"不是"没有杂散件"的证据。
    // 与判据 5 的克制相反（那边形状不合法时放行、为的是不假红），这里的方向是：
    // 源码面为空 ⇒ 任何 `.d.ts` 都无法被证明是 tsc 产出 ⇒ 全部报出（响亮，不静默）。
    // ⚠️ 现实中 `src/` 恒非空（构建的前提），这条锁的是失败姿态不是日常路径。
    expect(
      strayTypeDeclarations(["lib/types/pty/index.d.ts"], []),
    ).toEqual(["lib/types/pty/index.d.ts"]);
  });

  it("NO DISARMAMENT (复核 C1): the criterion does not depend on how `files` is written", () => {
    // 复核实测的静默失效路径：早先那版用 `files.some(p => p.startsWith('lib/types/'))` 当
    // 适用范围门 ⇒ `files` 一旦被宽写成 `lib/**`（`.d.ts` **照样进箱**），门判 false、
    // 判据**静默返回空**；而 `guardSelfCheck` 只要求"存在 chunk 族"、照样放行 ——
    // 与 #118 修的是同一族病（守卫被架空而无信号）。
    // 修法：**取消适用范围门** —— 判据的输入 `packedPaths` **就是 tarball**，一件 `.d.ts`
    // 出现在那里就说明它已经进箱，"该不该判"不需要再问 `files`。故本函数**不再接 `files`**。
    // 这条用例锁的就是那个性质：同一份输入，无论声明面怎么写，读数都一样。
    const paths = ["lib/types/zz-not-real.d.ts", "lib/types/pty/index.d.ts"];
    expect(strayTypeDeclarations(paths, realSources)).toEqual(["lib/types/zz-not-real.d.ts"]);
    // 对照：判据 5 在 `lib/**` 宽写下**确实**放行它（这正是本判据要补的洞，逐字复现）。
    const realFiles: string[] = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).files;
    expect(unexpectedPackedFiles(realFiles, ["lib/types/zz-not-real.d.ts"])).toEqual([]);
  });

  it("a malformed shape yields nothing — no crash", () => {
    expect(strayTypeDeclarations(undefined as never, realSources)).toEqual([]);
    expect(strayTypeDeclarations(["lib/types/zz.d.ts"], undefined as never)).toEqual([]);
    expect(strayTypeDeclarations(null as never, realSources)).toEqual([]);
  });

  it("accepts a `Set` for packedPaths — THAT is what `main()` actually passes (the wiring trap)", () => {
    // 本票实测踩到的洞：`main()` 的 `walk()` 产出的是 **`Set`**（与判据 3/4/5 同一份），
    // 而实现最初拿 `Array.isArray(packedPaths)` 当形状门 ⇒ `Set` 被判成"形状不合法"、
    // **静默返回空**。于是纯函数用例（喂数组）全绿、CLI 上一次都不报 —— 「看似在守、
    // 实则守不住」。这条用例按**真实形状**（`Set`）锁住它，不是按方便的形状锁。
    expect(
      strayTypeDeclarations(
        new Set(["lib/types/pty/index.d.ts", "lib/types/zz-not-real.d.ts"]),
        realSources,
      ),
    ).toEqual(["lib/types/zz-not-real.d.ts"]);
    // 干净的 `Set` 同样不得假报。
    expect(
      strayTypeDeclarations(new Set(["lib/types/pty/index.d.ts"]), realSources),
    ).toEqual([]);
  });

  it("a hand-written ambient `src/*.d.ts` is a LEGAL emit source, not a stray (复核 C2)", () => {
    // tsc 在 `include: ["src"]` 下会把 `src/` 下的手写 ambient `.d.ts` **原样镜像**为
    // `lib/types/` 下的同名 `.d.ts`，故它同属"tsc 会产出"的面。早先的 `listSourceFiles`
    // 把 `.d.ts` 剔掉了，头注却声称"双射" —— 文档与实现自相矛盾；若源码面真出现此类文件，
    // 合法产物会被误报成杂散件。这里从判据的输入侧锁住它（源面含同名 ambient 声明 ⇒ 产物合法）。
    expect(
      strayTypeDeclarations(["lib/types/ambient.d.ts"], [...realSources, "src/ambient.d.ts"]),
    ).toEqual([]);
    // 但**没有**同名 ambient 源时仍然报 —— 修 C2 不得把判据一起放松掉。
    expect(strayTypeDeclarations(["lib/types/ambient.d.ts"], realSources)).toEqual([
      "lib/types/ambient.d.ts",
    ]);
  });
});

describe("emittedDeclarationOf", () => {
  it("maps a `src/` path to its `lib/types/` declaration — segment-for-segment", () => {
    expect(emittedDeclarationOf("src/detect.ts")).toBe("lib/types/detect.d.ts");
    expect(emittedDeclarationOf("src/pty/index.ts")).toBe("lib/types/pty/index.d.ts");
    expect(emittedDeclarationOf("src/pty/session-core.ts")).toBe("lib/types/pty/session-core.d.ts");
    // `./` 前缀等价写法归一后再映射。
    expect(emittedDeclarationOf("./src/pty/index.ts")).toBe("lib/types/pty/index.d.ts");
  });

  it("a `.d.ts` source maps to `.d.ts` (NOT `.d.d.ts`) — tsc mirrors ambient declarations", () => {
    // 复核 C2 的映射面：`.d.ts` 源同样在 emit 面上，且镜像后**仍是** `.d.ts`。
    expect(emittedDeclarationOf("src/ambient.d.ts")).toBe("lib/types/ambient.d.ts");
    expect(emittedDeclarationOf("src/pty/globals.d.ts")).toBe("lib/types/pty/globals.d.ts");
  });

  it("returns null for anything not on the emit face (non-`src/`, non-`.ts`)", () => {
    // 用**形态**举例而不是举仓内真路径：这些都是"不在 emit 面上"的形状，不是本仓的文件
    // （仓内路径引用会被 `tests/doc-references.spec.ts` 的引用腐烂判据扫到，那是它的活）。
    expect(emittedDeclarationOf("tests/not-a-source.ts")).toBeNull();
    expect(emittedDeclarationOf("src/hypothetical.tsx")).toBeNull();
    expect(emittedDeclarationOf("src/hypothetical.js")).toBeNull();
    expect(emittedDeclarationOf("outside-the-src-tree.ts")).toBeNull();
    expect(emittedDeclarationOf(undefined as never)).toBeNull();
  });
});

describe("unexpectedPackedFiles / compileFilesMatcher", () => {
  /** 生产 `package.json` 的 `files` 面（判据的**真实**输入，不是简化样本）。 */
  const realFiles: string[] = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).files;

  it("accepts the whole current build face — every declared shape matches (positive case)", () => {
    expect(
      unexpectedPackedFiles(realFiles, [
        "lib/types/pty/index.d.ts",
        "lib/types/wsl-plugin/index.d.ts",
        "lib/types/terminal/index.d.ts", // 深层声明：`lib/types/**/*.d.ts` 必须真的跨段
        "lib/pty/index.js",
        "lib/pty-C0_H63de.js", // tsdown 的真实 chunk 形态（hash 名）
        "lib/posix-quote-Y4b21.js",
        "lib/detect-Ab12.js",
        "lib/launchers-Cd34.js",
        "lib/src-Ef56.js",
        "lib/wsl-plugin/index.js",
        "lib/terminal/index.js",
        "cordis.patch.yml", // 声明面里的非 lib/ 件：范围内不判、也不该被判（`lib/` 前缀之外）
      ]),
    ).toEqual([]);
  });

  it("THE POINT (#111): a lib/ file outside the declared face is flagged, stably sorted", () => {
    // ⚠️ 防御性判据：这条红**只在纯函数级可达**。CLI 端收不到这种输入 —— npm 的 `files` 白名单
    // 在打包阶段就把 `files` 之外的 `lib/` 件挡掉了（实证：放 `lib/sta.js` 后 tarball 仍 16 files）。
    // 本票真正的可达守卫面是同族的"两代同行"，见上面的 `duplicateChunkFamilies`。
    expect(
      unexpectedPackedFiles(realFiles, [
        "lib/pty/index.js",
        "lib/pty-g32VoH8_.js.old", // glob 面之外的旧产物（`lib/pty-*.js` 只认 .js 结尾）
        "lib/legacy/index.js", // 多余目录
        "lib/sta.js", // 未被任何声明覆盖的散件
      ]),
    ).toEqual(["lib/legacy/index.js", "lib/pty-g32VoH8_.js.old", "lib/sta.js"]);
    // 排序稳定：同一集合不同输入顺序 → 同一读数（报告可比对）。
    expect(
      unexpectedPackedFiles(realFiles, ["lib/sta.js", "lib/legacy/index.js", "lib/pty-g32VoH8_.js.old"]),
    ).toEqual(["lib/legacy/index.js", "lib/pty-g32VoH8_.js.old", "lib/sta.js"]);
  });

  it("it does NOT catch a stale chunk that its own glob declares — that is `duplicateChunkFamilies`' job", () => {
    // 判据边界（写进注释也写进测试）：`lib/pty-*.js` 合法声明了两代 chunk，故"多余件"判据**放行**
    // `lib/pty-C0_H63de.js` + `lib/pty-zzz-fake.js` 同行的局面 —— 这正是它**不能**当本票修复面的原因。
    // 对照组证明两者分工：同一个输入，多余件判据空、族判据红。
    const twoGenerations = ["lib/pty-C0_H63de.js", "lib/pty-zzz-fake.js"];
    expect(unexpectedPackedFiles(realFiles, twoGenerations)).toEqual([]);
    expect(duplicateChunkFamilies(realFiles, twoGenerations)).toEqual([
      { family: "lib/pty-*.js", matches: ["lib/pty-C0_H63de.js", "lib/pty-zzz-fake.js"] },
    ]);
  });

  it("`lib/types/**/*.d.ts` really crosses directories — a single-segment `*` would miss the deep one", () => {
    // 这条锁的是"简化成单层 `*` 就漏检深层声明"的回归：深层 .d.ts 必须**被认可**（不误报）。
    const [deepMatcher] = compileFilesMatcher(["lib/types/**/*.d.ts"]);
    expect(deepMatcher.test("lib/types/pty/index.d.ts")).toBe(true);
    expect(deepMatcher.test("lib/types/pty/deep/deeper/index.d.ts")).toBe(true);
    // 零层同样命中（`**/` 吸收后的零段）；且**不**跨过 `.d.ts` 之外的扩展名。
    expect(deepMatcher.test("lib/types/top.d.ts")).toBe(true);
    expect(deepMatcher.test("lib/types/pty/index.js")).toBe(false);
    // 非 .d.ts 的深层件落在声明面之外 —— 必须被判为多余件。
    expect(unexpectedPackedFiles(realFiles, ["lib/types/pty/orphan.js"])).toEqual(["lib/types/pty/orphan.js"]);
  });

  it("`*` is single-segment (never crosses `/`) while `**` is cross-segment", () => {
    const [single] = compileFilesMatcher(["lib/pty-*.js"]);
    expect(single.test("lib/pty-C0_H63de.js")).toBe(true);
    expect(single.test("lib/pty-zzz-fake.js")).toBe(true); // 真 chunk 形态被 `lib/pty-*.js` 认可
    expect(single.test("lib/pty/index.js")).toBe(false); // `*` 不跨 `/`
    expect(single.test("lib/pty-sub/dir.js")).toBe(false);
    expect(single.test("lib/pty-C0_H63de.mjs")).toBe(false); // 扩展名逐字
  });

  it("literal characters are escaped — `.` is a dot, not a wildcard", () => {
    const [literal] = compileFilesMatcher(["cordis.patch.yml"]);
    expect(literal.test("cordis.patch.yml")).toBe(true);
    expect(literal.test("cordisXpatch.yml")).toBe(false);
    // `index.js` 里的点同理：`lib/pty/indexXjs` 不是声明面里的件。
    expect(unexpectedPackedFiles(realFiles, ["lib/pty/indexXjs"])).toEqual(["lib/pty/indexXjs"]);
  });

  it("scope is `lib/` ONLY — packer-added files outside it are never judged (the no-false-red guard)", () => {
    // 打包器总会带上这些（与 `files` 无关）：判它们必然假红 —— 这正是判据只覆盖 lib/ 的理由。
    expect(
      unexpectedPackedFiles(realFiles, [
        "package.json",
        "README.md",
        "LICENSE",
        "LICENSE.md",
        "CHANGELOG.md",
        ".npmignore",
        "package-lock.json",
        "cordis.patch.yml",
      ]),
    ).toEqual([]);
    // 前缀必须以 `/` 收口：`libfoo/x.js` 不是 `lib/` 里的件。
    expect(unexpectedPackedFiles(realFiles, ["libfoo/x.js", "lib"])).toEqual([]);
  });

  it("a `./`-prefixed packed path is normalised before matching (no false red on spelling)", () => {
    expect(unexpectedPackedFiles(realFiles, ["./lib/pty/index.js", "./package.json"])).toEqual([]);
    expect(unexpectedPackedFiles(realFiles, ["./lib/sta.js"])).toEqual(["lib/sta.js"]);
  });

  it("a directory-level declaration still covers its whole subtree (npm semantics, not a false red)", () => {
    expect(
      unexpectedPackedFiles(["lib/pty", "lib/types/**/*.d.ts"], [
        "lib/pty/index.js",
        "lib/pty/deep/nested.js",
        "lib/types/pty/index.d.ts",
      ]),
    ).toEqual([]);
  });

  it("an empty / malformed `files` judges NOTHING — 'declared nothing' is not evidence of 'nothing extra'", () => {
    const paths = ["lib/pty/index.js", "lib/sta.js"];
    expect(unexpectedPackedFiles([], paths)).toEqual([]);
    expect(unexpectedPackedFiles(undefined as never, paths)).toEqual([]);
    expect(unexpectedPackedFiles(null as never, paths)).toEqual([]);
    // 全非字符串：等同"没有可用声明"，同样不判（否则整棵 lib/ 会被报成违规 = 假红）。
    expect(unexpectedPackedFiles([42, null] as never, paths)).toEqual([]);
    expect(compileFilesMatcher(undefined as never)).toEqual([]);
  });

  it("a `*` inside a declaration covers the whole scope (variation: the criterion keeps biting)", () => {
    // 变异面：若 `files` 被宽化成 `lib/**`，`lib/` 里就"没有任何多余件"——判据的正确读数随之变成空。
    // 这条同时反证上面的正例不是靠"匹配器恰好全过"得来的假绿。
    expect(unexpectedPackedFiles(["lib/**"], ["lib/sta.js", "lib/legacy/index.js"])).toEqual([]);
  });
});

describe("untarGz", () => {
  it("unpacks files byte-for-byte and creates the nested directories the paths imply", () => {
    const dest = tempDir("untar");
    try {
      untarGz(
        tarGz(
          tarEntry("package/", "", "5"), // 目录项（typeflag '5'）
          tarEntry("package/index.js", "export const x = 1;\n"),
          tarEntry("package/lib/bytes.bin", Buffer.from([0, 255, 1, 2])),
        ),
        dest,
      );
      expect(readFileSync(join(dest, "package", "index.js"), "utf8")).toBe("export const x = 1;\n");
      expect([...readFileSync(join(dest, "package", "lib", "bytes.bin"))]).toEqual([0, 255, 1, 2]);
      expect(statSync(join(dest, "package")).isDirectory()).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("keeps `./`-prefixed names and `.` segments inside the destination (nothing lands beside it)", () => {
    // 父目录只有 dest 一个条目 —— 越界（写到 dest 之外）会在这里现形。
    const root = tempDir("untar-escape");
    const dest = join(root, "dest");
    mkdirSync(dest);
    try {
      untarGz(
        tarGz(tarEntry("./package/./lib/a.txt", "A"), tarEntry("./dir/./", "", "5")),
        dest,
      );
      expect(readFileSync(join(dest, "package", "lib", "a.txt"), "utf8")).toBe("A");
      expect(statSync(join(dest, "dir")).isDirectory()).toBe(true);
      expect(readdirSync(root)).toEqual(["dest"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours the ustar `prefix` field (long paths split across header fields)", () => {
    const dest = tempDir("untar-prefix");
    try {
      untarGz(tarGz(tarEntry("long.txt", "P", "0", "package/deep/deeper")), dest);
      expect(readFileSync(join(dest, "package", "deep", "deeper", "long.txt"), "utf8")).toBe("P");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("treats a NUL typeflag as an old-style regular file", () => {
    const dest = tempDir("untar-nul");
    try {
      untarGz(tarGz(tarEntry("old.txt", "OLD", "\0")), dest);
      expect(readFileSync(join(dest, "old.txt"), "utf8")).toBe("OLD");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("reads an empty size field as 0 instead of derailing the offset (NaN would silently stop)", () => {
    const dest = tempDir("untar-nosize");
    try {
      const header = ustarHeader("weird.txt", 0, "0");
      header.fill(0, 124, 136); // size 字段全零 = 空串：不加守卫时偏移成 NaN，后面整段不再解析
      untarGz(tarGz(header, tarEntry("after.txt", "AFTER")), dest);
      expect(readFileSync(join(dest, "weird.txt"), "utf8")).toBe("");
      expect(readFileSync(join(dest, "after.txt"), "utf8")).toBe("AFTER");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("stops at the two zero blocks: entries after the end marker are not unpacked", () => {
    const dest = tempDir("untar-end");
    try {
      untarGz(
        gzipSync(Buffer.concat([tarEntry("kept.txt", "K"), Buffer.alloc(1024), tarEntry("ignored.txt", "I")])),
        dest,
      );
      expect(readFileSync(join(dest, "kept.txt"), "utf8")).toBe("K");
      expect(existsSync(join(dest, "ignored.txt"))).toBe(false);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("ignores entry types it does not model (pax header / symlink) rather than inventing files", () => {
    const dest = tempDir("untar-skip");
    try {
      untarGz(
        tarGz(tarEntry("PaxHeaders/package", "30 mtime=1\n", "x"), tarEntry("link", "target", "2")),
        dest,
      );
      expect(readdirSync(dest)).toEqual([]);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("isDirectInvocation", () => {
  it("recognises the script's own path as direct execution", () => {
    expect(isDirectInvocation(SCRIPT_PATH, SCRIPT_URL)).toBe(true);
  });

  it("tolerates an equivalent spelling of the same path (forward slashes)", () => {
    // 这条只锁"写法等价"（纯 `resolve()` 也会过）；真正区分 realpath 与字面比对的是
    // 下面的符号链接用例 —— 那才是守卫要修的假绿形态。
    expect(isDirectInvocation(SCRIPT_PATH.replace(/\\/g, "/"), SCRIPT_URL)).toBe(true);
  });

  it("treats another file — or no argv[1] at all — as an import", () => {
    expect(isDirectInvocation(join(repoRoot, "scripts", "frontier.mjs"), SCRIPT_URL)).toBe(false);
    expect(isDirectInvocation(undefined, SCRIPT_URL)).toBe(false);
  });

  it("does not crash on a missing path or a non-file URL", () => {
    // 守卫自己崩掉 = 入口崩，比失配更糟；两种情况都该安静地判"非直接执行"。
    expect(isDirectInvocation(join(repoRoot, "scripts", "nope.mjs"), SCRIPT_URL)).toBe(false);
    expect(isDirectInvocation(SCRIPT_PATH, "https://example.invalid/verify-pack.mjs")).toBe(false);
  });

  it("counts a symlinked invocation as direct (the false-green mode the guard fixes)", () => {
    const link = join(tmpdir(), `verify-pack-link-${String(process.pid)}.mjs`);
    try {
      symlinkSync(SCRIPT_PATH, link);
    } catch (error) {
      console.info(
        `!! SKIP (loud): 本机无法创建符号链接（${String(error)}）—— 该形态未验证；需要开发者模式/管理员权限`,
      );
      return;
    }
    try {
      expect(link).not.toBe(SCRIPT_PATH); // 前置条件：确实是另一条路径
      expect(isDirectInvocation(link, SCRIPT_URL)).toBe(true);
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe("import 本脚本零副作用", () => {
  /**
   * 子进程里 import 一次被测脚本 → 断言它**没跑 CLI**。
   *
   * 判据刻意不看"stderr 为空"：node 自身的无关警告（如 NODE_OPTIONS 带实验开关）也会走
   * stderr，那和被测脚本无关。脚本自己的三种结局都会现形 —— 打包成功走 stdout，
   * loud skip 与"指针缺失"走 stderr，且都带 `verify-pack:` 前缀。
   */
  function importInChild(argv: string[]) {
    const run = spawnSync(process.execPath, argv, { cwd: repoRoot, encoding: "utf8" });
    expect(run.stdout, "import 不得产生脚本输出").toBe("");
    expect(run.stderr, "import 不得产生脚本输出").not.toContain("verify-pack:");
    expect(run.status, "import 不得因脚本自身 exit 非零").toBe(0);
  }

  it("THE POINT (#86): importing it packs nothing, writes nothing, prints nothing", () => {
    // 改前这一步会真打包（写 `.scratch/verify-pack` + spawn 打包器）并打印 5 行 `verify-pack: …`。
    const marker = join(repoRoot, ".scratch", "verify-pack");
    const before = existsSync(marker) ? statSync(marker).mtimeMs : null;
    importInChild(["--input-type=module", "-e", `await import(${JSON.stringify(SCRIPT_URL)});`]);
    // 「不写 .scratch/」的直接面：真跑一次会 rm + mkdir + 解包，该目录的 mtime 必变（没有则会被建出来）。
    expect(
      existsSync(marker) ? statSync(marker).mtimeMs : null,
      "import 不得写 .scratch/verify-pack",
    ).toBe(before);
  });

  it("…and the guard also holds when another real module owns argv[1]", () => {
    const dir = tempDir("import");
    const probe = join(dir, "probe.mjs");
    try {
      writeFileSync(probe, `await import(${JSON.stringify(SCRIPT_URL)});\n`);
      importInChild([probe]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 并发门槛的边界（task-5）：等 `main()` 判据 1/1b 的指针就位，最多等这么久（每 `PRELUDE_POLL_MS`
 * 一探）。取值依据：车道里 `clean-lib.spec.ts` 的「删 `lib/` → `node --run build` 重建」窗口
 * 实测在秒级到十几秒级；给到 60 s 是**宽松上界**（专治慢机器），而等不到就红 ⇒ 真缺件仍会响亮
 * 失败（不会因为上界宽就把缺陷吞成绿）。轮询只做 `existsSync`，无 I/O 压力。
 */
const PRELUDE_WAIT_MS = 60_000;

/** 前置门槛的轮询间隔（ms）。 */
const PRELUDE_POLL_MS = 250;

/**
 * 从**临时副本**驱动真实 CLI 的那几条用例的超时预算（模块级，两个 describe 共用）。
 *
 * **必须**大于 {@link PRELUDE_WAIT_MS}，否则前置门槛等不到上界就被 vitest 按默认 5 s 掐断 ——
 * 那时 `finally` 跑不完，`%TEMP%` 会**遗留副本目录**（#118 实测：把 `lib/` 移走造极端窗口后
 * 单档跑出 2 个残留）。给 90 s = 60 s 门槛 + 30 s 余量。
 *
 * 放在模块级而不是某个 describe 内：它是**一份并发事实**（门槛的上界决定用例预算），
 * #118 与 #117 两轮都要用；写进各自的 describe 会变成第二份，两处迟早漂移。
 */
const CLI_CASE_TIMEOUT_MS = 90_000;

describe("loud skip 路径（#90）：注入驱动，environment-independent", () => {
  /**
   * #90：**loud skip 路径**（`findPacker()` 返回 null）不得在 %TEMP% 下遗留 packdir。
   *
   * 实测症状（修复前）：`main()` 先 `mkdtempSync(join(tmpdir(), 'dsh-shell-host-pack-'))` 建
   * packdir，**紧接着**才判 `packer === null`；而原 loud-skip 分支在**自己的 `try` 内**直接
   * `process.exit(0)` 硬退出 ⇒ 该 `try` 的 `finally { rmSync(packdir, …) }` **不会执行**：
   * 每次 skip 都永久留下一个空目录。实证（本机 %TEMP%，**该族随时间仍在增长 ⇒ 这里不写封闭
   * 枚举**）：截至 2026-10-17 至少 3 个，例如 `dsh-shell-host-pack-oj6zqA`（2026-10-16 19:26 建）、
   * `dsh-shell-host-pack-flWQo0`（2026-10-17 20:09 建）、`dsh-shell-host-pack-mZ30Qt`（同日 20:31 建，
   * 由一次变异取证留下）—— 泄漏真实发生过，不是推演。修复把 `process.exit` 换成 `return <number>`
   * （入口改 `process.exit(await main())`），回收因此走正常控制流。
   *
   * 顺带一条**为什么它长期没被看见**：`docs/agents/TESTING.md` §证据纪律「回收要读总账」给的过滤器
   * 是 `dsh-shellhost-*`（`shellhost` 无连字符），**匹配不到**本族的 `dsh-shell-host-pack-*` ——
   * 按那条命令扫，计数恒为 0。故本族的残留只在本用例的差集判据里现形。
   *
   * **为什么本机现在能实证（第一轮的教训）**：`findPacker()` 的候选里有一条**硬编码**
   * `C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js`，它排在 PATH 兜底**之前**，而本机
   * 该路径真实存在 ⇒ 真实环境下 `findPacker()` **永远**返回 npm-cli，loud-skip 分支**结构性
   * 不可达**。第一轮那条用例因此只能恒为 loud skip（0 实证），在打包器可达的机器上反而会真跑
   * 一次完整 `npm pack`（重 e2e）。本轮改用 `main({ detect })` 的**注入缝**：注入
   * "所有候选都不存在 + 两个 PATH 兜底都抛错" ⇒ `findPacker()` 必然返回 null ⇒ **必定**走
   * loud-skip。于是本用例在任何机器上读数一致：**不依赖打包器是否可达，也不 spawn 打包器**。
   *
   * 判据为什么能判：
   *   - **判据只看 %TEMP% 的前缀**：packdir 恒建在 `tmpdir()` 下、前缀写死
   *     `dsh-shell-host-pack-`；本用例自己的临时目录用 `verify-pack-loudskip-` 前缀（见 `tempDir`）
   *     ⇒ 两者前缀不重叠，直接读 `tmpdir()` 条目即可，不必在用例与脚本之间做集合差。
   *     且**只**拿调用前后两次快照的**差集**判红（不是"快照必须为空"）：本机有 2 个修复前历史
   *     残留，用绝对计数会假红 —— 残留是泄漏的后果，不是前提。
   *   - **空 `package/` 是早期写法的残留，判据 1/1b 实际查的是真 `lib/`**（第二轮的前提修正）：
   *     `repoRoot` 恒取被测脚本所在目录、`pkg` 恒读其 `package.json`（与 cwd 无关）⇒
   *     `entryTargets(pkg.exports)` / `manifestTargets(pkg)` **永远**是那份真实指针集合
   *     （`.`→`./lib/pty/index.js`、`./pty`→…、`main`→`lib/pty/index.js` 等），**不会**因为
   *     cwd 或空 `package/` 而变空。故本用例**必须**先等这些指针在磁盘上齐全（见下面的前置门槛），
   *     否则 `main()` 会在判据 1/1b 早退 `return 1`，根本到不了 loud-skip。
   *   - **`probe` 必须抛错才算"不可用"**（与默认 `execFileSync` 的语义一致：不抛 = 命中）。
   *     故用 `() => { throw … }`，**不能**用空函数当"未找到"。
   *
   * ## 并发下的确定性（task-5：msys 车道红的根因与修法）
   *
   * **根因**：`main()` 的判据 1/1b 查的是**仓库真实 `lib/`**（见上）。而车道里
   * `tests/clean-lib.spec.ts` 会**删掉 `lib/` 的三个 entry 目录再真跑 `node --run build` 重建**
   * —— 重建窗口内 `./lib/pty/index.js` 之类**瞬时不存在** ⇒ 判据 1/1b 拿到非空 missing ⇒
   * **早退 `return 1`** ⇒ 到不了 loud-skip ⇒ 断言 (a) 红。实测：车道内红（连两次）、同一副本
   * 单独跑 42 passed、Windows 树连跑 5 次 5/5 绿 ⇒ **只在并行环境下红，不是确定性缺陷**。
   *
   * **修法（选 C 的变体：前置门槛，而非盲目重试）**：调用 `main()` **之前**，用**已导出**的
   * `entryTargets` / `manifestTargets` **精确复刻**判据 1/1b 的输入集合，等这些指针在磁盘上
   * 全部就位再调用。这样等待的条件就是 `main()` 自己的前置条件，不是近似物。
   *   - **为何不用 B（够不到就 skip）**：那等于把这条判据退回"恒 skip"，正是上一轮开注入缝要
   *     消灭的形态 —— 它会静默失去实证价值。
   *   - **为何不用盲目重试**：重试只有在窗口关闭后才有意义；先等前置条件（而非"重试到不红"）
   *     语义更准，也避免把真正的缺陷（指针真的缺失）误当成并发而吞掉。
   *   - **上界与失败姿态**：最多等 {@link PRELUDE_WAIT_MS} 毫秒（每 {@link PRELUDE_POLL_MS} 一探）；
   *     **等不到就是红**，报出仍缺失的指针与等待时长 —— **绝不**降级为 skip 或静默通过。
   *     故并发窗口只是"等一会儿"，而真正缺件（例如有人在删 `lib/` 却不重建）仍然响亮失败。
   *   - **不 spawn、不 build**：本用例只读文件存在性，不去修 `lib/`（修 `lib/` 是他人的写域，
   *     也会与 `clean-lib` 抢）。
   *
   * ⚠️ 它**只**锁 #90 的**回收面**（loud-skip 时 packdir 是否遗留）。以下都**不在**覆盖内，
   * 别让它冒充更强的保证：打包器在场时的清理路径；判据 3/4/5 的判定正确性；loud-skip 文案的
   * 逐字正确性（本用例只按子串判"确实走到了这个分支"）；`findPacker()` 候选数组/顺序的语义
   * （那由其它用例与本文件的注入形状间接反映）。
   *
   * ## 变异取证的纪律（本轮踩过的坑，写下来免得重犯）
   *
   * 这条用例的「红」是靠**变异**取到的（实测：删掉 `finally` 里的 `rmSync(packdir)` 后本用例
   * 报 `loud skip 在 %TEMP% 下遗留了 packdir：dsh-shell-host-pack-…`）。取红时**绝不写产品文件**：
   * 本仓未提交改动没有 git 保护，`git cat-file blob > file`（PowerShell 重定向不落盘）与
   * `Set-Content -NoNewline`（压平换行 ⇒ 整个文件变一行）都是高危还原手法，本轮真的因此损坏过
   * `scripts/verify-pack.mjs`。正确做法是让**变异体待在独立目录**，用 vitest `resolve.alias`
   * 覆盖本文件对 `../scripts/verify-pack.mjs` 的 import；或利用上面的注入缝在**用例内**注入
   * 退化行为。至少要还原时用 `git checkout -- <path>`，不要手工重定向。
   *
   * 另一条同源的教训：判断"文件到底是什么"要**读工作树**。`git grep` 默认搜 index / HEAD，
   * 而 index 可能停在旧版本（`git add` 滞后）⇒ 会用 0 命中给出与工作树相反的结论。
   * 0 命中先解释再采信（`git grep --no-index` 或直接读文件）。
   */
  it("THE POINT (#90): a loud skip leaves no packdir behind in %TEMP%", async () => {
    // 泄漏面：脚本的 packdir 前缀（写死在 main() 里）；本用例目录名是另一个前缀。
    const packdirsInTmp = () =>
      readdirSync(tmpdir())
        .filter((name) => name.startsWith("dsh-shell-host-pack-"))
        .sort();

    /** 注入"必然找不到打包器"：候选全判不存在 + 两个 PATH 兜底都抛错 ⇒ findPacker() === null。 */
    const noPacker = {
      candidateExists: () => false,
      probe: () => {
        throw new Error("no packer on PATH");
      },
    };

    // ── 前置门槛（task-5）：等 main() 的判据 1/1b 所需指针就位，避免车道内 `clean-lib` 重建
    //    `lib/` 的窗口把本用例打成"早退 return 1"。复刻用的是脚本**已导出**的同一个
    //    entryTargets / manifestTargets ⇒ 输入集合与 main() 完全一致，不是近似复刻。
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const preludeTargets = [
      ...entryTargets(pkg.exports).filter(([, target]) => !target.includes("*")),
      ...manifestTargets(pkg),
    ].map(([, target]) => target.replace(/^\.\//, ""));

    const missingPreludeTargets = () =>
      preludeTargets.filter((target) => !existsSync(join(repoRoot, target)));

    const waitDeadline = Date.now() + PRELUDE_WAIT_MS;
    let stillMissing = missingPreludeTargets();
    while (stillMissing.length > 0 && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, PRELUDE_POLL_MS));
      stillMissing = missingPreludeTargets();
    }
    // 等不到就**响亮失败**（绝不降级 skip）：并发窗口只是"等一会儿"，真缺件必须红。
    expect(
      stillMissing,
      `判据 1/1b 的指针在 ${PRELUDE_WAIT_MS} ms 内未就位（并发重建 lib/ 的窗口或真缺件）：` +
        `${stillMissing.join(", ")} —— 缺件则 main() 会早退 return 1，验不到 loud-skip`,
    ).toEqual([]);

    const dir = tempDir("loudskip");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    try {
      const before = packdirsInTmp();

      // 捕获 loud-skip 的 `console.warn`（脚本用它输出那行 `!! SKIP (loud)`）。
      // 只在这一段替换全局 console.warn，`finally` 里无条件还原。
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      // 注入驱动：main 返回退出码 number（不再 process.exit）⇒ 同进程内即可断言。
      const status = await main({ detect: noPacker });

      // (a) 防空转假绿：必须**真的**走到了 loud-skip 分支 —— 这正是当初揪出前提错误的那条断言。
      //     若注入没接上（例如探针把 detect 参数丢了），这里会立刻红，而不是安静地"零遗留"。
      expect(warnings.join("\n"), "必须真的走到 loud skip 分支（否则本用例什么都没验）").toContain(
        "verify-pack: !! SKIP (loud)",
      );
      // (b) loud skip 是诚实的退出：返回 0，而不是异常码。
      expect(status, "loud skip 应返回 0").toBe(0);

      // (c) THE POINT：packdir 建在 `try` 内；skip 分支若硬退出（修复前的 process.exit）则
      //     `finally` 不执行 ⇒ %TEMP% 里会多出一个 `dsh-shell-host-pack-*`。差集判红，
      //     不用绝对计数（本机有历史残留，绝对计数会假红）。
      const after = packdirsInTmp();
      const leaked = after.filter((name) => !before.includes(name));
      expect(leaked, `loud skip 在 %TEMP% 下遗留了 packdir：${leaked.join(", ")}`).toEqual([]);
    } finally {
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
    // 超时预算与 #118/#117 的副本用例同一份（{@link CLI_CASE_TIMEOUT_MS}）——**这条也必须挂**：
    // 它的前置门槛等的是同一个 `lib/` 重建窗口，默认 5 s 会在窗口稍宽时把它掐断，
    // 而掐断时 `finally` 跑不完 ⇒ 反而**制造**本用例正要检出的那种残留（实测：全量并发下
    // 5.0 s 红，单档 21 ms 绿 —— 只在并发环境下红，不是确定性缺陷）。
  }, CLI_CASE_TIMEOUT_MS);
});

/**
 * #118 的 **CLI 层**实证：`main()` 里那段自检接线是**活代码**，不是摆设。
 *
 * ## 为什么必须有这条（纯函数单测不够）
 *
 * 纯函数级用例锁的是 `guardSelfCheck` 的**判定**（AC3 的字面要求）。但 AC1 要的是
 * 「有**可达**的响亮路径」—— 若 `main()` 里那段 `if (selfCheck.length > 0)` 被误删、被短路、
 * 或干脆没接上，**纯函数用例照样全绿**（它压根不经过 `main()`）。这正是 `#111` 留下的教训：
 * 一个看起来在守、实际守不住的判据比没有更危险。故这里从**真实 CLI** 取读数。
 *
 * ## 手法：临时副本，**绝不写产品文件**（沿用 #90 的变异取证纪律）
 *
 * 要把 `files` 改成 `lib/**`，又不能碰权威树的 `package.json`（那是产品文件，写它 = 污染工作树；
 * 且 `git cat-file blob > file` / `Set-Content -NoNewline` 这类还原手法本仓**真损坏过文件**）。
 * 那条纪律的**本体**在**本文件上方** #90 用例的头注（搜「取红时**绝不写产品文件**」），
 * **不在** `docs/agents/TESTING.md` —— 后者只讲「实验标记要死掉再提交」那条（调试 / 变异探针
 * 要带方括号大写前缀，见 `TESTING.md` §证据纪律），并不含"变异取证不得写产品文件"这一条。
 * 故：把 `scripts/` 与 `package.json` 复制进 `%TEMP%` 的独立子目录，**只改副本**的 `files`，
 * 用真实 node 跑副本入口。
 *
 * ## 本票实测的一条附加陷阱：还原用 `git checkout --` 会连**未提交的实现**一起抹掉
 *
 * 本票的变异取证（M1 = 短路 `main()` 的自检接线；M2 = 让自检永远报）**两次**都红在正确的位置
 * （M1 只红 CLI 用例、纯函数全绿 ⇒ 证明该用例堵的正是"接线被删"这个洞；M2 红 6 条 ⇒ 证明
 * "永远报"的退化也会被拦）。但 M1 的还原用了 `git checkout -- scripts/verify-pack.mjs` ——
 * 该文件当时**整个实现都还没提交**，于是 checkout 把**变异体与实现一起**退回 HEAD，
 * `guardSelfCheck` 一度从工作树消失（靠变异前留的 `%TEMP%` 备份才恢复）。
 *
 * **教训**：`git checkout -- <path>` 是"退回 HEAD"，不是"撤销上一次编辑"。在**未提交**的树上做
 * 变异，还原手段必须与"实现尚未入库"这个事实匹配 —— 要么变异前后各留一份备份（本票的做法），
 * 要么先把实现提交再做变异。
 *
 * ⚠️ **这条修正了本文件上方 #90 用例头注里的一句**：那里写"**至少**要还原时用
 * `git checkout -- <path>`，不要手工重定向"—— 那是在**已提交**的前提下成立的建议（较手工重定向
 * 确实更安全）。但#90 当时同样是**未提交**的树上做的变异，故那句在它自己的场景里也有同一个洞，
 * 只是那次没踩到。两处口径以本条为准：**未提交的树上，`git checkout --` 不是还原手段**。
 * （保留 #90 那句不删，是因为它对"已提交"的情形仍是对的建议；但读它的人必须先读本条。）
 *
 *   为什么这样仍是真读数：`repoRoot` 取的是**脚本自己所在目录**的上级（`import.meta.url` 推导），
 *   不是 cwd ⇒ 副本入口天然把副本当仓库根，读的就是副本那份被宽写的 `package.json`。
 *
 * ## 判据为什么能判（两个面各锁一半）
 *
 *   - **响亮面**（AC1）：`lib/**` 下必须 `exit 1` 且 stderr 出现自检文案。自检在**判据 1 之前**
 *     运行（`main()` 里它是第 0 步），故副本**不需要** `lib/` / `cordis.patch.yml` / `node_modules`
 *     —— 判据 1/1b 的缺件输出会跟在后面，但那不影响本用例的断言（只看自检那三行与退出码）。
 *     这也是本用例**便宜**的原因：不到打包那一步就返回了，不会 spawn 打包器。
 *   - **不假报面**（AC2）：同一手法跑**真实** `files`（不改副本的 `package.json`）时，自检文案
 *     必须**不出现**。这一步会走完打包与判据 4/5（副本能自洽跑通到那一步；判据 2 的 import smoke
 *     在副本里会因够不到权威树的 `node_modules` 而红，故**只断言自检面、不断言总退出码**）。
 *
 * ⚠️ **它不锁**：判据 4/5 的产物判定正确性（判据 0 只问"我还有没有触发面"）、文案的逐字稳定性
 * （按子串判"确实走到了自检分支"）、`files` 宽窄本身（那是 #117 的面）。
 */
describe("守卫自检的 CLI 通路（#118）：临时副本里真跑，不写产品文件", () => {
  // 超时预算用模块级的 {@link CLI_CASE_TIMEOUT_MS}（#117 的副本用例共用同一份并发事实）。

  /** 把脚本与 manifest 复制成一个独立"仓库根"，返回该目录。 */
  function makeRepoCopy(tag: string): string {
    const root = tempDir(tag);
    mkdirSync(join(root, "scripts"), { recursive: true });
    for (const name of ["verify-pack.mjs", "script-entry.mjs"]) {
      writeFileSync(join(root, "scripts", name), readFileSync(join(repoRoot, "scripts", name)));
    }
    writeFileSync(join(root, "package.json"), readFileSync(join(repoRoot, "package.json")));
    return root;
  }

  /** 在副本入口上真跑一次 CLI，返回 stdout / stderr / 退出码。 */
  function runCopy(root: string) {
    return spawnSync(process.execPath, [join(root, "scripts", "verify-pack.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
  }

  /**
   * **并发前置门槛**（task-5 的同一手法，#90 用例已验证过）：等权威树 `lib/` 里判据 1/1b 需要的
   * 指针全部就位，再去复制它们。
   *
   * **为什么 #118 也需要它**（本票在全量套件里实测到的红）：车道里 `tests/clean-lib.spec.ts` 会
   * **删掉 `lib/` 三个 entry 目录再真跑 `node --run build` 重建**。本套件的副本 fixture 从权威树
   * `cpSync` 那棵 `lib/` —— 若正好落在重建窗口内，复制到的是**半棵**，于是副本里的判据 1/1b
   * 早退 `return 1`，本用例的"自检确实跑了"断言随之红。实测：单档 50/50 绿，而 `node --run test`
   * 全量里 4 条红（含 #90 那条）—— **只在并发环境下红，不是确定性缺陷**。
   *
   * 复刻用的是脚本**已导出**的 `entryTargets` / `manifestTargets` ⇒ 等待条件就是 `main()` 判据 1/1b
   * 自己的前置条件，不是近似物。**等不到就响亮红**（绝不降级 skip）；上界 {@link PRELUDE_WAIT_MS}
   * 与轮询间隔 {@link PRELUDE_POLL_MS} 复用上面 #90 用例的常量（同一份并发事实，不另立一套）。
   *
   * 本函数**只读**权威树，不改它 —— 修 `lib/` 是 `clean-lib` 的写域，抢它只会制造更坏的窗口。
   */
  async function waitForRepoLibReady(): Promise<void> {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const targets = [
      ...entryTargets(pkg.exports).filter(([, target]) => !target.includes("*")),
      ...manifestTargets(pkg),
    ].map(([, target]) => target.replace(/^\.\//, ""));
    const missing = () => targets.filter((target) => !existsSync(join(repoRoot, target)));
    const deadline = Date.now() + PRELUDE_WAIT_MS;
    let still = missing();
    while (still.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PRELUDE_POLL_MS));
      still = missing();
    }
    expect(
      still,
      `权威树 lib/ 的判据 1/1b 指针在 ${PRELUDE_WAIT_MS} ms 内未就位（并发重建窗口或真缺件）：` +
        `${still.join(", ")} —— 缺件会让副本 fixture 复制到半棵树`,
    ).toEqual([]);
  }

  /**
   * 让副本能走完判据 1/1b，从而**到达**判据 4/5：判据 1/1b 是**早失败**
   * （指针不在就 `return 1`），所以"只跑判据 0 的响亮用例"不需要这些件，
   * 而"要看判据 4/5 正常绿行"的用例**必须**备齐。
   *
   * 备的是**权威树已有的真件**（只读复制，不改）：`lib/` 整棵 + `cordis.patch.yml`。
   * 判据 2 的 import smoke 会因副本够不到权威树 `node_modules` 而红 —— 那是**副本的环境性**
   * 结果，与本用例无关（故下方只断言自检面与判据 4/5 的 stdout，不碰总退出码）。
   */
  function furnishForPackedCriteria(root: string): void {
    cpSync(join(repoRoot, "lib"), join(root, "lib"), { recursive: true });
    cpSync(join(repoRoot, "cordis.patch.yml"), join(root, "cordis.patch.yml"));
  }

  it("THE POINT (#118): `files` 宽写成 `lib/**` ⇒ 真实 CLI exit 1 并打出自检文案（AC1 可达）", async () => {
    // **顺序**：**先**等门槛（只读、无副作用），**再**建副本，然后整个"建了副本"的区间都在
    // try/finally 里。若先建副本再等门槛，门槛一旦超时被掐断，`finally` 跑不完 ⇒ 副本泄漏
    // （本票实测到过，见上面 `CLI_CASE_TIMEOUT_MS` 的说明）。
    await waitForRepoLibReady();
    const root = makeRepoCopy("selfcheck-wide");
    try {
      // 备齐 lib/ 与 cordis.patch.yml，让判据 1/1b **不是**早退的那条路 —— 否则退出码会被
      // 判据 1 的 `return 1` 污染，"exit 1" 就失去判别力（复核 C2 指出的一点，实测确认）。
      furnishForPackedCriteria(root);
      // 只改**副本**的 files：族声明全部消失，等价于票面"宽写成 lib/**（或删掉族声明）"。
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      pkg.files = ["lib/**"];
      writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));

      const run = runCopy(root);
      // **先证明"真的走到了自检分支"**（防空转假绿）：文案是这条用例真正的判别面 ——
      // 判据 1 早退、判据 2 环境性红都会给出 status 1，故 status 单靠自己**证明不了**自检跑过。
      expect(run.stderr, "必须真的走到自检分支（否则本用例什么都没验）").toContain("守卫自检失败");
      expect(run.stderr).toContain("[no-chunk-family]");
      expect(run.stderr).toContain("lib/**");
      // 响亮：非零退出码。前提（判据 1/1b 已过）由上面的 furnish 保证。
      expect(run.stderr, "判据 1/1b 不该早退（备齐后它们必须过）").not.toContain("pointers to missing files");
      expect(run.status, "自检失败必须响亮（exit 1）").toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CLI_CASE_TIMEOUT_MS);

  it("NO FALSE ALARM (AC2)：真实 `files` 下同一条通路**不**报 —— 判据 4/5 照常跑出正常绿行", async () => {
    // 副本 = 真实 package.json（**不改** files）。这条是变异验证的另一半：
    // 若自检写成了"永远报"，上面的响亮用例照样绿，只有这条能拦。
    // **顺序**同上面的响亮用例：**先**等门槛，**再**建副本（门槛超时不得泄漏副本）。
    await waitForRepoLibReady();
    const root = makeRepoCopy("selfcheck-real");
    try {
      furnishForPackedCriteria(root);
      // 判据 0 在**最前**且早于打包：先按下自检静默取证，再看判据 4/5 是否照常报告。
      const run = runCopy(root);
      expect(run.stderr, "真实 files 下自检不得触发（不假报）").not.toContain("守卫自检失败");
      // 判据 1/1b 必须真的过了（否则下面的判据 4/5 根本没跑 —— 断言会假绿成"没输出"）。
      expect(run.stderr, "副本缺 lib/ 或缺 cordis.patch.yml 会让判据 1/1b 早退").not.toContain(
        "pointers to missing files",
      );
      // 判据 4/5 仍**有触发面**：它俩照常执行并打出各自的正常读数（证明守卫确实"武装着"）。
      expect(run.stdout).toContain("no chunk family has two generations in tarball");
      expect(run.stdout).toContain("no unexpected lib/ files in tarball");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CLI_CASE_TIMEOUT_MS);

  it("THE POINT (#118，复核 C1 的回归): loud skip **不得吞掉**判据 0 已判定的红", async () => {
    // 复核发现、本票实测确认的真洞：loud-skip 分支原先写死 `return 0`，把判据 0 已设的
    // `exitCode = 1` **直接丢弃** ⇒ "找不到打包器"的环境下自检**报了红却退出 0**（假绿的一种）。
    // 这与 #90 修的是**同一类**洞（一条退出路径悄悄丢弃先前累积的结论），故就地补锁。
    //
    // 手法：**同进程**用 `main({ detect })` 注入"必然找不到打包器"（#90 已开的缝，不新增第二道），
    // 并把副本的 `files` 宽写。判据 1/1b 在 `main()` 里读的是**脚本自己所在仓库**的 package.json
    // ——故这里必须在**副本**里跑：权威树的 `files` 不能被改。
    // **顺序**同上面的响亮用例：**先**等门槛（只读、无副作用），**再**建副本 ——
    // 否则门槛超时被掐断时 `finally` 跑不完，副本会泄漏。
    await waitForRepoLibReady();
    const root = makeRepoCopy("selfcheck-skip");
    try {
      furnishForPackedCriteria(root);
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      pkg.files = ["lib/**"];
      writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));

      // 在副本里用同一个 main() 注入驱动 —— 副本入口是独立模块，故这里动态 import 副本的那份。
      const copyUrl = new URL(`file://${join(root, "scripts", "verify-pack.mjs").replaceAll("\\", "/")}`).href;
      const copyMain: (options: { detect: object }) => Promise<number> = (await import(copyUrl)).main;

      const warnings: string[] = [];
      const errors: string[] = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      try {
        console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
        console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
        const status = await copyMain({
          detect: {
            candidateExists: () => false,
            probe: () => {
              throw new Error("no packer on PATH");
            },
          },
        });
        // (a) 自检**确实**判了红（否则下面 (b) 是空断言）。
        expect(errors.join("\n"), "必须真的走到自检分支").toContain("守卫自检失败");
        // (b) 又**确实**走到了 loud skip（两个分支在同一次运行里都发生过）。
        expect(warnings.join("\n"), "必须真的走到 loud skip 分支").toContain("!! SKIP (loud)");
        // (c) THE POINT：loud skip 返回的码必须**带着**判据 0 的红，而不是写死 0。
        expect(status, "loud skip 不得吞掉判据 0 已判定的红（原为写死的 return 0）").toBe(1);
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CLI_CASE_TIMEOUT_MS);
});

/**
 * #117 的 **CLI 层**实证：判据 6 的接线是**活代码**，不是摆设。
 *
 * ## 为什么必须有这条（本票真的栽在这上面）
 *
 * 纯函数用例锁的是 `strayTypeDeclarations` 的**判定**。但本票实现时，`main()` 传进去的
 * `packedFiles` 是 `walk()` 产出的 **`Set`**，而实现最初拿 `Array.isArray(packedPaths)`
 * 当形状门 ⇒ `Set` 被判成"形状不合法"、**静默返回空**。当时**全部纯函数用例都绿**
 * （它们喂的是数组），而真实 CLI 上判据 6 **一次都没 fire** —— 逐字复现了本文件反复
 * 引用的那句「一个看起来在守、实际守不住的判据比没有更危险」。
 *
 * 这条用例因此**从真实 CLI 取读数**（不是再喂一次数组）：只有把判据 6 接进 `main()`
 * 并跑通整条 walk → 断言这条链，那个洞才会现形。纯函数用例保留，但它锁不住接线。
 *
 * ## 手法：临时副本（沿用 #118/#90 的既有纪律，**绝不写产品文件**）
 *
 * `repoRoot` 取脚本**自己所在目录**的上级，故副本天然是个独立仓库根。副本需要
 * `src/`（判据 6 的对照面）与 `lib/`（判据 1/1b 的前置）——都从权威树**只读复制**。
 *
 * ⚠️ **它不锁**：判据 6 的判定正确性（那是纯函数用例的活）、文案逐字稳定性
 * （按子串判"确实走到了判据 6 分支"）。
 */
describe("判据 6 的 CLI 通路（#117）：临时副本里真跑，不写产品文件", () => {
  /** 把脚本、manifest 与判据 1/6 需要的真实面复制成一个独立"仓库根"。 */
  function makeRepoCopyWithFaces(tag: string): string {
    const root = tempDir(tag);
    mkdirSync(join(root, "scripts"), { recursive: true });
    for (const name of ["verify-pack.mjs", "script-entry.mjs"]) {
      writeFileSync(join(root, "scripts", name), readFileSync(join(repoRoot, "scripts", name)));
    }
    writeFileSync(join(root, "package.json"), readFileSync(join(repoRoot, "package.json")));
    return root;
  }

  function runCopy(root: string) {
    return spawnSync(process.execPath, [join(root, "scripts", "verify-pack.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
  }

  /** 备齐判据 1/1b（`lib/` + patch）与判据 6（`src/`）的输入面 —— 只读复制权威树。 */
  async function furnish(root: string): Promise<void> {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const targets = [
      ...entryTargets(pkg.exports).filter(([, target]) => !target.includes("*")),
      ...manifestTargets(pkg),
    ].map(([, target]) => target.replace(/^\.\//, ""));
    const missing = () => targets.filter((target) => !existsSync(join(repoRoot, target)));
    const deadline = Date.now() + PRELUDE_WAIT_MS;
    let still = missing();
    while (still.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PRELUDE_POLL_MS));
      still = missing();
    }
    expect(
      still,
      `权威树判据 1/1b 的指针在 ${PRELUDE_WAIT_MS} ms 内未就位（并发重建窗口或真缺件）：${still.join(", ")}`,
    ).toEqual([]);
    cpSync(join(repoRoot, "lib"), join(root, "lib"), { recursive: true });
    cpSync(join(repoRoot, "src"), join(root, "src"), { recursive: true });
    cpSync(join(repoRoot, "cordis.patch.yml"), join(root, "cordis.patch.yml"));
  }

  it("THE POINT (#117): 手写杂散 `.d.ts` ⇒ 真实 CLI exit 1 并点出它（AC1 可达）", async () => {
    const root = makeRepoCopyWithFaces("stray-types");
    try {
      await furnish(root);
      // 只改**副本**：在 `lib/types/` 放一个 tsc 永远不会产出的手写 `.d.ts`（票面原症状）。
      writeFileSync(join(root, "lib", "types", "zz-not-real.d.ts"), "declare const zz: never\n");

      const run = runCopy(root);
      // 先证明**真的走到了判据 6**（防空转假绿）：文案是这条用例真正的判别面。
      expect(run.stderr, "必须真的走到判据 6 分支（否则本用例什么都没验）").toContain(
        "no matching src/ file",
      );
      // 且必须**点名**那个杂散件 —— 拿到红的人要知道删哪一个。
      expect(run.stderr).toContain("lib/types/zz-not-real.d.ts");
      // 判据 1/1b 不得早退（备齐后它们必须过），且判据 4/5 仍照常绿 ——
      // 正是"四条判据全不报警"这一票面前提的反证现场。
      expect(run.stderr, "判据 1/1b 不该早退").not.toContain("pointers to missing files");
      expect(run.stdout).toContain("no chunk family has two generations in tarball");
      expect(run.stdout).toContain("no unexpected lib/ files in tarball");
      expect(run.status, "杂散 .d.ts 必须响亮（exit 1）").toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CLI_CASE_TIMEOUT_MS);

  it("NO FALSE ALARM (AC2)：真实构建面下判据 6 **不**报 —— 7 个 `.d.ts` 全有源码对应", async () => {
    // 变异验证的另一半：若判据 6 写成了"永远报"，上面的响亮用例照样绿，只有这条能拦。
    const root = makeRepoCopyWithFaces("stray-types-clean");
    try {
      await furnish(root);
      const run = runCopy(root);
      expect(run.stderr, "真实构建面下判据 6 不得触发（不假报）").not.toContain("no matching src/ file");
      expect(run.stderr, "判据 1/1b 不该早退").not.toContain("pointers to missing files");
      // 判据 6 必须**真的跑过**并给出正常读数（否则"没报"可能只是它压根没执行）。
      expect(run.stdout).toContain("every lib/types/ declaration has a matching src/ file");
      // 判据 3 的读数顺带证明走到了那一步（`entries` 计数仍是 9 —— #92 的 AC）。
      expect(run.stdout).toContain("all 9 export entries packed and importable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CLI_CASE_TIMEOUT_MS);
});

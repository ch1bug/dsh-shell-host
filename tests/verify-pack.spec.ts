/**
 * 离线单测：`scripts/verify-pack.mjs`（`node --run test:release` 的装箱检查器）的纯逻辑。
 *
 * 为什么存在（`#86`）：`#83` 刚给"唯一检查入口"补上纯函数拆分与离线单测，**同一类缺口立刻
 * 在同目录重现** —— 装箱检查器守着发布面（exports 指针存在性 / 自引用 import / tarball 内目标），
 * 自身零覆盖，且**import 即执行**（顶层 `await` 直接打包 + 写 `.scratch/` + spawn 打包器），
 * 连 import 它都无从下手。改前实测：`node -e "import('./scripts/verify-pack.mjs')"` 会真打包并
 * 打印 5 行 `verify-pack: …`。
 *
 * 本套件只测纯逻辑那半截（`entryTargets` / `manifestTargets` / `untarGz` / `isDirectInvocation`）；跑打包器的
 * `main()` 要真实环境（先 `node --run build`），由 `node --run test:release` 自身覆盖。
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
import { chunkFamilyDeclarations, compileFilesMatcher, duplicateChunkFamilies, entryTargets, isDirectInvocation, manifestTargets, unexpectedPackedFiles, untarGz } from "../scripts/verify-pack.mjs";

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

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
import { entryTargets, isDirectInvocation, manifestTargets, untarGz } from "../scripts/verify-pack.mjs";

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
/**
 * 隐私 / 环境串扫描 —— **提交门**与验收共用的一份判据。
 *
 * 为什么：本仓是 **PUBLIC** 仓，而人肉发现过一次真实泄漏（2026-10-16：机主用户名、家目录、
 * 检出与旧布局路径、个人署名与邮箱、真机名与内网 IP 已在历史里公开，处置见
 * `docs/agents/privacy.md`）。此前判据只活在 `node --run test` 的 unit 车道里 ——
 * 带个人串的提交**照样能进仓**，只在全量验收时才红。故抽到这里，让
 * `.githooks/pre-commit` 与 spec 走同一份逻辑。
 *
 * 三面判据（口径 = 「个人用户名 + 本机布局路径」，2026-10-16 human 拍板）：
 *   1. **本机运行时身份**：`os.userInfo().username` 与 `os.homedir()`（不是写死的名单；
 *      换台机器克隆，它守的是那台机器的身份）；
 *   2. **本机布局形态**：`<盘符>:<斜杠>dsh-*`、`/<盘符>/dsh-*`、`<盘符>:<斜杠>Work<斜杠>`
 *      —— `C:/msys64` 是**标准安装点**，保留；
 *   3. **本机 denylist**（`<DSH_HOME>/privacy-denylist.txt`，一行一个 token，`#` 注释）：
 *      运行时推不出来的那类（呼号、内网 host/IP、个人邮箱、旧布局根…）。该文件在 home 下、
 *      **永不进仓**；不存在就跳过这一面（`--verbose` 会说明）。
 *
 * 匹配**大小写不敏感**（实测教训：第一次探针用全大写，静默漏掉文件里的小写写法）。
 * 输出只报 `file:line 命中<类别>`，**不回显 token 本身** —— 失败信息会被粘进 issue / 日志。
 *
 * 用法：
 *   node scripts/privacy-scan.mjs            # 扫 git 跟踪的文件；命中 exit 1，干净 exit 0
 *   node scripts/privacy-scan.mjs --verbose  # 附带 denylist 路径与条数
 *
 * @module scripts/privacy-scan
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 判定结果的类别标签（值不落进报告）。 */
export const KINDS = {
  userName: "本机用户名",
  homeDir: "本机家目录",
  checkout: "本机检出路径",
  posixCheckout: "POSIX 检出路径",
  oldWork: "旧工作布局",
  denylist: "本机 denylist",
};

/** 布局路径的固定形态（大小写不敏感）。 */
export const LAYOUT_CHECKS = [
  { kind: KINDS.checkout, pattern: /[A-Za-z]:[\\/]dsh-[A-Za-z]/iu },
  { kind: KINDS.posixCheckout, pattern: /\/[a-z]\/dsh-[A-Za-z]/iu },
  { kind: KINDS.oldWork, pattern: /[A-Za-z]:[\\/]Work[\\/]/iu },
];

/** 本机运行时身份：用户名 + 家目录（两种斜杠写法）；空值不猜。 */
export function identityTokens() {
  const user = userInfo().username;
  const home = homedir();
  return [
    ...(user.trim() === "" ? [] : [{ kind: KINDS.userName, value: user }]),
    ...(home.trim() === "" ? [] : [{ kind: KINDS.homeDir, value: home }]),
    ...(home.trim() === "" ? [] : [{ kind: KINDS.homeDir, value: home.replaceAll("\\", "/") }]),
  ];
}

/** denylist 路径：`<DSH_HOME>/privacy-denylist.txt`（本机、永不进仓）。 */
export function denylistPath(dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh")) {
  return join(dshHome, "privacy-denylist.txt");
}

/** denylist tokens（一行一个；`#` 注释与空行忽略；读不到就返回空数组，不抛）。 */
export function denylistTokens(file = denylistPath()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((value) => ({ kind: KINDS.denylist, value }));
}

/** git 跟踪的文件（本仓无 CI、无 lint，唯一清单来源就是 index）。 */
export function trackedFiles(cwd = REPO) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" });
  return out.split("\0").filter((f) => f !== "");
}

/**
 * 命中清单：`<file>:<line> 命中<类别>`（同一行同一类别只报一次，按文件行序）。
 *
 * @param files 待扫的相对路径
 * @param readText 读文件（读不到返回 null）
 * @param tokens `{ kind, value }[]`，大小写不敏感子串匹配
 * @param layouts `{ kind, pattern }[]`
 */
export function privacyHits(files, readText, tokens, layouts = LAYOUT_CHECKS) {
  const needles = tokens.map((t) => ({ kind: t.kind, value: t.value.toLowerCase() }));
  const hits = [];
  const seen = new Set();
  for (const rel of files) {
    const text = readText(rel);
    if (text === null || text.includes("\0")) continue; // 读不了 / 二进制
    text.split("\n").forEach((line, index) => {
      const lower = line.toLowerCase();
      const record = (kind) => {
        const key = `${rel}:${String(index + 1)} 命中${kind}`;
        if (seen.has(key)) return;
        seen.add(key);
        hits.push(key);
      };
      for (const t of needles) if (lower.includes(t.value)) record(t.kind);
      for (const layout of layouts) if (layout.pattern.test(line)) record(layout.kind);
    });
  }
  return hits;
}

/** 读一个跟踪文件（相对 cwd）；读不到返回 null。 */
export function readTracked(rel, cwd = REPO) {
  try {
    return readFileSync(join(cwd, rel), "utf8");
  } catch {
    return null;
  }
}

/** 全量扫描（CLI 与 spec 的共同入口）。 */
export function scan({ cwd = REPO, tokens } = {}) {
  const all = tokens ?? [...identityTokens(), ...denylistTokens(denylistPath())];
  const files = trackedFiles(cwd);
  return { files: files.length, hits: privacyHits(files, (rel) => readTracked(rel, cwd), all) };
}

/** 直接执行才跑 CLI（被 spec import 时不扫）。 */
function isDirectInvocation(argv1, moduleUrl) {
  if (argv1 === undefined) return false;
  try {
    return resolve(argv1) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

function main(argv) {
  const verbose = argv.includes("--verbose");
  const dl = denylistTokens();
  if (verbose) {
    console.log(`privacy-scan: denylist ${denylistPath()}（${String(dl.length)} 条${dl.length === 0 ? "，文件不存在或为空" : ""}）`);
  }
  const { files, hits } = scan();
  if (hits.length === 0) {
    console.log(`privacy-scan: 干净（${String(files)} 个跟踪文件；身份 + 布局 + denylist 全 0 命中）`);
    return 0;
  }
  console.error(`privacy-scan: 命中 ${String(hits.length)} 处（本仓是 PUBLIC 仓 —— 个人 / 本机环境串不进仓）：`);
  for (const hit of hits) console.error(`  ${hit}`);
  console.error(
    "改法：家目录用 `~` / `%USERPROFILE%` / `$HOME`，检出与旧布局用 `<repo>` / `<sibling-repo>` / " +
      "`<old-work>`；确属误报才 `SKIP_HOOKS=1 git commit`（明确跳过）。",
  );
  return 1;
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
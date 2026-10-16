/**
 * 隐私 / 环境串扫描 —— **提交门**与验收共用的一份判据，扫的是**会被推出去的发布面**。
 *
 * 为什么：本仓是 **PUBLIC** 仓，而人肉发现过一次真实泄漏（2026-10-16：机主用户名、家目录、
 * 检出与旧布局路径、个人署名与邮箱、真机名与内网 IP 已在历史里公开，处置见
 * `docs/agents/privacy.md`）。判据原先只活在 `node --run test` 的 unit 车道里 ——
 * 带个人串的提交**照样能进仓**，而且只在**文件内容**上判。故抽到这里，让
 * `.githooks/pre-commit` 与 spec 走同一份逻辑，并把发布面扫全：
 *
 *   1. tracked 文件内容
 *   2. **全部提交消息**（`--no-history` 只扫 HEAD）
 *   3. **提交身份**（author / committer，去重）
 *   4. **ref 名**（分支 / tag —— 名字也是发布面）
 *   5. **拟提交消息**（`.git/COMMIT_EDITMSG`：pre-commit 窗口内已写好）
 *   6. **轨迹面**（issue 正文 / 评论）：仓外，只有 `--gh` 显式跑（离线套件不受影响）
 *
 * 规则两类（口径 = 「个人用户名 + 本机布局路径」，2026-10-16 human 拍板）：
 *   - **结构性**（入仓，机械可判）：字面家目录 `/home/<u>/`、`/Users/<u>/`、`<盘符>:\Users\<u>`；
 *     检出与旧布局 `<盘符>:\dsh-*`、`/<盘符>/dsh-*`、`<盘符>:\Work\`。**占位符与运行期派生形态豁免**：
 *     `ALLOWED_USERS`（`me` / `x` / `agent` / `runner` / `<user>` 这类）与 `$(whoami)` /
 *     `%USERNAME%` / `${USER}` 不判。`C:/msys64` 是**标准安装点**，保留。
 *   - **词表**（**不入仓**）：`<DSH_HOME>/privacy-denylist.txt`（或 `DSH_PRIVACY_DENYLIST`），
 *     一行一个 token、`#` 注释、**大小写不敏感** —— 覆盖运行时推不出来的那类（呼号、内网
 *     host/IP、个人邮箱、旧布局根）。**词表绝不入仓**，否则守卫自己就成了泄露源。
 *   - 另有本机**运行时身份**：`os.userInfo().username` / `os.homedir()`（不是写死名单）。
 *
 * 命中只报 `发布面:文件:行 命中<类别>`，**不回显 token 与行文**（失败信息会被粘进
 * issue / 日志 —— 输出本身也是发布面）。例外有两种，都要可 review：**行内** `pii-allow`
 * 标记（有理由的那一行），或整门 `SKIP_HOOKS=1 git commit`。
 *
 * 用法：
 *   node scripts/privacy-scan.mjs [--root <dir>] [--no-history] [--gh] [--denylist <file>] [--verbose]
 *   exit 0 = 净；1 = 有命中；非 git 环境**响亮跳过**（不把缺环境装成通过）。
 *
 * @module scripts/privacy-scan
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 判定结果的类别标签（值不落进报告）—— **与邻仓逐字一致**（跨仓对读日志 / issue 时同一个词）。
 * 含形态的标签在**源码里**拼接写：`X:\dsh-*` 直写会被自己的规则扫到（本会话两边都踩过）。
 */
export const KINDS = {
  userName: "本机用户名",
  homeDir: "本机家目录",
  layoutWin: "本机布局(X:" + "\\dsh-*)",
  layoutPosix: "POSIX 布局(/" + "x/dsh-*)",
  layoutWork: "旧工作布局(X:" + "\\Work\\)",
  homePath: "字面家目录(/home|/Users|X:" + "\\Users)",
  denylist: "denylist",
};

/**
 * 允许出现在家目录段里的**占位符 / 通用账户**（不是某个人的身份）。
 * 本仓既有写法：`C:\Users\me`（README）、`/home/me/…`（ssh 挂具）、`C:/Users/x/…`（汇总挂具）。
 */
export const ALLOWED_USERS = new Set([
  "agent", "runner", "user", "username", "your-user", "you", "me", "x", "app", "node",
  "example", "name", "your-name", "yourname", "foo", "bar", "baz", "test", "administrator",
  "default", "public", "shared", "tmp", "userprofile",
]);

/** 运行期派生形态（`$(whoami)` / `%USERNAME%` / `${USER}` / `<user>`）：不是硬编码身份。 */
const DYNAMIC_USER = /[$%{}()+*<>…]/u;

/**
 * 结构性规则：`id` 给报告、`re` 抓文本。家目录类规则的**捕获组 1 = 用户段**（过白名单）；
 * 其余规则不设捕获组（命中即算）。
 */
export const RULES = [
  {
    kind: KINDS.homePath,
    describe: "字面家目录 /home/<user>/ · /Users/<user>/",
    re: /(?<![\w.-])(?:\/home\/|\/Users\/)([A-Za-z0-9._-]+)(?=\/)/gu,
    userGroup: true,
  },
  {
    kind: KINDS.homePath,
    describe: "字面家目录 <盘符>:\\Users\\<user>",
    re: /[A-Za-z]:[\\/]Users[\\/]([A-Za-z0-9._-]+)/gu,
    userGroup: true,
  },
  { kind: KINDS.layoutWin, describe: "检出路径 <盘符>:\\dsh-*", re: /[A-Za-z]:[\\/]dsh-[A-Za-z]/giu },
  { kind: KINDS.layoutPosix, describe: "检出路径 /<盘符>/dsh-*", re: /\/[a-z]\/dsh-[A-Za-z]/giu },
  { kind: KINDS.layoutWork, describe: "旧工作布局 <盘符>:\\Work\\", re: /[A-Za-z]:[\\/]Work[\\/]/giu },
];

/** 词表位置：env 优先（`DSH_PRIVACY_DENYLIST`，兼容邻仓的 `DSH_PII_DENYLIST`），
 * 其次 `<DSH_HOME>/privacy-denylist.txt`（本机、不进仓）—— 与邻仓同路径。 */
export function denylistPath(dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh")) {
  return process.env.DSH_PRIVACY_DENYLIST ?? process.env.DSH_PII_DENYLIST ?? join(dshHome, "privacy-denylist.txt");
}

/** 词表 tokens（一行一个；`#` 注释与空行忽略；读不到就空数组，不抛）。 */
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

/** 默认判据面（词表缺失时只有结构性 + 运行时身份）。 */
export function defaultTokens(dshHome) {
  return [...identityTokens(), ...denylistTokens(denylistPath(dshHome))];
}

/** 命中行内的显式豁免标记（有理由、可 review；与邻仓同名）。 */
export const ALLOW_MARKER = "pii-allow";

/**
 * 扫一段文本（**所有发布面共用这一个实现** —— 守卫不得手抄被测语义）。
 *
 * 含 `pii-allow` 标记的行整行跳过：例外要**写在行上**、可 review，而不是靠关掉整道门。
 *
 * @returns `[{ kind, line }]`；同一行同一类别只报一次（按行序）。
 */
export function scanText(text, tokens = []) {
  const needles = tokens.map((t) => ({ kind: t.kind, value: t.value.toLowerCase() }));
  const findings = [];
  String(text)
    .split("\n")
    .forEach((line, index) => {
      if (line.includes(ALLOW_MARKER)) return; // 行内显式豁免
      const lower = line.toLowerCase();
      const seen = new Set();
      const record = (kind) => {
        if (seen.has(kind)) return;
        seen.add(kind);
        findings.push({ kind, line: index + 1 });
      };
      for (const t of needles) if (t.value !== "" && lower.includes(t.value)) record(t.kind);
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(line)) !== null) {
          if (rule.userGroup === true) {
            const user = m[1] ?? "";
            if (!/[A-Za-z0-9]/u.test(user)) continue; // `C:/Users/...` 这类省略号不是身份
            if (ALLOWED_USERS.has(user.toLowerCase()) || DYNAMIC_USER.test(user)) continue;
          }
          record(rule.kind);
        }
      }
    });
  return findings;
}

/** git 薄封装（守卫的唯一外部依赖）；stderr 静音，免得缺 git 的夹具把噪音打进汇总。 */
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * 扫一个仓库的**发布面**。`history: false` 只扫 HEAD 的提交消息（大仓可选）。
 *
 * @returns `{ findings, surfaces }`；`findings` 为 `{ surface, where, line, kind }`。
 */
export function scanRepo({ root = process.cwd(), tokens = [], history = true } = {}) {
  const cwd = resolve(root);
  const findings = [];
  const push = (surface, where, hits) => {
    for (const hit of hits) findings.push({ surface, where, ...hit });
  };

  const files = git(cwd, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // 二进制
    push("file", file, scanText(text, tokens));
  }

  const logArgs = history ? ["log", "--all", "--format=%B%x00"] : ["log", "-1", "--format=%B%x00"];
  const messages = git(cwd, logArgs).split("\0").filter((text) => text.trim() !== "");
  messages.forEach((text, i) => push("message", `log#${String(i + 1)}`, scanText(text, tokens)));

  const identities = [...new Set(git(cwd, ["log", "--all", "--format=%an <%ae>|%cn <%ce>"]).split("\n").filter(Boolean))];
  identities.forEach((text, i) => push("identity", `identity#${String(i + 1)}`, scanText(text, tokens)));

  const refs = git(cwd, ["for-each-ref", "--format=%(refname:short)"]).split("\n").filter(Boolean);
  for (const ref of refs) {
    push("ref", ref, scanText(ref, tokens));
  }

  // 拟提交消息：pre-commit 窗口内 `.git/COMMIT_EDITMSG` 已写好（钩子真正的拦截点）。
  try {
    const pending = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "COMMIT_EDITMSG"]).trim());
    if (existsSync(pending)) push("pending-message", "COMMIT_EDITMSG", scanText(readFileSync(pending, "utf8"), tokens));
  } catch {
    /* 非提交期：跳过 */
  }

  const seen = new Set();
  const unique = findings.filter((f) => {
    const key = `${f.surface}|${f.where}|${f.kind}|${String(f.line)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    findings: unique,
    surfaces: { files: files.length, messages: messages.length, identities: identities.length, refs: refs.length },
  };
}

/**
 * 轨迹面（issue 正文 / 评论）——**纯函数**：注入 `[{ surface, id, text }]` 即可离线测。
 * gh 只是取件的薄壳（见 `trackerItems`），判定与仓面共用 `scanText`。
 */
export function scanTrackerItems(items, tokens = []) {
  const findings = [];
  for (const item of items) {
    for (const hit of scanText(item.text, tokens)) {
      findings.push({ surface: item.surface ?? "tracker", where: item.id, ...hit });
    }
  }
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.surface}|${f.where}|${f.kind}|${String(f.line)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 从 GitHub 取轨迹面文本（issue 标题+正文、评论）。
 * 用 `--jq '.[] | {…}'` 拿 **JSONL**（逐行一个对象）而非数组：`--paginate` 会把数组拼起来，
 * 直接 `JSON.parse` 会炸。评论带真实 id + 票号，便于照单清理。
 */
export function trackerItems() {
  const jsonl = (args) =>
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  const issues = jsonl([
    "api", "--paginate", "repos/{owner}/{repo}/issues?state=all&per_page=100",
    "--jq", ".[] | {number: .number, title: .title, body: .body}",
  ]);
  const comments = jsonl([
    "api", "--paginate", "repos/{owner}/{repo}/issues/comments?per_page=100",
    "--jq", ".[] | {id: .id, issue: (.issue_url | split(\"/\") | last), body: .body}",
  ]);
  return [
    ...issues.map((i) => ({ surface: "issue", id: `#${String(i.number)}`, text: `${i.title ?? ""}\n${i.body ?? ""}` })),
    ...comments.map((c) => ({ surface: "comment", id: `comment ${String(c.id)} (#${String(c.issue)})`, text: c.body ?? "" })),
  ];
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

/** CLI 主体：`--root` / `--no-history` / `--gh` / `--denylist <file>` / `--verbose`。 */
export function main(argv = [], root = process.cwd()) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const cwd = resolve(arg("--root") ?? root);
  const verbose = argv.includes("--verbose");
  const history = !argv.includes("--no-history");
  const file = arg("--denylist") ?? denylistPath();
  const terms = denylistTokens(file);
  const tokens = [...identityTokens(), ...terms];
  if (verbose) console.log(`privacy-scan: denylist ${file}（${String(terms.length)} 条）`);

  let scanned;
  try {
    scanned = scanRepo({ root: cwd, tokens, history });
  } catch (error) {
    // 缺环境**响亮跳过**，绝不把"没验过"装成通过。
    console.log(`  !! SKIP (loud) — 不是可扫的 git 仓库（${String(error?.message ?? error).split("\n")[0]}）：守卫未生效`);
    return 0;
  }
  let findings = scanned.findings;
  if (argv.includes("--gh")) {
    try {
      findings = [...findings, ...scanTrackerItems(trackerItems(), tokens)];
    } catch (error) {
      console.log(`  !! SKIP (loud) — 轨迹面未核对（gh 不可用 / 未登录：${String(error?.message ?? error).split("\n")[0]}）`);
    }
  }

  const { surfaces } = scanned;
  const scope = `files=${String(surfaces.files)} messages=${String(surfaces.messages)} identities=${String(surfaces.identities)} refs=${String(surfaces.refs)}`;
  if (terms.length === 0) {
    console.log(`  !! SKIP (loud) — 词表缺失（${file}）：只跑了结构性规则与运行时身份，个人 token 未核对`);
  }
  if (findings.length === 0) {
    console.log(`privacy-scan: 干净（${scope}${terms.length === 0 ? "" : `; denylist ${String(terms.length)} 条`}）`);
    return 0;
  }
  console.log(`privacy-scan: 命中 ${String(findings.length)} 处（本仓是 PUBLIC 仓 —— 个人 / 本机环境串不进仓）：`);
  for (const f of findings) console.log(`  ${f.surface}:${f.where}:${String(f.line)} 命中${f.kind}`);
  console.log(
    "改法：家目录用 `~` / `%USERPROFILE%` / `$HOME`，检出与旧布局用 `<repo>` / `<sibling-repo>` / " +
      "`<old-work>`（流程见 docs/agents/privacy.md）；确属必需才 `SKIP_HOOKS=1 git commit`。",
  );
  return 1;
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  process.exit(main(process.argv.slice(2), REPO));
}
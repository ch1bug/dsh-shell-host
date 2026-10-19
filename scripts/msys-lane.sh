#!/bin/bash
# msys-lane.sh —— **msys 侧日常口径**：同步部署副本 → 重建副本构件 → 在副本上跑唯一检查入口 → 打读数汇总。
#
# 为什么存在：本仓有三条验证车道（见 docs/dev-environment.md §0.1.1）——
#   ① Windows 侧权威树（`node --run test`，开发时最常跑）
#   ② Windows 侧对副本（PowerShell 指过去跑，node 同样是 Windows node —— 三条车道的
#      node 归属见 docs/dev-environment.md §0.1.1 的表，那里是单一来源）
#   ③ **msys 侧对副本**（msys 的 git/sh/tar + Windows 的 node，真在副本里跑）
# 第 ③ 条此前只活在文档的散文里，每次都要手敲六条命令，且极容易踩「路径形态」坑（POSIX `/c/…`
# 交给 Windows node → 安装环红而装箱档绿，看着像产品缺陷）。本脚本把那条车道**口子化**：
# 一条命令走完，并把它依赖的环境事实（Windows node 前置、Windows 形态路径）在入口处钉死。
#
# **同步只搬 git 跟踪的文件**：`lib/` 被 gitignore，`merge --ff-only` 不会碰它 —— 故本脚本在跑
# 套件前**重建副本构件**。不重建就会是「新 spec + 旧构件」的**空心绿**：三档 e2e 安装/打包的
# 正是 <副本>/lib（`DSH_E2E_PLUGIN_DIR`），旧构件证明不了本次交付的东西。
#
# 用法（**在 msys bash 里跑**，不是 PowerShell；也不需要先 source 引导脚本 —— 本脚本自己 source）：
#
#   bash <repo>/scripts/msys-lane.sh                  # 同步 + 全量（验收口径）
#   bash <repo>/scripts/msys-lane.sh --lane machine   # 只跑 machine 车道（**迭代口径**，快）
#   bash <repo>/scripts/msys-lane.sh --no-sync        # 跳过同步（只验当前副本提交）
#
# 覆盖（默认值都在运行时推导，不写死本机路径；本仓是 PUBLIC 仓）：
#   DSH_MSYS_COPY   部署副本路径（默认在 msys2 家目录下按名找，见下）
#   DSH_MSYS_SRC    权威树路径（默认 = 本脚本所在仓；仅用于「两树同提交」的前置校验）
#
# 退出码：0 = 全绿；非 0 = 前置检查失败（**响亮失败**，绝不把「没跑」当「没问题」）或套件红。
# 前置检查失败时不跑套件 —— 缺件问题在 msys 车道与产品缺陷是**不同归因**，先分清再跑。
set -u

# —— 定位本仓（权威树）——
SELF="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=$(cd "$(dirname "$SELF")" && pwd)
DEFAULT_SRC=$(cd "$SCRIPT_DIR/.." && pwd)
SRC="${DSH_MSYS_SRC:-$DEFAULT_SRC}"

# msys2 的家目录：**不要用 `$HOME`** —— msys 的 `HOME` 由 msys 自己设定，**不是** msys2 的家目录
# （实测本机 `$HOME=/c/Cadence/SPB_Data`，而检出在 `/c/<msys 安装点>/home/<user>/…`）。
# msys 安装点可从它自己的 `MSYSTEM_PREFIX`（如 `/ucrt64`）上推两级拿到 → `/c/<msys 安装点>`；
# 拿不到时试两个通用安装点；用户目录名由 `cygpath $USERPROFILE` 推出。全程不写死本机路径。
WINHOME_U=$(cygpath -u "${USERPROFILE:-}" 2>/dev/null || true)
USER_NAME="${WINHOME_U:+$(basename "$WINHOME_U")}"
MSYS_HOME=""
if [ -n "${MSYSTEM_PREFIX:-}" ]; then
  MSYS_HOME="$(dirname "$(dirname "$MSYSTEM_PREFIX")")/home/${USER_NAME:-$(whoami)}"
fi
if [ -z "$MSYS_HOME" ] || [ ! -d "$MSYS_HOME" ]; then
  for root in /c/msys64 /c/msys2 /c/tools/msys64; do
    [ -d "$root/home/${USER_NAME:-$(whoami)}" ] && { MSYS_HOME="$root/home/${USER_NAME:-$(whoami)}"; break; }
  done
fi
[ -n "$MSYS_HOME" ] && [ -d "$MSYS_HOME" ] || MSYS_HOME="$HOME"

if [ -n "${DSH_MSYS_COPY:-}" ]; then
  COPY="$DSH_MSYS_COPY"
else
  COPY=""
  for cand in "$MSYS_HOME/dsh-shellhost-src" "$HOME/dsh-shellhost-src"; do
    [ -d "$cand/.git" ] && { COPY="$cand"; break; }
  done
  [ -n "$COPY" ] || COPY="$MSYS_HOME/dsh-shellhost-src"
fi

LANE=""
DO_SYNC=1
NO_LIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --lane) LANE="${2:-}"; [ -n "$LANE" ] || { echo "msys-lane: --lane 需要一个值（unit / machine）" >&2; exit 2; }; shift 2 ;;
    --no-sync) DO_SYNC=0; shift ;;
    --no-live) NO_LIVE=1; shift ;;
    -h|--help) echo "用法：bash scripts/msys-lane.sh [--lane unit|machine] [--no-sync] [--no-live]
  在 msys bash 里跑：同步部署副本 → 跑唯一检查入口 → 打读数汇总。
  --lane      只跑一个车道（迭代口径；默认全量 = 验收口径）
  --no-sync   不碰同步，只验当前副本提交
  --no-live   排除真实层（e2e-real-llm；外部端点偶发 TRANSPORT，会假红）——**日常推送口径**
  覆盖：DSH_MSYS_COPY（副本路径，默认在 msys2 家目录下按名找）、DSH_MSYS_SRC（权威树，默认本仓）"; exit 0 ;;
    *) echo "msys-lane: 未知参数：$1（见 --help）" >&2; exit 2 ;;
  esac
done

fail() { echo "msys-lane: FAIL — $1" >&2; exit 1; }
step() { echo "msys-lane: $1"; }

# 工作树是否干净。**行尾口径很关键**：msys git 若没读到 `core.autocrlf=true`，会把 Windows
# 检出（worktree 是 CRLF、index 是 LF）整棵树判成 modified（本机实测 117 处）；那**不是**
# 未提交改动。判别沿用 docs/dev-environment.md §0.1 第 1 条：**忽略行尾后为空 = 纯噪音**。
# 返回 0 = 干净（或仅行尾噪音，此时以 NOTICE 形式说一声），1 = 真有未提交改动。
tree_status() { # tree_status <repo> <label>
  local repo="$1" label="$2" out out_nl
  out=$(git -C "$repo" -c core.autocrlf=true status --porcelain 2>/dev/null)
  [ -z "$out" ] && return 0
  out_nl=$(git -C "$repo" -c core.autocrlf=true diff --ignore-cr-at-eol --stat 2>/dev/null)
  if [ -z "$out_nl" ]; then
    step "注意：$label 仅行尾差异（msys git 未读到 core.autocrlf=true 时的老噪音，见 §0.1 第 1 条）——按干净处理"
    return 0
  fi
  printf '%s\n' "$out" >&2
  return 1
}

# —— 0. 引导（Windows node 前置 / git·gh 配置 / 自检）。缺件这里就会响亮报。——
[ -f "$SCRIPT_DIR/msys-env.sh" ] || fail "缺 $SCRIPT_DIR/msys-env.sh（引导脚本）"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/msys-env.sh" || fail "引导脚本 source 失败（$SCRIPT_DIR/msys-env.sh）"
command -v node >/dev/null 2>&1 || fail "PATH 上仍没有 node —— 见 scripts/msys-env.sh 的警告"
case "$(command -v node)" in
  */ucrt64/*) fail "生效的 node 是 ucrt64：构建/套件会崩在原生件绑定上（rolldown 与 gnu 绑定，见 docs/dev-environment.md §4.2）。设 DSH_MSYS_WIN_NODE_DIR 后重试" ;;
esac

# —— 1. 副本前置检查 ——
[ -d "$COPY/.git" ] || fail "没有部署副本（$COPY）。先按 docs/dev-environment.md §0 建立：
    git clone <origin> \"\$HOME/dsh-shellhost-src\"   # 依赖随仓 node_modules，本仓不需要额外接线"
[ -d "$SRC/.git" ] || fail "权威树路径不像 git 检出：$SRC（用 DSH_MSYS_SRC 覆盖）"

tree_status "$SRC" "权威树" || fail "权威树工作树不干净（先在权威树收尾，别在有未提交改动时跑车道）"

# —— 2. 同步（权威树是源；与 §0 口径逐字一致：--prune --tags --force + merge --ff-only）——
sync_one() { # sync_one <repo>
  git -C "$1" fetch --prune --tags --force origin >/dev/null 2>&1 || fail "fetch 失败：$1"
  git -C "$1" merge --ff-only FETCH_HEAD >/dev/null 2>&1 || fail "merge --ff-only 失败：$1（副本里有本地提交或行尾噪音 → 见 §0.1）"
}
sync_from_src() { # sync_from_src <copy> <src>
  git -C "$1" fetch --prune --tags --force "$2" >/dev/null 2>&1 || fail "从权威树 fetch 失败：$1 ← $2"
  git -C "$1" merge --ff-only FETCH_HEAD >/dev/null 2>&1 || fail "merge --ff-only 失败：$1 ← $2"
}

if [ "$DO_SYNC" = 1 ]; then
  # 权威树先与 origin 对齐（这样副本从谁同步都拿到同一提交）。
  git -C "$SRC" fetch --prune --tags --force origin >/dev/null 2>&1 || fail "权威树 fetch origin 失败"
  ahead=$(git -C "$SRC" rev-list --count "refs/remotes/origin/main..HEAD" 2>/dev/null || echo "?")
  behind=$(git -C "$SRC" rev-list --count "HEAD..refs/remotes/origin/main" 2>/dev/null || echo "?")
  [ "$behind" = "0" ] || fail "权威树落后 origin/main $behind 个提交（先 pull）"
  [ "$ahead" = "0" ] || step "注意：权威树领先 origin/main $ahead 个提交（副本将从本机权威树同步）"

  tree_status "$COPY" "副本（同步前）" || fail "副本工作树不干净（副本是只读部署副本，不该有本地改动）"

  before=$(git -C "$COPY" rev-parse --short HEAD)
  if [ "$ahead" = "0" ]; then sync_one "$COPY"; else sync_from_src "$COPY" "$SRC"; fi
  after=$(git -C "$COPY" rev-parse --short HEAD)
  step "同步：副本 $before → $after"
else
  step "同步：跳过（--no-sync）"
fi

# —— 3. 两树同提交（AGENTS.md 的硬约束：不同即说明有人在副本里提交过）——
src_head=$(git -C "$SRC" rev-parse HEAD)
copy_head=$(git -C "$COPY" rev-parse HEAD)
if [ "$src_head" != "$copy_head" ]; then
  step "注意：权威树与副本**不同提交**（权威 ${src_head:0:7} / 副本 ${copy_head:0:7}）——"
  step "      若是刻意只验副本的某提交，忽略本条；否则停下核对（有人在副本里提交过？）"
fi
copy_short=$(git -C "$COPY" rev-parse --short HEAD)
tree_status "$COPY" "副本（同步后）" || fail "副本工作树在同步后不干净"

# —— 4. 环境：把「Windows 形态路径」钉死（POSIX /c/… 交给 Windows node 会拼出坏路径）——
# 默认值本来就在 tests/helpers/e2e-install.ts 里按运行时用户名推出；这里显式给一遍，
# 是为了让「形态」这件事在入口处可见，而不是藏在挂具的默认值里。
to_win() { cygpath -w "$1" 2>/dev/null | tr '\\' '/' ; }
export DSH_E2E_PLUGIN_DIR="${DSH_E2E_PLUGIN_DIR:-$(to_win "$COPY")}"
export DSH_E2E_HOST_DIR="${DSH_E2E_HOST_DIR:-$(to_win "$MSYS_HOME/dsh-host-src")}"
export DSH_E2E_NODE="${DSH_E2E_NODE:-$(to_win "$(command -v node)")}"
export DSH_E2E_PNPM_DIR="${DSH_E2E_PNPM_DIR:-$(to_win "$MSYS_HOME/dsh-host-src/node_modules/.bin")}"

# —— 5. 跑唯一检查入口（在副本里；msys 的 git/sh/tar + Windows 的 node）——
[ -f "$COPY/node_modules/vitest/vitest.mjs" ] || fail "副本没装依赖（$COPY/node_modules/vitest 不存在）：先在副本里装一次依赖"

# —— 5a. 重建副本构件（**同步 ≠ 重建**）——
# 为什么必须有这一步：`lib/` 被 .gitignore，同步只搬 git 跟踪的文件；源码更新后副本的 `lib/`
# 仍是上一次构建的产物，而三档 e2e 安装/打包的正是它（`DSH_E2E_PLUGIN_DIR`，见第 4 步）。
# 没有这一步，改了 `src/` 的车道会拿**旧构件**跑出绿 —— 恰好在「证明交付构件可用」这层哑火。
# 成本实测 ≈2s（tsc 全量 emit + tsdown 33ms，无 tsbuildinfo）；tsdown 需 Windows node（§4.2），
# 第 0 步已把 ucrt64 排除。
buildlog=$(mktemp)
trap 'rm -f "$buildlog"' EXIT
step "构件：重建副本 lib/（同步只搬源码，不搬被 gitignore 的 lib/）"
if ! (cd "$COPY" && node --run build) >"$buildlog" 2>&1; then
  tail -20 "$buildlog" | sed 's/^/  /'
  fail "副本重建失败（$COPY）—— 三档 e2e 装的就是它，装不出就没有可验的构件"
fi
# 建完仍缺件就**在这里**判失败：否则三档 e2e 会因缺件响亮跳过，看着像「门禁未开」而不是构建坏了。
[ -f "$COPY/lib/pty/index.js" ] || fail "重建后仍没有 $COPY/lib/pty/index.js（e2e 门禁要它）"

scope="${LANE:-全量（unit + machine）}"
[ "$NO_LIVE" = 1 ] && scope="$scope（已排除真实层）"
step "车道=$scope  副本=$copy_short  node=$(node -v)"
# 真实层（`tests/e2e-real-llm-machine.spec.ts`）打的是**外部端点**：交接与本会话都实测到偶发
# `TRANSPORT`（外部网络问题，重跑即绿）。故 `--no-live` 把它排除 —— 那是「日常推送口径」：
# pre-push 不该因外部端点抖动阻断推送（否则大家只会常按 SKIP_HOOKS，闸门形同虚设）。
# 发布 / 手动验收仍跑默认（含真实层）。
LIVE_SPEC="tests/e2e-real-llm-machine.spec.ts"
# **为什么全量也直调 vitest、而不是 `node --run test`**：`node --run test` 会把额外参数转交
# `scripts/verify-all.mjs`，而它只认自己的参数（实测：`--exclude` → `verify-all: 未知参数`，
# 套件一次都没跑就红）。要排除真实层就必须直调 vitest。
# 代价与补偿：这条路少了 `verify-all` 的**汇总口径与 `PASS*` 计数**，也少了它包的 typecheck
# → 故这里**显式跑一次 typecheck**，读数表里再照 `PASS*` 的口径标出含 loud skip 的档。
# 真要「唯一检查入口」的验收口径（`node --run test`），照 §0.1.1 的手工等价跑法在副本里跑它。
log=$(mktemp)
typeslog=$(mktemp)
trap 'rm -f "$log" "$typeslog" "$buildlog"' EXIT
step "typecheck（规范要求：与 vitest 同批跑）"
if ! (cd "$COPY" && node --run typecheck) >"$typeslog" 2>&1; then
  tail -20 "$typeslog" | sed 's/^/  /'
  fail "typecheck 未通过（副本 $copy_short）"
fi

# 读数走**双 reporter**（两个一起给，缺一不可）：
#   - `--reporter=json --outputFile=…` → 逐档表（每个 spec 一条：status + 用例计数 + 耗时）。
#     为什么不解析控制台行来出表：`--reporter=verbose` / `tree` 会把**逐用例**行也打出来
#     （300+ 行），vitest 4 又已没有旧版的 `basic`（实测：`Failed to load custom Reporter from basic`）。
#   - `--reporter=default` → **控制台输出**（`!! SKIP (loud)` 行、三档 e2e 环表、红档诊断原文）。
#     缺了它，下面读 `$log` 的那几个读数（loud / loud_by_file / rings）**结构性恒空** ——
#     json reporter 不记 console（`#133`）。机制 / 取舍 / 代价的单一来源：docs/dev-environment.md §0.1.1。
#     （汇总两行**不走**它：msys 下 reporter 会给那两行上 ANSI 色码，`^ *Test Files` 锚不到 ⇒
#     照旧由下面的 JSON 兜底给出稳定的同形汇总。）
JSON_OUT="dsh-lane-results.json"
if [ -n "$LANE" ]; then
  runner=(node node_modules/vitest/vitest.mjs run --project "$LANE")
  [ "$NO_LIVE" = 1 ] && runner+=(--exclude "$LIVE_SPEC")
else
  runner=(node node_modules/vitest/vitest.mjs run)
  [ "$NO_LIVE" = 1 ] && runner+=(--exclude "$LIVE_SPEC")
fi
(cd "$COPY" && rm -f "$JSON_OUT" && "${runner[@]}" --reporter=json --reporter=default --outputFile="$JSON_OUT") >"$log" 2>&1
rc=$?
trap 'rm -f "$log" "$typeslog" "$buildlog"; [ -n "${COPY:-}" ] && rm -f "$COPY/$JSON_OUT"' EXIT

# —— 6. 读数汇总：逐文件四态 + loud skip 原文 + 汇总行（**绿红都收**）——
echo ""
echo "=== msys 车道读数（副本 $copy_short${LANE:+ · lane=$LANE}） ==="
# 逐档读数：跑测试时已用 `--reporter=json --outputFile` 把结果写到副本根的临时 JSON，
# 这里用小段 node 解析成与 verify-all 同形的表（`✓ |lane| tests/x.spec.ts (7 tests | 1 skipped) 20529ms`）。
# 解析器读不到（json 没写成 / 形状变了）就退回控制台尾部 —— 读数表宁可短，不能空。
JSON_OUT_PATH="$COPY/$JSON_OUT"
per_file=$(node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  if (!fs.existsSync(path)) process.exit(0);
  const report = JSON.parse(fs.readFileSync(path, "utf8"));
  // vitest 的 json 报告**不带 project 名**（实测：testResult 只有 name/status/…），故车道标记
  // 由这份**与 vitest.config.ts 的 machineLane 同口径**的清单判：机器档是串行车道那 5 个文件。
  // 清单漂移的表现只是表里标记错，不影响判绿红（判据是退出码与标记本身）。
  const MACHINE = [
    "ssh-pty-live", "terminal-machine", "e2e-tool-call-machine",
    "e2e-real-llm-machine", "e2e-tarball-machine",
  ];
  const rows = (report.testResults ?? []).map((file) => {
    const rel = String(file.name ?? "").replace(/\\/gu, "/").replace(/^.*?\/tests\//u, "tests/");
    const lane = MACHINE.some((m) => rel.includes(m)) ? "machine" : "unit";
    const assertions = file.assertionResults ?? [];
    const total = assertions.length;
    const skipped = assertions.filter((a) => a.status === "skipped").length;
    const failed = assertions.filter((a) => a.status === "failed").length;
    const mark = failed > 0 ? "×" : total > 0 && skipped === total ? "↓" : "✓";
    const detail = `${total} tests${skipped > 0 ? ` | ${skipped} skipped` : ""}`;
    const ms = Number.isFinite(file.endTime - file.startTime) ? ` ${Math.round(file.endTime - file.startTime)}ms` : "";
    return `  ${mark} |${lane}| ${rel} (${detail})${ms}`;
  });
  process.stdout.write(rows.join("\n"));
' "$JSON_OUT_PATH" 2>/dev/null || true)
if [ -n "$per_file" ]; then
  printf '%s\n' "$per_file" | sed 's/^/  /'
else
  tail -3 "$log" | sed 's/^/  /'
fi
rings=$(grep -E "^ *(✓|×|–) [0-9]" "$log" || true)
[ -n "$rings" ] && printf '%s\n' "$rings" | sed 's/^/  /'
# loud 计数读 `$log` 的**控制台**：这些行只有 `--reporter=default` 会写进来（json reporter 不记
# console，#133）⇒ 上面 runner 少了 default 时本读数会静默退回 0。`tests/msys-lane.spec.ts`
# 的契约 4 钉住了这条耦合（变异验证：删掉 default ⇒ 守卫红）。
loud=$(grep -c "!! SKIP (loud)" "$log" || true)
# 逐档归因（#133，票面「影响」要的就是"哪一档"）：default reporter 把每条 console 输出打在
# `stderr | <spec> > <用例>` 头行之后 ⇒ 记住最近一次头行里的 spec，再数 loud 行。
# 只锚「`| ` + 路径」这一段：msys 下色码会夹在路径与 `>` 之间（实测 `.ts\e[2m > `），
# 锚字面 ` >` 或行首都会假空；而 `$log` 里只有 console 头行带 `| tests/…spec.ts` 这个形状。
loud_by_file=$(awk '
  { if (match($0, /\| tests\/[^ ]+\.spec\.ts/)) { s = substr($0, RSTART, RLENGTH); sub(/^\| /, "", s); f = s } }
  /!! SKIP \(loud\)/ { if (f != "") c[f]++; else c["(未归因)"]++ }
  END { for (k in c) printf "%s ×%d\n", k, c[k] }
' "$log" 2>/dev/null | sort || true)
guard=$(grep -E "privacy-scan: (干净|命中)" "$log" | tail -1 || true)
files_line=$(grep -E "^ *Test Files" "$log" | tail -1 | sed 's/^ *//' || true)
tests_line=$(grep -E "^ *Tests " "$log" | tail -1 | sed 's/^ *//' || true)
# 兜底：msys 下 reporter 会给汇总两行上 **ANSI 色码**（行首是 `\e[2m`，不是空格 —— 实测），
# 故上面那两条 `^ *…` 锚不到、永远走这个 JSON 版。它也是本脚本的**稳定口径**（与颜色无关）。
# **注意 `numTotalTestSuites` 数是 suite 不是文件**（实测 22 个文件报成 96），文件级计数只能从
# `testResults` 数。
if [ -z "$files_line" ] && [ -f "$JSON_OUT_PATH" ]; then
  summary_lines=$(node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const files = r.testResults ?? [];
    // 「整档跳过」= 该文件有断言、但**一条都没跑**（如 ssh-pty-live 门禁未开）：算 skipped 不算 passed。
    const fullySkipped = (f) => {
      const a = f.assertionResults ?? [];
      return a.length > 0 && a.every((x) => x.status === "skipped");
    };
    const fFail = files.filter((f) => f.status === "failed").length;
    const fSkip = files.filter((f) => f.status !== "failed" && fullySkipped(f)).length;
    const fPass = files.length - fFail - fSkip;
    const t = { pass: r.numPassedTests ?? 0, fail: r.numFailedTests ?? 0, skip: (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0), total: r.numTotalTests ?? 0 };
    process.stdout.write(`Test Files  ${fPass} passed | ${fFail} failed | ${fSkip} skipped (${files.length})\nTests  ${t.pass} passed | ${t.fail} failed | ${t.skip} skipped (${t.total})`);
  ' "$JSON_OUT_PATH" 2>/dev/null || true)
  files_line=$(printf '%s\n' "$summary_lines" | sed -n '1p')
  tests_line=$(printf '%s\n' "$summary_lines" | sed -n '2p')
fi
[ -f "$JSON_OUT_PATH" ] && rm -f "$JSON_OUT_PATH"
echo "  ---"
echo "  typecheck=ok（副本 $copy_short）  ·  loud skip 行数：$loud"
# 逐档归因：只列**确实打了 loud** 的档（票面「影响」要的就是"哪一档"，不是只有总数）。
[ -n "$loud_by_file" ] && printf '%s\n' "$loud_by_file" | sed 's/^/  含 loud 的档：/'
[ -n "$files_line" ] && echo "  $files_line"
[ -n "$tests_line" ] && echo "  $tests_line"
[ -n "$guard" ] && echo "  $guard"
echo "  注：直调 vitest，故没有 verify-all 的 PASS* 计数；含 loud skip 的档看上面 loud 行数 + 逐档归因"
echo "      （口径 = 本次控制台打出的 \`!! SKIP (loud)\` 行数，跨车道合计；行尾 \`| N skipped\` 是"
echo "       vitest 级跳过，**与 loud 不是一回事** —— loud 是用例仍 passed、只放弃了环境侧断言）"
echo "  exit=$rc"
if [ "$rc" != 0 ]; then
  echo ""
  echo "--- 红档原文（末 40 行）---"
  # 隐私提醒：这一步把**控制台**原文打出来（#133 之后才有控制台可打），而 e2e 的打点里含
  # 一次性引导 URL（token）与本机绝对路径 —— 贴进 issue / 聊天前先脱敏（docs/agents/privacy.md）。
  echo "  （提醒：以下原文含控制台输出，可能有一次性 token / 本机绝对路径 —— 外贴前先脱敏）"
  tail -40 "$log" | sed 's/^/  /'
  fail "套件红（exit $rc）—— 完整输出见上面末 40 行"
fi
step "全绿 ✅（读数口径见上；验收依据 docs/agents/TESTING.md，含 loud skip 的档看逐档归因与 loud 行数）"
exit 0
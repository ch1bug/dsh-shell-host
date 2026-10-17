#!/bin/bash
# msys-lane.sh —— **msys 侧日常口径**：同步部署副本 → 在副本上跑唯一检查入口 → 打读数汇总。
#
# 为什么存在：本仓有三条验证车道（见 docs/dev-environment.md §0.1.1）——
#   ① Windows 侧权威树（`node --run test`，开发时最常跑）
#   ② Windows 侧对副本（PowerShell + ucrt64 node **指过去**跑）
#   ③ **msys 侧对副本**（msys 的 git/sh/tar + Windows 的 node，真在副本里跑）
# 第 ③ 条此前只活在文档的散文里，每次都要手敲六条命令，且极容易踩「路径形态」坑（POSIX `/c/…`
# 交给 Windows node → 安装环红而装箱档绿，看着像产品缺陷）。本脚本把那条车道**口子化**：
# 一条命令走完，并把它依赖的环境事实（Windows node 前置、Windows 形态路径）在入口处钉死。
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
while [ $# -gt 0 ]; do
  case "$1" in
    --lane) LANE="${2:-}"; [ -n "$LANE" ] || { echo "msys-lane: --lane 需要一个值（unit / machine）" >&2; exit 2; }; shift 2 ;;
    --no-sync) DO_SYNC=0; shift ;;
    -h|--help) echo "用法：bash scripts/msys-lane.sh [--lane unit|machine] [--no-sync]
  在 msys bash 里跑：同步部署副本 → 跑唯一检查入口 → 打读数汇总。
  覆盖：DSH_MSYS_COPY（副本路径，默认 \$HOME/dsh-shellhost-src）、DSH_MSYS_SRC（权威树，默认本仓）"; exit 0 ;;
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
  */ucrt64/*) fail "生效的 node 是 ucrt64：构建/套件会崩在原生件上（-msvc 绑定）。设 DSH_MSYS_WIN_NODE_DIR 后重试" ;;
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
step "车道=${LANE:-全量（unit + machine）}  副本=$copy_short  node=$(node -v)"
log=$(mktemp)
trap 'rm -f "$log"' EXIT
if [ -n "$LANE" ]; then
  (cd "$COPY" && node node_modules/vitest/vitest.mjs run --project "$LANE") >"$log" 2>&1
else
  (cd "$COPY" && node --run test) >"$log" 2>&1
fi
rc=$?

# —— 6. 读数汇总：逐文件四态 + loud skip 原文 + 汇总行（**绿红都收**）——
echo ""
echo "=== msys 车道读数（副本 $copy_short${LANE:+ · lane=$LANE}） ==="
if [ -n "$LANE" ]; then
  grep -E "^ *(✓|×|↓) \|" "$log" | sed 's/^/  /' || true
  tail -3 "$log" | sed 's/^/  /'
else
  grep -E "PASS|SKIP|OK —|FAILED|FAIL " "$log" | tail -30 | sed 's/^/  /'
fi
loud=$(grep -c "!! SKIP (loud)" "$log" || true)
guard=$(grep -E "privacy-scan: (干净|命中)" "$log" | tail -1 || true)
echo "  ---"
echo "  loud skip 行数：$loud${guard:+  ·  $guard}"
echo "  exit=$rc"
if [ "$rc" != 0 ]; then
  echo ""
  echo "--- 红档原文（末 40 行）---"
  tail -40 "$log" | sed 's/^/  /'
  fail "套件红（exit $rc）—— 完整输出见上面末 40 行"
fi
step "全绿 ✅（验收口径见 docs/agents/TESTING.md；machine 档的 PASS* 表示含 loud skip）"
exit 0
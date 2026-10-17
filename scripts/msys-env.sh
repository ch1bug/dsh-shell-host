#!/bin/sh
# msys-env.sh —— msys2 会话引导：让 msys 复用 Windows 侧的 node / gh / git 配置。
#
# 为什么需要：msys 的 `HOME` 由 msys 自己设定（**不是** Windows 用户目录），默认
# PATH 里也没有 Windows 的 node/gh —— 于是 msys 里 `gh auth status`、`node --run test`
# 全部失败，而 Windows 侧一切就绪（gh 已登录、GCM 管凭据、node 24 在位）。逐会话现场拼
# PATH 会漏、会拼错（见 docs/dev-environment.md §0.1 的两类静默错位）。
#
# 用法（**source，不要执行**）：  . <repo>/scripts/msys-env.sh
# 想常驻：写进 `~/.bashrc`。
#
# 设计约束（与邻仓 dsh-matt-preset 的 msys-env.sh 同形，但**占位化**）：
#
#   1. **只指向，不复制、不修改** Windows 的配置与凭据；**不覆盖 `HOME`**（改了会波及
#      msys 其它工具）——只覆盖 git/gh 的配置位置。
#   2. **不写死任何本机盘符 / 用户路径**（本仓是 PUBLIC 仓）：所有目录都经
#      `cygpath` / `command -v` / 注册表默认位置**在运行时推导**；确实要指到非默认位置时
#      用下面四个 `DSH_MSYS_*` 变量覆盖，而不是改本文件。
#   3. **Windows node 必须排在 ucrt64 node 之前**：ucrt64 node 上报 `platform=win32-x64-gnu`，
#      而本仓构建链的 rolldown 只发布 `-msvc` 绑定 → 用它跑套件会以缺 DLL 崩在原生件上
#      （实测；见 docs/dev-environment.md §4）。本脚本会把 Windows node 目录前置，并在
#      自检里**点名**当前生效的是哪一个。
#   4. **不提供 `dsh` shim**：本仓 e2e 挂具用显式 env（`DSH_E2E_NODE` /
#      `DSH_E2E_PLUGIN_DIR` / `DSH_E2E_HOST_DIR` / `DSH_E2E_PNPM_DIR`）直接驱动宿主 CLI
#      （`node <host>/apps/cli/src/bin.ts`），**不依赖 PATH 上的 `dsh`** —— 这是本仓相对
#      邻仓的**有意差异**（邻仓 #83 正要向这个形态收敛）。所以这里不造 shim；缺 pnpm 时
#      只需把宿主树的 `node_modules/.bin` 加到 PATH（见 §0.1.1 的配方）。

# —— Windows 用户目录（cygpath 由 msys 提供；%USERPROFILE% 在 msys 里通常仍在环境里）——
DSH_MSYS_WIN_HOME="${DSH_MSYS_WIN_HOME:-${USERPROFILE:-}}"
if [ -z "$DSH_MSYS_WIN_HOME" ] && command -v cygpath >/dev/null 2>&1; then
  DSH_MSYS_WIN_HOME=$(cmd //c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')
fi
if [ -n "$DSH_MSYS_WIN_HOME" ] && command -v cygpath >/dev/null 2>&1; then
  WINHOME=$(cygpath -u "$DSH_MSYS_WIN_HOME")
else
  WINHOME="${DSH_MSYS_WIN_HOME:-}"
fi

# —— 候选目录：从「当前 Windows PATH 上已经在的工具」反推所在目录，再补默认安装点 ——
# to_dir <exe>  → 该可执行文件所在目录（POSIX 形态）；找不到则空。
to_dir() {
  p=$(command -v "$1" 2>/dev/null) || return 0
  case "$p" in
    /*) d=$(dirname "$p") ;;
    *)  d=$(command -v cygpath >/dev/null 2>&1 && cygpath -u "$(dirname "$p")") ;;
  esac
  [ -n "$d" ] && printf '%s\n' "$d"
}

# from_win_path_outside <exe1> [exe2 …] → 该可执行文件所在目录（POSIX 形态），**排除 msys 自己的
# 目录**。为什么要另立一条：msys 的默认 PATH **优先**自己的 `/usr/bin/git`，`command -v git` 探到的
# 是 msys git（非默认安装点的 Windows git 更探不到）；而本仓若要 Windows git（GCM 凭据 +
# 与权威树同 core.autocrlf）就得另找。做法 = 用已探到的 node 读 **Windows 侧 PATH**（只读、不改
# 环境），逐个候选目录看里面有没有该 exe，并把 msys 根之下的命中剔掉 —— 否则第一命中永远是
# `C:\msys64\usr\bin`（实测），等于没换。全程不写死任何本机盘符 / 用户路径。
#
# 边界（有意）：只看 **PATH 上的目录**，不去猜非默认安装点。所以「Git for Windows 不在 Windows
# PATH 上」这类布局探不到 —— 那时打印警告，由 `DSH_MSYS_WIN_GIT_DIR` 显式覆盖（实测有效）。
from_win_path_outside() {
  command -v cygpath >/dev/null 2>&1 || return 0
  [ -n "$NODE_BIN_FOR_PATH" ] || return 0
  WINPATH="$("$NODE_BIN_FOR_PATH" -e 'process.stdout.write(process.env.PATH ?? "")' 2>/dev/null)"
  [ -n "$WINPATH" ] || return 0
  # msys 自己的根（如 /ucrt64 → 上两级 = C:\msys64）：msys 会把自己的 `/usr/bin`、
  # `/ucrt64/bin` 塞进 Windows PATH，而里面**就有** git.exe / node.exe —— 只排除
  # `MSYSTEM_PREFIX` 不够，必须排到 msys 根，否则第一命中还是 msys（实测）。
  MSYS_ROOT=""
  if [ -n "${MSYSTEM_PREFIX:-}" ]; then
    MSYS_ROOT=$(cygpath -w "$(dirname "$(dirname "$MSYSTEM_PREFIX")")" 2>/dev/null)
  fi
  # 注意：**不能**在 `-e` 的脚本里用 `process.argv` —— `node -e` 下 argv[0] 是 node 本身，
  # 传进来的参数从 argv[1] 起，容易错位一位（实测：候选名变成 argv[0]，永远查不到）。
  # 候选名、PATH、排除根都经环境变量传进去，避掉引号与错位两重坑。
  DIR=$(CANDIDATES=$(printf '%s,' "$@" | sed 's/,$//') PATHDIRS="$WINPATH" EXCL="$MSYS_ROOT" \
    "$NODE_BIN_FOR_PATH" -e '
      const { existsSync } = require("node:fs");
      const { join, normalize } = require("node:path");
      const excl = (process.env.EXCL ?? "").replace(/[\\/]+$/u, "").toLowerCase();
      const names = process.env.CANDIDATES.split(",");
      const hit = (process.env.PATHDIRS ?? "").split(";")
        .map((s) => s.replace(/[\\/]+$/u, "")).filter(Boolean)
        .filter((d) => excl === "" || !normalize(d).toLowerCase().startsWith(excl))
        .find((d) => names.some((n) => existsSync(join(d, n))));
      process.stdout.write(hit ?? "");
    ' 2>/dev/null)
  [ -n "$DIR" ] || return 0
  cygpath -u "$DIR"
}

# 先把 Windows 的 node 找到：`to_dir node` 在 msys PATH 上没有 node 时为空，故补默认安装点。
NODE_BIN_FOR_PATH=""
for c in "${DSH_MSYS_WIN_NODE_DIR:-}" "$(to_dir node)" "/c/Program Files/nodejs" "/c/Program Files (x86)/nodejs"; do
  [ -n "$c" ] && [ -x "$c/node.exe" ] && { NODE_BIN_FOR_PATH="$c/node.exe"; break; }
  [ -n "$c" ] && [ -x "$c/node" ] && { NODE_BIN_FOR_PATH="$c/node"; break; }
done

NODE_DIR="${DSH_MSYS_WIN_NODE_DIR:-$(from_win_path_outside node.exe node)}"
[ -n "$NODE_DIR" ] || NODE_DIR="$(to_dir node)"
GH_DIR="${DSH_MSYS_GH_DIR:-$(from_win_path_outside gh.exe gh)}"
[ -n "$GH_DIR" ] || GH_DIR="$(to_dir gh)"
GIT_DIR="${DSH_MSYS_WIN_GIT_DIR:-$(from_win_path_outside git.exe git)}"
[ -n "$GIT_DIR" ] || GIT_DIR="$(to_dir git)"

# 默认安装点（通用、非个人路径）。只在上面推导不到时兜底。
for d in "/c/Program Files/nodejs" "/c/Program Files (x86)/nodejs"; do
  [ -n "$NODE_DIR" ] && break
  [ -d "$d" ] && NODE_DIR="$d"
done
for d in "/c/Program Files/GitHub CLI"; do
  [ -n "$GH_DIR" ] && break
  [ -d "$d" ] && GH_DIR="$d"
done
for d in "/c/Program Files/Git/cmd" "/c/Program Files (x86)/Git/cmd"; do
  [ -n "$GIT_DIR" ] && break
  [ -d "$d" ] && GIT_DIR="$d"
done

# —— PATH 前置（先拼前缀再一次 prepend，避免逐个 prepend 把顺序倒过来）——
# 顺序硬约束：Windows node → gh / Windows git → corepack（pnpm shim）→ 其余原 PATH。
# **幂等**：本脚本建议写进 `~/.bashrc`，每次都无条件 prepend 会让 PATH 无限累加（实测），
# 故先过滤掉「已在本 PATH 里」的目录。
PREFIX=""
for d in "$NODE_DIR" "$GH_DIR" "$GIT_DIR" "$HOME/.corepack/bin"; do
  [ -n "$d" ] && [ -d "$d" ] || continue
  case ":$PATH:" in
    *":$d:"*) ;;                       # 已在本 PATH 里 → 不再前置
    *) PREFIX="$PREFIX$d:" ;;
  esac
done
[ -n "$PREFIX" ] && export PATH="$PREFIX$PATH"

# —— 复用 Windows 的 git / gh 配置与凭据 ——
# 系统级 gitconfig 从「Windows git 的安装根」推（cmd/git.exe → 上两级）；两个默认位置都试。
if [ -n "$GIT_DIR" ]; then
  GIT_ROOT=$(dirname "$GIT_DIR")
  for c in "$GIT_ROOT/etc/gitconfig" "/c/Program Files/Git/etc/gitconfig"; do
    [ -f "$c" ] && { export GIT_CONFIG_SYSTEM="$c"; break; }
  done
fi
[ -n "$WINHOME" ] && [ -f "$WINHOME/.gitconfig" ] && export GIT_CONFIG_GLOBAL="$WINHOME/.gitconfig"
[ -n "$WINHOME" ] && [ -d "$WINHOME/AppData/Roaming/GitHub CLI" ] && \
  export GH_CONFIG_DIR="$WINHOME/AppData/Roaming/GitHub CLI"
export COREPACK_HOME="${COREPACK_HOME:-$HOME/.corepack}"

# —— 自检：缺哪个报哪个，绝不静默（且**点名** ucrt64 / msys git 抢位这两条）——
# 直接执行（而非 source）时给一句明确提示：那样 PATH / 配置落到子壳里，会话里看不到效果。
if [ -n "${BASH_SOURCE:-}" ] && [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "msys-env: 这是要 **source** 的脚本（. <repo>/scripts/msys-env.sh）；直接执行不会影响当前会话" >&2
fi

warn() { echo "msys-env: 警告：$1" >&2; }
for t in node git gh; do
  command -v "$t" >/dev/null 2>&1 || warn "PATH 上找不到 $t —— 相关验证会响亮跳过或失败"
done

NODE_BIN=$(command -v node 2>/dev/null)
case "$NODE_BIN" in
  /ucrt64/*|*/ucrt64/*)
    warn "当前生效的 node 是 ucrt64（$NODE_BIN）：原生件只发布 -msvc 绑定，构建/套件会崩。
      设 DSH_MSYS_WIN_NODE_DIR 指向 Windows node 目录（如 '/c/Program Files/nodejs'）后重 source" ;;
esac
GIT_BIN=$(command -v git 2>/dev/null)
case "$GIT_BIN" in
  /usr/bin/*) warn "当前生效的 git 是 msys 自带的（$GIT_BIN）：工作区行尾判据可能与 Windows git 不同
      （见 docs/dev-environment.md §0.1 第 1 条）。用 Windows git 可设 DSH_MSYS_WIN_GIT_DIR 后重 source" ;;
esac

[ -n "$NODE_BIN" ] && echo "msys-env: node=$NODE_BIN（$(node -v 2>/dev/null)）"
[ -n "$GIT_BIN" ] && echo "msys-env: git=$GIT_BIN（$(git --version 2>/dev/null)）  gh=$(command -v gh 2>/dev/null)  gitconfig=${GIT_CONFIG_GLOBAL:-<msys 默认>}"

# 注意：**不要在这里 `exit 0`** —— 本脚本是 source 用的，`exit` 会把调用方的 shell 一起
# 退掉（实测踩过：source 完就没了后续命令）。脚本自然结束即可。
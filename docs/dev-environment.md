# 开发环境（源码部署 / 隔离 / 构建）

本文件是本仓**环境事实的唯一来源**（仓内、可继承）：隔离契约、工具链结论、
源码部署步骤、构建坑。日常改动的验证走 `pnpm test`（见
[TESTING.md](agents/TESTING.md)）；本文件只管**把实例跑起来**。

## 0. 权威工作树 vs 部署副本

**权威工作树 = `<repo>`（本仓库）。** msys2 侧的源码树
（`/home/<user>/dsh-shellhost-src`）只是**只读部署副本**。

| 动作 | 位置 |
|---|---|
| 改代码 / `git add` / `git commit` / `git push` | ✅ **只在权威树** |
| 跑实例（19502）、B1 构建、临时探针 | 部署副本 |

副本单向同步（权威 → 副本）：

```bash
git -C /c/msys64/home/<user>/dsh-shellhost-src fetch <repo> main
git -C /c/msys64/home/<user>/dsh-shellhost-src merge --ff-only FETCH_HEAD
```

**两边的 `main` 必须同提交。** 不同即说明有人在副本里提交了 —— 停下核对。

**实测教训（2026-10-16）**：为搭部署环境建克隆后顺手在克隆里开发并提交，结果出现
「两个都叫 `main`、内容不同」的仓库，权威树落后 3 个提交；又叠加 `git checkout <tag>`
造成的 detached HEAD。**根因是把"部署副本"和"开发工作树"混为一个。**

**本仓不要 `checkout` tag** —— `dsh-v0.2.0-rc.2` 锚点属于**宿主**源码树；本仓
`main` 就是工作线，切 tag 只会制造 detached HEAD。

## 0.1 msys2 会话引导（否则工具链会静默错位）

msys2 的 `HOME` 与 PATH 都不指向 Windows 侧，直接在里面跑 git/node 会踩两类坑：

1. **git 配置不继承** → `core.autocrlf` 等设置丢失，同一工作区被两套 git 判出
   **全量行尾差异**（实测 123 个文件 "modified"，`git diff --ignore-cr-at-eol --stat`
   为空），`merge --ff-only` 因此报「本地修改将被覆盖」。判别：**忽略行尾后为空
   即纯噪音**，可安全 `checkout -- .`；非空才是真实改动。
2. **ucrt64 node 优先于 Windows node** → ucrt64 上报 `platform=win32-x64-gnu`，而
   rolldown 等原生件只发布 `-msvc` 绑定（见 §4）。

引导做法（**Windows node 必须先于 ucrt64**，并复用 Windows 的 git/gh 配置与凭据）：

```bash
export PATH="/c/Program Files/nodejs:/ucrt64/bin:$PATH"
export GIT_CONFIG_GLOBAL="$(cygpath -u "$USERPROFILE")/.gitconfig"
export GH_CONFIG_DIR="$(cygpath -u "$USERPROFILE")/AppData/Roaming/GitHub CLI"
```

只**指向**Windows 配置，不复制不修改：凭据与登录态留在原处。

## 1. 隔离契约（三实例互不干扰）

启动器用 **`DSH_HOME`** 定位 home、**`--profile <name>`** 选择
`$DSH_HOME/profiles/<name>`。两处都要独立，profile **名**也要不同。

| 资源 | 桌面端 | 相邻工作区（matt 工作流） | **本区（shell-host）** |
|---|---|---|---|
| DSH_HOME | `C:\Users/<user>\.dsh` | `/home/<user>/dsh-matt-home` | `/home/<user>/dsh-shellhost-home` |
| profile | `desktop` | `matt-dev` | **`dsh-host-dev`**（常驻实例） |
| 端口 | 19387（GUI） | 19501 | **19502** |
| 源码树 | 安装版 | `dsh-matt-src` | 部署副本 `dsh-shellhost-src` + 宿主 `dsh-host-src` |

两个 e2e 套件另用**临时** profile（`os.tmpdir` 下的临时 DSH_HOME + `--port 0`，
跑完即删），不占上表任何资源：mock 层用 `dsh-host-dev`，真实层用
`dsh-host-real`（同名不同 home，互不干扰）。

- **`DSH_PROFILE` / `DSH_PROFILE_DIR` 不是启动选择器**：它们是 shell-env 插件每次
  模型 shell 调用**注入给模型的输出事实**。拿它们做隔离判断是错的。
- 桌面端是**稳定升级通道**：开发中的改动不得先装桌面端。
- pnpm store 与 corepack shim 可共享（内容寻址、只读复用）；**并发 install 不要共享**。

## 2. 宿主锚点（ADR-0008）

跟随 DSH 运行时 **rc 线**：本仓 `0.2.0-rc.2-r1` ↔ 宿主 tag
`dsh-v0.2.0-rc.2`（commit `639ed015`）。

**浅克隆默认分支会落到 alpha 系**（实测 `dsh-v0.2.1-alpha.4`），与锚不符 ——
宿主必须显式 checkout tag：

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git <src>
cd <src> && git fetch --depth 1 origin tag dsh-v0.2.0-rc.2 && git checkout dsh-v0.2.0-rc.2
```

**RC 与 alpha 的接口差异（切锚时必查）**：

| 项 | alpha | **RC2** |
|---|---|---|
| `session/initializeDefaultModel` | 有 | **无**（改用 `selectModel`） |
| `dsh-tools` peer 集 | 无 `dsh-invariants`；`cordis ~4.0.5-alpha.1`、`schemastery ~3.18.5-alpha.1` | **有 `dsh-invariants`**；`cordis ~4.0.4`、`schemastery ~3.18.4` |
| `scripts/build.ts` 参数 | `--scope artifacts` | `--profile` |

照 alpha 抄 peer 会**漏声明**（本仓 #82 即此）。

## 3. 源码部署步骤（msys2 侧）

```bash
# 宿主（自建，不复用相邻工作区的树）
git clone https://github.com/deepseek-ai/deepseek-harness.git /home/<user>/dsh-host-src
cd /home/<user>/dsh-host-src
git fetch --depth 1 origin tag dsh-v0.2.0-rc.2 && git checkout dsh-v0.2.0-rc.2
pnpm install --ignore-scripts --package-import-method=copy   # 见 §4.1
git clean -fxd && pnpm install --ignore-scripts --package-import-method=copy
pnpm build                                                   # 见 §4.2/§4.3（约 290s）

# 本插件（部署副本）
git clone <repo> /home/<user>/dsh-shellhost-src
cd /home/<user>/dsh-shellhost-src && pnpm install && pnpm build
```

# 把插件挂进 profile —— 官方两步命令，顺序固定
export PATH="/c/msys64/home/<user>/.corepack/bin:$PATH"       # dsh plugin 会调 pnpm
dsh --profile dsh-host-dev --from-default-profile web --dump-config   # ① 播种 profile
dsh plugin --profile dsh-host-dev add /home/<user>/dsh-shellhost-src   # ② 注册 + pnpm 安装
```

**完整规则与理由见 [profile-install.md](agents/profile-install.md)**（为何 ① 不能省、
为何不许手工 symlink、三处断言、dump 组合树验证）。此处只记部署侧要点：
`dsh plugin` 需要 PATH 上有 pnpm shim，而 corepack 装 shim 要避开 Program Files
权限（写进去会 EPERM）—— 用上方那个 `--install-directory` 路径即可。

## 4. 工具链结论（全部实测，别重复试错）

### 4.1 ucrt64 node 跑 pnpm 装 DSH 本体不可行

pnpm 加载 N-API 原生件即 `napi-sys … Node-API symbol has not been loaded` → panic
abort（`--ignore-scripts` 也一样）。绕行 = `--package-import-method=copy`（关硬链接）
**且用 Windows node 装**。（本插件包几乎纯 JS，纯 ucrt64 能过 —— 结论不可类推。）

### 4.2 构建期原生件缺口

ucrt64 node 上报 `platform=win32-x64-gnu`，而 rolldown 等只发布 `-msvc` 绑定，
且 `@rolldown/binding-win32-x64-gnu` **在 npm 上不存在** → 打包必须走
**Windows node**。B1 分工：

| 环节 | 环境 |
|---|---|
| `tsc` typecheck / 声明产出（纯 JS） | msys2 ucrt64 node 可 |
| `tsdown` 打包（rolldown） | **必须 Windows node** |

### 4.3 切 tag 后必须清理构建产物

`lib/` 被 `.gitignore` 忽略，`git status` 看着干净，实际残留上一 tag 的产物 ——
RC2 构建会报 `MISSING_EXPORT "principalOf"`（该符号只存在于 alpha 源码）。
用 `git clean -fxd`（实测清掉 38 个孤儿 `lib/` 后通过）。

### 4.4 本插件的依赖锚（#82）

`@deepseek-ai/dsh-tools` 必须锚 **RC 线**（`0.2.0-rc.2`），且其 **10 个
peerDependencies 必须显式声明**（含 `dsh-invariants`）。未声明时 pnpm 严格布局下
运行时缺失：`Cannot find package '@deepseek-ai/dsh-scope'`。

### 4.5 msys 的 `pkill` 杀不掉 Windows node 进程

端口占用报 `EADDRINUSE 127.0.0.1:<port>` 时，用 `netstat -ano` 找 pid +
`Stop-Process -Id <pid> -Force`。

## 5. 实例相关文档

- 驱动实例 / 读耐久证据 / RPC 参数名 / mock LLM：[dsh-runtime-cheatsheet.md](dsh-runtime-cheatsheet.md)
- 验证分层与门禁：[TESTING.md](agents/TESTING.md)
- 隔离与构建的**本机落地记录**（机器相关，不入库）：
  `<DSH_HOME>/REGISTRY.md`
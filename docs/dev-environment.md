# 开发环境（源码部署 / 隔离 / 构建）

本文件是本仓**环境事实的唯一来源**（仓内、可继承）：隔离契约、工具链结论、
源码部署步骤、构建坑。日常改动的验证走 `node --run test`（见
[TESTING.md](agents/TESTING.md)）；本文件只管**把实例跑起来**。

## 0. 权威工作树 vs 部署副本

> 占位符约定（本文件与全仓）：`<repo>` = 本仓检出的权威副本、`<sibling-repo>` = 相邻工作区
> 检出、`<old-work>` = 旧工作布局根；`~` / `$HOME` / `%USERPROFILE%` 照 shell 语义。
> 本仓是 **PUBLIC** 仓，真实个人 / 本机路径不进仓（机械守卫：`scripts/privacy-scan.mjs`，
> pre-commit 跑它）。

**权威工作树 = `<repo>`（本仓库的检出）。** msys2 侧的源码树
（`~/dsh-shellhost-src`，即 msys2 家目录下的 `dsh-shellhost-src`）只是**只读部署副本**。

| 动作 | 位置 |
|---|---|
| 改代码 / `git add` / `git commit` / `git push` | ✅ **只在权威树** |
| 跑实例（19502）、B1 构建、临时探针 | 部署副本 |

副本单向同步（权威 → 副本）：

```bash
git -C ~/dsh-shellhost-src fetch --prune --tags --force origin
git -C ~/dsh-shellhost-src merge --ff-only FETCH_HEAD
```

**两边的 `main` 必须同提交。** 不同即说明有人在副本里提交了 —— 停下核对。

**实测教训（2026-10-17）：tag 也要同步，且要 `--force`。** 只 `fetch origin main` 时 tag
**根本不进同步面**：不报错、退出码 0、`git status` 干净，副本静默停在旧 tag。补 `--tags`
后才碰 tag，但**已存在的 tag 默认 refuse clobber** —— git 打一行
`! [rejected] <tag> -> <tag> (would clobber existing tag)` 便**略过该 tag**（其余 ref 照常
更新；该次 fetch 退出码非 0）。**判别与后果**：`main` 同提交、工作树干净，**只有 tag 停在
旧对象** —— 落后的 tag 让**重写前**的提交仍经 `refs/tags/*` 可达，`git log --all` 于是扫出
重写前的旧个人身份，副本侧隐私守卫（`tests/privacy-scan.spec.ts` 活体扫描）判红：看着干净的
副本判不出绿。**处置**：`git tag -d <两个 tag>` + `git fetch --tags --force origin` 把 tag
落到 origin 的对象；之后按 [privacy.md](agents/privacy.md) §4 第 3 条清掉留下的本机悬挂旧对象
（`git reflog expire --expire=now --all` + `git gc --prune=now`），别把它留在副本里。
**与 §0.0 的分工**：那条管历史分叉后的一次性 `reset --hard`，本条是 tag 面的常规口径。

**实测教训（2026-10-16）**：为搭部署环境建克隆后顺手在克隆里开发并提交，结果出现
「两个都叫 `main`、内容不同」的仓库，权威树落后 3 个提交；又叠加 `git checkout <tag>`
造成的 detached HEAD。**根因是把"部署副本"和"开发工作树"混为一个。**

**本仓不要 `checkout` tag** —— 宿主锚点 tag（当前见 §2）属于**宿主**源码树；本仓
`main` 就是工作线，切 tag 只会制造 detached HEAD。

### 0.0 历史重写（2026-10-16，隐私）

本仓是 **PUBLIC** 仓，2026-10-16 之前的历史里带着个人 / 本机环境串（机主用户名与家目录、
检出与旧布局路径、个人署名与邮箱、真机名与内网 IP）。**处置 = 历史重写**：现树先占位化并提交，
再 `filter_repo`（blob 内容 / 提交信息 / 身份 `--mailmap`），最后 `--force-with-lease` 重推
`main` / 侧分支 / 两个 tag —— 与相邻工作区同一口径。

- **流程本体**（何时重写、枚举-一遍跑齐、飞行前后检查、tracker 口径、回滚退路）：
  [privacy.md](agents/privacy.md)。**本节只留这一次的现场事实。**
- 现场：旧提交 SHA 全部失效；tracked 文件里的引用已按**提交主题**对齐到终态
  （`tests/doc-references.spec.ts` 会挡下一次写错）；**commit 信息内**的旧哈希不改
  （历史不可追改），解析不到时以 `git log -S <符号>` 或备份镜像为准。
- 备份镜像（重写前完整历史，本机、不进仓）：`<repo>-backup-<date>.git`。
- **平台侧残留（human 2026-10-16 拍板不处理）**：GitHub 上旧对象仍可按旧 SHA 直接访问
  （本仓 0 fork / 0 PR）；彻底清除需向 GitHub Support 申请 purge —— **不申请**。
- **部署副本这一次不能用 `merge --ff-only`**：先 `git fetch` 再一次性
  `git reset --hard origin/main`；之后恢复正常同步口径。
- 防复发：`scripts/privacy-scan.mjs`（本机身份运行时取 + 三种布局形态 + home 下的 denylist），
  `.githooks/pre-commit` 与 `tests/privacy-scan.spec.ts` 共用；探针要 `-i`（全大写会静默漏小写写法）。

## 0.1 msys2 会话引导（否则工具链会静默错位）

msys2 的 `HOME` 与 PATH 都不指向 Windows 侧，直接在里面跑 git/node 会踩两类坑：

1. **git 配置不继承** → `core.autocrlf` 等设置丢失，同一工作区被两套 git 判出
   **全量行尾差异**（实测 123 个文件 "modified"，`git diff --ignore-cr-at-eol --stat`
   为空），`merge --ff-only` 因此报「本地修改将被覆盖」。判别：**忽略行尾后为空
   即纯噪音**，可安全 `checkout -- .`；非空才是真实改动。
2. **ucrt64 node 优先于 Windows node** → 构建 / 打包会在原生件绑定上崩掉。机制、上游事实与 B1
   分工**只在 §4.2 记一次**（那里有判别式、registry 读数与可跑的复现），本处不复述。

引导做法（**Windows node 必须先于 ucrt64**，并复用 Windows 的 git/gh 配置与凭据）：

```bash
export PATH="/c/Program Files/nodejs:/ucrt64/bin:$PATH"
export GIT_CONFIG_GLOBAL="$(cygpath -u "$USERPROFILE")/.gitconfig"
export GH_CONFIG_DIR="$(cygpath -u "$USERPROFILE")/AppData/Roaming/GitHub CLI"
```

3. **pty 里跑长命令要把输出重定向到文件**。msys2 bash 在 pty 下会缓冲，
   增量读取（`pty_tail`）会出现连续 `(no new output)` —— 实测为此反复空轮询十几次，
   关键路径被拖长。可靠做法是**命令写文件、读文件**：

   ```bash
   pnpm build > /d/build.log 2>&1; echo "exit=$?"; tail -20 /d/build.log
   ```

   次优：把整个命令链串成**一条**（含 `sleep`）再读取，而不是分多条排队 ——
   排队会让输出积压得更深。构建这类分钟级任务可交给后台作业（`run_in_background`），
   避开 pty 缓冲。

只**指向**Windows 配置，不复制不修改：凭据与登录态留在原处。

上面前两件（PATH + git/gh 配置）已经收进 `scripts/msys-env.sh`，source 一次即可：

```bash
. <repo>/scripts/msys-env.sh      # 只指向 Windows 的 node / gh / git 配置，不改 HOME
```

- 它把 **Windows node 前置**（防 ucrt64 抢位）、推导 gh / Windows git 目录、指向
  `%USERPROFILE%/.gitconfig` 与 Windows 的 gh 凭据目录，并在自检里**打印当前生效的
  node / git / gh 版本**（缺哪个报哪个，绝不静默）。**幂等**：重复 source 不会累加 PATH
  （故可安全写进 `~/.bashrc`）。
- **不写死本机路径**：目录都在运行时经 `cygpath` / Windows PATH 推导（本仓是 PUBLIC 仓）。
  非默认布局用四个变量覆盖：`DSH_MSYS_WIN_NODE_DIR` / `DSH_MSYS_GH_DIR` /
  `DSH_MSYS_WIN_GIT_DIR` / `DSH_MSYS_WIN_HOME`。实测：本机 **Git for Windows 不在 Windows
  PATH 上**，脚本于是维持 msys git 并**打印警告**，此时用
  `DSH_MSYS_WIN_GIT_DIR='<git 安装根>/cmd'` 覆盖即切到 Windows git
  （实测生效，且 `GIT_CONFIG_SYSTEM` 一并认到）。
- **不要把它当 `.sh` 执行**：`source` 是用法（脚本里没有 `exit`，就是为了不把调用方 shell 退掉）。

### 0.1.1 副本的 msys 侧全流程验证（**第三条车道**，2026-10-17 落地）

**三条车道用哪个 node**（**订正**：本节开篇此前写「默认的副本验证是『Windows 侧 PowerShell +
ucrt64 node 指过去』」—— 那句话与挂具默认值和车道前置检查**都对不上**（ucrt64 在车道上会
**响亮失败**，不是被选中的 node），故删去，改成下面这张显式表）：

| 车道 | 跑在哪 | 用哪个 node | 在哪个环节 | 这条归属的**依据** |
|---|---|---|---|---|
| ① Windows 侧权威树 | `<repo>` | Windows node | 全部：`node --run test`（typecheck + unit + machine） | 见下第 1、2 条（挂具默认值 + 车道前置检查） |
| ② Windows 侧对副本 | `~/dsh-shellhost-src` | **Windows node** | 全部（含 e2e 三档的宿主 CLI 调用） | 见下第 1 条（同一份挂具，副本只换路径） |
| ③ msys 侧对副本 | 副本内，msys 的 git/sh/tar | **Windows node** | 全部；生效 node 是 ucrt64 时车道**响亮失败** | 见下第 2、3 条（车道自己的 `fail` + 从生效 node 推导） |

**三条为什么都是 Windows node**（逐条对照，可复核）：

- `tests/helpers/e2e-install.ts:29`：`DSH_E2E_NODE ?? "C:/Program Files/nodejs/node.exe"`
  —— e2e 挂具驱动宿主 CLI 的默认 node **就是 Windows node**。它**同时**是车道 ① 与 ② 的依据：
  两条差别只在「副本还是权威树」（`DSH_E2E_PLUGIN_DIR` 指向谁），挂具是**同一份**；
- `scripts/msys-lane.sh:107-109`（票面引作 `:105-108`，本票的头注 +1 行所致）：生效 node 落在
  `*/ucrt64/*` 时**直接 `fail`**，并提示设 `DSH_MSYS_WIN_NODE_DIR` —— 车道 ③ **不允许**
  ucrt64 node 走到跑套件那一步；
- 同文件 `:162`：车道 ③ 把 `DSH_E2E_NODE` 从**当前生效的 node**（`command -v node`）
  `cygpath -w` 推导出来 —— 而第 0 步的引导已把它前置成 Windows node（§0.1 的引导做法）。
- §0.1 第 2 条（上文）：ucrt64 node 优先于 Windows node 会让构建 / 打包在原生件绑定上崩掉
  —— 这是**要防的故障**，是上面三条的**共同动机**，但它**本身不指定**哪条车道用哪个 node。

⚠️ **诚实声明（依据强度不同）**：车道 ① 与 ② 的 node 归属，依据是**挂具默认值**（那一条直接可核）；
车道 ② 在仓内**没有**对应的 PowerShell 侧车道脚本可引 —— 它的「Windows 侧」形态是**手工口径**
（§0.1.1 下面的手工等价跑法即其一份实例），其 node 归属由「同一份挂具 + 同一条引导前置」推出，
属**外推**而非直接引用。本处按实标记，不把它写成与 ① 同等强度的引用。

**`ucrt64` 唯一合法的落点**是 §4.2 的 B1 分工表（那里的**唯一来源**；本处不复述它的分工内容）：
它落在**单步 `tsc`** 上，**不是任何一条车道**。本仓的车道入口（`node --run test` /
`node --run build`）都把 Windows node 前置，所以**没有任何一条车道"用 ucrt64 node 指过去"跑**。

本仓的 e2e 挂具用**显式 env**
（`DSH_E2E_NODE` / `DSH_E2E_PLUGIN_DIR` / `DSH_E2E_HOST_DIR` / `DSH_E2E_PNPM_DIR`）驱动宿主 CLI，
所以**不依赖 PATH 上的 `dsh`**（这一点被邻仓 `dsh-matt-preset` 的 §0.1 反过来引用，
其 #83 正要把他们那套 `dsh` 依赖改成这个形态）。但那样跑，**msys 的 git/sh/tar 语义一次都没被行使**。

隔壁工作区的做法值得照搬：在**副本里**、用 **msys 的 git/sh/tar + Windows 的 node** 跑一遍完整套件
（含三档 e2e 的「安装 → 配置 → 启动 → 建会话 → 真实调用」）。本仓**已把它口子化成一条命令**：

```bash
bash <repo>/scripts/msys-lane.sh                  # 日常口径：同步副本 → 全量套件（含真实层）→ 读数汇总
bash <repo>/scripts/msys-lane.sh --no-live        # 排除真实层（外部端点偶发 TRANSPORT；**pre-push 用的就是这条**）
bash <repo>/scripts/msys-lane.sh --lane machine   # 迭代口径：只跑 machine 车道（~1 分钟）
bash <repo>/scripts/msys-lane.sh --no-sync        # 只验当前副本提交，不碰同步
```

**推送前自动跑**：`.githooks/pre-push` 会调 `scripts/msys-lane.sh --no-live`（约一分钟）——
推送是本套仓库离开本机的时刻，值得在它前面过一遍唯一检查入口。默认排除真实层的原因：
那一档打外部端点，偶发 `TRANSPORT` 会假红；让它阻断日常推送只会逼出 `SKIP_HOOKS`。真实层
留给发布 / 手动验收（默认口径含它）。绕过：`SKIP_HOOKS=1 git push …`。

`scripts/msys-lane.sh` 自己 source 引导脚本，并把这些面在入口处钉死（前置检查失败就**响亮失败**、
**不跑套件** —— 环境缺件与产品缺陷是不同归因，先分清）：

- 权威树工作树干净（行尾噪音按 §0.1 第 1 条判别：**忽略行尾后为空 = 纯噪音**，不算脏）；
- 权威树先与 `origin` 对齐，副本按 `--prune --tags --force` + `merge --ff-only` 同步（口径见 §0）；
- 两树同提交提示（`AGENTS.md` 的硬约束）、副本同步后仍干净；
- 四个 `DSH_E2E_*` 一律**推导成 Windows 形态**（`cygpath -w`），避免下面那条路径形态坑；
- 同步后**重建副本 `lib/`**（`node --run build`，实测 ≈2s）：`lib/` 被 gitignore，同步只搬源码 ——
  不重建就是「新 spec + 旧构件」的**空心绿**（三档 e2e 安装/打包的正是它）；
- 读数汇总**绿红都收**：逐文件行、`!! SKIP (loud)` 行数、隐私扫描读数、退出码；红时把末 40 行原文打出来。
  - **`loud` 行数的口径**（`#133` 修正）：= 本次运行**控制台**打出的 `!! SKIP (loud)` 行数（跨车道合计），
    外加一行**逐档归因**（`含 loud 的档：tests/x.spec.ts ×N`）—— 票面「影响」要的正是"哪一档跑得不全"。
    归因靠 reporter 的 `stderr | <spec> > <用例>` 头行，**不锚行首**（msys 下会带 ANSI 色码）。
    这些行只有 `--reporter=default` 会写进日志 —— vitest 4 的 **json 报告不记 console**
    （`testResults[]` 只有 `assertionResults` / `startTime` / `endTime` / `status` / `message` / `name`），
    所以跑套件那行**必须同时给** `--reporter=json`（逐档表）与 `--reporter=default`（控制台）。
    `#133` 之前只给 json ⇒ 该读数**结构性恒 0**，`PASS*`（"跑过但部分断言没验"）在 msys 面哑火 ——
    **历史车道读数里的 `loud skip 行数：0` 不可当基线**（那是缺陷，不是"没有 loud skip"）。
    形状守卫：`tests/msys-lane.spec.ts` 契约 4（变异：删掉 `--reporter=default` ⇒ 守卫红）。
    - **汇总两行仍走 JSON**（不是 reporter）：msys 下 reporter 会给 `Test Files` / `Tests` 上 ANSI 色码，
      行首是 `\e[2m` 而不是空格 ⇒ `^ *Test Files` 锚不到。JSON 版与颜色无关，是本脚本的稳定口径。
    - **同一份控制台还喂 `rings`**（三档 e2e 的环表 `✓ 1 pack …`）：修复前同样恒空，`#133` 一并变成
      真读数（实测：同一副本 `c0a573c` 上，旧脚本 0 行 → 新脚本 5 行）。
    - **代价（隐私面）**：控制台原文含 e2e 的一次性引导 URL（`?token=…`，随实例销毁）与本机绝对路径；
      车道只在**红时**打末 40 行，脚本已在该节印一行脱敏提醒 —— 外贴日志（issue / 聊天）前按
      [agents/privacy.md](agents/privacy.md) 脱敏。
    - 反例（**不属此类**）：`guard`（`privacy-scan: 干净|命中`）**目前取不到值** —— 那读数由
      `tests/script-entry.spec.ts` 用子进程捕获后**断言**，从不落控制台；给不给 default reporter 都一样。
      该行是"永远不出现的读数"，已在队列外记录、待立票处置（别把它当已验证）。

⚠️ **`amend` 过提交之后，副本必须先 `reset --hard` 才能同步**（批 D 聚合 A8，`#126` D0b 实测）：
车道同步用的是 `merge --ff-only`，而 `--amend` **重写了历史** ⇒ 副本里那个旧提交不再是新提交的祖先
⇒ 同步**响亮失败**：`msys-lane: FAIL — merge --ff-only 失败：… ← …`，**推送被阻断**。
- **这不是产品红**，是前置未满足。恢复路径与 §0「部署副本这一次不能用 `merge --ff-only`」**是同一条**
  （那条是为脱敏 / 历史重写写的，但 `amend` 是**日常动作**：复核后修提交几乎必然 amend）：
  ```bash
  git -C ~/dsh-shellhost-src fetch --force <repo>     # 或 origin
  git -C ~/dsh-shellhost-src reset --hard FETCH_HEAD
  ```
- **重置前先核零损失**（副本是**只读部署副本**，但它可能有意外提交）：
  ① `git -C <copy> status --porcelain` 为空；② `git -C <copy> log --oneline FETCH_HEAD..HEAD`
  **只有那个被 amend 掉的旧提交**（它已被新提交取代，重置即丢弃，无实质损失）。
- ⇒ 推论：**批次内尽量把 amend 集中在该票推送之前**；一旦推送过、副本已同步，
  再 amend 就得走上面这条重置（并意味着远端要 force-push —— 本仓**不允许**，见 `AGENTS.md`）。

手工等价跑法（脚本不存在或要单独调时用）：

```bash
. <repo>/scripts/msys-env.sh
cd ~/dsh-shellhost-src
export DSH_E2E_PLUGIN_DIR='C:/msys64/home/<user>/dsh-shellhost-src'   # Windows 形态，见下条
export DSH_E2E_HOST_DIR='C:/msys64/home/<user>/dsh-host-src'
export DSH_E2E_NODE='C:/Program Files/nodejs/node.exe'
export DSH_E2E_PNPM_DIR='C:/msys64/home/<user>/dsh-host-src/node_modules/.bin'
node --run build      # 构件是副本的 lib/（gitignore，同步搬不动它）——先重建再跑
node --run test
```

- 读数 `OK — 22/23 通过（其中 1 项为 PASS*）`、`exit 0`；三档 e2e 全绿（装箱档 5/5 环表）。
  四个 `DSH_E2E_*` 的默认值已经就是这套（`tests/helpers/e2e-install.ts` 按运行时用户名拼出
  `C:/msys64/home/<user>/…`），所以**不设也能跑**；显式设一遍是为了把路径形态摆明。
- **它与 Windows 车道不是逐项同读数**：msys 车道下 `tests/terminal-machine.spec.ts` 是
  `(7 tests | 3 skipped)`（Windows 侧 1 skipped），即该档在 msys 环境里有更多 loud skip ——
  读 msys 车道的汇总数字要看 `PASS*` 与 skip 数，别按「与 Windows 逐项一致」判绿红。
- **路径形态坑（本会话实测）**：`DSH_E2E_*` 必须是 **Windows 形态 `C:/…`**。POSIX 形态
  `/c/…` 交给 Windows node 后，`node:path.join('/c/…', 'lib/pty/index.js')` 会拼出
  `/c/…/lib/pty/index.js` 这类**当前盘根下的不存在的路径**，症状是**安装环红而装箱档绿**
  （装箱档自己 `npm pack`、不吃该 env）。赋值成 `C:/…` 不会被 msys 转换（实测：`export X='C:/…'`
  与命令前缀 inline 两种形态都给到 Windows node 原样字符串，**不需要 `MSYS2_ARG_CONV_EXCL`**）。
- 环境缺件时的正确归因：安装环红 + 装箱档绿 = 该 env 形态/缺件问题，**不是本仓缺陷**；
  若两档一起红才是产品面可疑。

## 1. 隔离契约（三实例互不干扰）

启动器用 **`DSH_HOME`** 定位 home、**`--profile <name>`** 选择
`$DSH_HOME/profiles/<name>`。两处都要独立，profile **名**也要不同。

| 资源 | 桌面端 | 相邻工作区（matt 工作流） | **本区（shell-host）** |
|---|---|---|---|
| DSH_HOME | `%USERPROFILE%\.dsh` | `~/dsh-matt-home` | `~/dsh-shellhost-home` |
| profile | `desktop` | `matt-dev` | **`dsh-host-dev`**（常驻实例） |
| 端口 | 19387（GUI） | 19501 | **19502** |
| 源码树 | 安装版 | `dsh-matt-src` | 部署副本 `dsh-shellhost-src` + 宿主 `dsh-host-src` |

三个 e2e 套件另用**临时** profile（`os.tmpdir` 下的临时 DSH_HOME + `--port 0`，
跑完即删），不占上表任何资源：mock 层用 `dsh-host-dev`，装箱交付层用
`dsh-host-tarball`，真实层用 `dsh-host-real`（同名不同 home，互不干扰）。

- **`DSH_PROFILE` / `DSH_PROFILE_DIR` 不是启动选择器**：它们是 shell-env 插件每次
  模型 shell 调用**注入给模型的输出事实**。拿它们做隔离判断是错的。
- 桌面端是**稳定升级通道**：开发中的改动不得先装桌面端。
- pnpm store 与 corepack shim 可共享（内容寻址、只读复用）；**并发 install 不要共享**。

## 2. 宿主锚点（ADR-0005）

跟随 DSH 运行时 **rc 线**：本仓 `0.2.1-rc.2-r1` ↔ 宿主 tag
`dsh-v0.2.1-rc.2`（commit `687f282e`）。旧锚（`0.2.1-rc.1` ↔ `1600d8a1`、
`0.2.0-rc.2` ↔ `639ed015`）的历史事实保留下表与 [GLOSSARY.md #82](../GLOSSARY.md)。

**宿主契约核对优先读源码树**：`bundlePatchFiles()`、patch op 语义、profile 组合这类问题，
直接读 `dsh-host-src` 的 TS 源码（如 `packages/boot/app-boot/src/profile.ts:58-64`）。
安装目录的 `resources/app.asar`（包内 `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`）
只是**源码树不在本机时的退路**：行号对不上源码，引证时别拿它当权威。
（retro 2026-10-16：一份调研文档把 primary source 指到已不存在的 `<old-work>\deepseek-harness`，
一次宿主契约核对被逼成 asar 逆推 —— 单条工具输出 54KB。）

**浅克隆默认分支会落到 alpha 系**（实测 `dsh-v0.2.1-alpha.4`），与锚不符 ——
宿主必须显式 checkout tag：

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git <src>
cd <src> && git fetch --depth 1 origin tag dsh-v0.2.1-rc.2 && git checkout dsh-v0.2.1-rc.2
```

**RC 与 alpha 的接口差异（切锚时必查）**：

| 项 | alpha（历史调查） | **0.2.0-rc.2**（旧锚） | **0.2.1-rc.2 = 现锚** |
|---|---|---|---|
| `session/initializeDefaultModel` | 有 | **有**（`@Remote`） | **有**（两侧一致） |
| `dsh-tools` peer 集 | 无 `dsh-invariants`；`cordis ~4.0.5-alpha.1`、`schemastery ~3.18.5-alpha.1` | **有 `dsh-invariants`**；`cordis ~4.0.4`、`schemastery ~3.18.4` | **无 `dsh-invariants`、新增 `dsh-working-directory`**；`cordis ~4.0.5`、`schemastery ~3.18.5`（rc.1→rc.2 只动版号、成员不变） |
| `scripts/build.ts` 参数 | `--scope artifacts` | `--profile` | `--scope`（`complete`/`artifacts`/`check`/`typecheck`）与 `--profile` 并存 |

照 alpha 抄 peer 会**漏声明**（本仓 #82 即此）。

**2026-10-17 更正（切锚 `0.2.1-rc.1` 时按源码树复核，rc.2 复核同结论）**：上表原把
`session/initializeDefaultModel` 记成「RC 无」（[GLOSSARY.md #82](../GLOSSARY.md) 同），
与同一 tag 的源码树矛盾 —— `dsh-v0.2.0-rc.2` 与 `dsh-v0.2.1-rc.1`/`-rc.2` **两侧都有**
`@Remote initializeDefaultModel`（两侧各 19 个 `@Remote`；rc.2 另有未进旧清单的
`@Remote canOpenWorkspacePath`）。**会话 RPC 侧切锚零影响**，选模型仍走 `selectModel`。
`dsh-invariants` 的移除见现锚列与 §4.4。

### 2.1 锚不匹配时的行为与精确版本豁免（`0.2.1-rc.*` 实测）

bundle 声明的 DSH 版本要求不满足运行版本时（规则：声明了 `engines.dsh` 就**只**看它、
peer 被忽略；否则逐条 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 必须满足），
rc.1 起分两处体现：

**本仓现行口径 = 门禁走区间、认证走精确**（ADR-0005 决策 6，2026-10-17 拍板）：
`package.json` 声明 `"engines": { "node": ">=24", "dsh": "~0.2.1-rc.1" }` —— 门禁只看这个
区间（`~0.2.1-rc.1` = `>=0.2.1-rc.1 <0.2.2`，放行 `0.2.1-rc.*` 与 `0.2.1` 正式版，排除
alpha 线与 `0.2.0-rc.2`）；精确钉（`dsh-tools` 依赖 + 10 个 peer）与 release tag 仍表示
**我们构建并验证过的那个版本**。动机：桌面端跟随 `next` 通道，`rc.1 → rc.2` 只隔数小时
且只动版号（接缝包无 `src` 变更、peer 集成员不变），精确钉门禁把每次这样的发布都变成
一次「bundle 被整层跳过」的故障。代价：**区间内的未验证版本会被放行 —— 「装得上」不再
等于「验过」**；所以升级认证版本时仍照 §2.2 走一遍。

- **安装侧**（`dsh plugin --profile <p> add <spec>`）：以 `incompatible-version` 拒绝，
  stderr 打印 `installation rejected: Plugin <name>@<ver> is incompatible with dsh <runtime>:
  requirements {...}` + 精确的豁免命令；`exit 1`，profile 不改（**fail-closed**）。
- **启动侧**：bundle **不是行**，它自身要求不满足时**整层被跳过**，启动器每次启动打印一次
  `skipping profile bundle "<name>": <reason>`；该 bundle 的行不出现在组合里
  （`--dump-config` 亦然）。普通**行**不满足则是逐行 `disabled` + stderr 报告，语义不同。

**精确版本豁免**（#107 实测，rc.1 宿主 + `0.2.0-rc.2` 钉的 bundle）：

```bash
dsh plugin --profile <p> allow-version <name>@<ver> --dsh-version <exact-runtime> --accept-risk
# → 先打印「可能崩溃 / 数据损坏」警告，再 "allowed <name>@<ver> for DSH <exact>"
#   记录写进 profile 的 compatibility.json
dsh plugin --profile <p> add <spec>     # 重试 → 接受（pnpm 另会 warn peer 未解析）
```

豁免按**「精确包版本 × 精确运行时版本」对**生效：切锚后旧豁免不再匹配（等于自动失效），
`revoke-version` 可显式撤销。桌面端 `desktop` profile 由 app 持有，只能用随桌面交付的
`dsh` 命令、且在 app 退出时操作。

**rc.1 的两条安装 / 组合行为变化**（与锚无关，但会影响挂具与操作脚本）：

- `dsh --profile <p> --from-default-profile <t>` 现在**替换**已存在的目标 profile
  （连同其 `package.json` 依赖、`node_modules`、`cordis.patch.yml` 一起删除重建），
  以前是拒绝 —— 重复执行等于重置。
- HMR 下对**已安装**的包再 `installBundle` 直接以 `already-installed` 拒绝（不再是
  `restart-required`）：换版本 / 来源要先 `removeBundle` 再装。

### 2.2 升级顺序（旧锚用户 / 桌面端）

锚定义的是「**产物 × 运行版本**」的成对契约（§2.1）：两者不匹配时不会以「可用但降级」的
形态出现 —— 安装侧 fail-closed，启动侧整层跳过。所以升级是**有序动作**：

1. **先升运行版本**：把 DSH 运行时（桌面端 = app 的 runtime）升到本版锚（见 §2）
   （桌面端 profile 的操作窗口见 §2.1）。
2. **再让 profile 重新判定 manifest**：重启 / 重载 profile —— 宿主只在启动时组合一次，
   patch 与组合变更**不热更新**（[profile-install.md](agents/profile-install.md)）。
3. **`link:` 形态**（profile 依赖指向本仓检出，即本机桌面端现状）：权威树
   `node --run build` 重建 `lib/` 后按第 2 步重载即可 —— **无需重装**
   （不必再 `dsh plugin add`）。
4. **顺序错的形态**（运行版本已升、profile 没重载）：本 bundle 在启动侧被整层跳过（§2.1），
   症状是**插件工具面整体消失**、而实例与会话照常可用。判据 =
   `dsh --profile <p> --dump-config` 里没有 `dsh-shell-host/pty` 行（口径见
   [profile-install.md](agents/profile-install.md) 的「装好后必须 dump 组合树」）。

要保留**旧锚产物**（而不是装锚匹配的版本）只能走 §2.1 的**精确版本豁免**
（豁免按精确「包版本 × 运行时版本」对生效，锚一变即失效）。

本版发布时打 tag `dsh-v0.2.1-rc.2-r1`（ADR-0005 的 `dsh-v<锚版本>-r<模块修订号>` 形态；
`package.json` 的 `version` = `0.2.1-rc.2-r1`，即 tag 去 `dsh-v` 前缀）。tag / publish 是
maintainer 动作，不由开发票触发。

## 3. 源码部署步骤（msys2 侧）

```bash
# 宿主（自建，不复用相邻工作区的树）
git clone https://github.com/deepseek-ai/deepseek-harness.git ~/dsh-host-src
cd ~/dsh-host-src
git fetch --depth 1 origin tag dsh-v0.2.1-rc.2 && git checkout dsh-v0.2.1-rc.2
pnpm install --ignore-scripts --package-import-method=copy   # 见 §4.1
git clean -fxd && pnpm install --ignore-scripts --package-import-method=copy
pnpm build                                                   # 见 §4.2/§4.3（约 290s）

# 本插件（部署副本）
git clone <repo> ~/dsh-shellhost-src
cd ~/dsh-shellhost-src && pnpm install && pnpm build

# 把插件挂进 profile —— 官方两步命令，顺序固定
export PATH="$HOME/.corepack/bin:$PATH"                      # dsh plugin 会调 pnpm
dsh --profile dsh-host-dev --from-default-profile web --dump-config   # ① 播种 profile
dsh plugin --profile dsh-host-dev add ~/dsh-shellhost-src             # ② 注册 + pnpm 安装
```

**完整规则与理由见 [profile-install.md](agents/profile-install.md)**（为何 ① 不能省、
为何不许手工 symlink、三处断言、dump 组合树验证）。此处只记部署侧要点：
`dsh plugin` 需要 PATH 上有 pnpm shim；引导脚本已把它前置（`scripts/msys-env.sh` 把
`$HOME/.corepack/bin` 放进 PATH）—— shim 落在**家目录**而不是 Program Files 下，
避开写权限（写进去会 EPERM）。

## 4. 工具链结论（全部实测，别重复试错）

### 4.1 ucrt64 node 跑 pnpm 装 DSH 本体不可行

pnpm 加载 N-API 原生件即 `napi-sys … Node-API symbol has not been loaded` → panic
abort（`--ignore-scripts` 也一样）。绕行 = `--package-import-method=copy`（关硬链接）
**且用 Windows node 装**。（本插件包几乎纯 JS，但**构建面**仍卡在 rolldown 的绑定上 —— 见 §4.2；
结论不可类推。）

### 4.2 构建期原生件缺口（ucrt64 node 下 rolldown 拿不到绑定）—— **#81 结论（#80 复核后不变）：不承诺 msys2 侧构建**

**判别不是 `platform`**：ucrt64 node 实测上报的仍是标准 `win32 x64`（node v24.21.0、ABI 137）。
rolldown 看的是 **`process.config.variables`** 里的两个值 —— 本机实测两个 node 各有一组：

| 键 | ucrt64 node | Windows node |
|---|---|---|
| `shlib_suffix` | `dll.a` | `so.137` |
| `node_target_type` | `shared_library` | `executable` |

判定在 rolldown 的绑定加载器里。该文件在 pnpm 的虚拟 store 下、文件名带内容哈希，用
`Get-ChildItem node_modules/.pnpm/rolldown@1.2.11/node_modules/rolldown/dist/shared -Filter 'binding-*.mjs'`
定位（本机 = `binding-BY0qR5iS.mjs`）：

- `:132`：`shlib_suffix === "dll.a" || node_target_type === "shared_library"` → 选
  `@rolldown/binding-win32-x64-gnu`（`:134-141`）；**ucrt64 node 两个条件都命中**；
- `:146-160`：否则选 `@rolldown/binding-win32-x64-msvc`（Windows node 走这条）；
- wasm 回退候选：`:546`（`./rolldown-binding.wasi.cjs`）与 `:567`（`@rolldown/binding-wasm32-wasi`）。

**上游事实（2026-10-17 查询）**：

- `npm view @rolldown/binding-win32-x64-gnu@1.2.11 version` → **`E404`**（未发布）；
- `npm view @rolldown/binding-wasm32-wasi@1.2.11 version` → `1.2.11`（存在）。

**复现（只读：不装包、不碰工作树；下条命令 2026-10-17 已逐字跑过）**：

```powershell
$entry = Join-Path $PWD 'node_modules/.pnpm/rolldown@1.2.11/node_modules/rolldown/dist/index.mjs'  # 必须绝对路径
& '<msys2 根>/ucrt64/bin/node.exe' -e "import('file:///'+process.argv[1].replace(/\\/g,'/')).catch(e=>{let c=e;for(let i=0;c&&i<5;i++){console.log('['+i+'] '+c.message.split('\n')[0]);c=c.cause}})" $entry
# → [0] Cannot find native binding. npm has a bug related to optional dependencies …
#   [1] Cannot find module '@rolldown/binding-wasm32-wasi'
#   [2] Cannot find module './rolldown-binding.wasi.cjs'
#   [3] Cannot find module '@rolldown/binding-win32-x64-gnu'
#   [4] Cannot find module './rolldown-binding.win32-x64-gnu.node'
```

把上面那行的 `'<msys2 根>/ucrt64/bin/node.exe'` 换成 `node` 再跑一遍 = **阳性对照**：打印
`LOADED`（Windows node 走 msvc 绑定）。`<msys2 根>` 本机为 `C:/msys64`，非默认安装根按实际替换。

**结论（#81，本会话判定）：本仓不承诺 msys2 ucrt64 侧构建**，四条理由：

1. rolldown 的 gnu 目标在上游**没有产物**（上面那条事实），本仓无法提供；
2. 声明 wasm 回退（`@rolldown/binding-wasm32-wasi`）只解决**打包器**这一层：版本必须与 tsdown 带的
   rolldown **锁死同步**（tsdown 一升级就得跟着改 pin，漂移即再失败）；而本仓的 msys 路线根本不在
   这条链上 —— 它缺的只有绑定这一层（`tsc` 与 tsconfig 解析都正常，见下「#80 的结论」）；
3. 它换不到本仓实际使用的流程：msys 侧引导脚本（`scripts/msys-env.sh`）做的就是**把 Windows node
   前置**，而 `scripts/msys-lane.sh:107-109` 对生效 node 是 ucrt64 的情形**响亮失败**并提示设
   `DSH_MSYS_WIN_NODE_DIR` —— 没有流程会从那条链上拿产物；
4. **AC2 同样不做**：`vitest run` 的启动也经 vite/rolldown 的绑定解析，缺的是同一个 gnu 产物；
   本仓的构建与套件入口都把 Windows node 前置（`scripts/msys-env.sh`），生效 node 是 ucrt64 时
   车道直接**响亮失败**（见上条）。

B1 分工（结论不变；`tsc` 那一行是 2026-10-19 的复核实测读数，`tsdown` 那一行的机制见上）：

| 环节 | 环境 |
|---|---|
| `tsc` typecheck / 声明产出（纯 JS） | msys2 ucrt64 node 可 |
| `tsdown` 打包（rolldown） | **必须 Windows node**（机制见上） |

#### #80 的结论：双拼发生在原生绑定层，本仓无可修面

票面报告的失败发生在**另一层**：ucrt64 node 下 tsdown 报
`[TSCONFIG_ERROR] Failed to load tsconfig '<cwd>/<cwd>\tsconfig.json'`（Windows 形式 cwd 与绝对
路径二次拼接）。2026-10-19 复核（tsdown 0.22.14 / rolldown 1.2.11 / ucrt64 node v24.21.0）的三条
读数把落点定在**原生绑定层**：

1. **今天这条错误不可达**：同一 node 跑 `node --run build`，崩在**绑定加载**
   （`Cannot find native binding`，即上面那条链），tsconfig 解析根本没被调用 —— 报告的
   `TSCONFIG_ERROR` 只可能出现在「绑定能加载」的机器上。
2. **绑定一旦可加载，ucrt64 node 的构建就成立**：把 gnu 包名用 `NODE_PATH` 别名到本机已装的
   msvc 绑定（下面「夹具」，不改 `node_modules`、不装包）后，tsdown 打出 `tsconfig: tsconfig.json`
   与三个入口四个产物、总大小 84.52 kB、exit 0 —— 与 Windows node 那一跑**文件集合、`tsconfig`
   行与总大小相同**（个别 gzip 列差 0.03 kB 量级；两个 node 的补丁版本本就不同：
   ucrt64 v24.21.0 / Windows v24.18.0）⇒ **双拼不来自 node 风味，也不来自本仓传入的任何输入**。
3. **显式 `tsconfig` 不是可验证的修法**：临时写成 `tsconfig: './tsconfig.json'` 后，三组读数
   （ucrt64+夹具 / ucrt64 无夹具 / Windows）与不写该项时**逐行相同**（两种设法打出的
   `tsconfig:` 行都是 `path.relative(cwd, …)` 的 `tsconfig.json`）⇒ 它连「绕开症状」都无法取证
   （症状不可达），更不是「修掉成因」，故**不入仓**（票面 Out of scope：不做路径 hack）。

机制面：`TSCONFIG_ERROR` / `Failed to load tsconfig` / `Tsconfig not found` 三个串**就在原生绑定
二进制里**（已装的 msvc 绑定 `.node` 可搜到，rolldown/tsdown 的 JS 产物零命中）；而 tsdown 交给
rolldown 之前已经把 `tsconfig` 解成**绝对路径**（自动发现走 `empathic/find` 的 `up()`，实测返回
`D:\<repo>\tsconfig.json`、`path.isAbsolute` = true）⇒ 拼接发生在这个值进入原生绑定**之后**。
本仓能调的只有「传哪个 `tsconfig` 值」（以及 `cwd`），影响不了拼接本身。

报告里被转写的双拼形态（末级目录名重复，且 `/` 与 `\` 混用恰是 guest 与宿主两套分隔符）
指向 **WASI 适配层的宿主↔guest 路径映射**：ucrt64 node 的绑定选择器只会走 gnu 分支（gnu 产物
未发布，见上「上游事实」），故报告者当时能加载的绑定只可能是 wasm 回退 —— 这条是**推断**
（本机无该产物，未复跑），不影响上面三条读数。

**可复现命令**（msys2 UCRT64 shell；`<repo>` = 本仓检出根）：

```bash
export MSYSTEM=UCRT64 PATH="/ucrt64/bin:$PATH"
cd <repo>
node -p "process.version + ' | ' + process.execPath"          # v24.21.0 | <msys>/ucrt64/bin/node.exe
node node_modules/typescript/bin/tsc -p tsconfig.build.json   # exit 0，声明产出到 lib/types/（B1 的 tsc 行）
node --run build                                              # exit 1，但崩在 binding，不是 TSCONFIG_ERROR
```

**夹具**（只为把「绑定层」与「tsconfig 层」切开；**不是**构建处方 —— 换绑定不改任何路径逻辑，
gnu 产物缺失仍在，且 wasm 回退的锁步代价见上面理由 2）：

```bash
REPO="$(pwd -W)"                                   # 仓的 Windows 形态绝对路径（别用相对路径）
BASE="$(mktemp -d)"; SHIM="$BASE/node_modules/@rolldown/binding-win32-x64-gnu"
mkdir -p "$SHIM"
printf '%s' '{"name":"@rolldown/binding-win32-x64-gnu","version":"1.2.11","main":"index.cjs"}' > "$SHIM/package.json"
BINDING="$(ls -d "$REPO"/node_modules/.pnpm/@rolldown+binding-win32-x64-msvc@*/node_modules/@rolldown/binding-win32-x64-msvc/*.node | head -1)"
printf "module.exports = require('%s')" "${BINDING//\\//}" > "$SHIM/index.cjs"   # \ → /：JS 单引号里反斜杠是转义
NODE_PATH="$(cygpath -w "$BASE/node_modules")" node node_modules/tsdown/dist/run.mjs   # exit 0
```

结论：**本仓无可修面，B1 分工不变**；msys2 ucrt64 侧构建不可用的原因收敛为**唯一一条** ——
该 node 的绑定选择器指向未发布的 gnu 产物（上面那条链）。

### 4.3 构建产物必须清理（切 tag / 发布）

`lib/` 被 `.gitignore` 忽略，`git status` 看着干净，实际残留上一 tag 的产物 ——
RC2 构建会报 `MISSING_EXPORT "principalOf"`（该符号只存在于 alpha 源码）。
用 `git clean -fxd`（实测清掉 38 个孤儿 `lib/` 后通过）。

**判构件新旧用内容哈希，不用 mtime**：同步会**重写副本 `src/` 的 mtime**（内容没变也照改），
而 `lib/` 是 gitignored 的构建产物 —— 实测副本 `src/` 显示 14:15、`lib/` 12:05，看着「源码比构件新」，
两树 `lib/` 却逐文件哈希相同（唯一差异是权威树里一个 tsdown 不清理的孤儿 chunk）。
所以：`ls` 时间戳只能当线索，判据是**同名文件哈希比对**（`Get-FileHash`），
而车道已改为同步后**无条件重建**（§0.1.1），不存在靠猜的场景。

**`lib/` 是累积目录，而 `package.json` 的 `files` 用 glob**（`lib/pty-*.js` 等）⇒ 不清就会把上一版
遗留的 chunk 一起发出去。**rc.1 期历史读数（当时锚，非当前锚 `0.2.1-rc.2-r1` 的读数）**：2026-10-17
实测未清时 tarball 同时含当次构建的 `lib/pty-C0_H63de.js`（46520 B）与前一天遗留的
`lib/pty-g32VoH8_.js`（46509 B，内容不同），tarball = 16 文件 / 59771 B；清后 = 15 文件 / 45527 B。
复核 = `npm pack --dry-run` 的文件面。

**清理已做进 `build`，不再是手工处方** ⇒ `node --run test:release`（先 `build` 再 `verify:pack`）
本身就是发布口径，不需要任何前置命令。实现与确切删除/保留语义的**唯一来源**是
[`scripts/clean-lib.mjs`](../scripts/clean-lib.mjs)（`build` 的第一步）：清 tsdown 上一代产物
（`lib/` 顶层 `*.js` chunk + 三个入口目录整棵），**保留 `lib/types/**` 整棵**，其余一切不删
（判不准就不删）；`lib/` 不存在时也照常通过。tsdown 自己的 `clean` **不能**代劳：`lib/types/` 的
声明由 tsc 产出、与 tsdown 共享 outDir 根（`tsdown.config.ts`），打开它会把声明面一并清掉。

**守卫面（#111）：`verify-pack` 现在能判「历史 chunk 同行」**。原来的判据只问「声明目标**在不在**
tarball 里」（+ 逐个 import 冒烟）—— 而 `lib/pty-*.js` 这类宽松 glob **合法声明了上一代 chunk**，
所以残留不会让它变红。真正的修复面是 `scripts/verify-pack.mjs` 的 `duplicateChunkFamilies`
（纯函数，`files` 的 chunk glob 族命中数 **≥2 即红**）：同一次构建里一个模块只该产出一个 chunk，
两代同行只可能是累积残留。该文件另有一条 `unexpectedPackedFiles`（`files` 之外的 `lib/` 件），
但它是**防御性/前瞻性**检查 —— `files` 之外的件在打包阶段就被 npm 白名单挡掉，CLI 端**结构性
收不到触发输入**，故**不得**把它当成守住了本票症状的那条。分工与可达性边界见该文件头注释。

### 4.4 本插件的依赖锚（#82）

`@deepseek-ai/dsh-tools` 必须锚 **当前 RC 线**（`0.2.1-rc.2`；门禁已由 `engines.dsh`
区间接管，这里的精确钉表示**认证版本**，见 §2.1），且 **`dsh-tools` 自己的 10 个
peerDependencies 必须显式声明**（现为 `dsh-agent` / `dsh-llm` / `dsh-ptc-runtime` /
`dsh-sandbox` / `dsh-sandbox-policy` / `dsh-scope` / `dsh-session` /
`dsh-system-prompt` / `dsh-user-approval` / **`dsh-working-directory`**；
`dsh-invariants` 自 `0.2.1-rc.1` 起被上游整包移除，声明已删）。未声明时 pnpm
严格布局下运行时缺失：`Cannot find package '@deepseek-ai/dsh-scope'`。
⚠️ 这个"10"是 **`dsh-tools` 的 peer 集**，不是本包 `peerDependencies` 的总条数 ——
本包另外还声明 `cordis` / `schemastery`，以及下面 #120 的那**两个例外包**（合计 14 条）。

口径 = **只跟 `dsh-tools` 的直接 peer 集**（#107 拍板）：不补传递闭包 ——
`dsh-working-directory` 自身还 peer 依赖 `dsh-fs` / `dsh-session-projection`，
因此 `pnpm peers check` 会报这两条 missing，属**已知并接受**；`node --run test`
与 `test:release` 不受影响。

**例外（#120，2026-10-20，带理由）：`dsh-jobs` + `dsh-tool-jobs` 两个包显式声明为 peer。**

- **加的是哪两个**：`@deepseek-ai/dsh-jobs@0.2.1-rc.2`（抽象 `JobRegistry` seam）与
  `@deepseek-ai/dsh-tool-jobs@0.2.1-rc.2`（那个 seam 的 controller + `job_*` 工具 + 完成投递）。
- **为什么破例**：两者**都不是** `dsh-tools` 的直接 peer，照 #107 的口径本不该声明。
  但 `pty_send` / `ssh_send` 的 `run_in_background` 要接的是**宿主已经自带**的后台任务栈
  （桌面端 `app.asar` 的文件清单里就有这三个包，`dsh-jobs-local` 是进程内实现）——
  本包做的是**接线**，不是造新面。缺这两个包时 `ctx.get('jobs')` 取不到，工具**响亮报错并点名两个包**
  （姿态见 README「后台发送」；源码入口 `src/pty/background-send.ts`）。
- **必须成对**：`dsh-jobs` 的 `start` 在**没有 attached controller 服务该 owner 时直接拒绝**，
  而 controller 在 `dsh-tool-jobs` 里（`ctx.jobs.attachController`）。只声明前者 =
  一条永远报错的死路，所以两个一起声明、一起记账。
- **`pnpm peers check` 的新增读数**：多一条 `missing peer @deepseek-ai/dsh-output-retention`
  （`dsh-tool-jobs` 要它）。与既有的 `dsh-fs` / `dsh-session-projection` 同一性质 ——
  peer 的 peer，属**已知并接受**，不补闭包。当前实测三条 missing：
  `dsh-session-projection`（agent / sandbox-policy / working-directory 要）、
  `dsh-output-retention`（tool-jobs 要）、`dsh-fs`（working-directory 要）。

### 4.5 msys 的 `pkill` 杀不掉 Windows node 进程

端口占用报 `EADDRINUSE 127.0.0.1:<port>` 时，用 `netstat -ano` 找 pid +
`Stop-Process -Id <pid> -Force`。

### 4.6 DSH 沙箱下的执行口径（agent 会话，2026-10-18 起实测）

- **跑测试、写 git 走 PTY 会话**（`pty_open` 开 `cmd`）：`pwsh` 工具下 vitest 在**加载配置**
  阶段就炸 —— `spawn EPERM`（vite `optimizeSafeRealPathSync` → `exec("net use")` 需要管道）；
  `git add` / `commit` / `push` 报 `Unable to create .git/index.lock: Permission denied`。
  PTY 内两者都正常（本会话实测：PTY 里 `execSync('cmd /c echo hi')` OK、`git add` OK）。
- **验收读数加 `NO_COLOR=1`**（#122 之后**只影响跨会话可比性**，不再影响 `verify-all` 能否解析）：
  `verify-all` 自己 spawn 测试运行器时把形态钉成 `NO_COLOR=1`，解析层又同时认裸 `|lane|` 与
  带色的色块徽标，故逐文件表不再随调用者会话带不带色而时有时无。**你在 `verify-all` 之外**
  直接跑 vitest 抓日志时仍请显式 `NO_COLOR=1`。历史根因与修法见 #122（`verify-all` 另有
  响亮失败兜底：解析不到行但 vitest 报过用例数 ⇒ FAIL，不再是 SKIP）。
- **重定向会吃掉颜色，PTY 控制台不会**（实测 #122）：`set FORCE_COLOR=3 && node … > log` 落地
  的日志 **ESC 字节 = 0**（stdout 不是 TTY，vitest 自动不打色）——要抓**真实带色**输出，
  只能在 PTY 控制台里跑并把控制台字节读出来（`.scratch/t122-colored-vitest-raw.log` 即此来源）。
  别用重定向伪造"带色环境"的读数。
- **`.bat` 证据模板：日志名必填、先 `del`、退出码用括号形式重定向**（批 E 聚合 E6/E9，
  `#103`/`#100` 实测）：
  - **`echo exit=%RC%> file` 会被 cmd 当成句柄重定向**：RC=0 时该行解析成 `echo exit=` + `0>`
    ⇒ **证据文件被建成 0 字节、`exit=` 打在 stdout** —— 与"没跑"不可区分（同 A9「空日志 ≠ 没跑」）。
    正确写法：`(echo exit=%RC%)> file` 或前置重定向 `> file echo exit=%RC%`。
  - **模板形状**：`<name>.bat` 第一行取 `%1` 当**日志名**（先 `del` 旧 `.log`/`.exit` 再写，
    跑完 `type` 出 `.exit`）—— 复跑同名会**覆盖红步读数**（`#103` 的红步因此只剩文档里抄的异常原文）。
  - **交接文档点名的模板名要先核存在**：`#100` 照抄一个不存在的 bat 名，cmd 直接报
    「不是内部或外部命令」；自建同形状模板后才跑通。
  - **`pwsh` 工具里没有 POSIX 工具**：`grep` / `sed` / `find` 都不可用（报"术语…不会被识别"）。
    搜内容用 harness 的 grep 工具、或走 msys bash；`.bat` 里也别用 grep（cmd 的 `findstr`
    语义不同，`#103` 实测踩过一次 `exit 1`）。
- **判断后台套件在不在跑，看日志文件的 size/mtime**：沙箱下 `tasklist` / `Get-Process node`
  返回 Access denied。
- **PTY 会话的跨轮存活取决于文件沙箱是否生效**（#147；两种环境都实测过 —— 这是一条**带条件**的
  结论，别再当无条件规则读）：
  - **沙箱生效时：不跨轮**（本节 2026-10-18 的原始场景）—— 下一个 tool call 里即报
    `no pty session … for this agent`；此时把多条命令用 `&&` 串成一次做完，读数重定向进
    `.scratch/*.log` 再读文件。
  - **无沙箱时：跨轮存活** —— 2026-10-19 见 `#147` 票面（采集环境：文件沙箱 = `danger-full-access`、
    无审批提示）；2026-10-20 在本机同一策略下复跑：`pty_open` 开一次，后续 tool call 里 `pty_tail` /
    `pty_send` / `pty_close` 都正常；`shell_open` 开的 launcher 会话同样如此，`cd` 过的 cwd **跨 call**
    保持（读数：会话开在 `<repo>`，下个 call 里 `cd /d/`，再下个 call 里 `pwd` 仍 `/d` —— 与会话
    打开时的 cwd 不同，排除"复位成同一个值"的巧合）。
    **成本含义**：常驻会话下一条命令 = 一次 `pty_send`（与平台 shell 工具同价），**不必**把所有
    命令 `&&` 串成一条；中途要读数就 `pty_tail`，也不必落日志再读文件。
  - **可复跑的读数（**最少**三次 tool call；必须在不同 call 里做，同一个 call 里做完测的正是「跨轮」；
    中间可插更多 `pty_send` / `pty_tail`，本机转录那一轮是五次）**：
    ① `pty_open { command: 'node -e "setInterval(() => {}, 1000)"' }` → 记下返回的 session id；
    ② **另一次** tool call 里 `pty_tail { id }` → 不报 `no pty session … for this agent`
    （无输出的子进程读到空增量也算正常返回）；③ 第三次 tool call 里 `pty_close { id }` →
    `{"closed":true}`。驱动性用 launcher 会话复跑：`shell_open` 开一个，下个 call 里
    `pty_send` 发 `pwd`（cwd 会保持）。**采集环境必须一并记**（文件沙箱策略 + 是否走审批）——
    换个策略读数可能就反过来。本机 2026-10-20 读数（转录）：
    `.scratch/t147-pty-crosscall.md`。
- **临时产物（驱动脚本 / 生成的 config / 探针）一律放 `.scratch/` 下，别落仓库根**
  （#123 retro C6）：
  - **为什么**：本机**多个会话共用一个检出**，而**复核者看到的永远是一个瞬间快照**
    —— "长时间跑的 driver + 中途产出的临时文件"必然让复核者把它读成**残留**
    （#123 实测：Spec 轴复审时看到仓库根的 `vitest.ac0.config.ts`，那是**当时仍在跑**的
    driver 的中间态；其 `finally` 随后已删，事后 `Test-Path` = False）。
  - 另一层理由：仓库根的文件与**产品文件**混在一起，而 `git status` 里 `?? ` 一行
    区分不了"半途"与"忘了删"。
  - 例外：**变异探针 spec** 必须落在 `tests/` 内才会被收集（见
    [TESTING.md](agents/TESTING.md) §证据纪律的那条）—— 那种情况用唯一前缀
    且**跑完即删**，别留到下一轮。

## 5. 实例相关文档

- 上游契约 / RPC 参数名（typert 逐方法三种形态）/ 会话证据与计费判据：[GLOSSARY.md #82](../GLOSSARY.md)
- 驱动实例（隔离契约、端口、profile）：本文件 §1
- 验证分层与门禁：[TESTING.md](agents/TESTING.md)
- 隔离与构建的**本机落地记录**（机器相关，不入库）：
  `<DSH_HOME>/REGISTRY.md`
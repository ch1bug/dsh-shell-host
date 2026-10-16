# 脱敏 / 历史重写流程（privacy.md）

**本仓是 PUBLIC 仓**（`gh repo view --json visibility` 自查）——推上去就是公开。
本文件是**流程**的唯一来源；具体某一次重写的现场事实记在
[dev-environment.md](../dev-environment.md) §0.0。判据的机械守卫是
`scripts/privacy-scan.mjs`（`.githooks/pre-commit` 与 `tests/privacy-scan.spec.ts` 共用）。

## 0. 先判「要不要重写」

| 情形 | 处置 |
|---|---|
| 只有**现树**有（历史干净） | 改占位符 → 提交；`scripts/privacy-scan.mjs` 会挡复发 |
| **历史**里有（已推送） | 走 §2–§4 的历史重写 |
| 只在 **issue / 评论**里 | §5 tracker 口径 |
| 只在**未跟踪**文件（`.scratch/`、临时目录、会话日志） | 直接删 —— 它没被推上去 |

先摸清落点，**别边找边改**：

```bash
node scripts/privacy-scan.mjs --verbose                     # 现树（身份 + 布局 + denylist）
git grep -inE '<类别词>'                                     # 现树其它形态
git log --all --format='%an <%ae> | %cn <%ce>' | sort -u    # 署名 / 邮箱
git log --all --format=%B | grep -inE '<类别词>'             # 提交信息
```

> 探针纪律：身份 / 路径类探针一律 `git grep -i`。全大写探针会**静默漏掉**文件里的小写写法
> （2026-10-16 实测：`0 命中` 差点被当成干净）。

## 1. 先枚举全部标识类别，再动手（一次跑齐）

范围由 human 拍板（2026-10-16 那次 = **个人用户名 + 本机布局路径**）。一次枚举这几类，
**大小写两形**：

1. 机主用户名 / 呼号 / 别名；
2. 家目录（`C:\Users\<user>`、`/home/<user>`、`/c/msys64/home/<user>`）；
3. 检出与旧布局路径（`<盘符>:\dsh-*`、`/d/<盘符>/dsh-*`、`<盘符>:\Work\…`）；
4. 署名与邮箱（author + committer）；
5. 真机 host 名与内网 IP；
6. 其它环境指纹（临时目录名、内部端口、机器名）。

**一份规则文件、一遍重写。** 分几遍做的代价是重复：改哈希 → 重修引用 → 重新验收
（2026-10-16 实测跑了三遍，约 100 次工具调用）。

### 占位符白名单（两边守卫都放行，新增写法随手补进来）

`~` / `$HOME` / `%USERPROFILE%` / `$(whoami)` / `%USERNAME%` / `${USER}` / `<user>` /
`<用户名>` / `<repo>` / `<sibling-repo>` / `<old-work>` / `<work>` / `<src>` / `<盘符>`，
以及通用账户段：`me` / `u` / `x` / `you` / `user` / `username` / `your-user` / `agent` /
`runner` / `example` / `name` / `foo` / `bar` / `test` / `shared` / `public` / `default`，
外加夹具用的合成身份（如 `alice`）——它们进的是 `ALLOWED_USERS` 白名单与
`DYNAMIC_USER` 派生判定，**不是**漏判。两仓判据同步改，跨仓跑才不会互报红。

## 2. 飞行前

- **工作树必须干净**（`git status --porcelain` 为空）：`filter-repo` 会 **reset 工作树**，
  未提交的改动会**丢**（实测踩过；要留下的先 `git commit`）。
- 备份：`git clone --mirror . <repo>-backup-<date>.git`（或 `git bundle create --all`），
  并存 baseline：`git rev-parse HEAD origin/main <tag>…` + 提交数。**它是后面按主题对齐哈希的唯一依据。**
- 远端检查：`gh api repos/<owner>/<repo>/branches/main/protection`（是否保护）、
  `gh api repos/<owner>/<repo>/forks --jq length`（有 fork 就有副本）、
  `git ls-remote --heads --tags origin`（别忘了**侧分支与 tag**）。
- **本机 denylist**：`<DSH_HOME>/privacy-denylist.txt`（一行一个 token，`#` 注释，**不进仓**），
  覆盖运行时推不出来的那类。可从重写前的备份镜像自动提取（署名 / 邮箱 / 内网 IP）。

## 3. 重写（一遍跑齐）

工具是 `python -m git_filter_repo`（本机 `git filter-repo` 子命令不在 PATH —— pip 装的是
user site；`--help` 可用 `python -m git_filter_repo --help` 查）。

```
# 规则文件语法：pattern==>replacement —— **等号两侧不留空格**（留了会当成模式的一部分、静默不命中）
python -m git_filter_repo --dry-run --force \
  --prune-empty=never --prune-degenerate=never \
  --replace-text rules.txt --replace-message rules.txt --mailmap mailmap.txt

# 门禁：比对 .git/filter-repo/fast-export.original 与 .fast-export.filtered 的 token 计数，
#       filtered 全 0 才跑正式那遍（dry-run 会把两个流留在 .git/filter-repo/ 下）
python -m git_filter_repo --force \
  --prune-empty=never --prune-degenerate=never \
  --replace-text rules.txt --replace-message rules.txt --mailmap mailmap.txt
```

- `--replace-text` 管 blob 内容，`--replace-message` 管提交信息，`--mailmap` 管**提交身份**
  （`Proper Name <proper@email> Commit Name <commit@email>`，只给邮箱也行）——author 与
  committer 一起归一；顺手把 `git config user.name/email` 也改成公开身份，后续提交同形。
- `--prune-empty=never --prune-degenerate=never`：别让 tag / 提交被顺手裁掉。
- filter-repo 会**摘掉 `origin`**（防误推）→ 之后 `git remote add origin <url>` 补回。

## 4. 飞行后

1. **本地校验**：提交数不变、`git status` 干净、`git grep -l -i <token> $(git rev-list --all)`
   为空、署名已归一。
2. **引用哈希重映射**：文档 / 注释里对旧提交的引用要落到**终态**。
   **别自己反推 filter-repo 的 commit-map** —— 它的 key 是重写前的原始哈希，多遍之后语义
   更容易搞错（实测把"中间态"哈希写进了文档）。稳妥做法：**用备份镜像按提交主题对齐** ——
   `git --git-dir=<backup> log -1 --format='%H%x09%s' <旧令牌>` 取回主题，再在现历史里找
   同一主题唯一命中的提交。
   `tests/doc-references.spec.ts` 现在会断言 tracked 文件里的提交哈希**必须可解析** —— 写错当场红。
3. 本地清账：`git reflog expire --expire=now --all && git gc --prune=now`。
4. **推送**：`main` + **侧分支** + **tag** 一起，带 lease：
   `git push --force-with-lease=main:<推送前远端 SHA> origin main`；
   tag 不是快进 → `git push --force origin refs/tags/<tag>`。
5. **从远端 refs 回读校验**（不看本地）：`git fetch origin --prune --force --tags`，再
   `git rev-list origin/main`（含侧分支与各 tag）逐个 `git grep -l -i <token>`；
   GitHub 侧抽查原始文件（`gh api repos/<o>/<r>/contents/<file> --jq .content | base64 -d`）
   与代码搜索。
6. **部署副本**：历史分叉，这一次**不能 `merge --ff-only`** → `git fetch origin` +
   一次性 `git reset --hard origin/main`；之后恢复常规同步。
7. 更正 tracker 里引用的**旧哈希**（评论：`gh api --method PATCH .../issues/comments/<id> --input payload.json`）。
8. 补一条**隐私说明评论**：按 tracker 的 AI 免责声明口径，写清处置与验证，
   **不复述串本身**（复述等于再公开一次）。

## 5. Tracker 口径

**2026-10-16 human 拍板：清。** 本仓 issue 正文 / 评论已按机械替换清理完（14 篇正文 +
17 条评论，`--gh` 复扫 0 命中）；替换**只落在个人 / 环境串上**，正文其余部分一字不动。

- 审计工作清单：`node scripts/privacy-scan.mjs --gh` —— 逐条给
  `issue:#N:行` / `comment:<id> (#N):行 命中<类别>`。
- 改写（走 API，`--input -` 读 stdin，省掉临时文件与引号地狱）：
  正文 `gh api --method PATCH repos/<o>/<r>/issues/<n> --input -`、
  评论 `gh api --method PATCH repos/<o>/<r>/issues/comments/<id> --input -`，
  JSON 体 = `{"body": "<改写后的全文>"}`。
- 替换表（**盘符无关**，别只写自己那台的盘符；实测漏过 `<盘符>:\Work\…` 与 `<盘符>:\dsh-*`）：
  用户名 → `<user>`、家目录 → `~` / `%USERPROFILE%`、
  `<盘符>:\dsh-*` → `<repo>`、`<盘符>:\dsh-matt*` → `<sibling-repo>`、
  `<盘符>:\Work` → `<old-work>`、邮箱 → `<email>`、内网地址 → `<lan-ip>`。
- **改完必须回读**：`--gh` 再扫 + 抽读一两篇看占位是否合理（tracker 是权威表示，
  写坏没有第二份）。新评论 / 回复里**不复述串本身**（复述等于再公开一次）。
- 惯例：落地说明按 tracker 的 AI 免责声明口径单独发一条评论；不复改他人可见的**原文以外**内容。
- **平台侧边界**：被重写掉的旧提交在 GitHub 上**仍可按旧 SHA 直接访问** —— force-push 不会
  立即回收对象 / 缓存。彻底抹除需向 GitHub Support 申请 purge；**human 2026-10-16 拍板不申请**
  （本仓 0 fork / 0 PR，接受该残留），见 `dev-environment.md` §0.0。有 fork 时先处理 fork。

## 6. 防复发（已就位）

- `scripts/privacy-scan.mjs`：扫**会被推出去的发布面** —— tracked 文件、**全部提交消息**、
  **提交身份**（author / committer）、**ref 名**（分支 / tag）、以及 pre-commit 窗口里的
  `.git/COMMIT_EDITMSG`；`--gh` 再加**轨迹面**（issue 正文 / 评论，分页取 JSONL）。
  判据三面：本机运行时身份 + 结构性形态（字面家目录 / 检出 / 旧布局，占位符与
  `$(whoami)` 这类运行期派生豁免）+ `<DSH_HOME>/privacy-denylist.txt`（**大小写不敏感**）。
  只报 `发布面:文件:行 命中<类别>`，**不回显 token 与行文**（输出也是发布面）。
  入口守卫按 `realpath` 归一（共用 `scripts/script-entry.mjs`，`#85`）：本脚本**经符号链接
  调用也照常扫**（此前那处按字面路径比对，链接调用 = 静默 `exit 0`，即"守卫没跑"被读成
  "干净"）；链接形态有离线断言守着（`tests/script-entry.spec.ts`）。
  **类别标签与邻仓逐字一致**（`本机用户名` / `本机家目录` / `denylist`，以及三个布局标签
  与 `字面家目录` —— 它们的**形态在源码里用 `<盘符>` / `X:` 这类中性写法描述**，免得守卫
  扫到自己：直写具体盘符会被自己的规则命中，两边都踩过）。跨仓对读日志与 issue 时同一个词。
- `.githooks/pre-commit` 第 5 步跑它（误报才 `SKIP_HOOKS=1`）；`tests/privacy-scan.spec.ts`
  共用同一份判据，并用**真 git 夹具**逐面钉死（文件 / 消息 / 身份 / ref / 待提交消息 +
  CLI 退出码 + 非 git 目录响亮跳过），最后一条是**常驻守卫**（真实仓三个面全 0）。
- 引用哈希可解析性由 `tests/doc-references.spec.ts` 守（历史重写会改写全部 SHA）。
- 审计轨迹面现状：`node scripts/privacy-scan.mjs --gh`（有命中即 exit 1，逐条给
  `issue:#N:行` / `comment:<id> (#N):行`，按 §5 处置）。
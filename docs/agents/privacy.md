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

- 本仓**不追改历史 issue 正文 / 评论**：GitHub 的编辑不可公开对读，改掉等于动他人可见的原文。
  惯例是**补一条隐私说明评论**，把处置、验证与未清面写清楚（现行未清面见 #97 的隐私跟进评论）。
- 若 human 决定要清：`gh issue list --state all --json number,body,comments` 逐条判；
  正文 `gh issue edit <n> --body-file <file>`，评论
  `gh api --method PATCH repos/<o>/<r>/issues/comments/<id> --input payload.json`；
  改完**回读**（tracker 是权威表示，写坏没有第二份）。
- **平台侧边界**：被重写掉的旧提交在 GitHub 上**仍可按旧 SHA 直接访问** —— force-push 不会
  立即回收对象 / 缓存。要彻底抹除需向 GitHub Support 申请；有 fork 时先处理 fork。

## 6. 防复发（已就位）

- `scripts/privacy-scan.mjs`：三面判据（本机身份运行时取 / 三种布局形态 /
  `<DSH_HOME>/privacy-denylist.txt`），**大小写不敏感**，扫 `git ls-files`，
  只报 `file:line 命中<类别>`、不回显 token；`.githooks/pre-commit` 第 5 步与
  `tests/privacy-scan.spec.ts` 共用它（误报才 `SKIP_HOOKS=1`）。
- AGENTS.md 的硬规则 + 指针；`docs/dev-environment.md` §0.0 记本仓这一次的现场事实。
- 引用哈希可解析性由 `tests/doc-references.spec.ts` 守。
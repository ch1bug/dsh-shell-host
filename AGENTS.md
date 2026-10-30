# AGENTS.md

**与人沟通一律用中文。** 面向用户的一切输出 —— 汇报、提问、总结、最终答复、
提交信息、issue 正文与评论、新建文档 —— 全部写中文。

> 例外：代码标识符、命令、文件路径、上游 API/字段名、以及引用既有英文文本时
> 保持原样（翻译它们会破坏可执行性与可检索性）。
>
> **仓内文档的语言口径（2026-10-30 human 拍板）**：文档以**英文为权威原文**，
> 中文为跟随版（同名 `<name>_zh.md` 成对存在，两侧内容完整）；内容变更先改
> 英文、同步中文。存量中文文档的英文化按票逐步推进，未迁移的存量文档暂以
> 中文原文为准。与人沟通仍一律中文（上条不变）。

This workspace is a DSH bundle repo (`dsh-shell-host`) built with the Matt
Pocock AI-coding workflow. Route work through the flow skills (grill →
to-spec → to-tickets → implement).

**Package posture (ADR-0012/0013, 2026-10-16): tools-only plugin.** The shell
executor world is gone — no `ctx.shell` provider, no backends, no upstream
loader-row takeover. Entries: `./pty` (persistent PTY sessions), `./ssh`
(interactive ssh sessions — split out of `./pty` by #136), `./terminal`
(`shell_open` launcher presets), `./wsl` (WSL bridge tools)，以及 #137 新增的
`./remote` / `./remote-fs`。远程工作区配置、权限与本期边界见
[README 的远程工作区说明](README.md)。原远程 one-shot
路线归独立 `dsh-shell-remote` 插件（route C）的结论，已由 ADR-0016 的工作区方案修订。

## Agent skills

Engineering skills (v1.3.1, vendored editable copy from
`github.com/mattpocock/skills`) live in `.claude/skills/<skill-name>/SKILL.md` —
read one directly before running that workflow.

### Issue tracker

Issues live in GitHub Issues (`ch1bug/dsh-shell-host`), operated via the `gh`
CLI. See `docs/agents/issue-tracker.md`.

**引用票号要限定仓**（#123 retro C7）：本仓的票写裸 `#NN`；引用**其他仓库**
（如相邻工作区 `dsh-matt-preset`）的票**必须**写全 `owner/repo#NN`。
机械守卫抓不到这条 —— `tests/doc-references.spec.ts` 只管**路径**，而本仓恰好也有
主题相近的同号票（实测：`tests/verify-pack.spec.ts` 的 `#90`/`#117`/`#118` 与
`tests/built-artifact.spec.ts` 头注的 `#10` 都是**相邻工作区**的票，裸写会把人引去
本仓 tracker 找一个不存在的条目）。

**工具故障立票（human 长期授权）**：agent 使用自己的工具遇到真实故障时，先查重，再在归属仓库当场新建或更新问题票，无需逐次请示；记录复现命令、实际输出与环境，区分工具缺陷和调用错误。此授权仅覆盖工具问题立票，不扩展到推送、发布、破坏性操作或队列外直接修复；发现票不自动加入当前批次。

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

### 环境与安装（细节见文档，勿在此复述）

- **文件工具**：文本读取用 `read`，局部修改用 `edit`，创建或完整替换用 `write`；编辑已有文件前先读取，局部修改优先 `edit`。工具参数错误应修正原调用，不改用 `str_replace_editor` 或终端绕行。当前会话禁用权限升级时，省略 `sandbox_permissions` 与 `justification`，不为常规文件操作附带升级参数。
- **agent 解释器边界（human 明确要求）**：禁止使用 `cmd.exe`；PowerShell（含 `pwsh` 工具、`pwsh` / `powershell` 解释器）**仅允许执行 git 和 gh 操作**，其他用途禁止。其他环境不限制，也不强制使用 MSYS2；human说明UCRT已装gh、MSYS已装git，也可按实际PATH使用。文件读取、编辑、搜索仍优先专用工具；测试仍走PTY并选择允许的解释器。此约束针对 agent 的执行方式，不改变产品已有功能；历史 cmd/pwsh 示例不扩展上述许可。
- **权威工作树**：`<repo>`（本仓检出，唯一提交处）；msys2 侧检出是**只读部署副本**。
  分工表、同步命令、`core.autocrlf` 对齐与实测教训的唯一来源：`docs/dev-environment.md` §0。
- **本仓是 PUBLIC 仓**：文档 / 代码 / 提交信息里不得出现**个人绝对路径**；占位符
  写法（`me` / `x` / `<user>` / `%USERPROFILE%`）与机械守卫（`scripts/privacy-scan.mjs`）
  的完整口径见 `docs/agents/privacy.md`。
- **脱敏 / 历史重写流程**：`docs/agents/privacy.md`（何时重写、枚举-一遍跑齐、飞行前后检查、
  tracker 口径、回滚退路）。
- **环境事实唯一来源 / 隔离契约 / 源码部署 / 构建坑**：`docs/dev-environment.md`
- **DSH 沙箱下的执行口径**（测试与 git 写操作走 PTY；验收读数 `NO_COLOR=1`；PTY 会话跨轮存活的
  **适用条件**——沙箱生效 vs 无沙箱——见该节，勿在此复述）：`docs/dev-environment.md` §4.6
- **插件安装与注册**（官方两步 CLI；手工 symlink 不算安装）：`docs/agents/profile-install.md`

## Project context

Read `GLOSSARY.md` first — it carries the verified upstream facts and the
grill-locked decisions (D1–D8) this repo is built on.

## Build & verify

命令、脚本语义与 No-CI 口径的**权威来源**：[README.md](README.md#build--verify)（`node --run
typecheck` / `build` / `test` / `test:release`；`test` = typecheck + `scripts/verify-all.mjs`，
**唯一检查入口**）。读法要点（agent 日常要用的最小集）：汇总里 **`PASS*` = 该用例含 loud
skip、环境侧断言未验证**（绿 != 全验过，先看 PASS* 数量）；`SKIP` = 门禁未开。
pre-commit 守卫一次性启用：`git config core.hooksPath .githooks`（查什么、怎么绕：
`SKIP_HOOKS=1`）。

**msys 侧日常口径**（第三条车道：在部署副本里用 msys 的 git/sh/tar + Windows 的 node 跑，
含「安装 → 配置 → 启动 → 建会话 → 真实调用」三档 e2e）：跑 `bash <repo>/scripts/msys-lane.sh`
（`--no-live` = pre-push 用的那条；`--lane machine` = 迭代口径）。车道机制、命令行全表、
读数判据与路径形态坑的唯一来源：`docs/dev-environment.md` §0.1.1；`.githooks/pre-push`
推送前自动跑 `--no-live`（红则阻断，`SKIP_HOOKS=1 git push …` 明确跳过）。

分层、证据纪律、失败归因规则见 `docs/agents/TESTING.md`。

**审阅阶段**（`/code-review` 的两个轴 subagent）另读 `docs/code-review-brief.md` ——
本仓怎么组装那两份 brief（固定点写法、spec 源、standards 清单、smell 基线粘贴要求）。
实现阶段不必读。

## 批次模式（攒批）

人类**显式声明**批次（"这批攒批 / 系列处理"）时才生效，**不是**默认节奏。声明时必须给出
**成员 + 顺序 + 结束点**；声明即**授权自主执行**，并在 `.scratch/batch-state.md` 落一份
权威状态 —— **恢复/接续会话以它为准，不以记忆为准**（每票完成后更新，批次末归档为
`.scratch/batch-archive-<批>-<成员>.md`，供下一批另起）。它至少要有这四块：
**成员与顺序** / **结束点** / **进度日志**（每行 = 票 + 证明命令 + 退出码 + 证据路径，
缺一条即 BLOCKED 不算完成）/ **未推送提交清单**。

**批次实施中，票内口径不要逐个问人。** 批次声明已经把"做哪些票、什么顺序"拍过了；
票内的**判据口径 / 边界取舍 / 落在哪个函数**属实现细节 —— 按**既有惯例自己定**，
并在该票的落地文档（`.scratch/<NN>-landing.md`）里**显式留档**（选了什么、为什么、
代价是什么）。**只有这三类才停下来问**：

1. **外部动作**（推送 / issue 创建·关闭·评论 / 发布 / 破坏性操作）—— 走批次末汇总 → 确认；工具故障新建/更新问题票适用上文 human 的长期授权，无需再次确认；
2. **跨票判据变更**（会改变别的票既有行为的语义变更，如豁免粒度）—— 立独立票，不在票内顺手改；
3. **批次声明本身要变**（加票 / 改顺序 / 改结束点）—— 需人类显式扩展。

> 实测教训（2026-10-18，批 B 的 #94）：票内口径（占位符怎么排除、扫描面取哪个、跨仓引用
> 怎么留档）本该**自定 + 留档**，却被当成决策问了人 —— 批次的意义正是消掉这类往返。
> 判据口径自己定**不等于**降低证据标准：留档 + 变异验证 + 两轴复核照旧。

**批次纪律要点**（最容易忘的四条）：

- **一票一会话**（人类强制）：每票本地提交 + 本地验证 + 两轴 code-review，**批次内不推送**；
- **每票结束即落 retro 候选**到 `.scratch/retro/<batch>-<会话>.md`（**只落候选，不落地**）——
  否则批次末聚合缺料。实测：批 B 前两票没落，末会话只能**二手代记**，细节已丢失；
- **批次末**：汇总（列全批 issue，含新立/更新的）→ 人类确认 → 一次性推送；
  之后跑 retro → **聚合呈现一次** → 写 `.scratch/retro/.aggregated`（跨会话抑制器）+
  `retro: done @ <commit>`；
- 反堆积护栏：**5 张未推送票或 1 周** → 暂停并请示检查点；按票计数，不按提交数计数（文档提交/一票多提交不另算票）；批次**必须**终于一次推送。

**两个文件形状的硬要求**（批 D 实测，漏了会静默毁数据）：

- **`.scratch/retro/.aggregated` 是「累积台账」，必须追加、不可覆盖**：它是
  **跨批**的抑制器，A/B/C/D 各批的段落**都要留着**（段间用 `---` + 「历史（保留，不删）」隔开），
  每段自带 `retro: done @ <commit>`。**新批次把新段落加在最前面**，旧段落原样保留。
  ⚠️ `.scratch/` 已 gitignore、**无 git 历史** ⇒ **覆盖 = 真的丢数据，无法恢复**。
  （同一个坑已发生过两次：批 D 声明时覆盖过 `batch-state.md` 的批 C 区；
  若再按"写一个标记文件"的字面去覆盖 `.aggregated`，会毁掉前三批。）
- **`.scratch/batch-state.md` 也是累积文件**：新批次**另起时先把上一批整份归档**为
  `.scratch/batch-archive-<批>-<成员>.md`，再改写本文件的现役区；历史区保留不删。
  它至少要有四块：**成员与顺序 / 结束点 / 进度日志**（每行 = 票 + 证明命令 + 退出码 +
  证据路径，缺一条即 BLOCKED）/ **未推送提交清单**。

**交接（handoff）文档的义务**（批 D 聚合 A5/D3）：**必须列出本次新踩的陷阱**，
不只是复述上一轮的清单。实测：批 D 的交接清单**命中率很高**（`pwsh` 下 vitest EPERM、
`.bat` 末步静默丢、`typecheck` 成功无输出、`git add` 后又改文件…全部有效），
但它是**手工维护、只覆盖上一会话踩过的** —— 而每一轮都会踩出**新的**一条
（批 D 的 #126 就踩出了 CRLF 判据假红与 `amend` 打爆副本同步两条）。
⇒ 交接文档写清单时，**把本轮新增的那条也加进去**，否则陷阱清单会随时间失真。

**模板里的「环境快照」「产物清单」两节必填**（批 G 聚合 G9，计次 ×2；`#149` / `#120` 实测空模板）：
留空会逼子会话自己重跑起手式 + 逐条哈希自验，而且**证明不了**「与父会话看到的是同一棵树」。
父会话没跑起手式时写「**未填（父会话未跑起手式）**」—— 明确的不填 ≠ 留空假装已验证。

⚠️ **`handoff_tool` 会在正文之后另追加两节同名空模板**（2026-10-20 实测，第三次复发：正文里填了，
文末仍出现 `- 分支/HEAD:` 空行与 `- （替换本行：path/to/artifact sha256:…）`）⇒ 光"填模板"不够：
父会话要在**正文自写一节**「环境快照（实测）」+「产物清单」，标题里写明「**工具若另追加空模板，以本节为准**」，
子会话按这条优先读。工具侧修掉之前，这是唯一可靠的写法。

**本仓无 CI（ADR-0014）** ⇒ 批次末的"CI 绿"口径 = **pre-push 的 msys `--no-live` 车道全绿**
（`.githooks/pre-push` 自动跑）+ `node --run test`。

Gotchas (learned the hard way):

- 提交或复核前先 `git add -A` 再 `git diff --staged` —— **否则新增文件不进 diff**
  （`docs/code-review-brief.md` §1；此前真实踩过：审出的面少了新文件）
- **但同一个工作树可能有并行会话在写**（本机实测多次：两个会话共用一个 `<repo>` 检出，
  各自提交、各自推送）。此时 `git add -A` 会把**别人的未提交改动**一起收进你的提交 ——
  实测（2026-10-17/18）一次纯文档提交吞掉了另一会话正在改的 `tests/verify-pack.spec.ts`：
  内容没丢、也过了 pre-commit typecheck 与 pre-push 全量车道，但**归属与意图混了**。
  ⇒ 暂存前先 `git status --short` 看清有哪些文件；**不属于你本次改动的一律不要收**，
  用**显式路径** `git add <path> …` 代替 `-A`（只在确认自己是唯一写者时才用 `-A`），
  提交后再核 `git show --stat` 的清单是否恰好等于你的改动面。
- **而且别人可能已经把改动放进了暂存区**（`git status --short` 第一列是 `M`）—— 此时
  `git add <你的路径>` **挡不住**它，`git commit` 会把**整份索引**一起提交（本仓第二次踩到：
  修本条 gotcha 的提交自己就把对方已 staged 的 `tests/verify-pack.spec.ts` 收进去了；
  2026-10-24 深夜批第三次实测 16 files，见 `.githooks/pre-commit` 的 reminder）。
  ⇒ **共享工作树上的提交一律 pathspec 形式**：`git commit -m <msg> -- <你的路径>`
  （走临时 index，只提交该路径、索引里其余条目原样留着；与 preset 仓
  `dsh-matt-preset#103` 的暂存纪律同族，两仓互指）。add/commit 清单只含仓内产物，
  证据/落地文档（`.scratch/`，gitignored）不进清单——含 gitignored 路径的 add 会整条 exit 1。
  提交前看 `git diff --staged --name-only`、提交后核 `git show --stat` 清单；发现卷入他方内容
  立即 `git reset --soft` 回退重做（未 push 即无远端污染；`git restore --staged <path>`
  注意：若对方 staged 版本与其工作树版本不同，unstage 后该版本无 git 级副本，先取副本再 restore）。
- **共享工作树还会让 pre-push 车道互相阻塞**：`.githooks/pre-push` 跑车道前要求**权威树工作树
  干净** —— 只要另一个会话还有未提交改动（哪怕与你无关），推送就会被拒（实测：一次纯文档提交
  因此推不上去）。这是**前置未满足，不是产品红**：等对方收尾，或确认自己的提交面已单独验过
  （`node --run typecheck` + 与改动相关的 spec + `scripts/privacy-scan.mjs`）后，走钩子自己写的
  逃生口 `SKIP_HOOKS=1 git push …`，并把「跳了什么、为什么」写进当次汇报。
- **加/删依赖的票在「首次推送」时才撞部署副本**（批 G 聚合 G14；`#120` / `#146` 实测）：权威树装过 ≠
  副本装过，pre-push 在副本重建 `lib/` 时报 `TS2307`（报错文案已区分"副本前置"与"产品缺陷"）。
  推送前先在副本里 `node <pnpm.mjs> install --frozen-lockfile`（走本地 store，约 2s），再推。
  这是**前置未满足，不是产品红**。
- `!!js` values inside `cordis.patch.yml` that contain a colon-space (`: `)
  must be block scalars (`!!js >-`) — colon-space breaks YAML plain-scalar
  parsing. Colon-free inline expressions (the platform guards) are fine;
  upstream base uses them verbatim.
- Launcher argv/prefix constants (`*_INTERACTIVE_ARGV`, `msys2PathPrefix`,
  `parseWslDistroList`) live in `src/launchers.ts` (ADR-0013) — do not
  recreate a second argv table.
- Never mount a loader row that takes over an upstream row id (ADR-0012) or
  reintroduce an executor/ctx.shell provider (ADR-0013).

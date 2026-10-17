# AGENTS.md

**与人沟通一律用中文。** 面向用户的一切输出 —— 汇报、提问、总结、最终答复、
提交信息、issue 正文与评论、新建文档 —— 全部写中文。

> 例外：代码标识符、命令、文件路径、上游 API/字段名、以及引用既有英文文本时
> 保持原样（翻译它们会破坏可执行性与可检索性）。既有英文文档按需局部改写为
> 中文，不做整篇重写式改动。

This workspace is a DSH bundle repo (`dsh-shell-host`) built with the Matt
Pocock AI-coding workflow. Route work through the flow skills (grill →
to-spec → to-tickets → implement).

**Package posture (ADR-0012/0013, 2026-10-16): tools-only plugin.** The shell
executor world is gone — no `ctx.shell` provider, no backends, no upstream
loader-row takeover. Entries: `./pty` (persistent PTY sessions), `./terminal`
(`shell_open` launcher presets), `./wsl` (WSL bridge tools). Remote one-shot
belongs to the standalone `dsh-shell-remote` plugin (route C).

## Agent skills

Engineering skills (v1.3.1, vendored editable copy from
`github.com/mattpocock/skills`) live in `.claude/skills/<skill-name>/SKILL.md` —
read one directly before running that workflow.

### Issue tracker

Issues live in GitHub Issues (`ch1bug/dsh-shell-host`), operated via the `gh`
CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

### 环境与安装（细节见文档，勿在此复述）

- **权威工作树**：`<repo>`（本仓检出，唯一提交处）；msys2 侧检出（如
  `~/dsh-shellhost-src`，跑 19502 实例）是**只读部署副本**，
  用 `fetch` + `merge --ff-only` 单向同步。两边 `main` 必须同提交；本仓不
  `checkout` tag（`dsh-v0.2.1-rc.2` 是**宿主**树的锚点）。
- **本仓是 PUBLIC 仓**：文档 / 代码 / 提交信息里不得出现**个人绝对路径**（本机用户名、
  家目录）；用 `~` / `$HOME` / `%USERPROFILE%` / `DSH_E2E_*` 覆盖或占位符
  （`me` / `x` / `<user>`）。机械守卫：`scripts/privacy-scan.mjs`（pre-commit 跑它，
  `tests/privacy-scan.spec.ts` 共用同一份判据）。
- **脱敏 / 历史重写流程**：`docs/agents/privacy.md`（何时重写、枚举-一遍跑齐、飞行前后检查、
  tracker 口径、回滚退路）。
- **环境事实唯一来源 / 隔离契约 / 源码部署 / 构建坑**：`docs/dev-environment.md`
- **插件安装与注册**（官方两步 CLI；手工 symlink 不算安装）：`docs/agents/profile-install.md`

## Project context

Read `GLOSSARY.md` first — it carries the verified upstream facts and the
grill-locked decisions (D1–D8) this repo is built on.

## Build & verify

```bash
node --run typecheck      # tsc --noEmit -p tsconfig.json
node --run build          # tsc -p tsconfig.build.json → tsdown (lib/*.js)
node --run test           # typecheck + scripts/verify-all.mjs（**唯一检查入口**）
node --run test:release   # build + verify:pack（装箱面：exports 指针与产物）

No CI (maintainer decision 2026-09-30; boundaries in ADR-0014): verification is local.
Do not propose adding ci.yml. Local guardrails ARE allowed — enable once per clone:

    git config core.hooksPath .githooks      # pre-commit: detached HEAD + lockfile + typecheck + 实验标记 + 隐私扫描
    git config push.autoSetupRemote true     # 首次 push 不必 -u（否则 git push 报 no upstream）
    # bypass deliberately: SKIP_HOOKS=1 git commit …
```

`node --run test` 的汇总里 **`PASS*` 表示该用例含 loud skip，其环境侧断言未验证**
（绿 != 全验过）；`SKIP` 表示门禁未开。看汇总先看 `PASS*` 数量。

**msys 侧日常口径**（第三条车道：在部署副本里用 msys 的 git/sh/tar + Windows 的 node 跑，
含「安装 → 配置 → 启动 → 建会话 → 真实调用」三档 e2e）——**在 msys bash 里**跑：

```bash
bash <repo>/scripts/msys-lane.sh              # 同步副本 → 全量套件（含真实层）→ 读数汇总
bash <repo>/scripts/msys-lane.sh --no-live    # 排除真实层（外部端点偶发假红）；pre-push 用的就是这条
bash <repo>/scripts/msys-lane.sh --lane machine   # 迭代口径（只跑 machine 车道）
```

`.githooks/pre-push` 已接：branch 推送前自动跑 `--no-live` 那条（约一分钟）；红则阻断推送，
`SKIP_HOOKS=1 git push …` 可明确跳过。它自己 source `scripts/msys-env.sh`（Windows node 前置 +
复用 Windows 的 git/gh 配置），并把四个 `DSH_E2E_*` 推导成 **Windows 形态**路径；
机制、读数判据与路径形态坑见 `docs/dev-environment.md` §0.1.1。

分层、证据纪律、失败归因规则见 `docs/agents/TESTING.md`。

**审阅阶段**（`/code-review` 的两个轴 subagent）另读 `docs/code-review-brief.md` ——
本仓怎么组装那两份 brief（固定点写法、spec 源、standards 清单、smell 基线粘贴要求）。
实现阶段不必读。

Gotchas (learned the hard way):

- 提交或复核前先 `git add -A` 再 `git diff --staged` —— **否则新增文件不进 diff**
  （`docs/code-review-brief.md` §1；此前真实踩过：审出的面少了新文件）
- `!!js` values inside `cordis.patch.yml` that contain a colon-space (`: `)
  must be block scalars (`!!js >-`) — colon-space breaks YAML plain-scalar
  parsing. Colon-free inline expressions (the platform guards) are fine;
  upstream base uses them verbatim.
- Launcher argv/prefix constants (`*_INTERACTIVE_ARGV`, `msys2PathPrefix`,
  `parseWslDistroList`) live in `src/launchers.ts` (ADR-0013) — do not
  recreate a second argv table.
- Never mount a loader row that takes over an upstream row id (ADR-0012) or
  reintroduce an executor/ctx.shell provider (ADR-0013).

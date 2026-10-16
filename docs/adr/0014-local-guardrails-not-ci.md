# ADR-0014: 本地守卫允许，CI 服务不允许 —— 无 CI 决定的边界

- Status: Accepted
- Date: 2026-10-16
- Deciders: human（2026-10-16，retro 落地时拍板：允许 pre-commit，不建 CI 服务）
- Context: 维护者 2026-09-30 决定"本仓无 CI"（写进 AGENTS.md）；相邻工作区
  `dsh-matt-preset` 的 ADR-0004 给出同向理由（上游漂移造环境假红）；本会话反复
  纠结"加 pre-commit 是否违反无 CI"，故立此 ADR 划清边界

## Context

"无 CI"这条决定写在 AGENTS.md，但**只说了结果，没说边界**。于是每次会话遇到
"要不要加一道自动检查"都要重新判断一次，并可能得出相反结论。本会话即发生：
retro 中提议 pre-commit 时，无法从既有文字判断它是否被禁。

需要区分的两类东西被同一个短语盖住了：

- **CI 服务**：`.github/workflows/*.yml`，在 GitHub 托管的干净 runner 上跑。
- **本地守卫**：`core.hooksPath` 指向的 hook（如 `.githooks/pre-commit`），在
  开发者本机、提交前跑。

两者的失败面完全不同：runner 上没有本机 msys2 布局、没有已装 DSH 运行时、
没有账号凭据，**上游 rc 一漂就红，且红的不是本次改动**——这正是无 CI 决定与
相邻工作区 ADR-0004 要躲的假信号。本地守卫跑在同一台机器上，环境齐全，
**红即代表改动或本机状态有问题**。

## Decision

- **禁止**：为本仓新增 CI 服务（`.github/workflows/` 下任何文件、任何托管 runner）。
  理由不变（上游漂移造环境假红）。不要提议建 `ci.yml`。
- **允许并鼓励**：本地守卫，条件是它只依赖**仓库自身或本机已有**的东西：

  - 允许：`typecheck` / 单元测试 / `pnpm install --frozen-lockfile`（依赖一致性）/
    `git symbolic-ref -q HEAD`（detached HEAD）/ 文件编码与行尾检查
  - 允许：`--from-default-profile` + `dsh plugin add` 这类需要**本机 DSH 布局**的
    安装检查 —— 但它属**环境侧**，必须**响亮跳过**（`!! SKIP (loud)`）而非阻断提交
  - 禁止：任何需要外部网络服务、托管 runner 或第三方账号的检查

- 守卫必须可按需绕过（`SKIP_HOOKS=1 git commit …`），且绕过时**打印说明**——
  与套件的 loud-skip 惯例一致：未验证就说未验证，不要装作验过。

- 守卫与唯一检查入口共用同一份逻辑（`node --run test` == `scripts/verify-all.mjs`），
  不得各写一套判据。

## Consequences

- 未来会话不必再逐个判断"这道检查算不算 CI"：看它是否落在 `.github/workflows/`
  或依赖外部服务，即可判定。
- 提交前能自动挡住本会话真实踩过的四类错误：lockfile 漂移、detached HEAD、
  typecheck 失败、装箱面（exports）与产物不符。
- 代价：hook 是**每 clone 一次**的配置（`git config core.hooksPath .githooks`），
  未配置的 clone 不受保护。这是本地守卫的固有局限，故它只作**辅助**，
  验收标准仍是 `node --run test` 全绿 + `/code-review` 双轴。
- 上游若未来 API 稳定（正式版发布），可重议是否把守卫搬到 CI —— 届时需新 ADR
  推翻本条的"禁止"部分，理由须正面上游漂移问题（相邻工作区 ADR-0004 已给出
  前置条件：CI 内钉版本装固定 dsh）。
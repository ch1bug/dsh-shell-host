# ADR-0006: 锚定升级的依赖 lane = npm 发布 dist（2026-10-03）

## 状态

已接受（human 决策 A0，批 A 声明时拍板；推翻 2026-09-30 的"不走 npm"决定）

## 背景

ADR-0005 定义了模块锚定官方 DSH 版本的 tag 方案。dsh-shell-host 自 #10 起的依赖 lane 是本地源码 checkout（`../deepseek-harness` pin 在 rc.2）：pnpm link: overrides + tsconfig extends 源码 paths 门面 + vitest alias 表三处枚举，理由是当时 npm 上没有对齐版本、且源码闭包便于跟随上游。

锚定升级到 `dsh-v0.2.1-alpha.1`（票 #17）时发现：官方已把全套 `@deepseek-ai/*` 发布到 npm（含 alpha 版 cordis/schemastery/loader，tarball 内带完整 `lib/types` 声明与 subpath exports）。本机运行中的应用仍是 rc.2（官方无安装包资产）。

## 决策

1. 锚定升级一律走 **npm 发布 dist**：peer 精确锚定官方版本，类型/运行时全部来自 node_modules；不再维护本地源码 checkout 的三处枚举。
2. **运行环境验证与锚定解耦**（A0）：应用本体未升级到锚定版本不阻塞锚定链上的 seam 审计/conformance——审计对象是 npm dist 的类型与行为；运行验证推迟到 feed 可用或手动安装。
3. peer 实装（`autoInstallPeers: true`）；原生闭包构建用 `allowBuilds` 显式放行。
4. 此前由源码闭包隐式提供的 ambient 类型面（dsh-app-boot、dsh-settings、client 面包）改为显式 devDependencies。

## 后果

- 升级 = 改一组精确版本号 + `pnpm install`，不再随上游仓库结构漂移。
- 类型来自官方构建产物，与上游消费者看到的世界一致（比源码闭包更真）。
- 失去"改上游源码即时生效"的调试通道；需要时临时 `pnpm override` 回 link:。
- `minimumReleaseAgeExclude` 列表由 pnpm 在 install 时生成，锚定 bump 后需重新生成（机械同步，勿手编）。

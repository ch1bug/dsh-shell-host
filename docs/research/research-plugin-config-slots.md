# Research: 宿主插件配置插槽与配置写协议（#105 / ADR-0018 的证据落仓）

日期：2026-10-26 · 取证人：批 J #105 实现会话 · 结论消费者：`docs/adr/0018-custom-shell-registration.md`

## 取数方法（可复跑）

锚 = 已安装宿主的编译产物 `app.asar`（`<DSH 安装目录>/resources/app.asar`，本仓
不依赖具体个人路径——以运行中的宿主自身安装为准）。读法：把 asar 当文本读入、
按行切开、按行号取窗口（行号指该展开文本，同一宿主版本内稳定；口径与 #121 一致）。
复跑脚本形状（临时件，不进仓）：

```js
import { readFileSync } from 'node:fs'
const lines = readFileSync(process.argv[2], 'utf8').split('\n')
for (const n of process.argv[3].split(',')) {
  console.log(lines.slice(n - 9, n + 10).map((l, i) => `${n - 9 + i + 1}: ${l}`).join('\n'))
}
```

宿主版本锚：`0.2.1-rc.2`（package.json `engines.dsh` 同款）。宿主升级后行号会漂移，
结论应按关键词重探（`plugins.row.config` / `form.mutate` / `dsh.client`）。

## 读数 1：三个配置插槽全是 client 插槽（bundle 浏览器半侧注册 React 表单）

L498265（宿主文档英文卷）：

> A plugin that carries its own configuration renders it on this page rather than
> in Settings, through three slots the page declares: `plugins.item` (list) …;
> `plugins.bundle.config` (keyed by the bundle's package name) …; and
> `plugins.row.config` (keyed by `<package name>#<row id>`) for one row's
> configuration, which gives that row a **Configure** control opening the row's page.

同段注册示例（L498268-498272）：`ctx.slots.inject('plugins.row.config', () =>
ctx.slots.register({ name: 'plugins.row.config', key: '@acme/dsh-sidebar#sidebar',
locale: 'acmeSidebar' }, ({ t, view }) => … <SidebarForm t={t} />))`。
`rowConfigKey(bundle, rowId)` 实现：L498595-498597。client 侧 `renderSlot`
消费：L501375。中文卷同文：L498453-498463。

## 读数 2：不存在通用 schema 渲染的插件配置页

同段点名四个宿主配置页各来自伴生 UI 包（ui-settings-shell / ui-settings-agent-loop /
ui-settings-subagent / ui-settings-web-search，L498265 末）。关键词探针 0 hit：
`setPluginConfig` / `updatePluginConfig` / `configSchema` / `clientEntry`。

## 读数 3：浏览器半幅装载约定（dsh-client-modules README，L427562-427568）

> A browser plugin package declares `dsh.client` in its `package.json` with
> `platform: 'web'`, exports a `./client` bundle, and lists any non-baseline
> module requests under `dsh.client.external`.

HMR：`HMR switches one changed row to its revisioned one-resource combo URL`
（L427568）。

## 读数 4：配置写协议（ops 形状未取证）

L498323 / L498511（页面 store 节）：

> The page owner supplies `form.state` and `form.mutate(operations,
> expectedRevision)` when the entry exposes editable Config fields.

`ConfigFormController.mutate`（L537375-537390）：`const ownedOps =
structuredClone(ops); … await this.ctx.remote.settings.mutate(this.spec.namespace,
ownedOps, revision)`。**`ops` 的元素形状未在本卷取证**（`json-patch` 命中均为无关
axios 测试件；`ConfigOperation` / `mutateConfig` 0 hit）——这是 ADR-0018 §4 把
client 配置页出候选票的直接依据，也是候选票立项的前置取证项。

## 读数 5：HMR 重组语义（行重挂 ≠ 重启）

L498261：

> A row's switch on the bundle's page calls `pluginManager.setPluginEnabled` …
> The tree recomposes at once on a profile with HMR, so the row's host half
> unmounts or mounts while the rest of the bundle keeps running.

⇒ 配置写若触发同型重组，「宿主重跑 apply」不是重启——#105 的重启生效契约因此用
**进程级快照**保证（ADR-0018 §2），不依赖「宿主不重读文件」。该读数未做活体
HMR 实测（边界声明见 ADR-0018「边界与显式不做」末条）。

# Research: 官方可选 bundle（持久终端 / Ralph）对本仓的影响

- 评估日期：2026-10-17（Asia/Shanghai）
- 上游锚：宿主 tag `dsh-v0.2.1-rc.1`（与 `dsh-v0.2.0-rc.2` 的差异在正文标注）
- 只读来源：上游裸仓浅克隆（`git show dsh-v0.2.1-rc.1:<路径>` /
  `git grep -n <模式> dsh-v0.2.1-rc.1 -- <路径>`）；可复现命令清单见附录 B
- 本仓：`<repo>`（评估期间只读）
- 记号：**【源码】**= 上游源码逐字确证；**【实测】**= 评估会话现场观察；**【推断】**= 逻辑外推，未实测

---

## 0. 一句话结论

官方这两个 bundle 对本仓是 **「重叠但可共存」**：工具名零冲突、loader 行 id 零冲突、
挂载面互不触碰，可在同一 profile 同时启用；但**必须做两笔账**——
(1) 文档层写明「与官方可选 bundle 的分工 / 别同时开」；
(2) **ADR 级**更正 ADR-0009/0010 的事实依据：rc.1 起 `@deepseek-ai/dsh-terminal` 已是可挂载的
cordis Service 插件、`subprocess` 已是 **base bundle 的 root 行**，ADR-0009 的「重开条件 1」
在非桌面模板里已部分成立；不过其**结论**（桌面线第三方 root 行拿不到官方 `terminals` 实例）
仍然成立，因为所有随附挂载点都把它关进 `isolate: { terminals: true }` 的 entry-local realm。

---

## 1. `dsh-experimental-terminal-bundle`

### 1.1 patch 全文（`packages/experimental/terminal-bundle/cordis.patch.yml`，共 16 行，逐字）

```yaml
- insert:
    - id: optional-persistent-terminals
      name: cordis:group
      group: true
      isolate:
        terminals: true
      config:
        - id: optional-terminal-registry
          name: '@deepseek-ai/dsh-terminal'
        - id: optional-terminal-bash
          name: '@deepseek-ai/dsh-terminal-bash'
          disabled: !!js process.platform === 'win32'
        - id: optional-terminal-pwsh
          name: '@deepseek-ai/dsh-terminal-bash'
          disabled: !!js process.platform !== 'win32'
          config:
            shellDialect: pwsh
        - id: optional-tool-terminal
          name: '@deepseek-ai/dsh-tool-terminal'
```

逐行含义：

| 行 id | name | 含义 |
|---|---|---|
| `optional-persistent-terminals` | `cordis:group` + `group: true` | 组合层组行；本行**不产出服务**，只做 realm 边界 |
| （上行的）`isolate: { terminals: true }` | — | 为 `terminals` 开一个**该 entry 私有**的服务 realm（见 §3） |
| `optional-terminal-registry` | `@deepseek-ai/dsh-terminal` | 会话注册表服务（`TerminalSessionService`，`super(ctx,'terminals')`，`packages/terminal/terminal/src/index.ts:105,116`） |
| `optional-terminal-bash` | `@deepseek-ai/dsh-terminal-bash` | Linux/macOS 的 bash 后端；`disabled: process.platform === 'win32'` |
| `optional-terminal-pwsh` | `@deepseek-ai/dsh-terminal-bash`（同名包） | Windows 侧以 `config.shellDialect: pwsh` 复用同一后端包；`disabled: process.platform !== 'win32'` |
| `optional-tool-terminal` | `@deepseek-ai/dsh-tool-terminal` | 面向模型的 6 个工具 |

### 1.2 `dsh-tool-terminal` 注册的全部工具（`packages/experimental/tool-terminal/src/index.ts`）

`export const inject = ['terminals', 'tools', 'systemPrompt', 'workingDirectory']`（第 30 行）——即
**必须能解析到 `terminals` 服务**才会注册工具。注册 6 个工具：

| 工具 | 用途（原文摘） |
|---|---|
| `terminal_open` | “Create a persistent, owner-isolated terminal session from a registered backend type.” 参数 `type`/`name`/`cwd` |
| `terminal_send` | “Send text to a persistent terminal.” 默认回车、等待 prompt/stdin/idle/timeout/exit；`run_in_background` 走 `ctx.jobs`（`JobKindMap['pty-send']`） |
| `terminal_read` | “Read a bounded page of retained output … without sending input.”（`offset`/`count`，新近为基准） |
| `terminal_signal` | “Send an allowed signal to the current foreground process group”（`SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP`；shell 目标 SIGKILL 被拒） |
| `terminal_close` | “Close one persistent terminal and wait until its captured owned process tree is gone.” |
| `terminal_list` | “List persistent terminal sessions owned by the current agent.” |

另注册一条 system prompt section：`ctx.systemPrompt.section({ name: 'tool:pty', … })`。

### 1.3 谁来启用（【源码】+【实测】）

- **默认关**。`packages/boot/app-boot/src/profile.ts:216-231`：

```ts
/**
 * The bundles the dsh installation ships for a person to switch on: each a
 * runtime dependency of the installation that declares `dsh.bundle.patch`,
 * an `icon`, and `./locale/*.json` display metadata, selected by no shipped
 * template, and offered switched off by the plugin manager
 */
export const OPTIONAL_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  …
]
```

- **启用入口 = 插件页 / 插件管理器**（`packages/boot/plugin-manager/README.md:60`）：
  “A bundle the launcher's `OPTIONAL_BUNDLES` names is `optional`: shipped switched off for the
  person to turn on, never removable, and selected by no shipped template”
  （中文版同文件 `README.zh.md:60`：「随安装提供、默认关闭、由用户开启，永不可卸载，也不被任何随附模板选中」）。
- **GUI 位置**：`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:120-128`
  的 `MORE_BUNDLES` 同时列出 `…terminal-bundle` 与 `…ralph-bundle`，并由
  `function pinnedToMainList(pkg) { return !MORE_BUNDLES.includes(pkg.name) || pkg.enabled }`
  决定：**未启用时藏在 More 列表**，启用后进入主列表。
- **开启动作做了什么**：`packages/boot/plugin-manager/src/index.ts:510-515`
  `setBundleEnabled(name, enabled)` → `selectBundle(name, enabled)` → `publishAndReload(bundleRows(name)…)`；
  `selectBundle`（同文件 808-829）改的是 profile manifest 的 `dsh.profile.bundles`：

```ts
const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]]
                        : previous.filter(item => item !== name)
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
await saveManifest(this.profile.dir, manifest)
```

  → 即「profile bundles 列表」新增一项（此前不在任何随附模板里），并立刻把该 bundle 的 patch 层
  应用到运行中的 Host。bundle README（`packages/experimental/terminal-bundle/README.zh.md`）：
  「在 Web 或 Desktop 中打开插件页，在官方分组启用 **持久终端**……启用或关闭组合包会在运行中的
  Host 注册或移除其全局工具，因此所有预设（包括 minimal）中的每个智能体都会在下一次请求时看到变化。」
  回归证据：`apps/cli/tests/optional-bundle-transitions.e2e.ts:334,346` 启用后断言所有 agent 与 Host
  工具目录均含 `terminal_open`；`:281` 关闭后断言不含。
- **【实测】** 本会话 Agent 可调用工具里确实有上游 `terminal_open/send/read/signal/close/list`；
  并且实跑通过：`terminal_open { type: 'shell', name: 'probe' }` → `started terminal session pty-1 (probe) [type: shell]`；
  `terminal_send` 回显 `DSH_PROBE_OK_SH107`；`terminal_close` → `closed terminal session pty-1`。
  说明本机 profile 已启用该 bundle，且其全部 inject（含 `subprocess`）在 root 组合层解析成功。

### 1.4 与本仓 `./pty` + `./terminal` 的重叠面

本仓工具面（源码 grep `<repo>/src`）：`pty_open`/`pty_send`/`pty_tail`/`pty_close`（`src/pty/index.ts:138,184,210,237`）、
`ssh_start`/`ssh_send`/`ssh_tail`/`ssh_close`（同文件 421,463,489,516）、`shell_open`（`src/terminal/index.ts:139`）、
`win_ls`/`win_read`/`win_write`/`win_run`/`win_open`/`win_path`/`win_drives`（`src/wsl-plugin/index.ts:127…294`，挂载面在 `./wsl`，当前 `<repo>/cordis.patch.yml` 未挂）。

- **名字冲突：无**。上游 `terminal_*` vs 本仓 `pty_*`/`ssh_*`/`shell_open`/`win_*` 互不相交。
  本仓 `tests/terminal.spec.ts:189-190` 只是负断言（`terminal_send`/`terminal_tail` 未注册）。
- **能力重叠**：持久会话 / 发送 / 读取 / 关闭 —— 四者语义近乎同构；本仓无 `signal`、无 `list`。
- **能否同时挂：能**。两边都是 patch 层 `insert` 自有 id 行：本仓 `<repo>/cordis.patch.yml` 用
  `pty`、`terminal`（第 15/18 行），上游用 `optional-persistent-terminals` 等 `optional-*` id；
  id 集合不相交。且两边各自提供**不同 realm** 的 `terminals`（上游是 isolate 私有；本仓 ADR-0010 后
  根本不 inject `terminals`，自己管 node-pty），**不存在 `provide('terminals')` 撞车**。
- **各自独有**：本仓 = ssh 四工具、`shell_open` 启动器预设（argv/前缀常量集中在 `src/launchers.ts`）、
  WSL 桥 7 工具、自管 node-pty（ConPTY）通道；上游 = `terminal_signal`、`terminal_list`、
  `run_in_background`（`ctx.jobs` 的 `pty-send` job kind）、`presentCall`/`presentResult` 的
  `card: 'terminal'` 富展示、以及**全局工具层**（所有 preset 的所有 agent 都看得见）。

---

## 2. `dsh-experimental-ralph-bundle`

### 2.1 patch 全文（`packages/experimental/ralph-bundle/cordis.patch.yml`，逐字）

```yaml
- insert:
    - id: optional-ralph
      name: cordis:group
      group: true
      isolate:
        workflowEngine: true
      config:
        - id: optional-ralph-workflow
          name: '@deepseek-ai/dsh-workflow-ptc'
          config:
            provider: spawn
        - id: tool-ralph
          name: '@deepseek-ai/dsh-tool-ralph'
          config:
            subagentProvider: spawn
            maxRounds: 64
```

挂的包：`@deepseek-ai/dsh-workflow-ptc`（隔离 `workflowEngine` realm）、`@deepseek-ai/dsh-tool-ralph`。
`package.json` 的 `dsh.bundle.patch = ./cordis.patch.yml`。

### 2.2 工具名与宿主能力依赖（`packages/experimental/tool-ralph/src/index.ts`）

```ts
export const inject = ['tools', 'workflowEngine', 'subagents', 'systemPrompt']   // 第 18 行
…
ctx.tools.register(defineTool({ name: 'ralph', … }))                             // 第 410-411 行
```

- **工具名：`ralph`**（1 个）。
- 依赖能力：**workflow engine**（`dsh-workflow-ptc`，`provider: spawn`）+ **subagent seam**（`subagents`）
  + `tools` + `systemPrompt`。
- **不依赖**：持久 shell / `terminals` / `subprocess` / `jobs` / `goal`。
  实现是「固定脚本 + 每轮一个 fresh 结构化输出子智能体」：
  “A fixed script starts one fresh structured-output child per round, carrying only the immutable
  objective and the previous bounded handoff between them.”（模块头注释）
- **会不会消费或替代本仓工具面：不会。** 它只用 subagent/workflow；长任务不需要持久终端。
  与本仓工具面零交集。
- 与本会话 `ralph` 工具的关系：**同一个工具**（同一个 `name: 'ralph'`）。本会话能看到它，
  说明本机 profile 也启用了 ralph bundle（是否真能跑未实测，见 §5）。

---

## 3. 是否推翻本仓既有结论（ADR-0009 / ADR-0010）

### 3.1 判据一：`isolate` 的语义（【源码】）

`vendor/loader/src/config/isolate.ts:74-83`：

```ts
function access(entry: Entry, name: string, create = false) {
  let realm: Realm | undefined
  const label = entry.options.isolate?.[name]
  if (!label) return
  if (label === true) {
    realm = entry.realm ??= new LocalRealm(entry)
  } else if (create) {
    realm = realms[label] ??= new GlobalRealm(label)
  } else { realm = realms[label] }
  return realm?.access(name, create)
}
```

同一文件 51-58：`LocalRealm.suffix = '#' + this.entry.options.id`、`GlobalRealm.suffix = '@' + this.label`。
→ `isolate: { terminals: true }`（`true` 而非字符串）得到 **entry 私有 realm**，
符号形如 `terminals#<entry id>`，例如 `terminals#optional-persistent-terminals`。
同文件 90-100：`newMap[name] = access(entry, name, true)` 且 `Object.create(entry.parent.ctx[Context.isolate])`
——只有该组**之下**的 ctx 才继承到这个阴影映射。

### 3.2 判据二：谁在 `provide` / `inject`

- **provide**：`packages/terminal/terminal/src/index.ts:105,116`
  `export class TerminalSessionService extends Service { … super(ctx, 'terminals') }`，
  cordis `Service` 构造器内部 `self.ctx.reflect.provide(name, self, …)`
  （`vendor/cordis/src/service.ts:55`），而 `provide` 用 `this.ctx[symbols.isolate][name]` 取 key：
  `vendor/cordis/src/reflect.ts:286-287`

```ts
this.ctx.root[symbols.isolate][name] ??= Symbol(name)
const key = this.ctx[symbols.isolate][name]
```

  ——**非 isolate** 的 provide 落在 root 符号上（全树共享，即「composition 层 provide」）；
  在 isolate 组内 provide 则落在 `terminals#<entry id>` 这个私有符号上。
- **inject**：`vendor/cordis/src/reflect.ts:154,164` 沿 fiber 链上行，
  `if (fiber.parent[symbols.isolate][prop] !== key) throw error`
  ——realm key 不一致即**解析失败**（`cannot get required service "terminals" in inactive context`）。
  `vendor/cordis/src/service.ts:62` 同款过滤：
  `return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name]`。
- 上游自己的定性（`packages/boot/app-boot/src/index.ts:764` 注释）：

```
// `cordis:group` alongside it: a group row is how a composition gives one
// `isolate` realm to a provider and its consumers together, and an agent
// preset living outside this workspace cannot resolve `@deepseek-ai/cordis-plugin-group`
```

  → **isolate realm 的用途是「把 provider 与它的消费者关在一起」**，不是对外共享的组合层。
- Agent preset 侧旁证：`packages/preset/agent-preset-registry/src/index.ts:319-321`
  `/** Read a service supplied inside an Agent's isolated preset group. */ serviceFor(...)`
  ——preset 内的 isolate 服务需要**专门的 API 才够得着**。

### 3.3 结论：ADR-0009「结论维持」，但事实依据必须更正

- **维持**：rc.1 里第三方（本仓）在 **profile root** 插的行，**仍然拿不到**官方 terminal bundle
  提供的那个 `terminals` 实例——它是 entry-local realm；上游 bundle 也用 `true`（私有），
  没有留下可共享的字符串 label，所以连「用同一个 label 加入」这扇门都没有
  （`isolate: { terminals: '<label>' }` 走 `GlobalRealm`，与 `LocalRealm` 的 `#id` 后缀**永不相同**）。
  ⇒ **ADR-0009 的判定仍然有效，ADR-0010 的改道选择仍然成立**。
- **但 ADR-0009「调查结论」1/2 条已经过期**（rc.2 → rc.1 的实质变化）：
  1. rc.2 时 `@deepseek-ai/dsh-terminal` 是**纯库包**（「main 只导出 TerminalSessionService 类与错误类，
     无 plugin entry / apply / provide 代码」「全 asar 无构造点」）。**rc.1 已不是**：它是正常 cordis
     插件（`Service` 子类 + `super(ctx,'terminals')`），可被任意 loader 行挂载。
  2. **上游确实存在 root 级（无 isolate）挂载先例**：`packages/bundle/sdk-minimal/cordis.patch.yml:5`
     的一个顶层 `- insert:` 列表里含

```yaml
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      disabled: !!js process.platform === 'win32'
    - id: terminal-pwsh
      name: '@deepseek-ai/dsh-terminal-bash'
      disabled: !!js process.platform !== 'win32'
      config:
        shellDialect: pwsh
```

     该文件**全文无 `isolate`**（grep `isolate` 在 sdk-minimal patch 零命中），
     即这个模板里的 `terminals` 是**根组合层 provide**（全树可见）。
     ⇒ ADR-0009「重开条件 1：上游为 `@deepseek-ai/dsh-terminal` 提供 composition 层 provide 入口」
     所要求的**能力形态已经存在**，只是**不在桌面线用的模板里**（桌面/web 线用
     `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`；`grep dsh-terminal packages/bundle`
     只命中 `sdk-minimal`、`web-app/presets/minimal`，base/web-app 本体零命中）。
  3. **ADR-0010 的措辞也要更正**：「世界级服务（`terminals` / `subprocess`）对 root 组合插件行不可见」
     —— rc.1 的 `subprocess` **就是 root 行**：`packages/bundle/base/cordis.patch.yml:234-235`

```yaml
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'
```

     （顶层 `insert` 列表内、无 isolate）。所以「不可见」如今只对 `terminals`（被各挂载点 isolate 私有化）
     成立，对 `subprocess` **不成立**。ADR-0010 的**决策**（自管 node-pty）依然可辩护，
     但其**必要性论证**需要重写为「官方实例被 realm 私有化」，而不是「世界级服务不可见」。
- 【实测】旁证：本会话官方 `terminal_open/send/close` 实跑成功，且 `dsh-terminal-bash` 的
  `inject = ['terminals','sandboxPolicy','sessionProjections','subprocess','workingDirectory']`
  （`packages/terminal/terminal-bash/src/index.ts:28`）全部在 root 组合层解析成功——
  再次印证 `subprocess` 现在 root 可达。

---

## 4. 本仓要不要动作（建议，不含代码）

### 4.1 文档层（记账级）
1. `README.md` / `GLOSSARY.md` 增一节「与官方可选 bundle 的分工」：点名两个 bundle、
   说明官方持久终端是**全局工具层 + 默认关 + 插件页开启**，与本仓 `pty_*`/`shell_open`
   **别同时开**（两套会话注册表、两套 system prompt 提示、`terminal_*` 与 `pty_*` 并存会误导模型）。
2. 顺手修既有 stale 文档：`GLOSSARY.md` 的「#52 grill 共识」节后三条（评估当时记为 `:216-218`）当时仍写「`shell_open` 走 terminals 缝」「sessionId 即缝会话 id」，
   与 `README.md:40-45`（“seam-free since #61, ADR-0010”）和 ADR-0010 冲突 —— **`#109`（2026-10-19）已加更正块（原文保留作历史）**。

### 4.2 ADR 级（必须，属于结论依据更正）
3. 新开/修订 ADR（或在 ADR-0009 加「2026-10-17 rc.1 复核」小节），记明：
   - 事实更正：`dsh-terminal` 已是可挂载 Service 插件；`subprocess` 已是 base 的 root 行；
     `sdk-minimal` 模板存在 root 级 `terminals` provide 先例。
   - 判据不变：桌面/web 线与官方 bundle 的挂载点都用 `isolate:{terminals:true}`，
     第三方 root 行仍拿不到；ADR-0009 结论与 ADR-0010 决策**维持**。
   - 重开条件细化：把「composition 层 provide 入口」明确为「**桌面线所用模板**里的 root 级 provide
     或命名 label 可加入的 realm」。

### 4.3 `./pty` 是否退场 / 收窄（决策级，建议暂不动）
4. **不建议现在退场**：官方 bundle 默认关、桌面线默认 preset（`standard`）里没有持久终端，
   退场会把默认体验打回一次性工具；且官方按钮开关是用户级，本仓无法假设它开着。
5. **可评估的收窄**：若采纳上游（两条路线）
   - A：让本仓 root 行自己挂 `@deepseek-ai/dsh-terminal` + `dsh-terminal-bash`（ADR-0009 的「甲方案」，
     如今源码上可行——`sdk-minimal` 即先例），本地持久终端让位官方 → 本仓只留 ssh 四工具 + WSL 桥 + `shell_open` 预设；
   - B：保持 ADR-0010 自管（现状），仅在文档写明与官方 bundle 互斥。
   两者都要新票 + 桌面实测，本报告只给判据。

### 4.4 「上游把持久终端纳入默认 preset」的影响面（**关键区分**）
6. **已经在某个随附 preset 里跑，但不是默认 preset** —— 两者必须分开说：
   - **默认就在跑的**：`packages/bundle/web-app/presets/minimal.patch.yml:34-81` 的 `persistent-shell` 组
     （`isolate: { terminals: true }`，含 `pty`=`@deepseek-ai/dsh-terminal`、`terminal-bash`、
     `dsh-tool-bash-persistent`/`dsh-tool-pwsh-persistent`，超时 300000）。它是**随附 preset 的一部分**，
     选中 `minimal` 这个 agent preset 就生效；`apps/cli/tests/optional-bundle-transitions.e2e.ts:174`
     断言（所有可选 bundle 关闭时）minimal 的工具目录恰为
     `['pwsh'|'bash', 'read_image', 'working_directory']` —— 那个 `pwsh`/`bash` 就是持久 shell 工具
     （`packages/shell/tool-bash-persistent/src/index.ts:415` 注册 `name: 'bash'`）。
   - **可选、默认关的**：`dsh-experimental-terminal-bundle`（`OPTIONAL_BUNDLES`，`MORE_BUNDLES`，
     插件页开启）。它加的是**全局工具层**的 `terminal_*` 六工具，对所有 preset（含 minimal）可见。
   - **不在默认 preset 里**：`standard`（order 1，e2e 里 `agent()` 的默认值）只有一次性
     `@deepseek-ai/dsh-tool-bash` / `-pwsh`，**没有任何持久终端行**。
   ⇒ 影响面推论【推断】：若上游把持久终端行搬进 `standard`（或任何默认 preset），
   本仓 `pty_*` 的「默认可用性」理由消失，收窄/退场的性价比立刻上升；
   但**即使到那一步也不构成名字冲突**（`bash`/`pwsh` vs `pty_*`），只构成功能重复。

---

## 5. 未确证面

1. **本机 profile 如何启用这两个 bundle**（GUI 插件页 or `dsh plugin`/profile 编辑）未确证；
   实测只确证「它们在本机是启用状态」。
2. **未在桌面 profile 实测「root 行挂 `@deepseek-ai/dsh-terminal`」**（4.3 路线 A）。
   可行性由 `sdk-minimal` 源码【源码】外推，未在本机 desktop 组合里验证。
3. **id 冲突面未逐项确证**：preset 内嵌套 `pty` id（`presets/minimal.patch.yml:40`）与本仓 root `pty` id
   是否落在同一 loader 子树未实测（`vendor/loader/src/config/tree.ts:51` 的 `ensureId` 只在**缺 id** 时随机化，
   嵌套 id 存在 `EntryTree.sep` 分隔；未见撞车证据，但也未构造实验）。
4. **`ralph` 工具是否真能跑**：本会话它在工具目录里，但未实跑（需要 workflow+subagent 世界）；
   其 workflow engine 的 `isolate` realm 是否影响它与本仓共存也未实测。
5. **两套并存时的实际模型体验**（提示词重复、工具选择困惑度）未实测，只有结构性推断。
6. **rc.1 → 后续 rc 的漂移**未评估（本报告锚定 `dsh-v0.2.1-rc.1`）。

---

## 附录 A：本仓 grep 结果（Q5）

命令（在 `<repo>` 内，排除 `.git`/`node_modules`）：
`Select-String -Path <md/yml/json/ts> -Pattern 'ralph','experimental-terminal-bundle','experimental-ralph','dsh-tool-terminal','terminal_open','dsh-experimental' -CaseSensitive:$false`

**命中：0 处提到这两个官方 bundle**（`ralph`、`experimental-*`、`dsh-tool-terminal`、`terminal_open` 全部零命中）。

只有两处**历史/负断言**命中 `terminal_`：
- `docs/adr/0008-launcher-layer.md:39`：`- \`terminal_*\` 三工具家族：Middle Man → 弃。`
- `tests/terminal.spec.ts:189-190`：`expect(() => tool("terminal_send")).toThrow(/not registered/)`（同理 `terminal_tail`）

另（非本次要求但相关）：`GLOSSARY.md` 的「#52 grill 共识」节后三条（评估当时记为 `:216-218`）当时仍以 terminals 缝描述 `shell_open`
（「`shell_open` 走 terminals 缝」），与 `README.md:40-45` 的 “seam-free since #61, ADR-0010” 及 ADR-0010 冲突 —— **`#109` 已加更正块（原文保留作历史）**。

## 附录 B：关键上游路径清单（可复现）

```
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/experimental/terminal-bundle/cordis.patch.yml
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/experimental/ralph-bundle/cordis.patch.yml
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/experimental/tool-terminal/src/index.ts
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/experimental/tool-ralph/src/index.ts
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/terminal/terminal/src/index.ts
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:vendor/loader/src/config/isolate.ts
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:vendor/cordis/src/reflect.ts
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/boot/app-boot/src/profile.ts
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/bundle/base/cordis.patch.yml
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/bundle/sdk-minimal/cordis.patch.yml
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:packages/bundle/web-app/presets/minimal.patch.yml
git -C "$env:TEMP\sh106-host-src" show dsh-v0.2.1-rc.1:apps/cli/tests/optional-bundle-transitions.e2e.ts
```
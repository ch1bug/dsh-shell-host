# Research: PTC 模式下第三方插件的工具能否像官方终端一样被 `run_code` 调用

- 核查日期：2026-10-18（Asia/Shanghai）
- 上游锚：宿主 tag `dsh-v0.2.1-rc.2`（宿主编译树 `<host>`）；核查时的本仓提交用 `git log` 现场取（**别抄哈希**）
- 只读来源：宿主源码树 + 本仓检出；实验产物（临时 profile、mock、日志）只在 `%TEMP%`
- 记号：**【源码】**= 读到的上游/本仓源码；**【实测】**= 本机跑出的读数；
  **【推断】**= 由源码+实测推出但未单独验证；**【未验证】**= 没做
- 一句话结论：**【实测】能 —— 本仓 `pty_*` / `ssh_*` / `shell_open` 在 PTC 下与官方
  `terminal_*` 等价可用，且无需补任何元数据**（§0 结论、§4 读数）

---

## 0. 一句话结论

**【实测】能，且无需补任何元数据**：在 `DSH_TOOLS_MODE=ptc` 下，本仓 `./pty`
（`pty_open/pty_send/pty_tail/pty_close` + `ssh_start/ssh_send/ssh_tail/ssh_close`）与
`./terminal`（`shell_open`）全部出现在 `tools:sdk` 的 `ToolArgsMap`/`ToolOutputMap` 里，
并被同一 `run_code` 程序成功派发执行（真实 ConPTY 输出 + 真实 sessionId）；
与官方 `terminal_open/terminal_close` 在同一程序内对照，行为等价。

> **重要更正**：任务背景称本仓工具「**没有**定义 `output.schema`」——**与源码不符**。
> 本仓每个工具都声明了 `output.schema` + `output.render`（见 §3 逐行证据）。
> 本仓真正缺的只有 `presentationMeta` / `presentResult`（纯展示面），
> 而这两者对 PTC 可用性**无影响**。

---

## 1. 规则（源码级）

### 1.1 PTC 把哪些已注册工具渲染进 SDK

**【源码】`<host>/packages/core/tools/src/index.ts:1273-1287`**

```ts
  /** Project visible callable tools onto the generated PTC mode SDK contract. */
  private sdkSchemas(scope?: ScopeKey): ToolSdkSchema[] {
    return [...this.view(scope).visible.values()]
      .filter(definition => definition.name !== RUN_CODE_NAME)
      .map((definition): ToolSdkSchema => {
        const output = snapshotJsonValue(definition.output.schema)
        /* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
        if (output === undefined) {
          throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`)
        }
        return {
          ...this.schemaOf(definition, true),
          output,
        }
      })
  }
```

**【源码】`index.ts:1289-1302`（`schemaOf` 只取四个字段）**

```ts
  private schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
    const { name, description, parameters, deferLoading } = definition
```

**【源码】`ts-types.ts:312-333`（实际拼文本：只读 `parameters` 与 `output`）**

```ts
export function renderToolsSdk(schemas: ToolSdkSchema[], programFormat: 'function-body' | 'repl' = 'function-body'): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const argsMembers: string[] = []
  const outputMembers: string[] = []
  for (const schema of sorted) {
    argsMembers.push(...docLines(schema.description, 1))
    argsMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`)
    outputMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`)
  }
```

**⇒ 渲染集合 = 调用该 agent 的可见集（全局层 ∪ 该 agent 作用域层，再经 `restrict()` 求交），
减去 `run_code`。判据只有四样：`name` / `description` / `parameters` / `output.schema`。
`presentationMeta`、`presentCall`、`presentResult`、`ctx.jobs` 一律**不参与**。**

### 1.2 派发侧用同一集合（所以"渲染了"就等于"能调"）

**【源码】`ptc.ts:686-694`**

```ts
        const functions: Record<string, PtcBindingFunction> = Object.create(null) as Record<string, PtcBindingFunction>
        // Enumerate the CALLING AGENT's visible set (scoped tools join,
        // restricted globals vanish) — the same view the SDK section declared,
        // so a program can bind exactly what its prompt promised; sub-dispatch
        // re-resolves per call through the same view (exec.agent threads down).
        for (const schema of registry.schemas(exec.agent)) {
          if (schema.name === RUN_CODE_NAME) continue
          Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(deepFreeze(schema)) })
        }
```

**【源码】`index.ts:1268-1270`** `schemas(scope)` 与 `sdkSchemas` 同源于 `this.view(scope).visible`。

### 1.3 注册期硬性门槛（缺什么会怎样）

**【源码】`index.ts:1071-1096`**

```ts
  register(definition: ToolDefinition): () => void {
    const name = definition.name
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    assertSupportedJsonSchema(output.schema)
    ...
    if (name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`)
    }
```

- **缺 `output` 或缺 `render`** ⇒ `register()` 抛 `TypeError`（行 1077）：插件行挂载期**响亮失败**，
  工具压根不存在 —— 是"装不上"，**不是**"被排除出 SDK"。
- **缺 / 非法 `output.schema`** ⇒ `assertSupportedJsonSchema(output.schema)`（行 1079）或其上游
  `defineTool` 的编译期检查先抛。

**【源码】`schema.ts:554-578`（`defineTool` 编译期就把 `output.schema` 转成 raw JSON Schema）**

```ts
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema)
```

**【源码】`schema.ts:438-442`** → `compileValueSchema(spec,'schema')` + `assertSupportedJsonSchema(schema)`。

**【源码】`json-schema.ts:257-267`（白名单关键字，其余一律违规）**

```ts
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue
      if (ANNOTATION_KEYWORDS.has(key)) { ... continue }
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
    }
```

- **"渲染成 unknown"** 只可能发生在**绕过 `register()`** 的 schema 上：
  `ts-types.ts:240-247` 的 `jsonSchemaToTs` 对非法输入 `catch { return 'unknown' }`。
  凡经 `ctx.tools.register` 的工具都已被 `assertSupportedJsonSchema` 拦过，**走不到**这条。
- **"提示词汇编失败"** 与工具元数据无关，只由两件事触发：
  **【源码】`index.ts:1053-1062`**

```ts
  private requirePtcRuntime(mode: ToolPresentationMode): PtcRuntime {
    const runtime = this.ctx.get('ptcRuntime')
    if (!runtime) {
      throw new Error(`dsh-tools: mode "${mode}" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or set tools mode to "native"`)
    }
    if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) { ... }
```

- **"被排除"** 只有一条路：该 agent 的可见集里没有它（未注册 / 作用域不符 / `restrict()` deny）。
- **非 native 模式下模型直接点名其它工具也一律 `UNKNOWN_TOOL`**（这是 PTC collapse 的语义，不是排除）：
  **【源码】`index.ts:1032-1036`**

```ts
    this.requirePtcRuntime(mode)
    const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
    return {
      schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME),
      knownNames: [RUN_CODE_NAME],
    }
```

  **【源码】`index.ts:1359-1361`** `collapses()`：`!nested && modeFor(scope)==='ptc' && name !== RUN_CODE_NAME`。

### 1.4 `presentationMeta` 是纯展示（PTC 路径也只用它填日志）

**【源码】`index.ts:1852-1861`**（可选、有 guard）与 **`ptc.ts:580-600`**（只写进 `tool/ptc-dispatch` 事件）。

**【实测/源码】`ToolDefinition` **没有** `presentation` 这个字段**：在 `index.ts` / `types.ts` 里
grep `presentation?:` **0 命中**。任务里说的 "`presentation: 'ptc'`" 实际是
agent preset 里的 loader 行 `@deepseek-ai/dsh-agent-tool-presentation` 的 `config.mode`
（见 `<host>/packages/bundle/web-app/presets/ptc.patch.yml:124-126`），与单个工具的元数据无关。

### 1.5 `required` 的写法（本仓 `output.schema` 里 property 级 `required: true` 合法）

**【源码】`schema.ts:290-303`**

```ts
    if (task.kind === 'property') {
      if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`)
      if (Object.hasOwn(task.property, 'required') && task.property.required !== true) {
        authorError(`${task.path}.required must be true when present`)
      }
      if (Object.hasOwn(task.property, 'required') && task.property.required === true) task.required.push(task.key)
      tasks.push({ kind: 'value', input: task.property, path: task.path, allowRequired: true, destination: { kind: 'property', target: task.properties, key: task.key } })
```

**【源码】`schema.ts:283-288`** 把这些 key 上抬成对象级 `required: [...]`。
⇒ 本仓 `output.schema.properties.sessionId.required === true` 会被编译成标准
`{type:'object', required:['sessionId'], ...}`，`assertSupportedJsonSchema` 全过。
**这就是为什么它既能装、又能渲染出非可选的 `sessionId: string`**（见 §4.3 实测原文）。

---

## 2. 本仓 vs 官方 `tool-terminal` 逐项对照

官方源码：`<host>/packages/experimental/tool-terminal/src/index.ts`。

| 维度 | 本仓 `./pty` / `./terminal` / `./wsl` | 官方 `tool-terminal` | 影响 PTC？ |
|---|---|---|---|
| 注册方式 | `ctx.tools.register(defineTool({...}))` | 同 | **否**（两者走同一管线） |
| `parameters` | schemastery 风格对象 spec，property 级 `required: true` | 同 | **否** |
| `output.schema` | **有**：pty 4 工具 `index.ts:163-175/191-201/217-228/242-251` 与 ssh 4 工具 `441-453/470-480/496-507/521-530`、`shell_open` `terminal/index.ts:151-169`、wsl 7 工具 `wsl-plugin/index.ts:138/181/205/232/270/283/297` | 有（`additionalProperties:false`，如 `SESSION_SNAPSHOT_SCHEMA` L105-109） | **否** |
| `output.render` | 有（`jsonRender` / 自定义文本） | 有 | **否** |
| `presentationMeta` | **无** | 仅 `terminal_send`（L242-249） | **否**（纯 UI；PTC 仅记日志） |
| `presentCall` | 有（`card:'terminal'` / `card:'generic'`） | 有 | **否** |
| `presentResult` | **无** | 仅 `terminal_send`（L299-303） | **否** |
| `ctx.jobs` / `run_in_background` | 无（等价物：`autoClose`、`idleTimeoutMs`） | 有（`jobs.start`，`kind:'pty-send'`，L255-283） | **否**（能力差异，非 PTC） |
| `finalizeContent`（结果字节上限） | 无 | 有（`maxResultBytes`，L155-158） | **否** |
| 工具名 | `pty_open` / `shell_open` / `ssh_*` / `win_*`：合法标识符 | `terminal_*`：合法标识符 | **否**；且 `ts-types.ts:22-24` 对非标识符名会加引号（`tools["my-tool"]`），不会因此消失 |
| 注册上下文 | bundle patch 根层（全局行）：本仓 `cordis.patch.yml:14-21` | 官方在 `minimal` preset 的 `isolate:{terminals:true}` 组内 | **否**（决定"在哪个 profile 挂得起来"） |
| inject | `./pty`: `['tools']`；`./terminal`: `['tools','pty']` | `['terminals','tools','systemPrompt','workingDirectory']`（L30） | **否**；但 web-app 默认**不挂** `terminals` seam，所以默认 profile 里官方 `terminal_*` 根本不注册（§4.2 实测） |

**结论：所有会被 PTC 用到的字段（`parameters` / `output.schema`）两者齐备；
所有差异都在纯展示（`presentationMeta`/`presentResult`/`finalizeContent`）或能力面（`jobs`/`run_in_background`）。**

---

## 3. 实证

### 3.0 环境与命令（全部在 `%TEMP%\sh116-ptc\`）

```
# 安装（官方两步，临时 profile）
node --import tsx/esm apps/cli/src/bin.ts --profile sh116ptc --from-default-profile web --dump-config
node --import tsx/esm apps/cli/src/bin.ts plugin --profile sh116ptc add <plugin-dir>
# 起实例（cwd = <host>，PATH 前置 pnpm shim 目录）
DSH_HOME=<temp>\.dsh  DSH_TOOLS_MODE=ptc  DEEPSEEK_BASE_URL=http://127.0.0.1:<mock>  DEEPSEEK_API_KEY=mock-key-nonempty
node --import tsx/esm apps/cli/src/bin.ts --profile sh116ptc --no-open --port 0
# 然后 RPC: session/create({request:{cwd}}) → session/prompt({content:[{type:'text',...}]})
```

安装读数：`bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-shell-host"]`、
`dependencies["dsh-shell-host"]="link:<plugin-dir>"`、`linked=true`、
`dump-config` 含 `dsh-shell-host/pty` 与 `dsh-shell-host/terminal` 与 `ptc-runtime` 行。
插件实际解析到 `@deepseek-ai/dsh-tools@0.2.1-rc.2`（发布产物内同样有
`must declare output { schema, render, presentationMeta? }` 与
`output schema must be lossless JSON before SDK projection`，与源码一致）。

### 3.1 run1：纯本仓（`DSH_TOOLS_MODE=ptc`）

```
### session/create status=200 sessionId=session-... agentPreset="standard"
### request[0] tool names: ["run_code"]
### system prompt bytes: 52794
  contains pty_open: true      contains shell_open: true
  contains pty_send: true      contains pty_tail: true      contains pty_close: true
  contains ssh_start: true     contains run_code: true      contains terminal_open: false
  contains ToolArgsMap: true   contains ToolOutputMap: true
### sdk fence captured: 45454 bytes
### tool_result is_error=true present: false
### nested PTY output marker "ptc-nested-ok" in result: true
### instance stderr bytes: 183 / stderr blames repo rows: false / dsh-shell-host: false
   （183B 全是 node 的 ExperimentalWarning: stripTypeScriptTypes）
```

`run_code` 里执行的程序（mock 模型发出的 `tool_use`）：

```ts
const out = {}
try {
  const a = await tools.pty_open({ command: 'cmd.exe /c echo ptc-nested-ok', autoClose: true })
  out.pty_open = { sessionId: a.sessionId, initialOutput: a.initialOutput }
} catch (e) { out.pty_open_error = String((e && e.message) || e) }
try {
  const b = await tools.shell_open({ preset: 'pwsh' })
  out.shell_open = { sessionId: b.sessionId, preset: b.preset, transport: b.transport, command: b.command, source: b.source }
  try { out.pty_close = { closed: (await tools.pty_close({ id: b.sessionId })).closed } }
  catch (e) { out.pty_close_error = String((e && e.message) || e) }
} catch (e) { out.shell_open_error = String((e && e.message) || e) }
return out
```

回灌的 `tool_result` 原文（`is_error: false`）：

```json
"{\n  \"pty_open\": {\n    \"sessionId\": \"pty-1\",\n    \"initialOutput\": \"\\u001b[?9001h...\\u001b[Hptc-nested-ok\\n\"\n  },\n  \"shell_open\": {\n    \"sessionId\": \"pty-2\",\n    \"preset\": \"pwsh\",\n    \"transport\": \"local\",\n    \"command\": \"%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe -l -noexit\",\n    \"source\": \"builtin\"\n  },\n  \"pty_close\": {\n    \"closed\": true\n  }\n}\nFile sandbox enforcement is partial on this host."
```

⇒ **本仓工具在 PTC 下真的被调用了**：真 ConPTY 回显、真 sessionId、真关闭。
（`autoClose: true` 是默认推荐路径；`env`/`idleTimeoutMs` 未在本轮覆盖。）

### 3.2 run2：本仓 + 官方同请求对照

临时 profile patch 追加（仅 `%TEMP%`）：

```yaml
- insert:
    - id: sh116-terminal-seam
      name: '@deepseek-ai/dsh-terminal'
    - id: sh116-terminal-pwsh
      name: '@deepseek-ai/dsh-terminal-bash'
      config: { shellDialect: pwsh, timeoutMs: 300000 }
    - id: sh116-tool-terminal
      name: '@deepseek-ai/dsh-tool-terminal'
```

`--dump-config` 三行都在、**无** `waiting for service` / `Missing services`。读数：

```
### system prompt bytes: 56498    contains terminal_open: true
### request[0] tool names: ["run_code"]
### tool_result is_error=true present: false
### nested PTY output marker "ptc-nested-ok" in result: true
### instance stderr bytes: 182（同样只有 ExperimentalWarning）
```

同一 `run_code` 程序的返回值（官方段追加）：

```json
  "terminal_open": { "sessionId": "pty-1", "type": "shell",
                     "status": { "kind": "running" },
                     "motd": "PS %USERPROFILE%\\AppData\\Local\\Temp\\sh116-ptc\\run1> ..." },
  "terminal_close": { "sessionId": "pty-1", "outcome": "closed" }
```

结果文本里 **不存在** `pty_open_error` / `shell_open_error` / `pty_close_error` /
`terminal_open_error` / `terminal_close_error` 任何一个键。

### 3.3 SDK 原文（run1 摘录，证明 `output.schema` 真的渲染出来了）

```
interface ToolArgsMap {
  pty_open: {
    /** Command to run on the PTY after spawn (env vars, if any, are injected into the spawned process). */
    command: string;
    /** Optional initial working directory. */
    cwd?: string;
    ...
  pty_close: { /** Session id from pty_open. */ id: string; };
  shell_open: { /** Launcher preset id (built-in view or configured custom preset). */ preset: string; ... };
}

interface ToolOutputMap {
  pty_open: {
    /** Opaque session id for send/tail/close. */
    sessionId: string;
    /** Top-level process id when the backend exposes one. */
    pid?: number;
    /** Top-level process status at publication. */
    status?: Record<string, JsonValue>;
    /** Output captured during spawn/command start. */
    initialOutput?: string;
  } & Record<string, JsonValue>;
  pty_close: { /** Whether this call newly closed the session. */ closed: boolean } & Record<string, JsonValue>;
  shell_open: { sessionId: string; preset: string; transport: string; command: string; ... };
}
```

`& Record<string, JsonValue>` 来自本仓声明的 `additionalProperties: true`
（`ts-types.ts:169-171`），`sessionId: string` 非可选来自 property 级 `required: true` 的上抬。
**这一切只有在 `output.schema` 存在时才可能出现** ⇒ 反证背景描述有误。

run2 里官方侧的对应渲染（同一请求、同一格式）：

```
  terminal_open: { ... sessionId: string; type: string; status: {kind:"running"}|{kind:"exited";exitCode:number|null;signal:string|null}; motd: string; };
  terminal_close: { sessionId: string; outcome: "closed" | "already-closing" };
  terminal_list: Record<string, JsonValue>;   // parameters: {} → 开放 Record
```

两族在同一 `ToolArgsMap`/`ToolOutputMap` 内被同等对待，无任何官方特权路径。

### 3.4 卡点检查（逐条排除）

| 可能卡点 | 结论 | 依据 |
|---|---|---|
| 缺 ptc preset | 未卡：用 `DSH_TOOLS_MODE=ptc`（web-app `cordis.patch.yml:32-38` 的 env 缝）全局开 PTC | 【实测】`request[0].tools=["run_code"]` |
| 缺渲染器 | 未卡：`language='typescript'`、`programFormat='function-body'`，`SDK_RENDERERS.typescript` 命中 | 【源码】`ptc-runtime-node/src/index.ts:40,45`；【实测】SDK fence 45KB |
| 工具不可见 | 未卡：`./pty`+`./terminal` 两行挂载、`standard` preset 无 `restrict()` deny | 【实测】SDK 含 8 个本仓工具名 |
| 权限/审批 | 未卡：`pty_open`/`shell_open` 无审批门；实例 stderr 干净 | 【实测】stderr 183B 仅 node warning |
| 本仓工具缺元数据导致失败 | **不成立**：工具是**有** `output.schema` 的；PS §1.3 门槛全过 | 【源码】+【实测】§3.3 |

---

## 4. 结论与建议

### 4.1 结论：**能（无条件）**

PTC 可用性的充分必要条件是「已注册 + 对该 agent 可见 + `output.render` 与合法 `output.schema`」。
本仓工具**全部满足**，且与官方 `terminal_*` 走完全相同的渲染与派发路径。
不存在"因为缺 `presentationMeta`/`presentation` 而不进 SDK"的机制。

### 4.2 差距清单（按优先级，**不建议为 PTC 改任何代码**）

| 优先级 | 差距 | 性质 | 建议 |
|---|---|---|---|
| — | PTC 可用性 | 零差距 | **不改** |
| P1 | 无 `presentationMeta` | 纯展示：PTC 嵌套调用的 `result.meta` 恒为空，Web 卡片在 PTC 会话里只能走 content 文本 | 可选：给 `pty_send/pty_tail`（`delta`/`status`）与 `shell_open`（`preset`/`executable`/`probed`）补 projector，收益是 UI 卡片质量，**与 PTC 可用性无关** |
| P1 | 无 `presentResult` | 同上（官方仅 `terminal_send` 有） | 可选 |
| P2 | 无 `run_in_background` / `ctx.jobs` | 能力面差异；本仓以 `autoClose` / `idleTimeoutMs` 覆盖部分语义 | 依 ADR-0013 现状**不动** |
| P2 | 文档口径 | 本仓 `GLOSSARY.md` / `docs/` 没有一条写明"PTC 可用性由 `register()`+`output.schema` 决定，`presentationMeta` 纯展示" | 建议加一句结论，防止后人误判 |
| P2 | `./wsl` entry | 【#143 改判，2026-10-19 human 裁决】随 bundle 挂载但默认 `disabled: true`（本行快照记录的是 #143 前的「不挂」状态）——默认下 `win_*` 仍不出现，开启 = profile patch 覆盖该行后重启（README *The `./wsl` entry*） | 已随 #143 落实 |

### 4.3 未确证面

- **【未验证】** 真实（非 mock）模型在 PTC 下自主写程序调本仓工具的行为；本轮模型是 mock，程序是固定文本。
- **【未验证】** agent preset `ptc`（`presets/ptc.patch.yml`）这条**按会话选择**的路径，以及
  `tools.presentAs('ptc')` 的运行期切换；本轮只用了 `DSH_TOOLS_MODE=ptc` 全局默认。
- **【未验证】** python SDK 渲染（本机只挂 node runtime，`language='typescript'`）；
  `py-types.ts` 只做了源码阅读。
- **【未验证】** `restrict({deny:[...]})` 后工具从 SDK 消失的行为（仅源码推断）。
- **【未验证】** `./wsl` 的 `win_*` 在 PTC 下的实际调用（未挂载该 entry；仅推断"挂上就会渲染"）。
- **【未验证】** `pty_open` 的 `env` / `idleTimeoutMs` / `pty_send` / `pty_tail` / `ssh_*` 在
  PTC 嵌套派发下的行为（本轮只覆盖 `pty_open`/`shell_open`/`pty_close`）。
- **【推断】** 发布版 `@deepseek-ai/dsh-tools@0.2.1-rc.2` 与 `<host>` 源码树同源（同 tag）；
  本文引用的行号取自 `<host>` 源码树，发布产物只做了关键字符串比对。

---

## 附：产物清单（全部在 `%TEMP%\sh116-ptc\`）

- `stage-a.mjs` / `stage-b.mjs`：实验脚本
- `run1/stage-b-out.txt`、`run1/sdk-section.txt`、`run1/system-prompt-1.txt`、
  `run1/request-1.json`、`run1/request-with-tool-result.json`、`run1/tool-result-blocks.json`（run1 原始读数）
- `run1-evidence/`：run1 证据归档副本
- `run1/dump-ptc2.txt`、`run1/stage-a2-out.txt`：run2 profile 的安装/组合读数
- `run2-out/stage-b-out.txt`、`run2-out/sdk-section.txt`、`run2-out/tool-result-blocks.json`（run2 原始读数）
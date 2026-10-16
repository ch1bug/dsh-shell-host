# TESTING.md — dsh-shell-host 验证分层与证据纪律

> 与相邻工作区（matt 工作流，`<sibling-repo>/tests/`）**同步对齐**的口径
> （2026-10-16）。两边规则同构，便于跨工作区互读证据。

## TEST SCOPE TIERING（选最小能证明当前改动的档，并在票的 evidence 行点名）

| 档 | 范围 | 何时用 |
|---|---|---|
| **① minimal relevant** | 触及改动的单个测试文件 / target | 迭代时 |
| **② single-module** | 该模块/包自己的套件 | 改动局限在单模块内 |
| **③ full high-risk suite** | 完整 verify 集（+ e2e） | 票关闭时；以及改动触及**高危面** |

本仓高危面：**loader 行 / 组合树 / 入口导出（pty·terminal·wsl）/ 原生件路径 /
依赖锚（peer、RC 锚）**。

## 证据纪律（硬规则）

- **声明你未跑的，是证据的一部分，绝不是证据的替代。**
  跳过必须显式写成 `not run locally: X`。
- **响亮跳过（loud skip）**：门禁未满足时**必须打印 `!! SKIP (loud)` 并说明缺什么**，
  绝不静默当 pass。
- **证据必须点名层级**（mock 层 / 真实层），因为两层能证明的东西**不同**。

## 分层：mock 层 vs 真实层

| 层面 | mock 层**能**证明 | mock 层**不能**证明 |
|---|---|---|
| 本仓（harness） | 真实实例启动、真实组合树、真实建会话、真实发出的请求字节、真实工具执行（含真实 PTY 子进程） | — |
| agent 循环 | 真实 `tool_use` → 真实工具执行 → `tool_result` 回灌 | — |
| 供应商侧 | ❌ | 真实端点是否接受（鉴权 / 模型名 / 提示词长度上限 / 字段兼容 / 流式格式差异） |
| 真实模型行为 | ❌ | 模型是否真按预期发起工具调用（注入有效性） |
| 真实工具面 | ❌ | `shell_open` 等**受审批门**工具的审批/沙箱路径（mock 层刻意挑免审批工具，只证"工具面被打通"） |
| 鉴权 | ❌ | mock 层塞的是假 key |

**结论：mock 绿 ≠ 真实调用没问题。**

## 失败归因断言（**最重要的一条**）

允许"环境性失败"存在，但**失败信息绝不能点名本仓新增的行/工具**——
把「环境缺失」与「我的缺陷」机械区分开：

```js
const MY_ROWS = ['pty', 'terminal']            // 本仓新增的 loader 行
const blamed = MY_ROWS.filter(row => message.includes(row))
if (blamed.length === 0) ok('失败只指向 harness 缺失的服务')
else bad('失败归咎于本仓新增行', blamed.join(', '))
```

**为什么必须有**：只写 `package.json` 注册记录而不真安装时，loader 会
`skipping profile bundle: cannot resolve`，但**实例照样起得来、会话照样建得成**——
此时任何"请求里出现 `pty_open`"的断言都会**假绿**（那字符串可能是测试自己塞的）。

### 工具面断言的正确写法

必须断言 **实例真实请求体里的 `tools` 数组**含有本仓工具，
**不能**断言"请求文本里出现过工具名"（后者会把 mock 自己发的 `tool_use` 当成证据）：

```js
const declaredTools = firstBody.tools ?? []
const names = declaredTools.map(t => t.name)
check('实例的 tools 数组含 pty_open', names.includes('pty_open'))
```

## 真实层门禁（opt-in）

两条凭据路线**二选一**，未满足则**响亮跳过**：

- `DEEPSEEK_API_KEY` —— 真 key，仅经 env 传给被测实例，**不落文件**
- `DSH_*_REAL_CREDENTIALS_SOURCE` —— 含 `deepseek-account-platform/*` 记录的
  credentials.yaml 路径；**只读**取出该前缀记录写入临时 home，跑完随临时目录删除

隔离：临时 `DSH_HOME`（`os.tmpdir`）+ `--port 0`，**不占用任何固定端口**
（19387 桌面 / 19501 隔壁 / 19502 本区常驻实例）。

## 隔离契约（三实例）

| 项 | 桌面 GUI | 隔壁（matt） | **本区（shell-host）** |
|---|---|---|---|
| DSH_HOME | `C:\Users/<user>\.dsh` | `/home/<user>/dsh-matt-home` | `/home/<user>/dsh-shellhost-home` |
| profile | `desktop` | `matt-dev` | `dsh-host-dev` |
| 宿主源码树 | 安装版 | `dsh-matt-src` | `dsh-host-src` |
| 端口 | 19387 | 19501 | 19502 |

**宿主锚点统一 = `dsh-v0.2.0-rc.2`（`639ed015`）**，ADR-0008 口径。

## 权威工作树 vs 部署副本（**提交只在权威树**）

**权威工作树 = `<repo>`（本仓库）。** 任何 msys2 侧的源码树
（如 `/home/<user>/dsh-shellhost-src`）都是**只读部署副本**。

| 动作 | 位置 |
|---|---|
| 改代码 / `git add` / `git commit` / `git push` | ✅ **只在 `<repo>`** |
| 跑实例、跑 B1 构建（原生件走 Windows node）、部署验证 | 部署副本 |
| 临时探针脚本（未跟踪、不提交） | 部署副本 |

**实测教训（2026-10-16）**：为搭 msys2 部署环境建克隆后，顺手**在克隆里开发并提交**，
结果出现「两个都叫 `main`、内容不同」的仓库，权威树落后 3 个提交；又叠加
`git checkout <sha>` 造成的 detached HEAD，需 `merge --ff-only` 补救。
**根因是把"部署副本"和"开发工作树"混为一个。**

**两边的 `main` 必须同提交。** 不同即说明有人又在副本里提交了 —— 停下核对：

```bash
git -C <repo> rev-parse HEAD
git -C /c/msys64/home/<user>/dsh-shellhost-src rev-parse HEAD   # 必须相同
```

副本同步（单向，权威 → 副本）：

```bash
git -C /c/msys64/home/<user>/dsh-shellhost-src fetch <repo> main
git -C /c/msys64/home/<user>/dsh-shellhost-src merge --ff-only FETCH_HEAD
```

> 宿主的 tag 锚点（`dsh-v0.2.0-rc.2`）**只切在宿主源码树** `dsh-host-src`；
> **插件仓库不要 checkout tag** —— 本仓 `main` 就是工作线，切 tag 只会制造
> detached HEAD。

## 实测踩坑（写进规则，避免重复踩）

1. **tsdown tsconfig 路径双拼**（msys2 下）：`D:\x/D:\x\tsconfig.json` → 见 #80
2. **rolldown 在 ucrt64 node 下要 `win32-x64-gnu`**（npm 无此包）→ 构建走 Windows node，见 #81
3. **`@deepseek-ai/dsh-tools` 的 10 个 peer 必须显式声明**，否则 clean checkout 装不上也测不了 → 见 #82
4. **切 tag 后必须清理构建产物**：`lib/` 被 gitignore，`git status` 干净但残留旧产物 →
   构建报 `MISSING_EXPORT "principalOf"`（该符号只存在于 alpha 源码）。用 `git clean -fxd`。
5. **typert RPC 参数名逐方法不同，共三种形态**：
   - 带 `request` 形参的方法（`create` / `prompt` / `selectModel` / `page` / `projections`）→ `payload.args.request`
   - `list` → `payload.args._request`
   - `modelCatalog` → **纯空 `{}`**（传 `_request` 报 `unexpected "_request"`，传 `request` 也报错）

   猜错一律 `gateway/arguments-invalid`。无参方法建议**自动纠正**（先 `{}` 再 `_request`）。
6. **实例会另发"会话标题"轻量请求**：抓 agent 主请求要按 `tools.length > 0` 过滤，
   不能取 `captured[0]`。
7. **kill 实例后必须等子进程退出**（`SIGTERM` → await exit → `SIGKILL` 兜底），
   否则 libuv 断言噪音 + ECONNRESET 污染输出。预期 ECONNRESET 应静音。
8. **`pty_open` 必填 `command`**（在 PTY 上 spawn 的命令）；**`shell_open` 必填 `preset`**
   （launcher preset id）。混淆会得到 `missing required property "command"`。
9. **RC 锚点与 alpha 的接口差异**（切锚时必查）：RC2 **没有** `initializeDefaultModel`
   （alpha 才有）；RC2 的 `dsh-tools` peer 集与 alpha **不同**（多 `dsh-invariants`，
   `cordis`/`schemastery` 区间也不同）。照 alpha 抄 peer 会漏声明。
10. **凭据必须与路由配对**：账号记录配 `deepseek-account`，`DEEPSEEK_API_KEY` 配
    `deepseek-official`。配错是**静默失败**（`turn/end` 正常、stderr 空、`usage=0`）。

## 本仓现有验证入口

| 入口 | 层 | 覆盖 | 门禁 |
|---|---|---|---|
| `pnpm test` | ①②③ | typecheck + unit + machine（本仓常规套件） | 无 |
| `tests/e2e-tool-call-machine.spec.ts` | **mock 层** | 安装（注册记录 + 真实链接）→ 配置（组合树含两行、无 pending）→ 启动（真实 `dsh web`，OS 临时端口，stderr 干净）→ `session/create` → `prompt` → mock provider 要求 `pty_open` → 实例执行 → `tool_result` 回灌 | 插件树 + 宿主树（缺失则响亮跳过） |
| `tests/e2e-real-llm-machine.spec.ts` | **真实层**（opt-in） | 同一链路打**真实端点**：供应商接受（计费 usage）、真实模型行为、真实凭据路径 | 上述 + `DEEPSEEK_API_KEY` 或含 `deepseek-account-platform/*` 的凭据源（缺失则响亮跳过） |

两个 e2e 套件都在 **machine 车道**（串行，`fileParallelism` off），隔离用临时
`DSH_HOME`（`os.tmpdir`）+ `--port 0`，**不占任何固定端口**（19387 / 19501 / 19502）。

可选 env：`DSH_E2E_PLUGIN_DIR` / `DSH_E2E_HOST_DIR` / `DSH_E2E_NODE`（两套件），
`DSH_E2E_REAL_CREDENTIALS_SOURCE` / `DSH_E2E_REAL_PROVIDER` / `DSH_E2E_REAL_MODEL` /
`DSH_E2E_REAL_PROMPT`（真实层）。

### 真实层凭据与路由必须配对（实测静默失败）

持有**账号记录**却把会话路由到 **api-key** provider 时，实例**不报错**：
`turn/end` 正常落、stderr 为空、`usage=0`，唯一痕迹是会话事件里一条

```
assistant/attempt → finish → { code: "MISSING_CREDENTIAL" }
```

故真实层显式断言两条：`usage > 0` 且 **`assistant/attempt` 无 failure**；
账号路线还额外断言选中的 provider 是 `deepseek-account`（非 `deepseek-official`）。

### 模型路由必须在 prompt 之前显式选择

`session/create` 后必须 `session/modelCatalog` → `session/selectModel` → 再 `prompt`。
跳过或乱序的形态：turn 不起、会话文件只有 header、stderr 空。

### 会话证据只走 RPC，不读会话文件

`session/list` 的 `projections`（含 `asOfSeq` 游标）与 `session/page`
（`address = {kind:'session',sessionId}`，`throughSeq` 取 `asOfSeq`）。
**不要**读 `session.v4.jsonl.zstd`：事件批量落盘，**成功的 turn 也可能只留 header**，
据此判断会得到"turn 没跑成"的假红。同理 `llmMs` / `toolMs` 在本宿主上**可能为 0
而 turn 已完成**——计费证据看 `tokenUsage`，执行证据看 `tool/result` 事件。
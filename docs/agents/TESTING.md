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
- **验收口径的套件必须在最后一次写入之后起跑**（`node --run test` / `test:release`）：
  跑完 `git diff` 为空（或起跑前后文件 hash 一致）才采信输出。跑着的时候改文件 =
  跑的那份不是要交付的那份，只能重跑 —— 2026-10-16 实测踩过一次（多烧一轮全量套件）。

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

### e2e 的安装必须走官方命令

规则与理由（为何 ① 不能省、为何手工 symlink 不算安装）见
[profile-install.md](profile-install.md)。测试里只多两条自有约定：

- **断言"装好了"要看三处**：`dsh.profile.bundles` 含插件名、`dependencies` 有该
  条目、`node_modules/<pkg>/package.json` 存在。只看一条会漏掉"注册了但没装"的
  假绿形态。
- **用共享挂具** `tests/helpers/e2e-install.ts`（三个 e2e 套件共用：安装流程、
  host env 组装、loud-skip 门禁、装箱面），不要在 spec 里各写一套。

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

## 权威工作树 vs 部署副本

**提交只在权威工作树 `<repo>`**；任何 msys2 侧检出都是只读部署副本。
分工表、同步命令、`core.autocrlf` 对齐与实测教训见
[dev-environment.md](../dev-environment.md) §0（**唯一来源**）。

测试相关的两条推论：

- **e2e 用临时 DSH_HOME**（`os.tmpdir` + `--port 0`），不碰常驻实例，也不碰副本的
  profile —— 所以跑测试不需要先同步副本。
- **副本不同步就跑 e2e** 会测到旧代码：`tests/` 与 `lib/` 都来自副本自己的树。
  跑 e2e 前先确认两边 `main` 同提交。

## 写测试时会踩的坑

**领域事实**（RC/alpha 接口差异、typert RPC 参数名三种形态、会话证据只走 RPC、
凭据与路由配对）→ 见 [GLOSSARY.md](../../GLOSSARY.md) 的「#82 RC 锚 vs alpha 的
宿主接口差异」。此处不重复，只记**测试自身**会踩的：

1. **安装必须走官方两步命令**，且**第 ① 步不能省**（否则实例启动毫无输出）。
   见上文「e2e 的安装必须走官方命令」。
2. **实例会另发"会话标题"轻量请求**：抓 agent 主请求要按 `tools.length > 0` 过滤，
   不能取 `captured[0]` —— 取错会把标题请求当第 1 轮（假红）。
3. **kill 实例后必须等子进程退出**（`SIGTERM` → await exit → `SIGKILL` 兜底），
   否则 libuv 断言噪音 + ECONNRESET 污染输出。预期 ECONNRESET 应静音。
4. **`pty_open` 必填 `command`**（在 PTY 上 spawn 的命令）；**`shell_open` 必填 `preset`**
   （launcher preset id）。混淆会得到 `missing required property "command"`
   —— 这是**测试传错参**，不是插件缺陷。
5. **无参 RPC 方法建议自动纠正参数名**（先 `{}` 再 `_request`），别把信封琐事
   变成用例失败。
6. **构建期限制**（tsdown 路径双拼、rolldown 需 Windows node）见
   [#80](https://github.com/ch1bug/dsh-shell-host/issues/80) /
   [#81](https://github.com/ch1bug/dsh-shell-host/issues/81) 与
   [dev-environment.md](../dev-environment.md) §4。

## 本仓现有验证入口

| 入口 | 层 | 覆盖 | 门禁 |
|---|---|---|---|
| `node --run test` | ①②③ | typecheck + unit + machine（本仓常规套件） | 无 |
| `tests/doc-references.spec.ts` | ①② | 引用腐烂：注释里的仓内路径必须存在；本仓脚本一律写 `node --run`（历史提及在该注释/该行标 `[History: …]`） | 无 |
| `tests/e2e-tool-call-machine.spec.ts` | **mock 层** | 官方安装（`--from-default-profile` + `dsh plugin add` 源目录）→ 配置（组合树含两行、无 pending）→ 启动（真实 `dsh web`，OS 临时端口，stderr 干净）→ `session/create` → `prompt` → mock provider 要求 `pty_open` → 实例执行 → `tool_result` 回灌 | 插件树 + 宿主树 + pnpm shim（缺失则响亮跳过） |
| `tests/e2e-tarball-machine.spec.ts` | **mock 层（装箱交付，#89）** | **同一条链，起点换成现场 `npm pack` 的 tarball**：环 1 打包并断言**产物**里有 `cordis.patch.yml`（#88 的运行期版本）→ 环 2 官方安装且注册记录指向 `.tgz`（不是源目录）→ 环 3–5 同上；目录安装不经过 `files`，所以这条链是唯一能看到打包漏项的那条 | 上述 + 插件树有 `cordis.patch.yml` + 本机有可用打包器（缺失则响亮跳过） |
| `tests/e2e-real-llm-machine.spec.ts` | **真实层**（opt-in） | 同一链路打**真实端点**：供应商接受（计费 usage）、真实模型行为、真实凭据路径 | 上述 + `DEEPSEEK_API_KEY` 或含 `deepseek-account-platform/*` 的凭据源（缺失则响亮跳过） |

三个 e2e 套件都在 **machine 车道**（串行，`fileParallelism` off），隔离用临时
`DSH_HOME`（`os.tmpdir`）+ `--port 0`，**不占任何固定端口**（19387 / 19501 / 19502）。
两个 mock 层套件共用同一份链挂具（mock provider / 实例启动 / RPC 信封，见
`tests/helpers/e2e-chain.ts`）；安装与环境门禁在 `tests/helpers/e2e-install.ts`
（装箱交付档多两件：`packTarball()` / `tarballFiles()`）。真实层是另一条
（自有供应商路由与凭据形态），不吃这份挂具。

可选 env：`DSH_E2E_PLUGIN_DIR` / `DSH_E2E_HOST_DIR` / `DSH_E2E_NODE` /
`DSH_E2E_PNPM_DIR`（三套件），
`DSH_E2E_REAL_CREDENTIALS_SOURCE` / `DSH_E2E_REAL_PROVIDER` / `DSH_E2E_REAL_MODEL` /
`DSH_E2E_REAL_PROMPT`（真实层）。

> 装箱交付档的「`cordis.patch.yml`」在**两处**判：插件树有它 = 跳过条件（缺它组合不出
> 行），**产物**有它 = 环 1 的失败断言。两处都当跳过条件的话，「打包器把文件丢了」
> 只会得到一声 skip 而不是一次红 —— 与 #89 的「非空洞」要求正相反。

### 真实层的断言取舍（领域事实见 GLOSSARY）

三条**静默失败**形态决定了真实层怎么写断言 —— 事实与成因见
[GLOSSARY.md](../../GLOSSARY.md)「#82 RC 锚 vs alpha 的宿主接口差异」：

1. **凭据与路由配错** → 实例不报错（`turn/end` 正常、stderr 空、`usage=0`）。
   故断言两条：`usage > 0`，且 **`assistant/attempt` 无 failure**；账号路线额外断言
   选中的 provider 是 `deepseek-account`（非 `deepseek-official`）。
2. **模型路由必须先选再发**（`create` → `modelCatalog` → `selectModel` → `prompt`）。
   乱序的形态是 turn 不起 —— 且**没有错误可断言**，只能靠超时暴露。
3. **证据只走 RPC，不读会话文件**，且别拿 `llmMs`/`toolMs` 当完成判据
   （本宿主上可能为 0 而 turn 已完成）。计费看 `tokenUsage`，执行看 `tool/result`。
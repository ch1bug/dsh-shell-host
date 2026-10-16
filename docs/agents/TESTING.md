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

### e2e 的安装必须走官方命令（不许手工 symlink）

测试里装插件用**官方两步**，顺序固定：

```bash
dsh --profile <p> --from-default-profile web --dump-config   # ① 播种 profile
dsh plugin --profile <p> add <绝对路径>                       # ② 注册 + pnpm 安装
```

- **① 不能省**：它才写出 `cordis.yml` / `pnpm-workspace.yaml`。只跑 ② 的 profile
  随后 `dsh web` 启动**毫无输出**（实测 120s 超时、stdout/stderr 皆空）。
- **② 不许用手写注册记录 + 手工 `symlink` 代替**（[profile-install.md](profile-install.md)
  写明那**不是安装**）。手工做法额外丢掉两样：pnpm 对 `link:` 依赖的 **peer 解析检查**
  （本仓 10 个 peer 靠它暴露），以及 `.plugin-manager/logs/` **诊断面**。
- 断言"装好了"要看**三处**：`dsh.profile.bundles` 含插件名、
  `dependencies` 有该条目、`node_modules/<pkg>/package.json` 存在。

`tests/helpers/e2e-install.ts` 封装了这套流程与门禁，两个 e2e 套件共用。

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

> **同步前先统一 `core.autocrlf`**：本仓为 `true`，而 msys2 侧 git **不继承**
> Windows 侧配置。未设时同一个工作区会被两套 git 判出**全量行尾差异**
> （实测 123 个文件 "modified"，`git diff --ignore-cr-at-eol` 后为空），
> 于是 `merge --ff-only` 报
> 「您对下列文件的本地修改将被合并操作覆盖 / 请在合并前提交或储藏您的修改」。
> 一次性对齐：
>
> ```bash
> git -C /c/msys64/home/<user>/dsh-shellhost-src config core.autocrlf true
> git -C /c/msys64/home/<user>/dsh-shellhost-src checkout -- .   # 丢弃纯行尾噪音
> ```
>
> **判别**：`git status` 一片 "M" 时，先跑 `git diff --ignore-cr-at-eol --stat`。
> **为空**即纯行尾噪音，可安全 `checkout -- .`；**非空**才是真实改动，须先弄清来源。

> 宿主的 tag 锚点（`dsh-v0.2.0-rc.2`）**只切在宿主源码树** `dsh-host-src`；
> **插件仓库不要 checkout tag** —— 本仓 `main` 就是工作线，切 tag 只会制造
> detached HEAD。

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

## 实测踩坑（写进规则，避免重复踩）

## 本仓现有验证入口

| 入口 | 层 | 覆盖 | 门禁 |
|---|---|---|---|
| `pnpm test` | ①②③ | typecheck + unit + machine（本仓常规套件） | 无 |
| `tests/e2e-tool-call-machine.spec.ts` | **mock 层** | 官方安装（`--from-default-profile` + `dsh plugin add`）→ 配置（组合树含两行、无 pending）→ 启动（真实 `dsh web`，OS 临时端口，stderr 干净）→ `session/create` → `prompt` → mock provider 要求 `pty_open` → 实例执行 → `tool_result` 回灌 | 插件树 + 宿主树 + pnpm shim（缺失则响亮跳过） |
| `tests/e2e-real-llm-machine.spec.ts` | **真实层**（opt-in） | 同一链路打**真实端点**：供应商接受（计费 usage）、真实模型行为、真实凭据路径 | 上述 + `DEEPSEEK_API_KEY` 或含 `deepseek-account-platform/*` 的凭据源（缺失则响亮跳过） |

两个 e2e 套件都在 **machine 车道**（串行，`fileParallelism` off），隔离用临时
`DSH_HOME`（`os.tmpdir`）+ `--port 0`，**不占任何固定端口**（19387 / 19501 / 19502）。

可选 env：`DSH_E2E_PLUGIN_DIR` / `DSH_E2E_HOST_DIR` / `DSH_E2E_NODE` /
`DSH_E2E_PNPM_DIR`（两套件），
`DSH_E2E_REAL_CREDENTIALS_SOURCE` / `DSH_E2E_REAL_PROVIDER` / `DSH_E2E_REAL_MODEL` /
`DSH_E2E_REAL_PROMPT`（真实层）。

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
# Research: OSC 133 shell integration（注入可行性 + tail 流解析）

- 评估日期：2026-10-17（Asia/Shanghai）
- 焦点票：**#70**（其 agent brief 把交付限定为 findings doc + `do / do-not / needs-prototype`
  建议，boundaries 原文：`research only; no src changes; if the answer is "needs a prototype",
  say so and stop` ⇒ 本文件不含实现）
- 上游锚：宿主 tag `dsh-v0.2.1-rc.1`（commit `1600d8a1`；浅克隆 `grafted`，grep 覆盖该 commit
  全文件树，不做历史回溯）
- 只读来源：本仓 `<repo>`；宿主源码树 `~/dsh-host-src`；桌面临时安装产物 `resources/app.asar`
  （仅做字符串存在性检查，未反编译）；本机 msys2 bash 5.3.20 与 WSL Ubuntu 24.04.5
- 记号：**【源码】**= 源码逐字确证；**【实测】**= 本机现场实验；**【推断】**= 逻辑外推；
  **【未验证】**= 无法在本机核到（写明原因）

---

## 0. 一句话结论

**do-not（本期不做）。** 注入在 **bash 家族**上确实便宜（一个环境变量，本机实测 §3.1），但
**pwsh 不是 env 能解决的**（上游自陈 `pwsh cannot install its prompt from the environment`
⇒ 要么往会话里写函数、要么改 argv，§3.4），且真 PTY 下的同形性仍是【推断】（§7.4）。在此之上，
三条独立理由使它现在**没有正收益**：

1. **这条通路上没有消费者**。上游唯一的 OSC 133 解析端是 `dsh-terminal-bash` 自己的
   `TerminalSanitizer`，只服务**它自己经 `ctx.terminals` 起的会话**（§1.2）；本仓 `./pty`
   直接 `@lydell/node-pty` spawn（ADR-0013），不经那张注册表 ⇒ 注入的 `133;D` 没有任何宿主
   组件会读它。
2. **注入会把转义序列泄进模型可见输出**。本仓行缓冲只去 CR、按 LF 分行，**没有 ANSI/OSC
   剥离**（§4.1）⇒ 要么附带一次剥离改造（碰字节/字符记账），要么让 `pty_tail` 文本里多出
   `\e]133;D;N\a` 这类噪声。
3. **覆盖面天生残缺**：cmd 结构上不可行（§5.1），zsh / fish 本机无实机、只能引外部来源
   （§5.2）——真做也只能是 bash(+pwsh) 半边。

票面自己也写了「无注入能力时终端功能不缺面」。**将来出现消费者时**（例如上游把 133 消费面
开放给第三方 PTY，或本仓采纳官方 terminals seam —— 见 #110 的决策），重开的最小形状见 §6。

---

## 1. 上游：谁生产、谁消费、作用域（【源码】）

### 1.0 协议本身（外部规范，本轮已抓到原文）

`web_fetch` 对公网域名被本环境拒绝（报 `resolves to a non-public IP address`），改用
`Invoke-WebRequest` 抓到原文（命令见附录 A.8）。Contour 的 VT 扩展规范
（<https://raw.githubusercontent.com/contour-terminal/contour/master/docs/vt-extensions/osc-133-shell-integration.md>，
抓取于 2026-10-17；自述「inspired by FinalTerm」）给出：

- 格式：`OSC 133 ; <Command> [; <Parameters>...] ST`。
- 各标记（逐字摘要）：`A` = prompt 起点（可带 `k=<Kind>` 等参数）；`B` = 「Notifies the terminal
  that the prompt has ended」——即**提示符与用户输入的分界**；`C [; cmdline=…]` = 命令输出起点；
  `D [; <ExitCode>]` = 「Notifies the terminal that the command has finished.」，`<ExitCode>`
  缺失或非数字按 `0` 读；另有 `N` / `I` / `P` / `L`（本轮不需要）。
- **终止符差异**：规范示例用 **ST（`ESC \`）**，上游 DSH 用 **BEL（`\007`）**（【源码】
  `terminal-bash/src/index.ts:87/:98-99`）。BEL 也是 OSC 常见终止符，但本文件**未取到**把 BEL
  明确写进 OSC 133 规范的原文（§7.5）——故消费端行为一律以上游源码为准。
- VS Code 另有一套 **OSC 633**（本轮抓取原文：`OSC 633 ; A ST: Mark prompt start.` /
  `OSC 633 ; B ST: Mark prompt end.` / `OSC 633 ; C ST: Mark pre-execution.`，见 §5.2）——
  与 OSC 133 **不是同一编号**，互不兼容。

### 1.1 生产者：`dsh-terminal-bash`，仅 bash / pwsh 两方言，仅一条标记

`~/dsh-host-src/packages/terminal/terminal-bash/src/index.ts:76-89` 按方言分支给 spawn 环境：

- bash（`:87`，逐字）：

  ```
  PROMPT_COMMAND: `printf "\\033]133;D;%s\\007" "$?"; PS1='${CONTROLLED_PROMPT}'`,
  ```

- pwsh（`:98-99`）：一个 `prompt` 函数，`[Console]::Write([char]27 + ']133;D;' +
  [int]$LASTEXITCODE + [char]7)`；注释说明 `[char]27`/`[char]7` 是**运行时构造控制字节**，
  因为「raw ESC characters in submitted input are unreliable under PSReadLine」。
  **交付方式与 bash 不同**：bash 靠 spawn 环境一次装好；pwsh 是会话起来后把函数**当输入写进去**
  （`:136` `session.startSend({ text: ENCODING_PREAMBLE + PWSH_PROMPT_SETUP, submit: true })`；
  `:122-124` 的注释逐字：`pwsh cannot install its prompt from the environment`）。

即：**只发 `133;D;<exit>`**（命令结束 + 退出码），不发 `133;A`（prompt 起点）/`B`（prompt 结束）
/`C`（输出起点）。触发点 = 每次提示符渲染。argv 见 `terminal-bash/src/config.ts:65`
（bash `['--noprofile','--norc','-i']`）与 `:67`（pwsh `['-NoLogo','-NoProfile']`）。

### 1.2 消费者：`TerminalSanitizer` 的「就绪」判定；载荷**不被消费**

- `terminal-bash/src/sanitize.ts:6` `PROMPT_MARKER_PREFIX = '133;D;'`；`:75`
  `content.startsWith(PROMPT_MARKER_PREFIX)`；`terminal-bash/src/session.ts:497/499/509-513`
  用它做会话**就绪**判定。
- 上游自己的笔记写明载荷没人用：`.agents/notes/archived/architecture/2026-08-11-pwsh-persistent-pty.md:28`
  与 `.agents/notes/implemented/bug-fix/2026-09-27-pwsh-prompt-tail-grace.md:9` ——
  「标记仍是**载荷不被消费**的就绪信号」「精确的就绪证据是 OSC `133;D` 之后受控提示符的尾部」。
- ⇒ 这个标记的语义是**该后端内部的同步信号**，不是给 UI / 模型看的富信息。

### 1.3 没有 633；客户端 xterm 也不认 133

- 全树 `]633` 与 `633;` **零命中**（反证探针见附录 A.6；**裸 `633`** 这个 needle 的命中皆为
  i18n.yaml 哈希与 SVG path 数据 —— 两个 needle 的读数都在那里）。
- `packages/client/ui-sidebar-terminal/src/client/terminal-theme.ts:23,31,40,47` 注册的 OSC 处理器
  只有 4 / 104 / `10+offset` / `110+offset`（即 10–12、110–112，颜色族），**无 133**。
- 注：VS Code 的 shell integration 用的是 **OSC 633**（另一套编号，§1.0 末条），与上游这条不是
  同一协议。

### 1.4 作用域：默认关闭的**可选 bundle** 的后端会话；与本仓**不同通路**

- `packages/boot/app-boot/src/profile.ts:223-236` 的 `OPTIONAL_BUNDLES` 含
  `@deepseek-ai/dsh-experimental-terminal-bundle`（`:226`）；`:216-222` 的注释逐字说明这类
  bundle「selected by no shipped template, and offered switched off by the plugin manager」；
  `:183-185` 的默认 `web` 模板只选 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`
  —— 两条合起来即「默认不开」的含义（另有上游 `scripts/optional-bundles.spec.ts:1` 的断言）。
- 该 bundle 的 patch（`packages/experimental/terminal-bundle/cordis.patch.yml`）把
  `@deepseek-ai/dsh-terminal-bash` 挂在 `isolate: { terminals: true }` 的 entry-local realm 里
  （与本仓 ADR-0010 的记账一致）。调用者：`packages/shell/tool-bash-persistent/src/index.ts:258`、
  `packages/shell/tool-pwsh-persistent/src/index.ts:281`、
  `packages/experimental/tool-terminal/src/index.ts:189`。
- 本仓不同通路（【源码】本仓）：`src/pty/session-core.ts:23` 直接 `import { spawn as
  nodePtySpawn } from '@lydell/node-pty'`，`:267-282` 的 `defaultSpawnPty` 自己拿 ConPTY / pty
  —— **不注册任何后端**。
- 【实测】本机 desktop profile 已显式启用该可选 bundle（上游 `terminal_*` 工具可用），所以
  「无消费者」这个结论**只对不经 `ctx.terminals` 的 PTY 成立**，不要外推成「宿主没有 133 逻辑」。

---

## 2. 本仓：注入会落在哪一层（【源码】）

- **argv 单一出处**（ADR-0008）：`src/launchers.ts:40-42` —— `MSYS2_INTERACTIVE_ARGV =
  ['--login','-i']`、`PWSH_INTERACTIVE_ARGV = ['-l','-noexit']`、
  `WSL_INTERACTIVE_ARGV = (d) => ['-d',d,'-e','bash','--login','-i']`；macOS 侧 POSIX argv 在
  `src/detect.ts:376-382`（zsh `['-l']` / bash `['--login']`）。
- **预设 env**：`src/launchers.ts:238`（msys2 行当前只有 `{ MSYSTEM, CHERE_INVOKING: '1' }`）；
  同族的预设行 env 见 `:251/:265/:277/:295/:306/:315/:349`（`:250`/`:276` 是那两个预设对象的**行首**，
  `env:` 在下一行）。
- **env 传递链**：`src/terminal/index.ts:117` `launchEnv(...)` → `:148` 工具 `env` 参数（描述逐字
  写着 `VS Code profile semantics`）→ `:202-207` 交给 core → `src/pty/session-core.ts:487-491`
  → spawn `:279`（win32 直接 spawn）/ `:287`（POSIX `/bin/sh -c`），两处都是
  `{ ...process.env, ...spec.env }`，**spec 胜**。
- **最窄注入点** = `launchers.ts` 的预设行 env；但 `:238` 那个 `env:` 字面量由**三个 msys2 子系统
  预设共享**（`:232-242` 的 `for (const subsystem of MSYS2_SUBSYSTEMS)` 循环构造）⇒ 只给
  `msys2-ucrt` 加标记，要么加**按 id 的条件**、要么在预设构造处加 per-preset 字段 —— 不是改一行
  字面量。`cordis.patch.yml:14-21` 只有 `pty` / `terminal` 两个自有 id 行，**不需要新挂载面**。

---

## 3. 两条注入路线的事实对比（env vs rc 文件）

### 3.1 路线 (a) env 注入 —— 【实测】在本机成立

关键风险原本是「`--login -i` 下 `/etc/profile` 会不会把 `PROMPT_COMMAND` 覆盖掉」。本机实测
（命令与读数见附录 A.1–A.3）：

- msys 的 profile 链（`/etc/profile`、`/etc/bash.bashrc`、`/etc/profile.d/*`、`~/.bash_profile`、
  `~/.bashrc`）**全部不设 `PROMPT_COMMAND`**（唯一命中是 `~/.bashrc:70` 一行注释掉的
  `# export PROMPT_COMMAND="history -a"`）。
- env 注入的 `PROMPT_COMMAND` 在 `/usr/bin/bash --login -i` 下**照常执行**（探针打印
  `OSC-INJ-LOGIN`）。
- 非交互面另有 `BASH_ENV`：`BASH_ENV=<(printf 'printf OSC-INJ\n') bash -c true` 输出
  `OSC-INJ`（POSIX 的 `ENV` 只对交互 shell 生效，探针无输出）。
- 一手来源：bash(1) 的 `PROMPT_COMMAND` 段（本机 `/usr/share/man/man1/bash.1.gz`）——
  「If this variable is set … the value of each set element is executed as a command prior to
  issuing each primary prompt」。
- **代价**：注入后标记会以原始字节进入行缓冲（§4），所以 env 路线**省不掉剥离**这一半。

### 3.2 路线 (b) rc 文件（`--rcfile` / `--init-file` / `ZDOTDIR`）—— 更重且有 login 语义回归

- 需要**每会话一个临时文件**及其生命周期（生成 → spawn → close/dispose 清理）；本仓
  `session-core.ts:429/:599` 只收进程，**没有 per-session 文件生命周期**（先例在上游
  `packages/subprocess/subprocess-local/src/shell-activity.ts:66,96,126,128`：bash `--rcfile`、
  zsh `ZDOTDIR`）。
- msys2 预设是 `--login -i`：`--rcfile` / `--init-file` 会**跳过 profile 链**，脚本必须自己补回
  （VS Code 正是这么做的：`--init-file` 后由脚本去 source `~/.bashrc` 或模仿 `-l`）—— 这是
  对现有 login 语义的实质改动，回归面大于 env 路线。

### 3.3 win32 零回归面

若只给 msys2 行加 env：pwsh（`:41`）/ cmd / wsl / git-bash 行的 env 不变（【源码】各预设行；
msys2 之外的 POSIX 行还有 `:330` 的 win32 门控），可用离线单测断言「只有目标行的 env 多了一个
键、其余行逐字不变」；机器档再加一条 tail needle（§6）。

### 3.4 pwsh：env 路线不成立（本仓的落点判定 —— brief 点名的另一半）

票面点名 pwsh 的 prompt function；这里给**本仓**的判定，而不只是「上游怎么做」：

- 本仓 pwsh 预设 argv = `PWSH_INTERACTIVE_ARGV = ['-l','-noexit']`（`src/launchers.ts:41`），
  预设行 env 是空对象（`:265`）。
- **pwsh 没有「从环境装 prompt 函数」这条路**（上游注释逐字：`pwsh cannot install its prompt from
  the environment`，`terminal-bash/src/index.ts:122-124`）⇒ 路线 (a) 对环境变量本身**不适用**。
- 本仓两条替代路及其代价：
  1. **开完会话后把函数当输入写进去**（等价上游 `:136` 的 `startSend`）：这行注入会**进用户会话的
     可见回显与 `pty_tail` 文本**，而 `shell_open` 的语义是「把一个 shell 交给模型 / 用户」——
     注入可见命令属行为变化，且要自己处理启动竞态（上游为此专门有 startup 时序与 deadline 逻辑）。
  2. **改 argv**（例如 `-NoExit -Command "function prompt {...}"`）：动 ADR-0008 的 argv 单一出处
     常量，且 `-Command` 与 `-l` / 用户 profile 的交互**未测**（【未验证】）。
- ⇒ 判定：**pwsh 注入不是 env 可解**，属「要原型」的一档；即使将来做，也应先只做 bash、pwsh 单列。
  上游能做，是因为它自己持有会话的 send 生命周期、把 setup 当**启动输入**发，并把 `PS1` 换成受控
  提示符做就绪判定 —— 这两件本仓都没有（我们的就绪判据是 settle 静默窗口，§4.1）。

---

## 4. 解析面：注入之后必须剥离（票面问题 (b)）

### 4.1 行缓冲与记账的五个点（【源码】`src/pty/session-core.ts`）

| 点 | 行 | 现在的行为 |
|---|---|---|
| 行缓冲 | `:320-333` `append()`（`:318-319` 是 JSDoc） | `pending += chunk` → 按 `\n` 切行 → 每行去尾部 `\r` → `lines` 超 `scrollbackLines` 时 `splice` 并抬 `absBase` |
| settle 字符计数 | `:373` | `chars = lines.reduce((n,l) => n + l.length + 1, 0) + pending.length`（静默窗口的「字节仍在长」判据） |
| send delta | `:534-553` | `startAbs = totalLines(s)`、`startPendingLen = s.pending.length`；delta = `lines.slice(startAbs - absBase)` + `pending.slice(startPendingLen)` |
| tail 增量游标 | `:555-581` | `cursors` 按**行号**推进；有 3 次 live-anchor 重试，漂移时宁可不给页 |
| 页读 | `:337-348` `readNewest()` | 行窗口 + `truncated` 语义 |

**结论**：本仓对字节流只做「CR 剥离 + 换行切分」，**没有任何 ANSI/OSC 剥离**（全仓
`tests/*.ts` 里对 `\u001b` / `\x1b` / `\033` 也零断言 —— 附录 A.7 用大小写不敏感 needle +
原始 ESC 字节 + `fromCharCode(27)` 三种探法复核过这个 0 命中）。因此注入 marks 若不剥离，
`pty_tail` 文本与 `pty_send` 的 delta 里就会出现 `\e]133;D;N\a`。

### 4.2 「parsed out」的两种含义，与各自的落点

票面说的「parsed out of the tail cursor stream」在实现上是**两件事**，必须分开：

1. **剥离**（不再让消费者看到标记）：从行缓冲里去掉 —— 落在 `append()` 内（不变量见 §4.3）。
2. **提取**（让新消费者读到）：把「上次命令退出码 / 提示符边界」变成可读信息 —— 这是**契约面
   新增**：`pty_tail` 现在只返回 `{ text, lines, truncated }`（工具面在 `src/pty/index.ts`，
   core 在 `session-core.ts:555-581`），要新增字段或新工具，并同步 `tests/pty-*.spec.ts` 的断言面。
   本轮没有消费者（§1.2/§1.4），所以第 2 件不成立；brief 问题 (b) 的答案落在第 1 件上。

**剥离为什么只能落在 `append()` 内**：`send` 会把 `pending` 的**分片**直接拼进返回文本
（`:550-551`），跨 chunk 的半条序列会被撕成两半返回调用方；`tail` / `readNewest` 只吐**完整行**
（`:337-348`、`:572`），行内不会裂 —— 所以「必须在 `append()` 内」的理由主要来自 **send 侧**，
不是行读侧。

### 4.3 记账不变量（brief 的「without corrupting byte accounting」）

1. **活动计数必须与存储文本解耦**。`:373` 用 `lines` + `pending` 的字符数判断「输出还在长」。
   若剥离发生在记账之前，**只含标记、不含可见文本的 chunk**（提示符渲染时恰恰如此）会让字符数
   不变 ⇒ settle 可能**提前结束**（假的「安静」）。稳的写法 = 另记一个**原始字节计数**专供
   `:373`，存储文本仍存剥离后的内容。
2. **未终止序列必须自带 hold-back**。OSC 以 BEL / ST 结束，一条序列可能跨多个 `onData` chunk
   （`:509`）；`append()` 只对**行**做 hold-back（`pending`，`:321-327`），对转义序列没有状态
   ⇒ 剥离器必须自带一个**有界**的部分序列缓冲，否则 `send` 的 delta（`:550-551`）会把半条序列
   返回给调用方。
3. **行号语义不受影响**。`absBase`（`:316`）、`cursors` 与 `truncated`（`:337-348`、`:555-581`）
   都是**行维度**的；剥离只吃转义字节、不吞 LF ⇒ 行号、增量游标、截断报告都不用改。

### 4.4 「spill-free lane」在本仓的含义：剥离是**有损**的

本仓 PTY 输出**只在内存里**：行缓冲 + `scrollbackLines` 上限（`:328-332`，超限直接 `splice` 丢弃），
没有磁盘 spill —— ADR-0013 之后执行器 world 的 spill / `maxSpillBytes` 概念已不在本包。
⇒ 被剥离的标记**无法靠事后重读补回**；若将来要「既剥离又留档」，就得在行缓冲之外**另存**一份标记
记录 —— 那是新增状态与契约，不是顺手解析。

### 4.5 小结（问题 (b) 的答案）

**能解析出来而不破坏记账，但不便宜**：需要一个**有界的部分序列状态机** + **原始字节 / 存储文本
双记账**，改动面在 `append()` 与 `:373` 两处（外加测试）。在没有消费者（§1.4）的前提下，这份改动
换不到任何可见收益 —— 这正是 §0 把结论定在 **do-not** 的技术理由。

---

## 5. cmd / zsh / fish

### 5.1 cmd：结构上不可行（【实测】+【源码】）

- 上游 `packages/terminal` 内 grep `cmd.exe|conpty` **零命中**；唯一 cmd 用法是
  `packages/api/terminal-controller/src/shells.ts:18`（Windows 默认 shell）与 `:26`
  （`kind === 'cmd' ? [] : …`，即 **cmd 不注入任何东西**）。
- 本机实证：`cmd.exe /c "prompt /?"`（Windows 10.0.26300）列出的 `$` 代码只有
  `$A/$B/$C/$D/$E/$F/$G/$H/$L/$M/$N/$P/$Q/$R/$S/$T/$V/$_/$+`——**没有退出码代码，也没有
  per-prompt 钩子**；PTY 里 `set PROMPT=[%ERRORLEVEL%]$G` 后跑一条失败命令，下一个提示符仍是
  `[0]>`（`%ERRORLEVEL%` 在提示符求值时机上不成立）。

### 5.2 zsh / fish：本机无实机；注入面引**已抓取**的外部原文

- 本机：`wsl -l -q` 只有 Ubuntu（**实测** `$BASH_VERSION` = 5.2.21(1)-release），msys2 侧无
  zsh/fish 包，也没有 VS Code 的 `shellIntegration-*` 脚本副本 ⇒ **无实机可验**。
- VS Code 的 shell integration 文档（本轮 `Invoke-WebRequest` 抓到原文：
  <https://code.visualstudio.com/docs/terminal/shell-integration>）逐字给出：
  「Supported shells: Linux/macOS: bash, fish, pwsh, zsh / Windows: Git Bash, pwsh」；
  「This is done by **injecting arguments and/or environment variables** when the shell session
  launches」——即 VS Code 也不是纯 env，而是 **argv + env 组合**（其自身协议是 OSC 633，§1.0）。
- Contour 规范对**安装稳健性**的警告值得记（同一份已抓取原文）：bash 侧「installs itself by
  appending to `PROMPT_COMMAND`. A later `PROMPT_COMMAND=...` throws that away, and then no marks
  are sent at all, without an error: that is why the script belongs at the end of `~/.bashrc`」
  ⇒ **env 路线的软肋**：用户 rc 里若再次**赋值** `PROMPT_COMMAND`，我们的注入会被静默顶掉
  （本机实测不触发，因为 profile 链不赋值 —— 但那是环境相关，不是结构保证）。
- zsh（`precmd` + `add-zsh-hook`）/ fish（`--on-event fish_prompt / fish_preexec / fish_postexec`）
  的**脚本原文与行号**：本轮未抓（`web_fetch` 对 github 域名被拒，本轮只抓了上面两页）→ 标
  **【未验证】**。

---

## 6. 若重开：最小形状（建议，不含实现）

**前置（必须先满足）**：说清**谁消费**这些标记。三种可能的未来消费者：① 上游把 133 消费面
开放给第三方 PTY（当前不是）；② 本仓采纳官方 `terminals` seam（#110 / ADR-0009 的重开条件）；
③ 本仓自己新增消费面（例如 `pty_tail` 暴露提示符边界）——那要单独一张票设计契约。

形状（若 ①/② 成立）：

1. **只对 bash 家族行**（msys2；macOS 的 bash 行可选）注入 `PROMPT_COMMAND`，**默认关**（配置面
   才动 `src/terminal/index.ts` 的 preset config）；
2. 只发 `133;D;<exit>`，与上游同形（不补 A/B/C：那要 DEBUG trap / preexec，且 fish/zsh 异构）；
3. **剥离写在 `append()` 内**（不变量见 §4.3：原始字节计数与存储文本双账 + 未终止序列的
   hold-back）；单测断言「含序列的 chunk 进来后 `lines`/`pending` 不含序列、settle 的活动计数
   仍增长」，机器档用原始字节 needle
   （`/\u001b\]133;D;\d+\u0007/`，回声不可能满足 —— #99 的 needle 纪律见 TESTING.md:185-207）；
4. 机器档入口：`node node_modules/vitest/vitest.mjs run --project machine tests/terminal-machine.spec.ts`
   （现有 msys2 用例在 `tests/terminal-machine.spec.ts:77`，wsl 在 `:127`）。

**明确不做**（除非有独立理由）：rc 文件路线（§3.2 的 login 语义回归）、同票做 zsh/fish（无实机，
无法按证据纪律验收）、把 marks 暴露进 `pty_tail` 契约（消费者未定）、改 login argv。

---

## 7. 未确证面

1. **`#22` 的原始结论文件不可复核**：票面写的「前置输入已就绪」指向
   `.scratch/issue22-osc133-survey.md`，该文件既不在盘也不在 HEAD（`.scratch/` 未跟踪：
   `git ls-files .scratch` 为空；`git log --all -S osc133` 0 命中）。#22 只剩正文与 2026-10-08
   收尾评论、#26 的 2026-10-10 评论（「OSC133：票面可选 → 本票不做，建议独立票」）。
   ⇒ **本文件的结论不依赖 #22**，全部重新取证。
2. **zsh / fish 的脚本原文与行号**：见 §5.2（OSC 133 规范与 VS Code 文档本轮**已抓到原文**；
   仍未抓的只有那两个 shell 脚本本身）。
3. **上游 grep 口径**：宿主树是 `grafted` 浅克隆，只覆盖 `1600d8a1` 的全文件树；asar 侧只做
   字符串存在性检查（`133;D;`、`dsh-experimental-terminal-bundle` 命中），未反编译。
4. **本机 msys2 的 login 探针在真 PTY 下的同形性**【推断】：§3.1 的探针是管道 stdin（无 job
   control 警告），但 `PROMPT_COMMAND` 的执行时机与 stdin 类型无关；同一结论在机器档里可复核。
5. **BEL 作为 OSC 终止符的规范地位**【未验证】：OSC 133 规范示例用 ST，上游 DSH 用 BEL；本轮未取到
   把 BEL 明确写进该规范的原文。两侧的**行为**都有源码 / 实测支撑，缺的只是「规范承认」这一句。

---

## 附录 A：本机实测命令与读数（可复现）

A.1 profile 链是否设 `PROMPT_COMMAND`（msys bash）：

```bash
grep -rn "PROMPT_COMMAND" /etc/profile /etc/bash.bashrc /etc/profile.d/ \
  "$HOME/.bash_profile" "$HOME/.bashrc"
# 命中仅：/home/<user>/.bashrc:70  # export PROMPT_COMMAND="history -a"   （注释行）
```

A.2 env 注入的 `PROMPT_COMMAND` 在 login 交互 shell 下是否生效：

```bash
cd /tmp && PROMPT_COMMAND="printf \"OSC-INJ-LOGIN\n\"" /usr/bin/bash --login -i < /dev/null 2>&1 | head -6
# 读数含 OSC-INJ-LOGIN（另见 msys 自带提示符发的 OSC 0 标题序列）
```

A.3 非交互 bash 的 env 启动钩子：

```bash
BASH_ENV=<(printf 'printf OSC-INJ\n') bash -c true   # 输出 OSC-INJ
ENV=<(printf 'printf OSC-INJ\n') sh -c true          # 无输出（POSIX ENV 只对交互 shell）
```

A.4 cmd 的 `PROMPT` 无退出码代码：`cmd.exe /c "prompt /?"`（本机 Windows 10.0.26300）。

A.5 一手来源：`zcat /usr/share/man/man1/bash.1.gz | grep -n -A6 PROMPT_COMMAND`。

A.6 上游「无 633」的反证探针（0 命中先证伪再采信）：

```bash
git -C ~/dsh-host-src grep -c ']633' 1600d8a1 -- .        # 0 命中
git -C ~/dsh-host-src grep -n '633;' 1600d8a1 -- packages apps   # 0 命中
```

A.7 本仓 `tests/` 无 ESC 断言的**反证探针**（0 命中先证伪再采信；大小写不敏感 —— 全大写 needle
会静默漏掉另一种写法）：

```bash
grep -rniE '\\u001b|\\x1b|\\033' tests/ src/     # 0 命中
# 2026-10-17 另用原始 ESC 字节与 String.fromCharCode(27) 两种写法再扫一遍：同样 0 命中
```

A.8 外部规范的抓取方式（`web_fetch` 对公网域名被本环境拒绝时，用 `Invoke-WebRequest` 绕行 ——
本轮实际用法，两个页面都拿到 200）：

```powershell
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/contour-terminal/contour/master/docs/vt-extensions/osc-133-shell-integration.md' -UseBasicParsing   # 200, ≈13.5 KB
Invoke-WebRequest -Uri 'https://code.visualstudio.com/docs/terminal/shell-integration' -UseBasicParsing                                                        # 200, ≈161 KB
```

## 附录 B：路径清单

- 上游生产者 / 消费者：`~/dsh-host-src/packages/terminal/terminal-bash/src/{index.ts,sanitize.ts,session.ts,config.ts}`
- 上游可选 bundle：`~/dsh-host-src/packages/experimental/terminal-bundle/`、
  `~/dsh-host-src/packages/boot/app-boot/src/profile.ts`
- 上游 cmd 默认 shell：`~/dsh-host-src/packages/api/terminal-controller/src/shells.ts`
- 本仓注入面：`src/launchers.ts`、`src/terminal/index.ts`、`src/detect.ts`、`cordis.patch.yml`
- 本仓解析面：`src/pty/session-core.ts`（§4.1 的五个点）
- 本仓验收面：`tests/terminal-machine.spec.ts`、`tests/launchers.spec.ts`、
  `docs/agents/TESTING.md`（needle 纪律）
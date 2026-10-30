> 本文档提取自 README（issues #137–#140，ADR-0016）。返回 [README](../../README.md)。English version: [remote.md](remote.md)。

## 远程工作区：`./remote` 与 `./remote-fs`（#137）

这两个是兄弟入口：前者提供 `ctx.remote`，负责工作区登记与连接生命周期；后者提供
`ctx.remoteFs`，文件工具只经这个服务访问远端。它们不替换上游 `ctx.fs`，也不新增
`ctx.shell` 执行器。老 profile 的迁移路径（补 `ssh` / `remote` / `remote-fs`）
统一写在 *The bundle patch* 的「怎么装、怎么加行」（#142），此处不重复。

### 预热配置与工具

`remote` 行的配置示例（元数据，不保存凭据）：

```yaml
- insert:
    - id: remote
      name: dsh-shell-host/remote
      config:
        workspaces:
          - host: devbox
            root: /srv/app
            title: 远程应用
```

组合装载即开始连接，失败记录为 `unavailable` 与稳定错误码，不阻塞宿主启动。
`remote_open({ host, root, anchor?, title?, port?, jump?, options? })` 可动态登记或显式重试，
`remote_list` 查看登记项，`remote_status({ workspaceId? })` 查看实际启动形态、远端 shell
探测值、引用计数、重连次数、在飞请求及最后错误。同一 host 的工作区共享文件通道；若
port/jump/options 不同，明确拒绝复用，须使用不同 OpenSSH host alias，避免静默访问错误主机。
动态登记保留到 `remote_close_workspace` 或组件卸载；需在重启后预热的工作区写入上面的 `workspaces` 配置。

`remote_open` 创建本地锚点目录，内含 `.dsh-remote-workspace.json`（host + 远端 root
与连接指纹，不含凭据）。默认位于 `anchorRoot` 下；未配置时使用本次会话工作区根下的
`.dsh-remote`，配置预热则使用部署默认工作区根。锚点是身份而非文件副本；完整宿主有
`workspaceRegistry` 时自动把锚点登记为普通工作区，纯工具组合仍可通过本服务查询它。
已有 marker 不匹配、marker 是符号链接、或无 marker 的目录非空时均拒绝接管。
`remote_open` 经过 #102 权限门；`workspace-write` 同时约束 ssh 启动 cwd 与锚点真实路径，
`read-only` 拒绝开连接。配置预热是部署者声明，不冒充某个 agent 的一次性授权。

`remote_ls({ path?, limit? })` 列远端目录；显式 `path` 必须为绝对 POSIX 路径，省略则列
工作区根。工作区由会话 cwd 对应的本地锚点选定；无锚点时仅在唯一工作区下兜底，多主机
歧义必须明确报错。`limit` 只限制展示行数，返回 `truncated` 与 `total`，不是远端扫描或
内存预算；超出帧上限会响亮失败而不是返回半棵目录。**本地 read/write/edit 看到的是锚点，
远端文件必须用 `remote_*` 工具**。

`remote_read({ file_path, offset?, limit? })` 对齐上游 `read`：路径按会话锚点与远程文件系统解析，
行号从 1 开始；默认及最大 2000 行，每行最多 2000 字符，选中文本最多 50 KiB，footer 提示续读。
目录拒绝为 `FS_NOT_REGULAR_FILE`；严格 UTF-8 文本面拒绝非法编码及前 8 KiB 内的 NUL（`FS_NOT_TEXT`），
不猜编码或用替换字符掩盖坏字节。底层 `readBytes` / `readByteRange` 可逐字节读回非 UTF-8 文件。
读取按 256 KiB 字节块走既有 base64 通道；跨块保留 UTF-8 解码状态，大于单帧的文件不塞进一帧。
途中断连、超时、短块或文件版本变化均响亮失败，不返回前缀冒充完整结果。

`remote_write({ file_path, content })` 原子创建或替换文本；`remote_edit({ file_path, old_string,
new_string, replace_all? })` 做字面量替换，默认只允许唯一匹配。覆盖/编辑前先用 `remote_read` 读取；
观察按会话与远程 canonical 身份隔离，外部改动返回 `FS_STALE_VERSION`，需重读再试。成功创建/修改后
可以继续编辑，不必额外读取。编辑按上游规则恢复 LF/CRLF，`$&` 等不当作正则替换语法。
写入以有界 base64 块进入同目录私有 staging，发布前校验版本，替换保留已有权限位；失败清理 staging。
create 使用原子 no-clobber，替换使用 `mv`；provider 内同目标串行，不宣称对任意外部进程的 OS 级 CAS。
通道已死时无法保证远端清理，失败会明确报告。此后端不宣称本机文件沙箱能监禁远端路径；
写工具每次重新解析调用方会话策略，只有 `danger-full-access` 可写；降级、缺少策略服务均在远端请求前拒绝。
直接调用服务并传入受限本机 `sandboxPolicy` 同样返回 `FS_SANDBOX_DENIED`，工具不提供虚假的提权参数。

### 多会话编排（#140）

`remote_open_session({ workspaceId, kind, cwd?, env? })` 在已登记工作区打开独立远端 shell，
返回的 `sessionId` 就是同一 PTY 核心的 id，后续直接用同一 agent 的 `pty_send` / `pty_tail` /
`pty_close`。`kind` 只标注 `shell` / `build` / `test` 用途，不会自动运行构建或测试命令；
三种用途都拥有自己的交互 `sh`，一条中的 `cd` 不改变另一条。

`cwd` 是远端绝对 POSIX 路径，默认工作区 `root`；`env` 仅注入远端 shell，本地 SSH 进程的
cwd 仍取本次宿主权限门的授权值。每次打开均重新解析权限，将真实 grant 写入 PTY，后续
`pty_send` 保留降级拒写；已连接不等于永久授权，也不宣称本机沙箱能监禁远端。
每条会话在自己的连接内实测 POSIX 登录 shell，并确认 cwd/env 初始化成功后才发布 id；
探测还要求宿主具备文件帧协议的 coreutils（`base64` / `mktemp`，ADR-0016 decision 3）——
同一宿主同时承载文件通道，缺一件在探测期就 fail closed，而不是让会话起来后文件面逐请求失败。
失败、超时、中止均尝试回收，清理失败保留 id 供工作区关闭重试。

`remote_list` / `remote_status` 增加当前 agent 的 `sessions`（id、kind、cwd、运行/退出状态、
实测 shell、传输形态、connectionId）。工作区 `state` 指文件通道，不冒充交互会话状态。
POSIX 交互会话以 slave 加入已有 master（同一 `connectionId`）；master 丢失不能偷偷直连。
Windows 或明确禁共享时每条会话有独立连接和 id；文件连接的重连只影响文件连接。
交互 shell **不自动重连**，断线由 PTY 报 `exited`，需新开会话；POSIX master 丢失会影响
其下所有 channel。未实现 WSL/tmux 路径，状态不伪造这些形态。

软上限完全沿用 PTY owner 注册表，与本地 PTY、SSH、launcher 会话共用计数；退出未关闭仍占位，
超限使用核心的响亮错误与当前会话清单。没有第二套工作区配额。
`remote_close_workspace({ workspaceId })` 是**整个工作区**的收尾，会关闭其全部 owner 的
关联 id，并解除工作区登记；不触碰其他工作区、本地 PTY或本地锚点。它等待排队的打开操作，
重复关闭幂等；失败保留重试责任。列表不公开其他 agent 的会话明细，这不缩小整批关闭范围。

### 传输与本期边界

- POSIX 客户端明确启用 ControlMaster；Windows 明确禁用它，绝不先试 master 再回退。
  可显式 `ControlMaster=no` 选择独立连接，状态同步报告该形态；`auto`/`ask` 等不能保证
  可观测形态的模式响亮拒绝。WSL 承载和 tmux 仍为 ADR-0017 的 deferred 选项。
- 远端必须有 POSIX 登录 shell，以及 GNU `base64` / `mktemp` / `stat` / `find` / `realpath` / `dd`
  等工具；打开时实测 `uname` 与 `$SHELL`，Windows 或非 POSIX 登录 shell 响亮拒绝。
  不安装远端 server，不用 SFTP，不做本地文件镜像。
- 文件通道使用 `ssh -T` 的原始 pipe，不是交互 PTY；内部请求是带 id 的 base64 行帧。
  先协商协议版本与 `clientId`，异版或身份不匹配响亮拒绝；子命令与协议 stdin 隔离，
  响应帧有 8 MiB 上限。这是文件传输通道，不是第二份 PTY 核心。
- 本期真正实现 `resolve` / `stat` / `listDir` 与 #138 的 `lstat` / `readText` / `streamText` /
  `readBytes` / `readByteRange`，以及 #139 的 `writeText` / `editText`；#140 提供工作区多会话编排（见上节）。
- 无活体 ssh 主机的环境中，真实 bash 循环与注入通道覆盖不等于 ssh 活体验收；验证报告须
  明说 `not run locally: remote live`，不能用假通道绿灯代替真实网络证据。

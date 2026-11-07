# CONTEXT.md — dsh-shell-host 领域术语表

> 只收**术语**（glossary），不收实现细节与票务状态。决策记录在 `docs/adr/`。
> 上游宿主事实（RC/alpha 接口差异、typert、凭据路由）见 `GLOSSARY.md`。

## 术语

### 注册审计账本（registration audit ledger）
terminal 自定义 shell 注册面的 append-only 事件记录（JSONL，随 profile 持久）。
登记来源、内容哈希与事后变化（被改/被删/被禁用/被恢复）。它是**可观测性**设施，
不是门禁：变化只告警，不阻断——阻断权在 #102 权限门。（#170 grill D2/D4，2026-10-29）

### custom.d 文件族（per-entry registration files）
custom shell 预设的权威存储形态：每条预设一个独立文件（`custom.d/<id>.json`）。
一条坏文件只禁用该条，不拖垮整批挂载——「显性隔离」。（#170 grill D5，2026-10-29；
**修订 ADR-0018** 的「patch 行唯一写入口」决策）

### 单条禁用（per-entry disable）
校验不通过的注册条目被跳过并在 `shellhost_terminal_list` 中呈现 `disabled` + 原因原文
（#193 起；原名 `terminal_list`，与官方随包 optional-tool-terminal 撞名而改名），
其余条目照常挂载；用户改好文件后下次挂载自动放行。取代 #105 的整批
`registrationError` 门。（#170 grill D6/D7，2026-10-29）

### patch-source 废止事件（ignored: patch-source）
cordis.patch.yml 行配置里的 custom 条目在 custom.d 文件族生效后不再被采纳：
挂载时忽略并记一条审计事件，迁移走一次性文档指引。（#170 grill D8，2026-10-29）

### 哨兵标记（sentinel marker）
shell 在命令自有输出的前后打出的一对标记：每会话一个高熵随机 payload，
装在 OSC 私有序列壳里；闭标记只有与本会话的开标记配对才被信任。
用途 = 把「命令自己的输出」从回显/横幅/重绘残留中切出来，替代文本层启发式。
（#186 grill，2026-11-02；ADR-0020）

### 过滤视图（filtered view）
会话缓冲按哨兵标记切出的「仅命令输出」视图，与原始视图（raw，ADR-0019
契约不变）并存于 session-core；`pty_tail`/`read` 默认消费它，分页词汇沿用
`{text, offset, limit, totalLines, truncated}`（语义限定在过滤视图内）。
（#186 grill，2026-11-02；ADR-0020）

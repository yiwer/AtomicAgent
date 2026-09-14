# Ticket10 双轴审查

依据用户显式 `$implement` 及 code-review skill，两个 fresh (`fork_turns=none`) 只读 agent 并行审查。固定 baseline `6b84a52dc068eaedb2b2e75fde17375d5af6268c`，checkpoint `60cb7f40f117ff4f3f5dc85a456434eb13f9e49e`；后续独立修复 `4574a6e3f6ec64d4a05b6079435bd26173ab1c68`，没有 amend 被审查提交。

来源：`.scratch/v0/issues/10-isolated-readonly-execution.md`、ticket-plan、CLAUDE/docs/agents、PRD、domain model、task API、validation/audit、相关 ADR 与 01–09 兼容语义。审查是 source/test-code review，以下 reviewer 没有重跑 128/18 或 Linux/provider 实验；执行证据由实现 agent 录制并独立归档。

| 轴 | 首轮问题 | 独立修复与复核结论 |
|---|---|---|
| Standards / Pasteur (`/root/ticket10/standards`) | P2：许可错误记为实际 started；工具许可和收尾 ID 不一致，缺少完整调用结局。P3：准入逻辑重复造成语义漂移风险。 | requested/admitted 与真实 started 分开，SDK PreToolUse 不伪造进程启动；同一 invocation ID 贯穿工具/MCP 收尾，未知结局显式 unknown；共有边界路径整合。4574a6e 复核 P2/P3 关闭，无新增阻断。 |
| Spec / Linnaeus (`/root/ticket10/spec`) | P2：终态拒绝整批观测，丢失已准入调用迟到收尾。P2：模型非 2xx 仍记 completed。 | 仅已知 admitted ID 可在终态补收尾，不能新准入；混合快照先提交合法收尾再拒绝新请求，并立即 GET 断言保留。非 2xx failed。4574a6e 复核两项 P2 关闭，无新增阻断。 |

root 另做只读复核：最终 128/18 计数、实际四 Run、全 loopback 和原八资源消失、path-swap980次、最终手机边界截图；这不替代两轴 source review，也不冒充真实模型或用户人工验收。

Spec 对中间兼容修复 `05853934a07d8f6700063343c81d2edf0bef0dac` 发现新增 P2：当前执行资格清单可撤销，不能推断已在途镜像的历史停止协议；撤资格的新隔离 runner 会被误写旧 marker。保留该提交，不 amend。

最终独立修复 `82350d03082ccc86402fd190f64dbea26df724cb` 对原不可变资源先尝试固定 root marker，再独立尝试 node marker，单路径失败仍尝试另一条，最后报告错误；不开放新执行或读取模型凭据，也不从 marker 写入推导物理停止。HTTP 红6/8到绿10/10，包括名单内外及两种单路径403，types通过。

Spec 只读复核 `0585393...82350d0` 及迁移文档结论：新增迁移 P2 已关闭，未发现本次修复引入的阻断项；原两项 P2 和审计语义的关闭结论保持。reviewer 仅检查源码与断言，未重跑测试或物理实验。至此已报告问题全部关闭。

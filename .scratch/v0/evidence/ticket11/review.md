# Ticket11 双轴审查

用户显式 `$implement`，按 code-review skill 启动两个 fresh、只读 reviewer 并行工作。固定比较 `git diff 052a144f730ff0db6e5332cef384c2d2b7f99e18...f94d33614ad10d87be1c683409f8995e2122b646`；修复 `91621998077e53d2f6ffb7dfd9789e9d0f6d146e` 独立提交，未 amend。来源为 CLAUDE/docs/agents、PRD、Ticket11、API/domain/audit/validation、accepted ADR 和01–10兼容边界。

## Standards

Socrates (`/root/ticket11/standards`) 首轮：

- P1，文档规则违反：guardian 整轮 scan 被一个旧资源故障中断，后续到期任务可能永远不被巡检，违反 audit-monitoring 与 ADR0006 独立回收要求。
- P2，判断性 Duplicated Code：Worker 与 limits health 各自实现占用判定，activity 和物理责任可能漂移。不是工具可直接裁定的格式问题。

9162199 只读复核原文：

> 原 P1 已关闭：Guardian 按资源及 intent 隔离发现、删除异常，失败记录为 unknown，继续回收后续资源。新增测试覆盖连续三轮较早删除失败及 SQLite 重启恢复，符合 ADR0006 的独立回收要求。
>
> 原 P2 已关闭：调度与健康投影共用 executionSlotHeld，并由 worker.activeRunIds 提供相同活动身份，消除了占用判断漂移。
>
> 本次复核范围内未发现新的确定问题。未修改文件、未自行运行测试；测试执行结果以主代理证据为准。

## Spec

James (`/root/ticket11/spec`) 首轮 P1：独立 guardian 的单项异常会饿死后续到期任务，违反票中的“控制面与 worker 均失效时仍有独立到期／巡检停止保障”。reviewer 独立重现连续三轮首项删除异常、后项零发现；未报告其他确定缺失或 scope creep。

9162199 只读复核原文：

> 原 Spec P1 已关闭。expire() 按资源隔离失败；scan() 按 intent 继续巡检，发现失败也不抑制已知 ID 的到期处置，失败保留为 unknown。新增测试覆盖连续三轮旧资源删除失败、后项仍删除及重启后同 ID 对账。
>
> 本次只读检查固定 diff 和测试源码，未重跑测试；未发现新的确定性问题。全控制面故障实测结论仍以正在运行的最终证据为准。

Standards：原2项已关闭，剩余0；Spec：原1项已关闭，剩余0。两轴没有合并或重排。

root 另作只读核对：own-key schema、正常 main 传入 guardian、范围排版、01–11版本提示、observer 严格区分 absent/unknown 和原服务 ID、内存观测异常不阻止停止、最终139/19计数和真实资源证据。均已处理。root 的目视和技术复核不替代用户人工验收。

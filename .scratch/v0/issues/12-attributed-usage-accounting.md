# 12 — 在任务与额度页查看可信用量

**What to build:** 调用后端和维护者查看 Run 消耗及聚合用量，知道来源、单位、估计／确认及未知范围，并可供实际支持的预算维度使用。

**Blocked by:** 01 — 提交提示词并在 A 中取回已校验 JSON

**Status:** implemented-awaiting-real-and-manual-acceptance

**范围来源：** PRD + A；2026-09-14 用户接受 v0＋A 拆分后发布。

**验收对应：** AC-22。

**管理台验收对应：** A-AC-06。

## Acceptance criteria

- [x] InvocationRecord／UsageEntry 有稳定来源身份、父子／重试关联、范围和版本；累计重报、增量、乱序及重复观测不重复相加。
  - 形状、引用完整性校验、只追加合并与归一化均已交付并有回归测试。**父子／重试链接目前没有 v0 生产者**：受控边界无法证明某次工具或 MCP 调用属于哪一个模型回合，v0 也不存在阶段重试（DM-02）。字段保留、校验保序，覆盖边界由视图的 `linkage` 字段显式声明，不推断也不沉默。真实链接随 Ticket13 落地。
- [x] SDK 估算与供应商确认分别表示，同一消费不两次计入；不同供应商单位不混算，未知消费不显示为零。
- [x] 在途消费、可观察辅助调用和失败调用也计入对应范围；迟到数据可补记且不改写原始观测，不捏造供应商账单精度。
  - 确定性路径完整；真实执行层的在途导入（`opensandbox` 每秒读容器 `usage.json`）已实现但属「Docker 未验证」账。

勾选表示确定性、API、浏览器与构建产物证据已具备。**真实引擎／模型、真实供应商 token、Docker／gVisor 与人工验收仍未取得**，见下方证据出处。

## 验证与证据

- [验证账本](../evidence/ticket12/verification.md)：九类分账逐条结论。
- [双轴审查](../evidence/ticket12/review.md)：Spec 3 项实现缺陷、Standards 8 项问题，已修复并补回归测试。
- [失败与中间实验](../evidence/ticket12/failure-history.md)。
- [实现说明](../../../docs/implementation/ticket12.md)：可运行命令与最短演示步骤。

回归：类型检查通过、`npm test` 159/159、`npm run test:browser` 20/20、`npm run build` 通过、`scripts/verify-usage-release.ts` 在构建产物上 5/5、`scripts/verify-local.ts` 2/2。

## 贯穿本票的边界

- 随本票行为交付权限、关键事实持久化、失败与重复请求处理、所属审计事件及带新鲜度的健康／异常来源。观测出口使用有界字段允许清单。
- 一个 Run 至多一次实际 Agent 执行和一个权威终态；Result、Artifact 可用性和实际回收独立。未知结果先对账，业务重做须新 Run，阶段重试不重置累计限制。
- 页面与 API 查询同一事实；管理操作由服务端授权。提供刷新、越权和错误恢复证据，不以模拟控件或替身结果代替真实路径。

## Comments

- 2026-09-14：根据用户“接受”发布；尚未开始产品实现或验收。
- 2026-09-14：用户在 Ticket11 人工停点上明确要求实现 Ticket12，据此推进。实现、验证、双轴审查与修复完成。Ticket11 的人工 smoke 仍未反馈，本票也未取得真实模型／供应商／Docker／人工验收。

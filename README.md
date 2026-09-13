# AtomicAgent

基于 coding agent 的独立任务执行 API 平台。2026-09-14 已确认 v0＋A 运维管理台范围，并发布 33 张 tracer-bullet 本地实施票。ticket01 已建立首个可运行切片；真实 Linux／模型验收仍待获准配置。

- [ticket01 启动、API 合约与验证账本](docs/implementation/ticket01.md)：首次 `npm ci` → `npm run setup:local` → `npm run build` → `npm start`，访问 `http://127.0.0.1:4310`。默认明确使用确定性实验替身。

- [v0 产品需求文档（PRD）](docs/PRD-v0.md)
- [33 张实施票、依赖与验收覆盖](.scratch/v0/ticket-plan.md)
- [本地 tracker 约定](docs/agents/issue-tracker.md)
- [Web 管理台交互原型 · 已选 A 运维总览](docs/prototypes/admin-console-prototype/README.md)（模拟数据，已记录设计选择）
- [研究综合与项目对照](docs/research/00-synthesis.md)
- [OpenSandbox 与 Sandcastle 源码对比](docs/research/05-opensandbox-vs-sandcastle.md)
- [当前需求基线](docs/requirements-baseline.md)
- [任务 API 合约草案](docs/task-api-contract.md)
- [两类样例与故障验证计划](docs/validation-plan.md)
- [需求挖掘与决策树](docs/requirements-discovery.md)
- [逐轮访谈与确认记录](docs/interview-log.md)
- [领域术语](CONTEXT.md)
- [领域对象、关系与不变量](docs/domain-model.md)
- [审计与监控缺口、规格和验收](docs/audit-monitoring.md)
- 已确认决策：[独立任务](docs/adr/0001-independent-tasks.md)、[登记配置与外部只读](docs/adr/0002-registered-readonly-capabilities.md)、[任务与产物生命周期](docs/adr/0003-run-sandbox-artifact-lifecycles.md)、[重试边界](docs/adr/0004-explicit-retry-boundaries.md)
- 已选技术方向：[OpenSandbox + Claude Agent SDK](docs/adr/0005-opensandbox-with-claude-sdk.md)
- 已确认运行保障策略：[审计故障与资源责任边界](docs/adr/0006-audit-and-observation-boundaries.md)

研究建议不自动成为实施决策；尚未部署、调用付费模型或验证生产性能。

# AtomicAgent

调用后端提交一项 Agent 任务，平台在独立 sandbox 中运行固定的 Claude 引擎完成它，交付经平台校验的 Result 与 Artifact。任务内容不限定为软件开发；任务之间互不继承会话、文件与进程。

当前范围 **v0＋A**（任务 API ＋ 运维管理台），按 33 张 tracer-bullet 票推进。

## 现在到哪了

- 01–12 已实现、验证、双轴审查并提交；13 起未开始。
- Ticket11 后设立的人工 smoke 停点仍在等待实际体验反馈；用户已明确指示先推进 12。
- 已有一个 fixture 云端实例与 GitHub CI 自动部署。
- **未验收**：获准模型的真实执行、gVisor 隔离、生产容量、人工 AC。

逐票状态与外部输入缺口以 [实施推进记录](.scratch/v0/execution-progress.md) 为准，不从票号顺序推断。

## 跑起来

```bash
npm ci && npm run setup:local && npm run build && npm start
```

访问 `http://127.0.0.1:4310`，令牌在 `setup:local` 生成的 `.local/config.json` 里。本机默认 fixture：不调模型、不起容器。

## 给 coding agent

入口是 [CLAUDE.md](CLAUDE.md)（[AGENTS.md](AGENTS.md) 指向同一份）。它下面挂着 [代码地图](docs/agents/codebase.md)、[证据分账](docs/agents/evidence.md)、[领域约定](docs/agents/domain.md)、[tracker 约定](docs/agents/issue-tracker.md) 和 [分诊标签](docs/agents/triage-labels.md)。

## 规范文档

产品与领域

- [v0 PRD](docs/PRD-v0.md) — 需求正文：72 条故事、AC-01–28、A-AC-01–12
- [领域术语](CONTEXT.md) 与 [领域模型](docs/domain-model.md)（对象、关系、不变量 DM-01–12）
- [已接受的 ADR 0001–0006](docs/adr/)：[独立任务](docs/adr/0001-independent-tasks.md)、[登记配置与外部只读](docs/adr/0002-registered-readonly-capabilities.md)、[任务与产物生命周期](docs/adr/0003-run-sandbox-artifact-lifecycles.md)、[重试边界](docs/adr/0004-explicit-retry-boundaries.md)、[OpenSandbox ＋ Claude SDK](docs/adr/0005-opensandbox-with-claude-sdk.md)、[审计与观测边界](docs/adr/0006-audit-and-observation-boundaries.md)

规格与验收

- [任务 API 合约](docs/task-api-contract.md) — 协议草案
- [验证计划](docs/validation-plan.md) — 两类样例与故障材料
- [审计与监控规格](docs/audit-monitoring.md) — A／M／AL／V-AO 目录
- [票务计划与覆盖图](.scratch/v0/ticket-plan.md) — 33 票、依赖与验收映射
- [逐票实施说明](docs/implementation/) — 每票的实现与结论摘要

运行

- [云端验收部署](docs/cloud-deployment.md) — 运行边界、CI 与发布事务

## 历史与归档

以下保留追溯价值，不是当前执行依据。

- [需求基线](docs/requirements-baseline.md)、[需求挖掘](docs/requirements-discovery.md)、[访谈记录](docs/interview-log.md) — 需求确认过程
- [研究综合](docs/research/00-synthesis.md) 与 [OpenSandbox／Sandcastle 源码对比](docs/research/05-opensandbox-vs-sandcastle.md) — 选型时的带来源研究，不是本次重新验证的结论
- [管理台原型 A](docs/prototypes/admin-console-prototype/README.md) — 模拟数据的交互原型；结构已选定，控件不自动成为实现承诺

研究建议不自动成为实施决策。

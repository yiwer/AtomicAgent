# Domain Docs

## 开始任务

1. 读取 [CONTEXT](../../CONTEXT.md) 的领域术语及本票涉及的 [accepted ADR](../PRD-v0.md#决策依据与文档权威)；对象关系与不变量见 [领域模型](../domain-model.md)。
2. 以 [v0 PRD](../PRD-v0.md) 为需求正文；[票务计划](../../.scratch/v0/ticket-plan.md) 给出已批准的 A 范围、依赖及覆盖，逐票文件拥有实施验收细节。
3. 实现 API、执行／交付、运行保障时，分别按需读取 [API 合约](../task-api-contract.md)、[验证计划](../validation-plan.md)、[审计监控规格](../audit-monitoring.md)。字段与组件可细化，既定业务语义及 accepted ADR 保持一致；发现冲突时明确记录。

## Tracer bullet 交付

每票同时完成本行为的入口、持久事实、实际执行或查询、副作用及行为验证。审计和健康来源随对应行为交付，使用领域术语表达结果与未知状态。

证据分别记录确定性故障实验、真实引擎／模型、网络、业务内容、Docker／gVisor、通知投递及浏览器／人工验收。原型只提供交互证据；未验证项保持未完成。

平台采用单一 AtomicAgent 领域。工程入口仅用于开发协作，不作为任务 sandbox 的配置来源。

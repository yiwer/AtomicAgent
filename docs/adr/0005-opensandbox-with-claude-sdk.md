---
status: accepted
---

# 使用 OpenSandbox 管理执行空间，直接接入 Claude Agent SDK

首期采用 OpenSandbox 作为执行空间底座，以 Claude Agent SDK 对接已确定的 Claude runtime；任务状态、幂等、结果验证和保留由 AtomicAgent 自己管理。文件处理和资料研究不以 Git 分支与提交为领域对象，因此暂不引入 Sandcastle 的仓库编排层。

Sandcastle 已有程序化执行、结构化结果和 provider 扩展能力，但直接复用其高层工作流需要调整 Git 依赖、会话/工作区保留与清理确认。保留它作为未来仓库任务和 Agent 编排的参考，避免首期同时承担两层适配。

建议先在独立 Linux 节点验证 OpenSandbox Docker 路径，再对 gVisor 做同工作负载验证。该选型不表示 SDK/模型兼容性、隔离或性能已经通过；依据见 [固定版本源码比较](../research/05-opensandbox-vs-sandcastle.md)。

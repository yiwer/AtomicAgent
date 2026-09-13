# Agent runtime API：执行契约、协议与可靠性研究

研究日期：2026-09-12。状态：需求访谈材料，尚未形成已批准的架构决策。

访谈上下文更新：用户已确认首批调用方是自有后端。文件处理/研究样例、外部只读、任务独立、登记配置组合仍在访谈中，本文不将其记为已决策。

本文只讨论一次请求如何成为可管理的执行、如何得到可信结果以及如何处理失败。所有外部事实均来自本次实际打开的一方文档或源码 README；`main`、无版本文档可能漂移。没有运行项目、测量性能或验证其生产安全性。

## 1. 先明确平台卖给调用方什么

**设计判断，待用户确认：**“放大一次 LLM 调用”可以作为体验目标，但内部更接近带隔离工作区、预算、工具授权和结果验收的执行服务。HTTP 连接、agent 对话以及执行成功是不同事实。

以下两种产品承诺会导向不同的实现成本：

| 候选承诺 | 调用方真正得到什么 | 最难的边界 |
| --- | --- | --- |
| 计算与产物服务 | 文本、JSON、文件、补丁、报告；允许读取外部信息 | 产物校验、隔离、时限、成本与可恢复交付 |
| 外部行动服务 | 还可以发消息、提交 PR、修改数据库、触发部署 | 授权、操作身份、回执、结果未知时的对账与补偿 |

第二种不能靠“sandbox + agent 自动重试”自然获得可靠性。Sandbox 中的代码仍可能利用获授凭据修改外部世界。可选择先限制外部写入、先支持少数经过治理的连接器，或直接承诺开放式外部行动；三者都应显式写进范围，而不是隐含在 `mcp` 配置里。

## 2. 已核实的参考实现与协议边界

### 2.1 OpenHands：最贴近目标的实现参考，但不是已验证的完整平台

**事实：**Software Agent SDK 的 remote agent server 分为调用客户端、HTTP/WebSocket agent server、workspace。`Conversation` 可连接本地、Docker 或 API remote workspace；远端 workspace 支持命令与文件传输。参见 [OpenHands remote server overview](https://docs.openhands.dev/sdk/guides/agent-server/overview)。

**事实：**实际 agent-server README 将自身描述为 minimal REST/WebSocket 服务，使用本地文件存储 conversation、event、workspace，面向开发、测试和轻量部署；包含可选 API key 认证、webhook 等能力。它还分别描述去敏的生命周期遥测与可能含完整提示词/响应的 completion logging。参见 [agent-server 源码 README](https://github.com/openhands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/README.md)。

**设计启发：**值得学习 `Conversation` 与 `Workspace` 的分离、agent server 的远端控制边界，以及事件与调试日志的区别。不能从其高层架构宣传推导出跨租户授权、配额、公网 API 幂等或灾难恢复已经满足本平台要求。它原生服务 OpenHands SDK；是否适合承载其他 coding agent，还需要代码实验，不能直接视为通用 Codex/Claude/pi 宿主。

### 2.2 ACP / A2A / MCP 是不同层的候选，不是三选一

| 协议 | 已核实事实 | 对平台的候选用法与缺口 |
| --- | --- | --- |
| ACP（此处指 **Agent Client Protocol**） | 面向 client 与 coding agent；`session/new` 提供工作目录与 MCP server 列表；加载旧 session 需要能力声明 | 可作为 sandbox 内 adapter 与 agent 之间的协议。Session 恢复能力不等于工作区快照或外部副作用恢复 |
| A2A v1.0.0 | 有 Task、Message、Artifact，支持获取、取消、订阅任务；取消可能失败；Send Message 的幂等性只是 MAY | 可作为外部 agent 互操作入口或外部任务模型参考；平台仍要定义镜像、预算、租户、输入版本与更严格幂等契约 |
| MCP | 连接 host/client/server，server 暴露 tools/resources/prompts；host 负责权限与协调 | 可作为运行中的工具与上下文接入。不能把 MCP server 的可达性当成使用授权，也不能把协议隔离视为进程/内核隔离 |

来源：[ACP introduction](https://agentclientprotocol.com/get-started/introduction)、[ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[A2A v1.0.0 specification](https://a2a-protocol.org/v1.0.0/specification/)、[MCP 2025-11-25 architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture)。

**协议细节：**ACP `end_turn` 仅表示模型结束当前轮、没有继续请求工具；其他 stop reason 包含 token/请求次数限制、拒绝与取消。发出 `session/cancel` 后仍可能收到最后的更新，agent 应在中止操作后以 `cancelled` 结束原 prompt 请求。因此平台不可把“发出取消”或“收到 end_turn”直接映射为业务终态。参见 [ACP v1 prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)。

**版本陷阱：**MCP 2025-11-25 中的 Tasks 是实验性能力；本次打开的官方扩展文档已经展示 `io.modelcontextprotocol/tasks`、`tasks/get/update/cancel` 及返回 durable handle 的模型，取消为协作式。不能再把 MCP 概括成“只能短同步工具调用”。两代 wire shape 有差别，接入必须固定规范版本并做能力协商。参见 [2025-11-25 Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)、[当前 Tasks 扩展说明](https://modelcontextprotocol.io/extensions/tasks/overview)。本报告不假设所有 coding agent 已实现该扩展。

### 2.3 Temporal：可靠编排参考，不会自动让外部行动 exactly-once

**事实：**Temporal 根据 event history replay 恢复 workflow 进度。活动成功但未成功上报时，activity 仍可能被重试；官方明确建议 activity 幂等，并区分“一次观察到完成”和“实际代码可执行多次”。参见 [Workflow execution](https://docs.temporal.io/workflow-execution)、[Activity definition](https://docs.temporal.io/activity-definition)。

**设计建议：**如果采用 Temporal，可让它编排 admission → provision → execute → collect → finalize → cleanup，将平台命令变成有稳定 ID 的操作。不要把整只 agent 包成一个可无条件重试的 activity，再据此承诺每个工具动作只发生一次。一个巨大的黑盒 activity 只能让重试边界覆盖整个黑盒。

**事实：**Temporal 官方幂等文章指出，调用外部系统的 activities 需要由下游执行幂等键或相应业务设计。其 workflow/activity ID 组合示例在 activity 重试间稳定。参见 [Idempotency and durable execution](https://temporal.io/blog/idempotency-and-durable-execution)。

**待验证：**本项目是否有足够多的长任务、等待/恢复路径和运营规模值得引入 Temporal；一个数据库任务表、租约、队列和 reconciliation worker 是否已经足够。选择应基于可靠性需求和团队运维条件，不能仅因为“agent 是长任务”就决定用 Temporal。

### 2.4 成熟 API 的可借鉴契约

**事实：**Google AIP-151 对长操作提供独立 Operation 资源，允许之后查询进度和结果，并区分“不能开始的请求错误”与“执行中的 operation error”。其 protobuf 约束属于 Google API 体系，不是所有平台必须照搬的通用要求。参见 [AIP-151](https://google.aip.dev/151)。

**事实：**Stripe 的入口幂等保存首次执行的状态码与 body，重用相同 key 会返回已有结果；相同 key 不同参数会报错，保留期也是契约的一部分。参见 [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)。

**设计启发：**可以借鉴“先持久化任务身份，再确认已接受”“查询得到权威状态”“明确 key 作用域与 TTL”。不要把 Stripe 的具体保留天数、错误缓存规则或 Google 的特定 proto 硬套到本产品。

## 3. 候选领域对象：先分清身份，再决定字段

以下均为设计候选，名称与是否公开仍待访谈确认。

| 对象 | 定义与身份 | 生命周期/边界 |
| --- | --- | --- |
| Request | 一次 API 传输交互，`request_id` 用于追踪 | 同一个 Run 的提交重试可产生多个 Request；HTTP 结束不代表 Run 结束 |
| Run | 调用方授权完成的一份逻辑工作，`run_id` | 持有已解析输入、预算、能力授权、终态与结果引用；入口去重在这一层 |
| Attempt | 平台对 Run 的一次具体执行尝试，`attempt_id`、递增 epoch | 标记运行环境与 agent 身份、开始/退出、失败分类；重试新建 Attempt，不能抹除旧证据 |
| AgentSession | 底层 agent 的会话 ID 与上下文 | 属于 adapter；不保证跨 agent 可移植，也不保证能恢复进程中间态 |
| SandboxLease | 对某个隔离执行环境的限时占用 | 可早于 agent 启动、晚于业务完成；回收状态独立于 Run 结果 |
| Result | 按调用契约验收后的结果 envelope | 文本、结构化值、验证报告、产物 manifest；应可在 sandbox 销毁后读取 |
| Artifact | 已导出的产物对象 | 独立访问控制、大小/hash/type/保留期；sandbox 内路径不是稳定下载地址 |
| EffectOperation（若允许外部写入） | 一次逻辑副作用，`operation_id` 在重试间保持 | 保存请求摘要、下游幂等 key、receipt、核验结果；不能只依赖瞬时 tool-call ID |

“一次 API”不必公开 Session；同一 Run 内是否允许 adapter 重连、补充 prompt、格式修复或多轮 agent 调用，也不必改变调用方的一次工作语义。但任何修复/重试仍消耗该 Run 的总预算。

## 4. 外部 API 候选：持久 Run + 可选有限等待

**建议而非决定：**内部以持久 Run 为基础，同时给调用方同步风格的 SDK。

```text
POST /v1/runs                 接受并返回 run_id；可选择有限 wait
GET  /v1/runs/{run_id}        查询权威状态、终止原因、结果引用
GET  /v1/runs/{run_id}/events?after=<cursor>
POST /v1/runs/{run_id}:cancel 请求停止，返回当前已知状态
GET  /v1/runs/{run_id}/result 读取已提交结果
```

是否直接采用 A2A、是否需要 webhook、是否提供 OpenAI 风格兼容 endpoint，均为独立选择。单有相似 JSON 字段不足以称为语义兼容：耗时、错误、断连、usage、工具调用可见性以及结果模式都要定义。

候选契约：

1. **接受持久化后再响应。**`202` 代表工作已接受，不代表执行成功；快速完成可以直接返回终态对象。具体 status code 在 API 设计阶段定稿。
2. **HTTP 等待与执行 deadline 分开。**`wait_timeout` 结束时返回 Run handle；只有执行 deadline 才影响工作继续。客户端断连默认是否继续是必须确认的产品选择，不能由网关超时偶然决定。
3. **入口幂等。**`caller_scope + idempotency_key` 绑定一个 Run。区分 `submission_digest`（原始提交规范化后的摘要，包含调用方提交的 URL/版本引用）与 `resolved_spec_digest`（首次解析得到的文件内容、skill、镜像等固定版本摘要）。重复提交先查已有 Run，再比较 submission_digest；相同提交返回原 Run，不重新取件后因远程内容变化而误判冲突。首次提交才解析并固定 resolved spec，两个摘要都存储。并发首次提交需要原子占位/唯一约束，避免各自解析后创建两个 Run。新业务重跑或取最新内容应显式生成新 Run/key。
4. **事件是观测视图。**携带 `run_id/attempt_id/event_id/sequence/type/schema_version`，支持 cursor、重复去重和明确保留期；SSE 完成或 EOF 不能单独作为成功证据。遗漏事件时用 GET Run 收敛。
5. **Webhook 是投递机制。**若提供，定义签名、重放防护、重试、去重与死信；Run 成功与 webhook 送达分开。webhook URL 还需要出站安全控制。

## 5. 候选状态与完成判定

为避免把基础设施细节全暴露给客户，可将少量公开状态与详细 phase 分开：

```text
Run.status:
  queued → running → succeeded
                   → failed
                   → cancelled
                   → timed_out
  queued → cancelled / timed_out

Run.phase（非终态的执行进度）:
  admission / provisioning / preparing / executing /
  collecting / validating / committing / reconciling

独立事实:
  cancel_requested_at
  termination_reason
  effect_outcome = none / confirmed / unknown
  cleanup_status = pending / complete / failed
```

可选的 `awaiting_input` 或 `awaiting_authorization` 会使外部 API 成为可交互任务服务。若目标坚持无人值守、一次输入，遇到缺失权限/必须澄清的问题时应返回明确失败或不完整结果，而不是偷偷自动批准，也不是无限等待。这是首轮需确认的范围分叉。

`reconciling` 是否应成为独立公开状态，取决于用户是否允许外部行动及其等待 SLA。对账超期可以结束为 `failed + effect_outcome=unknown`；这表示平台无法完成契约，不表示外部动作确定未发生。

建议将 `succeeded` 的必要条件定义为：

1. Adapter 收到可识别终止信号，并记录原始 stop reason/exit 信息。
2. 结果满足约定 envelope/JSON Schema、必需文件存在、大小与格式等机械约束。
3. 必需 artifacts 已上传至持久存储，manifest 验证通过，结果引用已提交。
4. 如承诺外部写入成功，相关 receipt/核验满足该连接器的成功条件。
5. Run 终态与结果引用完成一次有并发保护的持久化提交。

这证明执行与输出契约满足，不自动证明开放任务的事实正确或代码在生产正确。可另设任务专属 validator；“agent 自称完成”“退出码 0”“JSON 合法”都不能独自代替业务验收。是否需要部分结果、可接受的语义错误率与人工验收，应由具体首批场景决定。

## 6. 失败矩阵与恢复边界

以下是设计建议与待做故障注入，不是已验证行为。

| 场景 | 必须保留的事实 | 候选处理 |
| --- | --- | --- |
| POST 已接受但响应丢失 | idempotency key → Run | 相同 key 找回原 Run，不新建 sandbox |
| Sandbox 创建成功但控制面未收到响应 | provisioning operation ID / provider sandbox ID | 先按身份查询对账；供应商支持时用幂等创建 |
| Worker 暂时失联，旧进程仍运行 | lease/epoch、agent 与 sandbox 身份 | 先 fencing、撤销出站能力或确认旧环境停止，再决定接管；仅数据库租约过期不足以阻止旧进程写外部系统 |
| agent 出现认证/配置错误 | adapter error 分类与有效配置版本 | 终止或等待显式更正；不可无限重试 |
| 模型 429/短暂 5xx | 累计预算、provider retry hint | 有界退避；adapter 内重试也要可观测 |
| agent 已输出但 JSON 不合法 | 原始输出、校验错误 | 可选预算内修复；修复轮数有界，失败保持明确 |
| 产物已上传但终态提交失败 | manifest ID、内容摘要、提交操作 ID | 重试提交，不重跑整个 agent |
| Result 已提交，sandbox 回收失败 | 成功结果与 cleanup_status | 保持结果可读，独立回收重试/告警；回收故障不能触发业务重做 |
| 取消和完成同时发生 | 取消意图、提交版本、实际停止证据 | 定义线性化点；先完成则返回成功，发出取消不能覆盖已提交结果 |
| agent 忽略合作式取消 | grace deadline、进程/环境身份 | 到期强制终止；记录方式与仍未知的外部影响 |
| 外部写入成功但回执丢失 | operation ID、请求摘要、下游 identity | 优先查询/同 key 重放；无可靠核验能力则标 unknown，不盲目执行新动作 |
| SSE 断线或 webhook 重复 | event cursor / delivery ID | 重新查询与去重；投递次数不能改变执行次数 |
| 任务/事件/产物过期 | 独立保留策略 | 明确已过期与无权限/不存在的返回约定；不能默默重做 |

如容许任意 shell 直接出网并携带长期密钥，平台通常无法逐一感知与治理所有副作用；想承诺可核验的外部行动，必须把出站能力收敛到能执行操作身份、授权和回执记录的边界，或明确排除该保证。

## 7. 输入、skills、MCP 与预算的边界

### 输入不是只有 prompt

**设计建议：**在运行前解析一份不可变 `resolved_spec`：agent/version、model/provider、image digest、初始文件 manifest、skill 包版本/hash、MCP server 身份与所需权限、输出契约、预算与保留策略。初始文件可通过预上传引用装载；不直接接受宿主机任意路径。远程 URL、压缩包、软链接和安装脚本都应受受限取件/展开规则管理。

Skills 中的文本可能改变 agent 行为，其脚本本身可能执行任意代码；MCP stdio server 是进程，远端 server 是数据与能力边界。因此租户提供的 skills/MCP/环境安装不能在控制面执行。平台系统规则与平台密钥不应存放在 agent 可改写的工作区。是否允许自定义镜像、任意依赖安装、任意 MCP URL，会直接改变安全与冷启动目标。

**事实：**MCP 的安全指南明确讨论 confused deputy、token passthrough、SSRF 与 session hijacking，禁止未校验 token audience 的 token passthrough。参见 [MCP security best practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)。

**设计建议：**使用秘密引用和短期按 Run 授权的凭据、网络出口策略、受控 MCP 配置与逐次工具授权；这些是外部强制边界。提示词中的“不要泄密”不能承担租户隔离。审计日志、LLM 原始 payload 和客户可见事件应有独立的内容与保留策略。

### 预算必须由平台执行，不只写在 prompt

| 预算 | 需要明确的计量与强制边界 |
| --- | --- |
| 时间 | 排队、启动、agent 执行、整体 deadline、取消宽限期分别计量 |
| 模型调用 | 请求次数、输入输出 tokens、并行调用；所有 Attempt、subagent、修复轮合计 |
| 金额 | 估算、已确认计费、在途预留分别显示；provider usage 延迟与价格版本明确 |
| 计算 | CPU、内存、磁盘、进程数、GPU 与网络 |
| 输出 | artifact 总大小/数量、stdout/event 大小、保留期与下载成本 |
| 租户 | 并发、队列长度、速率、总额度与公平性 |

**待验证：**如果供应商计费回报滞后，平台无法仅靠事后 token 统计承诺绝对零超支。可通过限制在途调用、调用前预留、强制 max output、统一模型出口来控制上界；实际能提供硬上限还是有界超额，需要 adapter 和模型供应商实测。调用方自带不受平台代理的密钥会削弱成本强制能力。

## 8. 建议带入访谈的关键问题

以下是访谈问题清单，不表示应一次问完，也不是已选方案。

1. 首个付费/真实调用场景是什么？给出输入文件、请求、预期结果，以及调用方判断成功的程序。
2. V1 是否允许外部写入？若允许，是任意 shell/MCP，还是少数明确操作？结果未知时宁愿重复、等待对账还是返回 unknown？
3. “单次”指一次业务任务、一次 HTTP 请求、一个 agent prompt-turn，还是绝不出现人工交互？
4. 可接受的总时延、并发、单任务成本与失败率是什么？冷启动是否已包含在内？
5. 需要文本、JSON Schema、文件、repo patch 中哪些输出？谁验收语义正确性？
6. 断连后是否继续？支持取消、恢复、人工补充输入的最小集合是什么？
7. 重试时可以接受模型重新规划和结果不同吗？还是必须恢复同一 session/工作区？
8. 初始文件、skills、MCP、镜像由可信开发团队配置，还是任意租户提交？
9. 哪些底层 agent 能力是必须一致的，哪些允许 capability negotiation 或明确不支持？
10. 输入、日志、产物、会话和幂等记录各保留多久，sandbox 何时销毁？

## 9. 小规模验证建议

### 自有后端场景的最小候选实现

**建议，尚未批准：**自有后端不要求立即提供公共 agent 互操作协议。可以先用一个版本化 HTTP Run API、关系数据库、worker 和对象存储，暂不采用 Temporal 或 A2A 兼容入口。首期可按一个受信服务调用方做认证、Run 归属与访问控制；`caller_scope` 不要求立即实现公开多租户组织、配额和计费系统。全文的 tenant 场景用于说明未来边界，不是首期默认工作量。

数据库与普通 worker 即可承担以下可靠性机制；是否达标仍需故障注入：

- 用数据库事务同时写入 Run 与待执行 job/outbox，避免“已接受但未入队”；worker 可先轮询 job 表，不必立即增加消息中间件。
- 用 `caller_scope + idempotency_key` 唯一约束去重，存储 submission_digest、首次解析的不可变 resolved spec 及其 digest、终态结果引用。重试先找回已绑定 Run，再比较提交摘要，不重新解析可变 URL。
- 用 lease、heartbeat、attempt epoch 与条件更新处理 worker 竞争；对失联 sandbox 先停止/核验再重跑。数据库锁本身不隔离旧 sandbox。
- 用 append-only event 表提供有序 cursor 与可恢复查询；对象存储持久化 artifacts，提交 manifest 后再写成功状态。
- 用独立 reconciliation/cleanup job 重试环境创建对账、产物提交和回收；配置整体 deadline、最大 attempts 与失败分类。

若后续出现跨天恢复、多级等待/人工交互、复杂补偿、跨服务编排以及明显增加的恢复逻辑维护成本，再评估 Temporal。即使采用 Temporal，Run/Attempt/Artifact 的产品契约仍需要自己定义。

如果进入实现，建议选择一个真实产物任务，先接一个 agent，完整跑通提交、隔离装载、预算、校验、持久结果、销毁和断连找回；再加第二个 agent 验证公共契约是否合理。无需先把所有供应商接齐。

最低验证应包含：并发重复提交只产生一个逻辑 Run；控制面重启后查询恢复；结果提交前后分别宕机；取消与成功竞态；恶意初始文件无法越过装载边界；预算作用于全部重试；产物在 sandbox 销毁后仍可取得。若允许外部写入，再额外模拟“外部成功、响应丢失”且确认不会盲目重复。

本报告没有给任何候选打生产 PASS，也没有决定使用 A2A、ACP、Temporal 或 OpenHands。协议互操作、安全边界与实际 adapter 行为仍需要按选定版本做验证。

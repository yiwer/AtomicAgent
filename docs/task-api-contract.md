# AtomicAgent 任务 API 合约草案

2026-09-14 范围更新：v0＋A 已纳入真实 Web 管理台，见 [PRD 第 10 节](PRD-v0.md#10-已批准的-a-管理台范围)。下文“无管理后台／不引入公开管理后台”保留原 API 基线语境；正式管理入口采用同一持久事实和独立服务端授权，API 的候选字段仍待实施定稿。

更新：2026-09-13。用户已确认 [需求基线](requirements-baseline.md) 的共同理解，本文的任务语义与实验默认值作为后续依据。下列路径、字段名和状态名称仍是待实施规格定稿的设计草案，尚不是实现或兼容性承诺；不把底层 Claude CLI 输出直接作为公共协议。

## 1. 最小接口面

| 接口候选 | 目的 | 关键语义 |
| --- | --- | --- |
| `POST /v1/files` | 上传初始文件，得到文件身份 | 上传结束并校验后才可引用；不能提供宿主路径 |
| `POST /v1/runs` | 提交独立任务 | 使用 `Idempotency-Key`；接受记录持久化后才响应 |
| `GET /v1/runs/{run_id}` | 获取权威状态 | 返回终止原因、阶段、结果/产物引用和清理状态 |
| `GET /v1/runs/{run_id}/events` | SSE 观察进度 | 可用事件游标继续读取；EOF 不代表成功 |
| `POST /v1/runs/{run_id}:cancel` | 显式请求停止 | 接受取消意图不等于已停止；以最终状态为准 |
| `GET /v1/runs/{run_id}/result` | 取回已提交结果 | 与原提交连接无关；产物过期后 JSON 可仍在保留期 |
| `GET /v1/artifacts/{artifact_id}` | 查询/下载产物 | 校验调用权限；区分短期下载链接过期和文件已删除 |

可通过提交参数的有限等待或客户端 SDK 包装提供“调用并等待结果”。等待期限不改变任务总期限；连接断开后任务继续，调用后端利用 Run 身份或原幂等键找回它。

## 2. 请求内容示例

以下 ID 是示意占位符，不是已登记资源。首期固定 Claude，不提供允许任意切换 Agent 的请求字段。

```json
{
  "prompt": "按输入规则处理数据，返回输出文件和统计结果。",
  "inputs": [
    {"file_id": "file_example", "path": "input/data.csv"},
    {"artifact_id": "artifact_example", "path": "input/rules.json"}
  ],
  "environment": {"profile_id": "python-node", "version": "1"},
  "model": {"profile_id": "approved-test-model", "version": "1"},
  "skills": [{"id": "data-processing", "version": "1"}],
  "mcp": [{"id": "readonly-reference", "version": "1", "parameters": {}}],
  "output": {
    "schema": {
      "type": "object",
      "properties": {"row_count": {"type": "integer", "minimum": 0}},
      "required": ["row_count"],
      "additionalProperties": false
    },
    "required_artifacts": [{"path": "output/processed.csv"}]
  },
  "limits": {"total_timeout_seconds": 3600}
}
```

配置清单分别规定允许的参数、secret 引用、工具、网络访问和资源上限。请求可以在允许范围内收紧或覆盖配置，不能通过参数赋予新的权限。镜像、CLI/SDK、模型身份、Skills/MCP 版本和输入摘要解析后写入本次执行清单，方便追溯。

## 3. 状态与结果

候选公开状态：`queued`、`running`、`succeeded`、`failed`、`cancelled`、`timed_out`。详细阶段单列为 `phase`，例如准备环境、装载输入、执行、收集、校验、提交。

```text
queued ─→ running ─→ succeeded / failed / cancelled / timed_out
  └────────────────→ failed / cancelled / timed_out

任务终态提交 ─→ cleanup: pending ─→ complete
                                  └→ retrying / failed
```

状态只是协议候选；关键不变量是：只有一个已提交任务终态，迟到的 agent 事件或旧 worker 不能改写它。`cancel_requested_at` 记录取消意图，`cleanup_status` 记录回收事实；两者都不冒充最终任务结果。

成功结果示例：

```json
{
  "run_id": "run_example",
  "status": "succeeded",
  "summary": "处理完成。",
  "result": {"row_count": 120},
  "artifacts": [{
    "artifact_id": "artifact_output",
    "path": "output/processed.csv",
    "size_bytes": 4096,
    "media_type": "text/csv",
    "availability": "available",
    "expires_at": "<任务终态时间加24小时>"
  }],
  "usage": {
    "model_calls": 3,
    "input_tokens": 1000,
    "output_tokens": 300,
    "provider_reported_cost": null
  },
  "cleanup_status": "pending",
  "record_expires_at": "<任务终态时间加7天>"
}
```

示例中用量为虚构的字段演示，不是测量数据；`null` 表示没有可核实的供应商成本，不表示免费。真实字段要区分供应商报告、平台估算和未知；Qwen 不能直接沿用 Claude 的美元成本估值。

`succeeded + cleanup_status=pending` 表示结果已提交且清理已触发，尚无清理完成证据。回收重试不覆盖成功结果。终态后禁止继续产生新的任务动作，并以执行层实际进程/环境状态确认回收。

## 4. 幂等与保留

同一调用方的幂等 key 绑定一份提交摘要和一个 Run，保留 7 天。接受请求的持久化事务解决并发重复；只有一个逻辑任务能从该 key 产生。

- 相同 key、相同提交：返回已有 Run，包括仍在运行、已失败或产物已过期的 Run。
- 相同 key、不同提交：返回冲突，不修改原任务。
- 相同任务材料但新 key：视为调用方显式要求新任务，会再次计算并可能产生不同结果。
- 先查已存在 Run，再比较提交；不重新下载可变内容或解析新版配置来“验证”一次旧提交。
- 初次解析的执行清单摘要与 API 提交摘要分开：一个说明实际执行了什么，一个判断是否重复提交。
- 记录过期后不再承诺旧 key 去重；调用后端应为新业务请求生成新 key。如何向长期离线客户端报告过期在 API 定稿时确认。

产物过期不会触发重新执行。7 天记录窗口内查询返回清单及 `availability=expired`；JSON 结果仍按自身保留规则存在。

## 5. 事件和可观测性

每个任务事件携带版本、Run、单调序号、发生/记录时间与类型；Attempt、能力调用和资源身份在实际存在时才关联，排队事件不能伪造一个尚未启动的 Attempt。事件默认包含阶段、工具名、耗时、用量、结果验证或错误摘要，不发送原始凭据、完整输入、原始模型对话或无限 stdout。

SSE 重连可以重复收到事件，调用方按序号去重。游标已过保留窗口时明确报告，调用方查询权威 Run 状态。任务成功由持久结果决定，不由“最后收到一条 done”或 HTTP 正常关闭决定。

任务事件是客户可见的授权投影。内部任务审计另记主体、动作、授权/配置修订、对象和结果证据；SSE 不作为审计原件，不能暴露 worker、宿主路径、secret 引用或其他调用方的信息。审计查询、监控和告警的具体范围见 [审计与监控规格](audit-monitoring.md)。

用量响应补充 `source`、`unit`、`measurement_scope`、`completeness` 和观测版本等信息；供应商未提供或适配器未覆盖的值保持未知。归一化处理累计快照、增量和重复事件，不能将不同来源对同一调用的估算与账单相加。

清理状态由 [资源回收单](domain-model.md) 汇总，需记录最近核验时间和未知/失败原因。`Artifact.availability=expired` 表示到期不可读取，物理删除是否核验完成是内部独立事实；签发下载 URL 不等于下载完成。

## 6. 失败合约

| 候选错误类别 | 对调用方的含义 | 重试规则 |
| --- | --- | --- |
| `invalid_request` / `config_unavailable` | 输入不合格或登记配置不存在/不可用 | 修正请求；不能静默换环境或工具 |
| `required_capability_failed` | 必需 Skill/MCP 没有成功加载 | 明确失败；不得继续假装完整能力运行 |
| `provisioning_failed` | 执行环境未准备成功 | 先核对既有资源，阶段内有界重试 |
| `runtime_failed` | Claude 或其模型连接无法继续 | 保留原始原因的脱敏分类；不自动重跑整项任务 |
| `execution_lost` | 无法安全接管失联执行 | 终止原执行、返回失败；清理状态独立可查 |
| `output_invalid` | 结构化输出或必需文件要求不满足 | 不宣告成功；是否启用有限格式修复由登记策略声明 |
| `artifact_commit_failed` | 文件或结果没有完成持久交付 | 重试收集/上传/提交阶段，不重跑 agent |
| `budget_exceeded` | 超过某项实际可执行的预算 | 明确限制维度，终止并清理 |
| `input_required` / `authorization_required` | 无人值守任务无法继续 | 明确失败，不等待未定义的人机交互 |

业务状态已成功但清理失败时，不返回 `runtime_failed` 误导调用方重做。取消与提交成功竞争时必须有原子裁定：已提交成功不能被迟到取消覆盖。

## 7. 实验默认值与实施规格边界

第六轮用户接受推荐并要求时间更宽泛，随后已确认最终共同理解；据此采用以下可配置实验默认值：

| 项目 | 建议 |
| --- | --- |
| 任务默认总期限 | 60 分钟，含排队、准备、执行、结果收集与提交；可按登记配置调整 |
| 提交连接等待 | 至多 30 秒，未终结返回 Run |
| 显式取消宽限 | 30 秒，随后由执行层强制终止 |
| 终态清理 | 立即触发，5 分钟内完成为待实测目标；失败继续对账回收 |
| 阶段重试 | 最多追加 2 次，始终受本任务累计期限与预算约束 |
| 不合格结果的 Agent 修复 | 首期默认关闭，输出不合格明确失败 |
| 未使用的上传暂存 | 24 小时 |
| 结果/产物保留计时 | 从任务终态提交开始，分别保持已确认的 7 天/24 小时 |

上传处理中失败的残留对象和未提交产物也需要到期回收；已过期旧对象不能在新任务中引用。输入工作副本与执行空间一起清理，不能因一个任务结束而删除其他任务合法引用的源对象。

精确 HTTP 错误码、schema 支持子集、SSE 事件名与实现版本属于 API 实施规格；不得改变已确认的冲突、过期、失败和成功语义。固定 SDK/模型可提供的预算强制能力是实验验证项，尚未据此承诺硬金额上限。

## 8. 内部运维接口候选

本轮补充的是首期运维能力，不引入公开管理后台；端点名仍为实施草案。

| 接口候选 | 语义与访问边界 |
| --- | --- |
| `GET /internal/audit` | 按时间、Run、actor、action、目标和结果过滤，稳定游标分页；限额导出，读取/导出本身留痕 |
| `GET /internal/health` | 分项呈现接受能力、worker、资源对账、产物存储、审计和采集新鲜度；未知不填健康 |
| `GET /internal/metrics` | 受保护聚合指标出口；不使用 Run/文件名/URL 等无界标签 |
| `GET /internal/incidents` | 查看异常条件、责任者、接手/抑制信息及真实恢复证据 |
| `GET /internal/cleanup-obligations` | 查询未完成、逾期或核验未知的资源责任，与业务终态分离 |

异常确认/抑制、重试回收等写操作通过受控运维命令执行，使用独立授权和命令身份并记录审计；不能提供任意宿主命令入口。读取监控、读取审计、读取业务结果和强制处置是不同权限。这里的运维回收不扩大 Agent 对外部业务系统的只读边界。

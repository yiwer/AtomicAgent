# Ticket12 — 在任务与额度页查看可信用量

调用后端和维护者现在能看到一个 Run 的消耗和工作区聚合用量，并且能分辨每个数字的来源、单位、是估算还是供应商确认、以及哪些范围仍然未知。

基线 `f55a0c2da9c4d084dd56379ad8ba49694d83cf31`。类型检查、154/154 测试、20/20 浏览器测试、构建和构建产物上的 5 项用量检查通过；证据与适用边界见 [验证账本](../../.scratch/v0/evidence/ticket12/verification.md)、[双轴审查](../../.scratch/v0/evidence/ticket12/review.md)、[失败历史](../../.scratch/v0/evidence/ticket12/failure-history.md)。真实模型、真实供应商 token、Docker／gVisor 与人工验收未完成。

## 记什么：InvocationRecord 与 UsageEntry

`src/usage.ts` 是唯一的记账核心。两类对象都带稳定身份，都只追加。

**InvocationRecord** — 可观察到的一次调用：`invocation_id`、`parent_invocation_id`、`retry_of`、`attempt_id`、种类（model／tool／mcp／transport）、目标、范围、状态、观测来源、观测时间。状态按 `requested < admitted < started < unknown < completed/failed/denied` 排序前进：迟到的旧状态不会把一个已结束的调用拉回去，明确结束优于 unknown。

**UsageEntry** — 一次消费观测：`entry_id`（观测身份）、`series`（序列身份）、`basis`（`sdk-estimate`／`provider-confirmed`／`platform-observed`）、`provider`、`unit`、`value`、`reporting`（`cumulative`／`delta`）、`measurement_scope`、`completeness`、`observation_version`、`in_flight`、来源与观测时间。

单位是有界允许清单：`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`web_search_requests`、`estimated_cost_micro_usd`、`calls`、`request_bytes`、`response_bytes`、`source_bytes`。容器送出的观测经 `validateUsage` 逐字段校验后才入库，并在入库时把 `entry_id`／`series` 加上 Run 前缀，跨 Run 聚合不会互相吞并。

关键不变量：`value === null` 当且仅当 `completeness === 'unknown'`。未计量永远不是 0。

`parent_invocation_id` 与 `retry_of` 属于记录形状并受引用完整性校验，但 v0 没有能证明它们的观测者：受控边界看不出某次工具或 MCP 调用属于哪一个模型回合，因此保持 `null` 而不是推断一个父调用；v0 也不存在阶段重试（DM-02），`retry_of` 因此恒为 `null`，Ticket13 落地阶段重试时才会产生真实链接。这条覆盖边界由视图的 `linkage` 字段显式说明，不靠沉默。

台账只追加并有上限（128 个调用、512 条观测）。超过上限时丢弃的观测会把台账标 `truncated`，视图据此声明覆盖不完整——不静默截断。

## 怎么算：归一化

`normalizeUsage` 按（供应商，来源基准，单位，范围）分桶，任何一维不同都不合并：

- **累计序列**取观测版本最高的一条替换基准（同版本按观测时间取后者），不把历史值再加一遍。乱序的旧版本被忽略但仍留在原始台账里。
- **增量序列**按 `entry_id` 去重后相加，重复投递不重复计数。
- **同一序列混用两种上报方式**判为不可用：该序列记 `unknown`，不做第二次相加；入库校验本来就会拒掉这种数据，读取路径只是降级而不是读不出。
- **未知序列**不参与求和，单独计入 `unknown_series` 并把完整度降为 `partial`；整桶全未知时值为 `null`。
- **在途**：序列里存在 `in_flight` 观测且之后没有非在途观测时，桶标记为在途；Run 层面还会结合未结束的调用状态。

因此引擎估算和供应商确认永远是两个数字。同一次消费被两方各报一次，不会被加成一份。

## 事实从哪来

| 来源 | 观测什么 | 基准 |
| --- | --- | --- |
| `src/model-gateway.ts` | 每次模型／连接调用的开启与结束、请求与响应字节，以及从供应商响应体里读出的 `usage` | 调用数与字节为 `platform-observed`；token 为 `provider-confirmed` |
| `src/claude-execution.ts`、`src/research-execution.ts` | result 消息上的 `modelUsage`，逐模型累计 | `sdk-estimate` |
| `src/research.ts` 的 `McpEvidence` | 登记只读 MCP 的调用与取材字节 | `platform-observed`，供应商键为 `registered-mcp/<id>@<版本>` |
| `src/fixture-sandbox.ts` | 确定性替身观测 | 明确标 `deterministic-fixture:*` |

网关是唯一看得到真实供应商响应的组件。它以有界方式读取：非流式整包不超过 262144 字节才解析；SSE 按行流式解码，取 `message_start` 与 `message_delta` 里的 `usage`。超预算就整包不解析，token 保持未知，不从截断前缀里推数。

供应商身份是 `endpoint 主机/model`，fixture 为 `deterministic-fixture:no-model`。不同端点或不同模型的单位天然分桶，一个引擎的列价估算不会被当成另一个供应商的数字。

引擎的 `costUSD` 只在 `costBasis` 不是 `unknown` 时记为 `estimated_cost_micro_usd`（整数微美元），并且永远只在 `sdk-estimate` 桶里。供应商账单没有适配器，`confirmed_cost` 保持 `null`。

在途、辅助和失败都计入。每次调用在**首次出现时**计一次，无论那时它处于什么状态：正常调用在 `requested` 时记一条在途的调用数、结束时补一条 0 增量的收尾观测；连接探测和在发出前就失败的请求首次出现即为终态，同样记一次调用而不是 0。`modelUsage` 里非本次请求模型的条目范围记为 `auxiliary`；失败或被拒的回合在抛出判定之前就先记录消费。

供应商确认的 token 只对**真正发往供应商**的调用记账：网关用 `dispatched` 区分「供应商没报用量」和「根本没联系供应商」。已发出但没有 `usage` 回报时，四个 token 单位各记一条 `null`／`unknown`，让该桶的 `unknown_series` 增加、完整度降为 `partial`；被拒或本地应答的调用不记供应商条目。两种情况都不会变成 0，也不会被静默丢掉。

真实执行路径上，`opensandbox` 适配器在轮询循环里每秒读一次容器的 `usage.json`，因此在途消费在 Attempt 运行期间就可见，不必等命令返回。

## 持久化、权限与审计

`Run.usage` 是一个只追加的台账。`Worker.recordUsage` 校验后 `mergeUsage`：新条目按 `entry_id` 追加，既有条目逐字节不改；调用状态只前进。不可信或残缺的观测完全不导入，只把 `imports.rejected` 加一——测量降级为未知，不改变执行裁定，也不会让一个健康的 Run 失败。记录写入失败按既有路径置 `recordFailure`，不编造总数。

审计：`usage.observed`（`recorded`／`rejected`）与逐调用状态变化的 `invocation.observed` 属于 A-04 能力调用；读取额度视图的 `usage.read` 属于 A-01 的受控查询访问记录。

权限由服务端裁定，不靠隐藏控件：maintainer 的 `GET /v1/usage` 聚合整个工作区，caller 只聚合自己拥有的 Run，health 身份对 `/v1/usage` 返回 403。health 身份仍可读 `/internal/health` 里本工作区的 M-07 用量指标——那是监控观测，不是业务正文；它不含 prompt、结果、产物或逐条台账。

## 看在哪

- `GET /v1/runs/{id}`：`usage` 完整台账（totals、invocations、entries、budget）。
- `GET /v1/runs`：每行带 `usage` 摘要（totals ＋ 计数，无逐条台账）。
- `GET /v1/usage`：工作区／自有 Run 聚合，含 `by_run` 摘要与预算维度声明。
- `GET /internal/health`：M-07 用量块，带查询时间、观测时间、新鲜度、覆盖范围、未知与在途计数、达到限额数、供应商清单。
- 管理台：任务详情的「可信用量」区展示归一化总量、可观察调用与原始台账；「额度与限制」里的「工作区可信用量」展示聚合与预算维度。两处与 API 读同一批事实。

已提交的 Result 端点不带 usage，保持逐字节稳定。

## 预算维度

用量能喂给平台**实际执行**的预算维度：`total_timeout_seconds`、`artifact_bytes`、`memory_mib`、`input_bytes`（Ticket11 的执行限额，有真实终止行为）。token 与字节是**仅观测**单位，本票不把它们变成硬上限。金额明确 `unsupported`，理由是没有供应商账单适配器且引擎列价不是账单；提交里带金额限额仍然返回 422。

## 可运行命令

```bash
npm ci && npm run build && npm start
```

```bash
npx tsx scripts/verify-usage-release.ts
```

最短演示：登录 → 提交默认提示词任务 → 打开任务详情 →「可信用量」看到引擎估算与供应商确认两行同名单位数值不同且互不相加、估算成本为未知 → 关闭详情 →「额度与限制」→「工作区可信用量」看到同一批数字的聚合与「不支持：cost」。API 侧 `GET /v1/usage` 返回同一事实；用 health 令牌请求同一路径返回 403。

本机 fixture 用真实 main／API／SQLite／UI，但不执行模型，也不产生真实供应商 `usage`。台账里所有 `deterministic-fixture:*` 来源都是替身证据，不能用来关闭真实引擎或真实供应商的账。

# Ticket12 验证账本 — 在任务与额度页查看可信用量

基线 `f55a0c2da9c4d084dd56379ad8ba49694d83cf31`。Node 24.18.0，Windows 11，fixture profile。
证据按 [九类分账](../../../../docs/agents/evidence.md) 记录；每条写输入条件 → 动作 → 外部可观察结果 → 出处 → 通过／失败／未验证。

## 1. 确定性合约与故障实验 — 通过

| 输入条件 | 动作 | 外部可观察结果 | 出处 |
| --- | --- | --- | --- |
| 同一累计序列的 v1=100、v2=260、重复 v2、乱序 v1=130 | `normalizeUsage` | 桶值 260，序列 1，观测 3；旧版本与重复观测均不相加 | `tests/usage.test.ts` |
| 同一 `entry_id` 的增量重复上报 | `normalizeUsage` | 只计一次；两个不同序列分别累加 | 同上 |
| 同一消费同时有引擎估算和供应商确认 | `normalizeUsage` | 两个独立桶，`input_tokens` 各 240，永不相加 | 同上 |
| 两个供应商上报同一单位 | `normalizeUsage` | 两个独立桶，不合并 | 同上 |
| 某序列值未知 | `normalizeUsage` | 桶值保持 `null`／`unknown`；已知＋未知混合时值为已知部分，`unknown_series=1`，完整度 `partial` | 同上 |
| 同一序列既按累计又按增量上报 | `normalizeUsage` | 判为不可用：值 `null`、完整度 `unknown`，不做二次相加 | 同上 |
| 后到的观测带新条目与更晚状态 | `mergeUsage` | 追加新条目，既有条目逐字节不变；调用状态前进，父子关系保留 | 同上 |
| 已结束调用收到更早状态的迟到观测 | `mergeUsage` | 终态与观测时间保持不变 | 同上 |
| 迟到观测带不同 source／coverage | `mergeUsage` | `sources`／`coverage` 取并集，既有表头与条目不被改写 | 同上 |
| 观测数超过 512 条上限 | `mergeUsage` | 台账标 `truncated`，丢弃不静默 | 同上 |
| 调用首次出现即为终态（连接探测、发出前失败） | `callUsageEntries` → `normalizeUsage` | 仍计 1 次调用、非在途、完整；不是 0 | 同上 |
| 两个模型名清洗后文本相同（`a/b` 与 `a-b`） | `sdkUsageEntries` | 序列与供应商键各自独立，10 与 7 不互相覆盖 | 同上 |
| 引擎 `costBasis='unknown'` | `sdkUsageEntries` | 估算成本为 `null`／`unknown`，不写入列价猜测 | 同上 |

## 2. API 与持久化 — 通过

| 输入条件 | 动作 | 外部可观察结果 | 出处 |
| --- | --- | --- | --- |
| fixture Run 正常完成 | `POST /v1/runs?wait_seconds=5` → `GET /v1/runs/{id}` | `sdk-estimate input_tokens=310`（v2 替换 v1=120，而非 430）、`provider-confirmed input_tokens=118`、`platform-observed calls=1`、`request_bytes=512`；`estimated_cost_micro_usd` 为 `null`／`unknown` | `tests/usage.test.ts` |
| 进程重启 | `restart()` → 重新读取同一 Run | `totals` 与 `entries` 完全一致 | 同上 |
| 同一 ledger 再次观测 | 重复调用 `observeUsage` | `totals` 不变、条目数不变、`imports.accepted` +1 | 同上 |
| 终态后到达新观测 | 追加 v9 累计条目 | 归一化取 480；前缀条目逐字节不变 | 同上 |
| run_id 不匹配的不可信 ledger | `observeUsage` | 不导入，`imports.rejected=1`，`totals` 不变，Run 仍 `succeeded` | 同上 |
| 输出不合格的失败 Run | `FixtureSandbox('invalid')` | 仍记录 `calls=1` 与引擎估算；失败调用计入范围 | 同上 |
| maintainer／caller／health 三种身份 | `GET /v1/usage` | maintainer 得 `scope=workspace`（2 个 Run、`input_tokens=620`）；caller 只得自己的 0 个 Run；health 403 | 同上 |
| 额度视图与任务视图 | `by_run` 对比 | 同一 Run 的 `totals` 深度相等，条目数一致 | 同上 |
| 审计 | 直接查询 SQLite | `usage.observed(recorded)` ≥2、`invocation.observed(completed)`=2、`usage.read` ≥2 | 同上 |
| 登记只读 MCP 研究 Run | 发布 mcp 修订后提交 research-report@1 | MCP 用量落在 `registered-mcp/research@1` 供应商、`registered-readonly` 范围：`calls=2`、`source_bytes>0`；模型单位仍在 `deterministic-fixture:no-model`，两者不合并 | 同上 |

## 3. 模型网关的供应商确认读取 — 通过

真实 `node:http` 上游 ＋ 真实 `ModelGateway`，经 Unix socket／命名管道调用。

| 输入条件 | 外部可观察结果 |
| --- | --- |
| 非流式 JSON 响应带 `usage` | `measurement.tokens` = 上游原值；`request_bytes` 等于实际请求体长度 |
| SSE `message_start` ＋ `message_delta` | 取到 `input_tokens=40`、`output_tokens=33`、`cache_read_input_tokens=7` |
| 响应不含 `usage` | `tokens` 为 `null` 且 `dispatched=true`：运行器据此写四条未知供应商条目，不填 0，也不整体丢弃 |
| 请求被网关拒绝（model 不匹配） | `dispatched=false`：不记供应商条目——它确实没有供应商消费，不是未知 |
| 响应体超过 262144 字节预算 | 完全不解析，`tokens` 为 `null`；仍记录真实 `response_bytes` |

出处：`tests/usage.test.ts`（`the gateway records only the provider own usage report…`）。

## 4. 浏览器 — 通过

`npm run test:browser` 20/20。ticket12 专项 `tests/usage.spec.ts` 覆盖正常、刷新、越权、错误恢复：

- 任务详情显示「引擎估算 · 输入 token · 310」「供应商确认 · 输入 token · 118」「平台观测 · 调用次数 · 1」「估算成本（微美元） · 未知（未计量，不记为 0）」与「模型 · 已完成 · 主执行」。
- 整页 reload 后同一 Run 的同一数值仍在，`detail-id` 不变。
- 额度与限制面板显示「工作区 browser-lab 全部任务」聚合、可执行预算维度与「不支持：cost」。
- 服务端授权：health 令牌 `GET /v1/usage` 返回 403；另一工作区 caller 得 `scope=own-runs` 且看不到本 Run。
- 断网一次后显示「连接失败，请重试。」，再次读取恢复并清空错误。
- 截图：`usage-detail-desktop.png`、`usage-quota-desktop.png`、`usage-quota-mobile.png`；移动视口无横向滚动。

## 5. 构建产物 — 通过

`npm run build` → `npx tsx scripts/verify-usage-release.ts`（跑 `dist/src/main.js`，真实 HTTP）：

```
{"check":"run-usage-normalized","result":"PASS","entries":13,"invocations":1}
{"check":"quota-view-matches-task-view","result":"PASS","measured_runs":1,"unsupported":"cost"}
{"check":"server-side-authorization","result":"PASS","health":403,"other_caller_runs":0}
{"check":"usage-survives-restart","result":"PASS","entries":13}
{"check":"console-usage-module-served","result":"PASS","bytes":2165}
```

`npx tsx scripts/verify-local.ts` 两项仍 PASS。

## 6. 回归

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 159/159 通过（新增 20） |
| `npm run test:browser` | 20/20 通过（新增 1） |
| `npm run build` | 通过 |

[双轴审查](review.md) 提出的 3 项 Spec 实现缺陷与 8 项 Standards 问题已全部修复并补回归测试；上表为修复后的结果。

## 7. 未验证的账

| 账 | 结论 | 原因 |
| --- | --- | --- |
| 真实引擎／模型 | 未验证 | 获准 profile（endpoint、model、服务端凭据绑定与用途授权）仍未提供。引擎估算条目的构造经确定性测试覆盖，但没有一次真实 Claude 推理产生过 `modelUsage` |
| 真实网络（供应商确认 token） | 未验证 | 网关解析经真实 HTTP／SSE 上游替身验证；没有对真实 Anthropic 端点取过一次 `usage` |
| 业务内容 | 不适用 | 本票不改变业务输出 |
| Docker | 未验证 | 容器内 `usage.json` spool、轮询期间的在途导入与 `importUsage` 未在固定 Linux 节点跑过 |
| gVisor | 未验证 | 同上 |
| 通知投递 | 不适用 | 本票不产生通知 |
| 人工验收 | 未验证 | 用户尚未体验；Ticket11 的人工 smoke 也仍未反馈 |

供应商账单级成本没有适配器，`confirmed_cost` 始终为 `null`，`estimated_cost_micro_usd` 明确标为引擎列价估算。未接入不等于零。

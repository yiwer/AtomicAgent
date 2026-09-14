# Ticket12 失败与中间实验

记录实现过程中被否掉或修正的做法，避免后续票重走。

## 1. `/v1/runs/{id}/result` 一度携带 usage — 已撤销

把 `usageView` 放进已提交 Result 响应后，`tests/artifact-reuse.test.ts` 的「同一 Result 两次读取应完全相同」断言失败：`usage.queried_at` 是读取时钟，每次不同。

结论：已提交的 Result 必须逐字节稳定，测量属于 Run 视图。usage 只出现在 `GET /v1/runs/{id}`、`GET /v1/usage` 和 `/internal/health`，Result 端点保持不变。

## 2. 用调用次数的累计快照记录连接探测 — 未采用

网关对 bundled CLI 的 `HEAD /api/hello` 最多放行 64 次。一度打算把它压成一个累计序列，但每次观测仍要写一条新 `entry_id` 才能保持只追加语义，条目数没有下降，反而让 transport 与 model 两类调用的记账方式不一致。

结论：连接探测与模型调用一样按调用记增量，范围标 `transport`，不与主执行混算。

## 3. 让运行器同时为 MCP 调用记用量 — 已否

运行器的边界事件里包含 `mcp` 调用，最初也为它们生成用量条目。这会让同一次只读取材料在「模型供应商」和「registered-mcp 供应商」两个桶里各出现一次——虽然因为供应商键不同不会把一个总数算两遍，但同一消费被表示了两次。

结论：运行器只为 `mcp` 之外的边界记账；MCP 消费由平台侧已校验的 `McpEvidence` 派生（`mcpUsageLedger`），fixture 与真实路径共用同一来源。

## 4. 归一化里对混合上报方式抛异常 — 已改为降级

`normalizeUsage` 最初在一个序列同时出现 cumulative 与 delta 时抛错。它在 API 读取路径上运行，抛错会让一条历史坏数据变成读不出任何用量。

结论：入库校验保持严格（`validateUsage` 拒绝），读取路径降级为该序列 `unknown`，其余序列照常显示。

## 5. 网关按块 `chunk.toString('utf8')` 扫描 SSE — 已改

跨块切断的多字节 UTF-8 会被破坏。改为 `StringDecoder` 做流式解码，非流式路径改为先 `Buffer.concat` 再解析；超过 262144 字节预算时整包不解析，`tokens` 保持 `null`，不从截断前缀里读数。

## 6. 顺带修掉的两个真实缺陷

- `web/app.js` 的 `api()` 把 `fetch` 的 `TypeError` 原样显示给用户（"Failed to fetch"）。断网时用户看到浏览器内部字符串而不是可操作提示。改为传输失败统一报「连接失败，请重试。」。
- `web/limits.js` 读取成功后不清除上一次的错误文本，恢复后旧错误仍留在页面上。改为一次完整读取成功即清空。

两者都是本票「错误可恢复」验收要求暴露出来的既有行为，不是新引入的问题。

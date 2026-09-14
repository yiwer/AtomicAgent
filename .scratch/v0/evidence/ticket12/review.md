# Ticket12 双轴审查

基线 `f55a0c2da9c4d084dd56379ad8ba49694d83cf31`。Standards 与 Spec 两名 reviewer 独立运行，互不共享上下文。

## Spec 轴（对照 [票 12](../../issues/12-attributed-usage-accounting.md)）

### 已修复的实现缺陷

**1. 真实调用被记成 0 次调用（AC-2「未知消费不显示为零」、AC-3「失败调用也计入对应范围」）。**
`src/runner.ts` 原先只在 `requested`／`started`／`denied` 时写值为 1 的调用条目。首次出现即为终态的调用因此只留下一条值为 0 的收尾观测：连接探测（`HEAD /api/hello` 直接 `record('completed','transport')`）、请求体超过 1 MiB 触发 `request_limit`、请求体非 JSON 导致 `JSON.parse` 抛出——这三类都只走 `record('failed')`。结果是 `platform-observed/calls` 读出 **0 且完整度为「完整」**。

修复：抽出 `callUsageEntries`，每次调用在**首次出现时**计一次，无论当时状态；仅在它确实还在途时才追加收尾标记。三处生产者（runner、fixture、MCP 证据）共用这一个实现。回归测试：`a call first seen in its ending state still counts as one call and is not in flight`。

**2. 供应商未回报用量时条目整体消失（AC-2「未知消费不显示为零」）。**
`for(const [unit,value] of Object.entries(measurement.tokens ?? {}))` 在 `tokens` 为 `null` 时产生空循环，一条条目都不写。三次模型调用里有一次没有 `usage` 回报时，`provider-confirmed/input_tokens` 只加了另外两次，却报 `completeness:'complete'`、`unknown_series:0`。

修复：`CallMeasurement` 增加 `dispatched`，区分「供应商没报用量」和「根本没联系供应商」。已发出但无回报时四个 token 单位各写一条 `null`／`unknown`，桶降为 `partial`；被拒或本地应答的调用不写供应商条目——它们确实没有供应商消费，不是未知。回归测试：网关用例断言 `dispatched` 两种取值。

**3. 迟到观测改写了台账表头（AC-3「迟到数据可补记且不改写原始观测」）。**
`mergeUsage` 无条件 `source: incoming.source, coverage: incoming.coverage`。研究路径的 `foldMcpUsage` 在执行之后运行，于是一个同时持有引擎与网关条目的 Run，最终表头变成 `coverage:'controlled-read-source-only'`。

修复：拆成 `UsageObservation`（单一来源的一次观测）与 `UsageLedger`（合并结果，持 `sources[]`／`coverage[]`）。合并只做并集，不替换。回归测试：`a late observation contributes its own source and coverage instead of replacing what was already recorded`。

### 已接受并明确记录的部分

**AC-1 的父子／重试关联只有形状，没有 v0 生产者。** reviewer 指出 `parent_invocation_id`／`retry_of` 处处硬编码 `null`。属实，且不打算伪造：受控边界无法证明某次工具或 MCP 调用属于哪一个模型回合，推断一个父调用会违反 DM「不得冒充完整进程行为追踪」；v0 也不存在阶段重试（DM-02），Ticket13 落地时才会产生真实链接。字段保留、引用完整性受校验、合并保序，并由视图新增的 `linkage` 字段显式声明这条覆盖边界，不靠沉默。

**AC-3 的在途消费此前只有 fixture 证明。** reviewer 指出真实路径的 `importUsage` 只在结果信封解析后运行。已修复：`opensandbox` 轮询循环每秒读一次容器 `usage.json`，在途消费在 Attempt 运行期间即可见。该改动本身仍属「Docker 未验证」账，需固定 Linux 节点复验。

**被判为 scope creep 的两处前端修复予以保留。** `web/app.js` 的 `api()` 传输失败本地化、`web/limits.js` 读取成功后清除旧错误，都是本票边界「提供刷新、越权和错误恢复证据」直接要求的；缺了它们，错误恢复路径会把浏览器内部字符串当作服务端裁定展示。理由与取舍记在 [失败历史](failure-history.md)。

## Standards 轴

### 已修复

- **静默截断（硬性违反 CLAUDE.md「未知≠零」、领域模型 §4「显式记 coverage=partial/unknown」）。** `mergeUsage` 触顶后丢弃观测且把 `coverage` 原样透传，被截断的台账仍归一化为 `completeness:'complete'`；`UsageSpool` 做对了，平台侧合并没有。已改为设置 `truncated` 并在视图声明；invocations 用 `break`、entries 用 `continue` 的不一致也统一为 `continue`。回归测试：`observations dropped at the ledger cap are reported as truncated rather than silently lost`。
- **实现说明与代码矛盾。** 文档称「health 身份读不到业务用量（403）」，但 `/internal/health` 的 M-07 指标对 health 身份可读。已改为分别说明：403 只适用于 `/v1/usage`；health 读到的是本工作区监控指标，不含 prompt、结果、产物或逐条台账。同时更正 `usage.read` 的审计归属为 A-01 受控查询访问，`usage.observed`／`invocation.observed` 才是 A-04。
- **Duplicated Code：开启／收尾调用计量在三处各写一遍。** 已抽出 `callUsageEntries`，三处共用。
- **Duplicated Code：两份分岔的清洗函数。** `providerIdentity` 与 `sdkUsageEntries` 各自 `replace(...)`，字符集还不同。已合并为 `usageToken`，并且改为**防碰撞**：清洗改变了内容时追加原值摘要。这不只是整洁问题——原实现下 `a/b` 与 `a-b` 两个模型会塌成同一个序列，累计替换会让其中一个被另一个覆盖，正是本票要守的不变量。回归测试：`two model names that sanitize to the same text keep separate series and provider keys`。
- **Mysterious Name／遮蔽。** `runner.ts` 的 `const open` 遮蔽了从 `node:fs/promises` 导入的 `open`，已改名 `inFlight`。
- **类型空洞。** `fixture-sandbox.ts` 的 `_observeBoundary?: unknown, _observeResources?: unknown` 已改为真实类型。
- **引号风格。** `model-gateway.ts` 两处 `"model"` 已改为单引号。
- **`web/app.js` 的 catch 吞掉非 JSON 错误响应。** 一个返回 HTML 的 502 会被报成「连接失败」，与注释意图相反。已拆成两段 catch：传输失败报连接错误，响应体不可读但状态码非 2xx 时仍报服务端裁定。

### 已接受、未在本票处理

- **Data Clumps／Shotgun Surgery：`SandboxPort.execute` 现有 7 个位置参数。** 属实。把观测者打包成一个对象是正确方向，但那是跨 `domain.ts`／`profile-routing.ts`／两个适配器／`worker.ts`／多个测试的既有设计重构，不属于本票行为范围。本票只消除了它造成的类型空洞。留作后续整理。
- **Primitive Obsession：序列身份是模板字符串。** 抽出 `callUsageEntries` 与 `usageToken` 后，剩余的模板散布在 `sdkUsageEntries` 与 `mcpUsageLedger` 两处，各自紧邻其来源定义。暂不再抽一层类型。
- **Speculative Generality：`'admitted'` 在用量路径上不可达。** 保留。`validateUsage` 接受的是整个边界状态词汇；把它删掉意味着一个如实上报 admitted 的观测者会让整份台账被拒。一个数组元素的成本换取拒绝面收窄，不划算。

## 修复后回归

类型检查通过；`npm test` 159/159；`npm run test:browser` 20/20；`npm run build` 通过；`scripts/verify-usage-release.ts` 5/5、`scripts/verify-local.ts` 2/2 在构建产物上通过。

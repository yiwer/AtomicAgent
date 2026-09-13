# Ticket06 — 固定 Skill 登记和引擎使用证据

本票实现公开配置命令→固定 Skill 修订→普通文件 Run→Claude SDK 受控加载／调用→Result、Artifact 和独立回收路径，以及 A 的维护、选择和证据展示。确定性实验通过不能关闭 AC-03、AC-08、AC-27 或 A-AC-02 的真实集成／人工验收。

## 运行与最短演示

```powershell
npm ci
# 仅首次安装且尚无 .local/config.json 时执行，不覆盖已有私有配置
npm run setup:local
npm run build
npm start
```

已有配置直接 build/start。打开 http://127.0.0.1:4310，私下使用已登记 maintainer 令牌登录。

1. 左侧「Skills」→「登记配置」→类型 Skill、名称 `statistics`、选择 `atomic-registered:data-statistics`，填写说明并预览。核对入口、完整固定内容、摘要和旧 Run 影响，确认发布 `statistics@1`。
2. 可再次登记 `integrity`，选择 `atomic-registered:result-integrity`，用于组合验证。此票提供两个受版本控制的审阅样例；源定义在 `src/skills.ts`。当前不接外部 Skills 仓库，Ticket27 负责来源同步。
3. 关闭配置，在普通表单多选 Skill 修订。保留「必须实际使用」，上传如下 CSV，再提交普通任务：

```csv
id,category,value
a,x,0.1
b,x,0.2
```

4. 详情核对 `total: "0.3"`、两份产物，以及已请求／文件已装载／引擎已加载／可调用／实际使用、来源、Attempt 和调用身份。在默认 fixture 模式，来源明确为 deterministic-fixture；不能作为 Claude 已调用的证明。回收后仍可下载两份文件。
5. 刷新详情／重启服务后核对固定清单摘要和证据。配置历史可发布后续修订、预览停用；旧 Run／原幂等键保留原事实，新 key 选择停用修订明确拒绝。发布回执丢失时刷新后「找回配置操作」继续同一命令正文和身份。

## 公共 API

`GET /v1/configurations` 增加 `skills`。维护者另可读取 `bindings.skills` 的固定入口、Markdown 和摘要；caller 只读受控选择投影，health 禁止读取。维护者可从两个审阅材料登记多个有名称的版本，但一个 Run 不能重复装入相同引擎入口。

共用 Ticket05 的 `POST /v1/configurations/preview` 和 `/commands`：

```json
{
  "action": "publish", "kind": "skill", "name": "statistics",
  "expected_generation": 0,
  "content": { "binding_ref": "从bindings.skills选取的完整身份" },
  "reason": "登记固定文件处理能力"
}
```

发布使用预览返回的 command 和 preview_digest，加稳定 Idempotency-Key。修订分配、预览摘要、expected_generation 并发、身份／工作区、命令回执、原 key 恢复和原子审计沿用05。`enable`／`disable` 固定 name/version，不能改写修订内容。旧 Run 固定材料完整保留，不从当前目录隐式替换。

普通文件 Run 增加：

```json
"skills": [
  { "id": "statistics", "version": "1", "must_use": true },
  { "id": "integrity", "version": "1", "must_use": true }
]
```

最多8项，精确版本，重复名称／入口拒绝。所有选择均要求初始化和加载成功；`must_use` 默认 false，只决定是否强制实际调用。当前样例只用于 `data-statistics@1`。请求不接受 Skill args、脚本、工具、网络、入口、内容、环境参数等授权扩张字段。无 skills 的01–05请求保持原摘要算法和执行路径。

Run 顶层 `skills` 是可变观测；`execution.skills` 是固定选择的 id/version/must_use/entry/content_digest。内容和入口的摘要在接纳及运行前校验，固定完整 Markdown 保存在内部 ExecutionManifest。请求摘要与manifest摘要仍分离。

## 引擎与证据边界

`src/claude-execution.ts` 是真实 runner 使用的 SDK 边界，`src/runner.ts` 保留唯一 Attempt 的独占启动标记。仅把本 Run 固定材料写入独立 `/workspace/registered-skills` 本地插件，使用显式 plugins 路径、`settingSources: []`、精确 `skills: ["atomic-registered:…"]`、独立 HOME／CLAUDE_CONFIG_DIR、无会话持久化。普通用户提示包裹为任务文本，不能以开头 slash command 绕过 Skill 工具过滤。

- requested：平台接纳的固定清单。
- materialized：runner 已写入固定入口并回读核验；这不表示引擎加载。
- loaded：SDK `system/init` 同时报告固定插件路径及精确 namespaced Skill 名称。
- callable：loaded 且 SDK init 报告 Skill 工具，精确允许集和 PreToolUse／canUseTool 两处裁定生效。
- used：仅同一 Skill 的获准 PreToolUse 和匹配 tool_use_id 的成功 PostToolUse；Agent 最终 JSON 自述不参与此证据。

观测携带固定内容摘要、Attempt、时间、调用身份，出口按允许清单重建。file/init/PostToolUse 的来源分开显示。复制文件、未初始化、可调用未使用、hook失败均不能伪装must-use成功；使用Skill后未产出普通文件仍被原文件验证器拒绝。

Skill许可前以独立runner权限写入有界fsync journal（最多40条），写入失败明确deny、abort并锁定必需能力失败。Post写入失败不保留used=true。API导入后Skill观测和每个完成调用审计与Run事实同SQLite事务保存；关键记录失败不得交付成功。模型无权限写journal，固定Bash程序也不触碰该文件。此本地受控日志是sandbox内阶段证据，不冒充已持久转存到平台的完整调用历史。

OpenSandbox成功包和异常退出后读取的journal均须通过固定摘要／Attempt检查；journal还需Run匹配、完整换行、最多256000 bytes及40行。无结果包、错Attempt、截断／超限、到期后迟到callback保持未知或拒绝，不重启Agent。回收后不能再读取的未导入证据保持unknown。本票没有阶段重试或整项重跑入口。

失败码 `required_capability_failed`（固定内容、初始化、加载／调用或关键证据失败）与 `skill_use_unproven`（可调用但必须使用的证据缺失）独立于 output_invalid、runtime_failed、Result 和清理。`/internal/health` 提供受控已请求／可调用／使用／未知数量、能力失败Run数、来源和观测时间；不宣称live兼容性健康。

## SDK 依据与待实测

本地固定 `@anthropic-ai/claude-agent-sdk@0.3.270` 的 sdk.d.ts 定义 skills 允许集、显式插件、system/init.skills/tools/plugins、PreToolUse/PostToolUse/PostToolUseFailure。官方[SDK Skills](https://code.claude.com/docs/en/agent-sdk/skills)说明插件路径可用于空settingSources，显式tools须包含Skill，插件名称采用plugin:skill，init提供加载清单；[SDK Plugins](https://code.claude.com/docs/en/agent-sdk/plugins)说明本地插件装载入口。查证日期2026-09-14。这些文档和QueryPort替身支持实现方式，不证明具体模型的实际调用兼容性。

真实验收仍需准确获准 endpoint/model、服务端环境变量名和用途／计费授权、指定Linux节点、已构建并固定摘要的runner镜像与OpenSandbox。取得后应使用上述普通API／A路径在真实profile执行CSV样例，记录SDK初始化、Skill成功工具hook、校验统计和Artifact字节、独立清理；再重复缺入口和无使用证据负例。不得用fixture关闭该门槛。本票未读取无关凭据、未调用原Qwen套餐、未部署远端。

## 验证与审查

具体命令、计数和审查见 [实施证据](../../.scratch/v0/evidence/ticket06/implementation.md) 和 [双轴审查](../../.scratch/v0/evidence/ticket06/review.md)。真实模型、真实资源隔离／清理、人工验收均未执行。

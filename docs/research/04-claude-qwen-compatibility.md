# Claude runtime + Qwen：兼容性、Token Plan 消歧与测试路径

研究日期：2026-09-12（Asia/Shanghai）。范围：只读第一方文档/源码，未安装或调用服务，未读取用户凭据。本文件不改变“首期采用 Claude runtime”的用户决策，也不构成法律结论。

## 1. 结论

**可以保留 Claude runtime 作为首期引擎；Qwen 是其拟接入的模型后端，必须分别登记 runtime 与 model provider。** 阿里云官方文档确实提供 Claude Code 使用 Qwen 的 Anthropic 兼容 endpoint 与模型映射。与此同时，Anthropic 官方说明它不支持通过 gateway 将 Claude Code 路由到非 Claude 模型：这意味着该组合属于供应商兼容方案，需要我们做版本级验证，不能宣称得到 Anthropic 对 Qwen 的支持。[阿里云 Claude Code 接入](https://help.aliyun.com/zh/model-studio/claude-code)、[Anthropic Gateway 支持边界](https://code.claude.com/docs/en/llm-gateway)

**不要把“能用 Token Plan 接入 Claude Code”理解成“可给无人值守 API 后端供给额度”。** 当前千问 AI 平台 Token Plan 个人版、团队版 FAQ 都明确限制为交互式使用，不可用于自动化脚本或应用后端；旧百炼 Coding Plan 也有相同方向的限制。没有找到针对“仅内部测试、无商业收入”的明确豁免。[个人版使用规则](https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-faq)、[团队版使用限制](https://platform.qianwenai.com/docs/token-plan/team/token-plan-team-faq)、[Coding Plan FAQ](https://help.aliyun.com/zh/model-studio/coding-plan-faq)

**推荐开发路径：** 保留 Claude Agent SDK，使用 Qwen 按量 API 的独立测试凭据和小额预算完成自动化集成实验；Token Plan 留作个人获准的交互式开发体验。若用户的“qwen token plan”指另一供应商或有额外授权，按准确产品重新核验，不应直接套用本文结论。上述是建议，未改动任何真实配置。

## 2. 产品消歧与来源之间的边界

| 用户可能指的产品 | 当日第一方证据 | 后端使用的证据边界 |
|---|---|---|
| 千问 AI 平台 Token Plan 个人版 | 新 Token Plan，Credits，专属 endpoint，个人套餐 | FAQ 明确不可自动化脚本/应用后端；另一问答聚焦生产非交互场景，但并未明确豁免非生产测试 |
| 千问 AI 平台 Token Plan 团队版 | 多席位、独立成员 key、额度管理 | FAQ 同样禁止自动化脚本/应用后端；“团队版”不等于服务器运行授权 |
| QwenCloud 国际 Token Plan | 同名国际文档，国际 endpoint | Team FAQ 同样明确交互式限制；需按购买区域/产品核验 |
| 百炼 Coding Plan / Model Studio Coding Plan | 旧 Coding Plan 套餐，独立 endpoint/key | 明确限制编程工具交互场景，禁止应用后端 |
| 百炼/千问 Qwen 按量 API | 独立 API key 与 workspace/region endpoint | 官方 Claude Code 接入页给出按量配置；适合作为后端集成的候选接入方式，具体账户/服务条款仍按该服务适用文件确认 |

来源：[Token Plan 总览](https://platform.qianwenai.com/docs/token-plan/overview)、[个人版 FAQ](https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-faq)、[团队版 FAQ](https://platform.qianwenai.com/docs/token-plan/team/token-plan-team-faq)、[国际 Team FAQ](https://docs.qwencloud.com/token-plan/team/token-plan-team-faq)、[旧 Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)。

总览写明按 OpenAI/Anthropic 协议兼容性判断工具接入，不按界面形态判断；这段是在解释**技术兼容**。具体 FAQ 另行限制**使用场景**。不能只引用其中一句就认定自研后端获准，也不能把两代不同套餐的 endpoint 混在一起。[Token Plan 总览](https://platform.qianwenai.com/docs/token-plan/overview)

实施前只需确认产品名称、个人/团队、区域和控制台域名；无需用户提供 key 内容来完成消歧。`sk-sp-` 前缀本身不足以区分产品。

## 3. Claude Code 连接 Qwen 所需配置

阿里云当前官方接入页提供以下配置维度：[Claude Code 配置接入凭证](https://help.aliyun.com/zh/model-studio/claude-code)

| 配置项 | 用途 | 平台建议 |
|---|---|---|
| `ANTHROPIC_BASE_URL` | 选择 Anthropic 兼容 endpoint | 来自登记 profile，限制允许的域名/地域 |
| `ANTHROPIC_AUTH_TOKEN` | endpoint 对应的 API key | 由 secret_ref 注入，不写请求体、产物或日志 |
| `ANTHROPIC_MODEL` | 主模型 | 与 SDK 显式 model 保持一致 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 辅助角色映射 | 显式指向该套餐/按量服务支持的精确模型 ID |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Sonnet 别名映射 | 同上 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Opus 别名映射 | 同上 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子任务模型 | 首次实验可统一模型，避免隐藏调用落到未支持模型 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 上下文上限 | 不直接复制大窗口值，按模型与测试预算设置 |

当日文档所列 endpoint：

- 国内 Token Plan：`https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`。
- 国内旧 Coding Plan：`https://coding.dashscope.aliyuncs.com/apps/anthropic`。
- 按量北京：`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic`；另有新加坡、弗吉尼亚地域地址。
- 国际 Token Plan FAQ 指向 `token-plan.ap-southeast-1.maas.aliyuncs.com`，Anthropic 路径为 `/apps/anthropic`。

endpoint 证据：[阿里云接入正文](https://help.aliyun.com/zh/model-studio/claude-code)、[国际 FAQ](https://docs.qwencloud.com/token-plan/team/token-plan-team-faq)。**不要混用 key/endpoint，也不要在这个 Base URL 后再次加 `/v1`。** 兼容端点提供 `/v1/messages`，不提供 `/v1/models`；模型列表探测 404 不足以证明聊天端点不可用。[Messages 接入说明](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)

该阿里云页面的按量主文使用 workspace 新域名，而后面的旧错误 FAQ 仍出现通用 dashscope 域名。登记 profile 应以当时控制台提供的地域/业务空间 endpoint 为准，保留来源日期；不要让适配器在多个地址之间静默尝试真实 key。

## 4. Agent SDK 会继承什么

**已核实源码：** Python SDK 的 subprocess transport 使用 CLI `--output-format stream-json`，将父进程环境（排除特定标记）与 `options.env` 合并后启动 CLI，`options.env` 可覆盖继承变量；`options.model` 编译为 `--model`，schema 编译为 `--json-schema`。[官方 Python SDK subprocess_cli.py](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)

**已核实官方文档：** 当前默认 `query()` 会读取 user/project/local settings；显式 `settingSources: []` 才关闭这些文件来源，但 `~/.claude.json`、特定 managed policy、auto memory 等不全受此参数控制。`CLAUDE_CONFIG_DIR` 可迁移全局配置位置，`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 可关闭自动 memory。Skills 需要文件系统来源，空 settingSources 会影响其发现。[SDK 配置来源](https://code.claude.com/docs/en/agent-sdk/claude-code-features)

**工程推断：** 可以在任务独立容器中，通过 SDK env 传入登记好的 Qwen endpoint/模型映射，而非复用用户电脑 settings.json。但“CLI 兼容页 + SDK 继承源码”只是这条集成路径可行的证据，不是固定 SDK + 固定 Qwen 模型完整通过的证明。首期 profile 应自建干净 config home，受控 `.claude/skills`，显式开启所需 project source；不要同时装入宿主所有 user 配置。

## 5. Structured output、工具调用和研究任务限制

| 能力 | 第一方已说明 | 本平台仍需验证 |
|---|---|---|
| 普通工具循环 | 百炼兼容 Messages 定义 `tools`、`tool_use`、`tool_result`、tool ID 关联 | Read/Bash/MCP 多轮结果是否完整、流式 chunk/错误是否兼容 |
| 工具选择 | 文档列出 auto/any/none/指定工具 | Qwen 具体模型的多工具与错误恢复行为 |
| API 层结构化结果 | 百炼 `output_config.format` 区分严格 schema 与普通 JSON；当前 qwen3.7/3.8 系列列为严格支持 | Token Plan endpoint 与按量 endpoint 是否等价，不能从通用 API 文档自动推定 |
| Agent SDK 结构化结果 | SDK 有 `outputFormat` 与 result.structured_output | 经 Qwen endpoint 的 CLI `--json-schema` 路径是否走同样的底层字段/工具，需实测 |
| 研究搜索 | Qwen 有模型内置工具，Claude runtime 也有自己工具/MCP 体系 | 不能把 Qwen 原生 web_search 与 Claude WebSearch 或 MCP 直接视为同一工具 |

API 能力来源：[Anthropic 兼容 Messages](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)。Agent SDK 结果来源：[Structured Outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)。Qwen 原生工具来源：[Token Plan 团队 FAQ](https://platform.qianwenai.com/docs/token-plan/team/token-plan-team-faq)。

本次**没有证据**证明使用 Qwen 后 Claude Code 内置 web search、所有 beta 参数、thinking、自动 compact、subagent、token 计数和成本计算都等价支持。尤其不能把 Claude SDK 的美元成本估值当 Qwen 套餐 Credits 或按量真实账单。研究任务建议先用登记的只读搜索/抓取 MCP，将网络事实获取与模型 provider 分开验收。

结果验收依然以平台 validator 为准：agent result 成功、structured_output 存在、schema 合格、必需 artifact 已收集后才构成成功。Claude 官方明确 `success` 也可能无结构化值，因此在 Qwen 兼容实验中更不能仅凭退出码 0 验收。[Claude Structured Outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

## 6. 推荐最小实现与验证顺序（未执行）

1. **注册一个 Claude + Qwen 按量测试 profile。** 锁定 Claude CLI、Agent SDK、镜像、模型 ID、endpoint/区域、skills/MCP 摘要。设小额 provider 预算，默认串行；不自动退回其他 key 或套餐。
2. **先做文件任务。** 两个小型文本文件，要求工具读取、计算、写一个输出文件和小型 JSON。观测脱敏网络元数据以证明实际 endpoint/model，不记录认证头或完整业务数据。
3. **逐项加入 schema 与错误用例。** 先普通回答/工具循环，再 schema；覆盖缺结果、格式不合格、超时、429、取消、输出超限。若 schema 路径不兼容，可研究受控提交工具或结果文件 + validator + 有界修复，记录其保障级别，不能声称原生强约束已通过。
4. **加入只读研究 MCP。** 一个固定查询，要求来源 URL、访问时间和带出处结论；证明 MCP 初始化、网络政策和引用检查生效，禁止外部写工具。
5. **任务独立生命周期。** 每次新 session，不 resume；结果和必需产物转存、任务终态提交后回收执行空间/config/transcript。用户已明确 HTTP 断连后任务可继续，因此断连本身不触发清理；最终失败、超时或取消同样进入清理流程。产物独立保留 24 小时，任务失败与清理失败分开。
6. **保留对照诊断口。** Claude 官方模型可以作为定位 harness/兼容端问题的可选控制组；使用它需要另行有效凭据，不是默认改变用户 Qwen 测试选择。

## 7. 必须明确而不扩大解释的边界

- 本次实际打开了个人/团队中文 FAQ 及国际 Team FAQ，限制证据来自正文，不是搜索摘要。只允许交互式的说明不能因在 shell 中启动了 `claude` 就变成后端使用许可。
- FAQ 个人版一处说不可用于自动化脚本/后端，另一处解释生产非交互调用；没有找到清楚的测试例外。因此推荐按量 API 完成自动化实验。若供应商另有书面授权，可按授权范围重新登记。
- Anthropic “不支持非 Claude 模型”的文字是支持边界；本文不把它扩展成未经核实的法律禁止，也不承诺商业支持。
- 不用本文件示例去修改用户机器、不索要密钥正文、不注册订阅、不执行计费调用。本文完成的是需求阶段的可行路径与证据边界。

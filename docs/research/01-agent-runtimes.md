# Coding agent 作为单请求执行引擎：接口能力与适配边界

访谈更新：用户已选择首期固定 Claude；本文保留多引擎对照作为研究资料，多引擎实验不再是首期前置。Claude + Qwen 见 [专项报告](04-claude-qwen-compatibility.md)，当前范围以 [访谈记录](../interview-log.md) 为准。

研究日期：2026-09-12（Asia/Shanghai）。状态：需求挖掘用研究，不是选型决议或运行验证。范围：Codex、Claude Agent SDK、Pi，补充 OpenCode。只读取第一方文档/仓库；未安装、启动 agent，未访问本机凭据。工作目录初始清单为空，没有可供检查的现有集成代码；Codex 部分因此回退到 official OpenAI documentation。引用页面为当日可访问的滚动文档，实施时仍须锁定发行版本和适配器版本。

## 1. 最重要的结论

**推断：这个构想在执行引擎层已经有直接支持，真正需要平台定义的是“完成一次任务”的服务契约。** 官方 Claude 部署文档直接给出每任务创建容器、执行后销毁的 ephemeral session，例子包括票据提取、翻译、媒体转换，并不局限于写代码。[Claude Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)

**事实：三家都有程序化入口，但协议并不等价。** Codex 提供非交互 CLI、SDK 和 app-server；Claude 提供 Python/TypeScript Agent SDK；Pi 提供 SDK、JSON 事件流和 stdio RPC。OpenCode 采用 HTTP/OpenAPI 服务。[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[Claude SDK](https://code.claude.com/docs/en/agent-sdk/overview)、[Pi SDK](https://pi.dev/docs/latest/sdk)、[OpenCode Server](https://opencode.ai/docs/server/)

**事实与设计后果：agent 停止、结构化输出通过、产物完整、外部动作完成，是不同事件。** Claude 明确指出 `result.subtype = success` 仍可能没有 `structured_output`，应用必须将其视为输出失败。因此统一平台应自己校验结果，而非把进程退出或结束事件直接映射为业务成功。[Claude Structured Outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

## 2. 能力对照

表中“未确认”表示本次第一方证据不足，不表示能力不存在；平台建议均为推断。

| 维度 | Codex | Claude Agent SDK | Pi | OpenCode |
|---|---|---|---|---|
| 适合单任务的入口 | `codex exec`；TS/Python SDK | `query()`；异步消息迭代 | print/JSON；`createAgentSession()` | `session.prompt()`；HTTP 消息接口 |
| 双向控制入口 | app-server JSON-RPC | SDK 会话/回调 | `pi --mode rpc` JSONL | HTTP/OpenAPI + SSE |
| 结构化结果 | `--output-schema`，最终消息 | `outputFormat` / `structured_output`，需检查 result subtype | 本次 SDK/RPC 文档未确认统一 JSON Schema 最终输出参数；可研究自定义提交工具 | JSON Schema + `StructuredOutput` 工具，重试耗尽报错 |
| 取消 | app-server `turn/interrupt`，结束状态 `interrupted` | 本次完整参考页抓取失败，具体 interrupt/abort API 与清理语义待固定版本验证 | `abort` 等待 idle；队列不自动清空 | `session.abort` / HTTP abort |
| 恢复 | thread/session ID + 本地持久化 | resume/fork；跨主机可用 SessionStore | SessionManager；runtime switch/fork/import | sessions/messages/fork 接口 |
| Skills | 文件发现；显式/隐式调用 | 文件来源 + `skills` 配置 | ResourceLoader；项目 trust 会影响加载 | 本次未专项验证 |
| MCP | 原生 stdio、Streamable HTTP | 原生 stdio、HTTP/SSE、进程内 SDK MCP | 核心明确不内置；需要扩展或 CLI 工具替代 | 服务端有 MCP 配置/状态接口；细节待专项验证 |
| 隔离边界 | 有 agent sandbox 选项；平台仍须负责租户隔离 | 权限模式、hooks；官方建议容器隔离 | 明确无内置 sandbox | 本次未确认独立安全沙箱边界 |
| 特别注意 | 当前 SDK 页面说旧 `codex mcp-server` 已移除 | `allowedTools` 是预批准规则，不是完整工具白名单 | `abort` 后队列可继续；headless 默认可能忽略项目扩展 | SDK 文档同页 `format` / `outputFormat` 描述存在差异，须以固定版 OpenAPI 为准 |

能力证据分别见后续各节；此表不声称跨提供方具有相同效果、成本或可靠性。

## 3. Codex：单任务 CLI 与完整控制协议需要分开

### 已确认事实

- `codex exec --json` 输出 JSONL，包括 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*` 和 `error`；`--output-schema` 约束最终结果，`-o` 保存最终消息。`--ephemeral` 不保存 session rollout；非 Git 目录默认需要显式跳过 Git 检查。非交互默认只读，写入需设置 sandbox。[Non-interactive Mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- SDK 现有 TypeScript `@openai/codex-sdk` 和 stable Python `openai-codex`。Python 通过 app-server JSON-RPC 控制本地 runtime，发布包固定 CLI runtime 依赖；TS 支持 start/continue/resume thread。官方建议自动化任务用 SDK，深度客户端集成用 app-server，旧 `codex mcp-server` 已移除。[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- app-server 连接需 initialize/initialized 握手；`thread/start|resume|fork` 管理历史，`turn/start` 开始执行，`turn/interrupt` 请求取消，最终 `turn/completed` 带状态。它也有 skill 输入项和工具/文本增量事件。[App Server](https://learn.chatgpt.com/docs/app-server)
- Skills 为带 `SKILL.md` 的目录，支持脚本、参考文件、资产；当前 repo 发现路径为 `.agents/skills`，并向上查找至 repo root；系统/用户来源也会参与。隐式调用基于描述，显式可用 `$skill`。[Build Skills](https://learn.chatgpt.com/docs/build-skills)
- MCP 配置位于 `config.toml`，支持 stdio 启动命令/env/cwd、HTTP URL/认证头；支持 `required`、启动与调用超时、工具允许/禁止清单。`required = true` 初始化失败会阻止非交互执行。[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

### 对平台的推断

CLI 是最短验证路径，但不要将 stdout 文本当唯一协议；优先读取事件、最终 schema 结果及进程状态三种证据。需要执行中取消、权限交互或更多运行观察时，SDK/app-server 可以减少自行模拟 CLI 的工作。任务配置应编译成独立 runtime home、工作目录和明确权限；不要依赖宿主用户配置。

### 凭据和许可证据边界

官方自动化文档推荐 API key，说明共享运行环境的非信任代码可能读取环境变量；也介绍短期 workload identity 与安全代理模式。因此平台可研究将真实 key 留在控制侧、给 sandbox 发短期受限访问能力，而非把租户所有 key 写入镜像。[Automation Authentication](https://learn.chatgpt.com/docs/non-interactive-mode)

官方确认 CLI、SDK、app-server 开源，云产品和 IDE extension 并非开源。本次遵循 OpenAI Docs 来源域限制，没有进一步抓取 GitHub LICENSE，因此具体发行物许可证、再分发义务及商业托管条款列为待核验，不从“开源”自动推导服务授权。[Open Source](https://learn.chatgpt.com/docs/open-source)

## 4. Claude Agent SDK：最直接的任务容器参考实现

### 已确认事实

- Agent SDK 使用与 Claude Code 相同的 agent loop、工具和上下文管理，提供 Python/TypeScript API；它不是需要自己实现循环的普通模型 Client SDK，也不同于 Anthropic 托管 sandbox/session 的 Managed Agents。[Overview](https://code.claude.com/docs/en/agent-sdk/overview)
- 官方 ephemeral 示例每任务创建容器并销毁，用 `maxTurns` 限制执行。达到上限产生 `error_max_turns`；当前单次 `query()` 在发出错误 result 后还会抛异常。transcript、memory 和工作目录 artifact 是分别需要管理的状态。[Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- 输出 schema 的成功判断至少包括 result 成功且 `structured_output` 存在；重试耗尽有 `error_max_structured_output_retries`。本次页面还指出模型 fallback 可能撤回已完成的输出，因此“曾经收到一个合法 JSON”也未必是最终结果。[Structured Outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
- Skills 从 user/project 来源发现，受 `settingSources`、`cwd` 和 `skills` 配置影响；单独设置空 `settingSources` 即使 `skills: all` 也不会加载文件 skills。应明确区分“文件已装载”“本次可调用”“实际被调用”。[Skills](https://code.claude.com/docs/en/agent-sdk/skills)
- MCP 支持 stdio、HTTP/SSE 和 SDK 内部工具；可在代码或配置文件声明。stdio 和没有缓存工具表的远程 MCP 会影响首轮启动等待，因此配置数量和初始化策略进入冷启动预算。[MCP](https://code.claude.com/docs/en/agent-sdk/mcp)
- `allowedTools` 预批准指定工具，但未列出的工具并不会自动消失；已有 allow rule/模式批准的调用可能跳过 `canUseTool`。需要每次工具调用都检查时，官方指向 `PreToolUse` hook。`dontAsk` 可拒绝原本需要交互批准的调用。[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- resume 使用会话 ID；fork 只分叉历史，不分叉文件系统。跨主机 transcript 可由 SessionStore 镜像，但文件产物仍需要自己的存储策略。[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

### 对平台的推断

最值得借鉴的是 `ResultMessage` 成功/错误分类和 ephemeral/session-store 分层。平台不能直接把通用 `tools.allow` 映射为 `allowedTools` 后声称封闭白名单；适配器必须定义工具暴露与工具授权的分别实现。无人值守任务还需要明确遇到用户提问、MCP elicitation 或批准请求时的终态。

### 已确认商业使用边界

官方明确：未事先获批，第三方开发者不能在产品中提供 claude.ai 登录或其 rate limits，应使用 API key 认证。SDK 使用受 Anthropic Commercial Terms 约束，具体组件若有单独 LICENSE 则另行适用。不能将其笼统登记为“整个 Claude Code 栈 MIT”。产品中展示名称还有独立品牌规范。[Overview 的认证、License and terms、Branding 段落](https://code.claude.com/docs/en/agent-sdk/overview)

## 5. Pi：轻核心、强可嵌入性，但需要更多平台能力

### 项目身份与已确认事实

本研究的 Pi 指 Mario Zechner 发起的 coding agent/toolkit。当前第一方仓库是 `earendil-works/pi`，当前文档 npm 包为 `@earendil-works/pi-coding-agent`，与搜索结果中的旧 `badlogic/pi-mono`、`@mariozechner/pi-coding-agent` 应区分。[官方仓库](https://github.com/earendil-works/pi)、[当前 SDK](https://pi.dev/docs/latest/sdk)

- `createAgentSession()` 提供 prompt、事件订阅、tools、ResourceLoader、cwd、agentDir；SessionManager 可纯内存。AgentSessionRuntime 管理 new/switch/fork/import；换 session 后事件订阅需重新绑定。[SDK](https://pi.dev/docs/latest/sdk)
- RPC 是 stdin/stdout 上严格 LF 分隔的 JSONL，命令可带相关 ID；接收命令成功与 agent 执行结束分别返回。`abort` 等待 idle，但剩余队列会继续，若平台意图彻底取消，还需要先处理 `clear_queue`。RPC 还有专门的 `abort_retry`、`abort_bash`。[RPC](https://pi.dev/docs/latest/rpc)
- 核心明确不内置 MCP，建议 CLI+README/Skills 或自行写扩展；不能将用户提交的 MCP 配置无条件映射为 Pi 原生能力。[Coding Agent README — Philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- Pi 明确没有内置 sandbox；工具及 TypeScript 扩展拥有进程权限。project trust 是输入加载控制。headless 不弹 trust 提问，默认 `ask` 未有已保存信任时忽略受保护项目资源；`--approve`/`--no-approve` 可逐次覆盖。[Security](https://pi.dev/docs/latest/security)
- 仓库许可证为 MIT；保留版权和许可声明是其条件。模型服务的使用条件仍需按 provider 独立核验。[LICENSE](https://github.com/earendil-works/pi/blob/main/LICENSE)

### 对平台的推断

Pi 适合探索“平台自有 harness 配置、精简工具集、跨模型 provider”的深度控制面。但 JSONL 不是结构化业务输出保证；如果需要统一 `response_schema`，可验证自定义 `submit_result` 工具 + 平台 validator + 有界修复重试，不应仅靠提示词要求输出 JSON。MCP 适配是额外工程和安全边界，不能隐藏在一个布尔能力声明后。

## 6. OpenCode：值得参考的 HTTP 服务形态

已确认：`opencode serve` 是 headless HTTP 服务，发布 OpenAPI 3.1，支持同步 message、异步 `prompt_async`、session abort/fork、SSE；可设 Basic Auth。JS/TS SDK 从服务规范生成，因此适合观察语言无关控制协议的设计。[Server](https://opencode.ai/docs/server/)

结构化输出通过 JSON Schema 和 `StructuredOutput` 工具产生；有重试次数与 `StructuredOutputError`。注意当前文档示例用 `format`，同页 API 摘要写 `outputFormat`，下一阶段应以所锁定版本的 OpenAPI/类型定义确定字段，而非照网页拼装请求。[SDK](https://opencode.ai/docs/sdk/)

仓库 LICENSE 为 MIT；此证据不覆盖模型 provider 或附属托管服务的商业条件。[LICENSE](https://github.com/anomalyco/opencode/blob/dev/LICENSE)

**推断：** 可借鉴其 API 形态，但 agent 内部 HTTP server 不宜直接成为平台多租户 API。平台还需任务身份、租户授权、资源预算、artifact 提交和确定的回收生命周期。

## 7. 统一 API 应表达什么（设计建议，尚未决策）

| 概念 | 应明确的契约 | 原因 |
|---|---|---|
| RuntimeSpec | engine、engine_version、adapter_version、provider、model、能力协商 | 相同名字的 skills/MCP/权限在不同 runtime 中语义不同 |
| TaskInput | prompt、input manifest、文件路径/摘要、可见性、可选 system/developer 指令边界 | 原始输入应可追溯，不能被执行中覆盖 |
| EnvironmentSpec | 固定镜像 digest、资源、cwd、依赖、网络策略 | 安装脚本不是普通字符串配置，而是可执行代码 |
| SkillBundle | 内容摘要、来源、支持引擎、安装成功与可调用状态 | 文件存在不代表已加载或被使用 |
| ToolConnection | stdio/remote、secret_ref、必需/可选、工具权限、超时 | MCP 初始化失败是否允许降级必须由调用方知道 |
| ExecutionBudget | wall time、模型费用、轮数、输出量、文件总量、CPU/内存 | 单次入口会放大成多模型轮次和工具执行 |
| ResultContract | text/JSON/artifacts、schema、必需文件、验证器版本 | engine success 无法证明调用方所需结果完整 |
| RunResult | 状态、validated result、artifact manifest、usage、错误层级、完成证据 | 原生事件保留为诊断，统一状态由平台负责 |

建议将 `Run` 和 `Attempt` 分开：同一调用的重试是新的 attempt；恢复 transcript 不等于重试不会重复外部动作。至少分别记录 `runtime_failed`、`budget_exceeded`、`cancelled`、`output_invalid`、`artifact_upload_failed`。这些是平台建议，不是任一 agent 已保证的语义。

“单次请求”也应分清：**单次业务任务**可以包含许多 agent turn 和 sandbox 操作，不一定要求一条 HTTP 连接一直存活。同步等待、SSE 和 job 查询可以共享同一 Run，只是交付方式不同。

## 8. 下一轮最小验证实验（尚未执行）

1. **共同任务对照：** 两个输入文件，要求计算、生成一个指定文件并返回小型 JSON。记录 engine/SDK/adapter/image/model 精确版本，验证 schema、文件 hash、usage 和终止事件；先用两种 runtime，避免同时扩展四个适配器。
2. **配置可见性：** 一个显式 skill、一个必需 MCP、一个可选 MCP；让必需 MCP 启动失败，确认平台在准备阶段失败，不把缺失能力静默降级。验证 Pi 项目 trust 和 Claude settingSources。
3. **取消闭环：** 长模型响应、阻塞 shell、MCP 调用、自动重试、排队 follow-up 分别触发取消。证明运行结束、所有子进程回收、不会继续产生新 artifact；不只检查取消 API 返回值。
4. **结果失败：** schema 缺字段、agent 成功但无结果、结果文件超限、artifact 上传失败。确认平台返回不同错误，且不会发布半完成产物。
5. **失联恢复：** 收到 agent 最终结果后、平台提交结果前杀 worker，使用同一幂等键重投。检查是否重复收费、运行或外部工具动作；使用只记录调用计数的测试工具，不接真实业务写入。
6. **凭据与隔离：** 两租户并行任务，使用无价值的 canary token 和文件，检查跨任务文件、日志、环境、MCP 配置与缓存隔离。真实 provider key 的隔离代理需独立设计，不能用 canary 实验宣称已完成生产安全验证。

## 9. 仍待确认的问题

- 用户所说 Pi 是否确指本文项目；若指另一个产品，应重做该列。
- Claude 具体固定版本的取消 API、挂起批准行为和 descendant process 清理；本次参考页抓取失败，不能据常识补齐。
- Codex 固定发行物 LICENSE/NOTICE、不同接入认证下的第三方托管条款；不将 SDK 可集成等价于订阅额度可转售。
- Pi 的 provider 级结构化输出支持、MCP 扩展候选以及跨模型一致性，需要源码和样本进一步核验。
- 成本/启动时延/长任务成功率未实测；没有依据给出性能排名或容量承诺。
- 这些引擎都不能仅凭文档证明平台的 exactly-once 外部动作、租户隔离、产物完整性与故障恢复。它们属于平台自身的验证责任。

# Ticket01：Qwen Token Plan CN 个人版接入复核

核验日期：2026-09-14（Asia/Shanghai）。范围：用户提供的官方 Claude Code 教程、Token Plan 总览、个人版概述与 FAQ；均已成功直接打开正文。最初两次页面打开超时，重试后成功；搜索摘要曾省略 FAQ 的使用规则，因此结论以直接打开的正文为据。未读取任何凭据、未调用模型，本文不构成真实运行验收。

## 结论与当前场景

官方提供个人版接入 Claude Code 的技术配置；但个人版概述的“订阅前须知”限制为编程或智能体工具内的交互式使用，排除自动化脚本、自定义应用后端及非交互批量调用。它明确允许工具内通过 Skill、Slash Command、Agent 扩展交互发起的调用。Ticket01 的自研后端 API 调用沙箱内 Claude Agent SDK，与该段排除的应用后端场景对应；个人、实验、非商业或单次调用在所读页面中均没有明确豁免。此处是按文档措辞进行的场景判断，不是对用户账户作出的供应商裁定。[个人版概述：订阅前须知](https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-overview)

个人 FAQ 的“使用规则”仍包含交互式限制及脚本/后端排除；其下一问聚焦生产自动化场景，未明确撤销前一条，也未说明开发测试例外。因此旧研究 [04](04-claude-qwen-compatibility.md) 的范围结论得到此次正文复核，不能只凭后一问的“生产”措辞推导测试获准。[个人版 FAQ：使用规则](https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-faq)

总览说明技术接入按 OpenAI/Anthropic 协议兼容性判断，支持配置 Base URL 和 API Key 的工具可接入。这解释了自研工具的技术条件；与具体个人版场景限制应一起阅读，不能据此推导自研后端已获准。[Token Plan 总览](https://platform.qianwenai.com/docs/token-plan/overview)

## 当前官方教程的精确配置

以下是教程“配置 Token Plan 个人版”的示例值，不代表已经登记或实测的 Ticket01 profile。[Claude Code 教程](https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/claude-code)

| 环境变量 | 示例值或来源 |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic` |
| `ANTHROPIC_AUTH_TOKEN` | Token Plan 个人版专属 API Key |
| `ANTHROPIC_MODEL` | `qwen3.8-max` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `qwen3.6-flash` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `qwen3.8-max` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `qwen3.8-max` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `qwen3.7-max` |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `983616` |

用户提供的 `DASHSCOPE_TOKEN_API_KEY` 是本地秘密来源名称；Claude Code 教程使用的是 `ANTHROPIC_AUTH_TOKEN`。若用于获准场景，需由服务端秘密注入映射，两者不能仅凭同名期待 runtime 自动读取。上述上下文数值是教程示例，不应自动成为平台预算或验收默认值。教程还要求独立配置位置中的 `.claude.json` 顶层 `hasCompletedOnboarding=true`；本次没有修改用户设置。[Claude Code 教程](https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/claude-code)

## 剩余边界与实施建议

- 技术兼容、使用范围和真实验收是三项独立证据；教程不能证明固定 SDK 版本的 schema、工具循环、回收和平台结果校验已经通过。
- Ticket01 真实后端验证可采用独立的按量 API 凭据，或由供应商明确授权此个人版后端实验。当前用户教程的按量配置为 `https://dashscope.aliyuncs.com/apps/anthropic`，示例主模型 `qwen3.7-max`；这是不同计费入口，不能把现有个人版 key 静默改投过去，也未在本次执行该替换。[Claude Code 教程：配置按量计费](https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/claude-code)

本文件只记录证据与候选路径，不改变项目引擎选择、票据范围或验收状态。

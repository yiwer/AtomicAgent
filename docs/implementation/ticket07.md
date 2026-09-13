# Ticket07 — 固定只读 MCP 与研究报告

已实现登记 MCP 修订、A 探测、caller 研究提交、Claude SDK 研究工具路径、来源校验、Markdown Artifact 独立保留与下载。确定性 API/协议和公开网络证据已取得；获准模型驱动的 OpenSandbox 全链路、Linux 部署隔离和人工研究内容验收仍未执行，综合 AC 未勾选。

## 运行与最短 A 演示

```powershell
npm ci
npm run build
npm start
# 独立真实公开取材，不调用模型、不创建 sandbox
npx tsx scripts/verify-research-network.ts
```

已有 `.local/config.json` 时保留它；仅首次无配置时先 `npm run setup:local`。打开 `http://127.0.0.1:4310`，按 ticket01 的私下取令牌方式登录维护者。在「MCP 只读研究」→「登记配置」选择 MCP、snapshot 绑定、名称 `research`，填写说明，预览后发布。点击「探测只读 MCP」看到连接、工具目录、实际 GET/材料读取授权、取得 2 个来源及观测时间；刷新仍保留。network 绑定使用同两个固定 URL 发起本次 HTTPS GET，不需要账户、密钥或付费授权。

关闭配置，选择 `research@1`，填写比较问题，提交任务；固定材料模式使用 fixture 环境。详情展示独立 MCP 证据、结构化结果、来源 URL/取得时间/摘要、未知项和「结论语义未核验」。回收完成后下载 `output/report.md`；移动端已点击下载并截图。停用只阻止新授予，旧 key 仍找回同 Run；显式撤销旧 Run 属 Ticket19。

## 固定协议与 API

- MCP 传输固定 `sdk`，服务 `atomic-readonly@1.0.0`；使用 Claude SDK 官方进程内 MCP 与真实 MCP Client/Server 初始化、工具目录、调用协议。未实现任意远程 HTTP/SSE/stdio MCP 的登记。调用方不能填写 endpoint、secret、任意工具或 URL。
- `secret_ref: null` 明确表示这两个公开来源无需凭据。版本固定的 deployment catalog 有 snapshot/network 两个绑定，初始均未发布；维护者沿 Ticket05 的 preview/command receipt/generation 路径发布、启停。binding digest 固定传输、服务版本、GET 范围和保存材料。
- 唯一工具 `read_source({source_id})`，严格 schema 拒绝多余参数，只接受 `opensandbox`/`sandcastle`。服务执行固定 HTTPS GET，禁止重定向，每源最多一次，15 秒网络超时，131072 原始响应字节上限；只向模型提供前 12000 字符。外部写工具不登记，Bash/文件工具均不暴露给研究模型；受控 runner 在任务目录生成报告。OpenSandbox 网络策略仅增加登记源域名，真实容器内防绕过仍待部署验证。
- `POST /v1/configurations/mcp-probe {id,version}`：维护者权限、预期 actor/workspace 防跨标签切换，先持久审计授权再做实际读取；结果持久、60 秒后健康标未知。连接指 MCP 初始化，callable 指工具目录，authorized/acquired 指受控 handler 实际读取。探测不调用模型。
- `POST /v1/runs` 使用 `output_contract: research-report@1`、`mcp:[{id:"research",version:"1"}]`，可选既有 profile 或固定 environment/model。研究不混入当前文件 Skill 或上传输入。fixture 只接 snapshot，network 研究须选获准真实环境与模型。
- 真实 runner 用独立 SDK 查询，空 `settingSources`/plugins/skills/builtin tools，精确权限回调与 PreToolUse；source/用户文本不能提权。每次授予前 fsync MCP journal；候选只含 summary/conclusions，来源和用量由控制边界记录。失败导入有界、匹配 Run/Attempt 的 journal；无来源不能提交报告。
- MCP 观测和来源都严格校验字段、固定内容、身份、时间与有限计数；未记录/模型 token/计费保持 null。`usage.bytes` 是返回给调用者的节选 UTF-8 字节数，**不是**整个 HTTP 响应流量或模型 token。

## 验证边界

平台检查候选 schema、两个来源本次已取得、URL/摘要/时间、引文确实在取得材料中、规范 Markdown 字节、转存与提交。Result、Artifact 和 cleanup 独立。报告和 A 明示语义未核验；真实引文不能证明任意结论正确。测试特意包含“使用真实引文声称完美可靠性”的反例：机械引用检查通过，人工事实清单判该结论不成立。没有用这个机械 PASS 关闭内容 AC。

固定材料事实清单见 [facts.md](../../.scratch/v0/evidence/ticket07/facts.md)，原文及许可同目录。README 只能支持其直接描述的定位；清理可靠性、性能、完全无 Git 依赖等不能从这些节选推导。

## 当前证据

- TDD 首条 API RED（目录未提供 MCP）→GREEN；协议额外参数 RED（SDK 默认剔除额外字段）→严格 schema GREEN。
- 聚焦 5/5；typecheck/build 通过；末尾全套 83/83。首次全套 81/83 暴露旧 Skill 故障 seam 缺少 mcp 字段时中断 journal 导入，修复兼容读取后对应 5/5 及全套通过。
- 完整浏览器 15/15；本票另 1/1 覆盖新增移动下载与预期身份拒绝。真实截图归档本票，不把重跑的旧票截图纳入本次变更。
- [network.json](../../.scratch/v0/evidence/ticket07/network.json)：2026-09-13T23:07:53Z，本地真实 MCP 协议＋公开网络读取两源 HTTP200、节选摘要与快照相同；模型未调用、sandbox 未创建。
- 双轴 code-review：以启动 `ea6b4d4632e73ae958f3994f9382f9f31d10ac7d` 为整票基线，待末尾记录审查结果。

未完成：确切获准模型 endpoint/model、服务端凭据变量及用途/计费授权仍待提供；真实模型工具循环、OpenSandbox 研究 Run、真实隔离和人工结论验收未执行。用户已提供 Ubuntu 节点 `159.75.158.26` / `agent.91boy.cn` 并完成 SSH 信任预检，当前缺的是实际部署与资源/镜像资格，不是节点地址。若用户指定外部 MCP，其确切传输/修订/来源仍需单独匹配登记，不将 sdk 传输证据自动套用。

## 实时技术依据

本地 Claude SDK `0.3.270` 的 sdk.d.ts、MCP SDK `1.30.0` 的 McpServer strict inputSchema，以及 zod `4.6.4` 已核对并固定为直接依赖。官方 [custom tools 文档](https://code.claude.com/docs/en/agent-sdk/custom-tools)说明 createSdkMcpServer 的进程内传输和工具权限；[MCP tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)区分工具列表与实际调用。官方文档证明接口设计依据，不代表当前镜像/模型兼容性已实测。

# Ticket03 — 提交响应丢失后找回同一 Run

本票补齐幂等摘要与 A 的未确认提交恢复，并验证真实本机 TCP 断连及跨控制进程恢复。**实际模型启动计数、Linux／Docker 部署和用户人工验收尚未验证，综合 AC-05／A-AC-01 保持未完成。** 上游 01 的真实条件仍是最终验收依赖。

## 运行与最短演示

环境沿用 Node 24.18.0。已有本地配置时运行：

```powershell
npm run build
npm start
```

首次环境按 [Ticket01](ticket01.md) 执行 `npm ci`、`npm run setup:local`；私下读取配置令牌登录 <http://127.0.0.1:4310>，不将令牌贴入证据。启动 profile 明示 fixture 或真实模式。

1. 用同一 Bearer 身份、`Idempotency-Key`、`prompt/profile/output_contract/inputs` 向 `POST /v1/runs` 并发提交；全部 202 返回同一 `run_id`。改变执行字段返回 409 `idempotency_conflict`；新 key 创建新的业务执行。
2. 执行 `npx tsx --test tests/submission-recovery.test.ts`：本机 HTTP 代理收到上游 202 后不转发响应字节，而是断开客户端 TCP；16 次并发重传仅找回一个 Run。终止控制进程并在独立新进程打开同一 SQLite，原 Run／Attempt 保留、状态为 `failed/execution_lost`，受控执行端启动账仍为 1。此脚本使用临时隔离目录和受控 SandboxPort，不使用真实模型。
3. 执行 `npx playwright test tests/idempotency.spec.ts`：A 提交经真实 API 接纳后，浏览器路由层丢弃响应；刷新后点击“找回未确认提交”，使用保存的原 key＋原内容恢复原任务。修改提示词不会重写未确认请求；取回结果并再次刷新后，任务列表只多一个任务。其余案例覆盖登出／切换身份、恢复时真实权限拒绝以及同浏览器双标签页共享 Cookie 的身份变化。

## 持久事实与接口

- SQLite 原有 `(workspace, owner, idempotency_key)` 唯一约束与接受事务继续决定唯一 Run；不改 Worker 的实际执行边界。重复请求只读原 Run 并写重放审计，不创建 Attempt，不刷新期限，不再次启动 Agent。控制进程恢复对已有执行明确失败与清理，不重跑任务。
- 提交摘要现在对 JSON 对象字段排序，数组顺序保持原义，涵盖全部已接纳请求字段。文件引用对象字段顺序不会造成冲突；改变 profile、输出契约、输入或提示词均冲突。重放比较在当前配置可用性、输入对象与装载解析之前进行。
- 新 Run 保存版本 2 的 `request_digest` 及独立 `manifest_digest`。清单摘要包括固定 profile、输入绑定、授权、schema 与期限；输入 `loaded` 是动态观测，排除在摘要之外。业务授权响应分别提供 `submission_digest` 与 `execution.manifest_digest`，不向健康出口输出这两个指纹。
- 01／02 旧记录无版本标记时，仅从原 Run 中已固定的提示词、profile 身份、输出契约和输入身份／路径重建规范提交摘要；旧清单摘要从固定事实计算。此兼容读取不请求源文件、不读取当前默认值，也不改写旧记录。当前系统只登记一个不可变 profile 修订；更改该修订原地内容仍按原规则拒绝启动，未新增配置管理功能。
- 幂等保证适用于约定的七天记录窗口；超出窗口不承诺旧 key 去重。当前记录物理到期与删除调度仍属原保留策略票，不能把尚未删除记录视为无限期保证。输入／Artifact 到期不影响已接受 Run 找回。

## A 与观测边界

A 在发送前将原 key＋原 body 存入标签页 `sessionStorage`，键绑定服务端确认的 workspace＋actor。刷新和同标签页重新登录可恢复；登出清理内存与画面但保留该身份待确认材料，切换身份不自动重发。恢复 POST 同时携带 `X-Submission-Actor`／`X-Submission-Workspace` 期望身份，服务端在读取正文和接纳前与实际认证身份匹配；另一个标签页切换共享 Cookie 会得到 403 `submission_identity_changed`，原材料保留，需重新登录原身份。期望身份只能收紧该请求，不能授予权限。

成功找回后删除材料。拒绝响应只有服务端已查明原 key 不存在、随后业务校验拒绝时才包含 `submission_status=not_accepted`，A 以此允许纠正输入。401、403、409、前置验证失败或未知存储／网络结果不能证明原提交未接纳，继续保留原材料；进入接受事务之前会撤销该声明判据。这不是服务端授权来源，不保存令牌，不承诺关闭标签页或清除浏览器存储后的草稿恢复；业务 Run 仍可通过服务端列表与原幂等键找回。

服务端持久审计继续记录 `run.accept/accepted`、`run.accept/replayed`，本票增加绑定原 Run 的 `run.accept/conflict`；授权读取与拒绝沿用原审计。`/internal/health` 的 `submissions` 仅提供同工作区 accepted／replayed／conflict 数量、观测时间和 `platform:durable-submission-audit` 来源，不输出 key、正文、Run 身份或异常原文。调用方无 health 权限，模型健康依然为 unknown。完整审计查询与异常管理不在本票扩展。

## 证据与未验证条件

[证据账本](../../.scratch/v0/evidence/ticket03/verification.md) 区分确定性、真实网络、跨进程、浏览器与真实模型证据。最终完整测试 37/37、浏览器 6/6、类型与构建通过；编译后 API／网络测试 6/6。Standards 初审和复核均 0 问题；Spec 初审的跨标签页 P1 已修复，增量复核 0 剩余问题。

TCP 实验是真实 socket 断连，跨进程实验是真实控制进程结束与新进程恢复；启动计数来源仅是受控 SandboxPort 在 execute 入口同步持久记录的追加账。它不证明 Claude SDK、模型、OpenSandbox 或 Docker 仅启动一次。实验直接创建 app，未替代 main 的生产进程锁验收：真实启动入口仍保留已有独占锁，异常退出后由维护者确认旧进程结束才可处理遗留锁。

真实验收仍需已授权 endpoint、model、secret 变量引用及计费用途、固定 Linux/OpenSandbox 与镜像 digest；按相同断连／并发／恢复路径核对真实模型调用与 Run／Attempt。未调用远程服务、未取得用户人工验收，不关闭本票。

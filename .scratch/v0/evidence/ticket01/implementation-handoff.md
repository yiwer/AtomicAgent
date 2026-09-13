# Ticket01 实施交接 — 2026-09-14

本轮开始时的固定基线为 `6d6fc3638cb6b48c66386121ddc123192518cf4f`，分支 `main`，工作区干净。使用全新 agent 上下文读取本票与权威文档，复核已有实现和证据；本轮只补充文档，没有产品代码变更，也未调用模型或修改远程服务。

## 实现结论与现有接口

本票已有窄 JSON 路径实现，本次复核没有识别出需要新增的本票代码缺口；该结论不是对未执行的真实集成作出兼容性保证。以下接口可供后续实现评估复用，后续需求仍须在各自票内扩展、验证；本记录不改变 Blocked by，不关闭综合 AC，也不释放后续 frontier。

| 接口／事实 | 当前实际行为 | 代码与证据 |
| --- | --- | --- |
| 接纳与查询 | `POST /v1/runs` 固定 prompt/profile/output_contract；同身份幂等提交；`GET /v1/runs`、`GET /v1/runs/{id}` 返回允许字段投影 | [app.ts](../../../../src/app.ts)、[runs.test.ts](../../../../tests/runs.test.ts) |
| 结果读取 | `GET /v1/runs/{id}/result` 仅在 succeeded 返回已提交 JSON、校验报告与空 artifacts；无上传或文件下载接口 | [app.ts](../../../../src/app.ts)、[domain.ts](../../../../src/domain.ts) |
| 持久化与固定依据 | `Store.accept` 在 SQLite 事务中绑定 Run／幂等与审计；`registerProfile` 在恢复前拒绝配置漂移；`change` 是受控状态变更与审计提交入口 | [store.ts](../../../../src/store.ts)、[既有完整测试](unit-tests.txt) |
| 执行与回收适配边界 | `SandboxPort.prepare(run)`、`execute(run, signal)`、`cleanup(run)`；Worker 持久创建／Attempt 意图，平台校验 JSON，再独立记录回收观测 | [domain.ts](../../../../src/domain.ts)、[worker.ts](../../../../src/worker.ts)、[opensandbox.ts](../../../../src/opensandbox.ts) |
| 故障验证边界 | 确定性 SandboxPort 覆盖 schema、缺输入／授权、准备失败、期限与回收未知；OpenSandbox SDK 通过受控 HTTP 验证 fresh 404；可读 SQLite 写失败仍逐项尝试处置 | [runs.test.ts](../../../../tests/runs.test.ts)、[opensandbox.test.ts](../../../../tests/opensandbox.test.ts)、[persistence-faults.test.ts](../../../../tests/persistence-faults.test.ts) |
| A 页面与身份 | `/auth/session`、`/v1/me` 与同一业务 API 支持身份、任务列表／详情及刷新恢复；健康角色仅有身份与健康读取权限 | [app.ts](../../../../src/app.ts)、[console.spec.ts](../../../../tests/console.spec.ts)、[既有浏览器记录](browser-tests.txt) |

当前窄类型固定无 inputs、tools、MCP；Result 固定 summary/value；执行槽位为 1。文件装载与产物、有限等待／SSE、取消、完整创建对账、持续回收调度和保留策略均须按原计划各票实施，不能从这些接口的存在推断其能力已经完成。

## 真实条件与验收边界

| 条件 | 已有证据与剩余工作 |
| --- | --- |
| Linux 节点与 SSH | 用户提供节点并确认主机指纹；SSH 登录和只读 Linux／Docker 观测已完成，见 [外部预检](external-preflight.md)。本轮没有重新登录，环境状态采用该同日归档观测。 |
| 模型 profile | 用途／凭据适用范围未解决，确切获准 endpoint/model、secret 环境变量绑定及用途／计费授权引用仍需落实；不得静默换套餐／账户，也未调用计费服务。 |
| 部署与资源 | OpenSandbox 部署修订、Node 安装、runner 基础及最终镜像 digest、独立 live 数据库仍待落实。预检显示 8080 已占用；代码请求每 sandbox 4Gi 内存，节点约 3.6 GiB，实际分配与容量仍待核实。没有部署／网络／隔离 PASS。 |
| 真实业务内容 | 尚无真实 Run/Attempt、schema 与 summary/value 内容、资源停止／消失的联合证据。fixture、SDK 本地 HTTP 和 Chromium 记录均不能补足。 |
| 人工验收 | 尚无用户确认；本票四条综合 AC 保持未勾选。 |

## 本轮验证

既有 15 项确定性测试、1 项 Chromium 测试、构建／跨进程重启与锁检查已经归档；[初次双轴审查](review.md) 的代码问题已修复。本轮没有新增验证 seam 或测试用例，不重复浏览器／远程验收。实施技能要求的末尾完整测试、类型检查和文档检查记录于 [本轮验证输出](handoff-validation.txt)；双轴审查结论另见本轮 review 记录。

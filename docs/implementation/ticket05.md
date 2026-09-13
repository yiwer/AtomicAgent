# Ticket05 — 环境与模型独立修订

已实现 A 配置面板、公开配置命令 API、独立不可变修订、普通 Run 固定选择和按清单执行／回收。当前证据是确定性执行端、真实 HTTP／SQLite／浏览器与编译后进程重启；**真实模型、Linux／Docker 和人工验收未完成，不关闭 AC-03、AC-18 或 A-AC-02 综合验收**。Skills／MCP、运行中授权撤销和权限编辑分别属于后续票。

## 启动和最短演示

Node 24.18.0，项目根目录：

```powershell
# 仅新安装、尚无 .local/config.json 时执行 setup:local；不覆盖已有私有配置。
npm ci
npm run setup:local
npm run build
npm start
```

已有本地配置时直接 `npm run build; npm start`。打开 <http://127.0.0.1:4310>，私下使用已登记 maintainer 令牌登录，不复制令牌到证据。

1. 侧栏「环境与模型」→「登记配置」。选择环境、名称 `short-task`、登记 runtime 身份、获准镜像和 30 秒期限，填写说明并预览。
2. 核对实际字段变化、影响的新 Run 范围和已有 Run 固定引用后发布。列表显示 `short-task@1`、发布者／时间、内容和兼容性未验证；可「发布后续修订」，旧内容不改写。
3. 关闭配置面板，在普通新任务表单选择 `short-task@1` 和 `json-lab@1` 模型。执行后详情显示环境／模型修订、固定 runtime、manifest digest、结果与独立回收状态。顶部模式说明来自所选修订，混合 fixture／opensandbox 模式不可提交。
4. 打开该配置历史，预览并停用；该修订不能用于新 Run。已有 Run 仍可查，已有授予继续，原幂等 key 仍找回原 Run。重新启用须预览和新命令身份。
5. 若发布响应丢失，「找回配置操作」使用原命令和正文；刷新或重新登录原工作区／身份后继续。配置冲突会明确拒绝，应重新打开最新修订并预览。停止并重启服务后重新登录，历史、启用状态、命令回执和旧 Run 仍在。

## API 与权限

`GET /v1/configurations` 返回本工作区修订和可选状态；caller 可读受控的选择投影，maintainer 额外读取登记目录与历史语义快照。health 无业务配置读取／写入权限。

维护者先 `POST /v1/configurations/preview`：

```json
{
  "action": "publish", "kind": "environment", "name": "short-task",
  "expected_generation": 0,
  "content": { "binding_ref": "从目录选择的runtime身份", "image": "从该身份允许集选择的镜像", "timeout_seconds": 30 },
  "reason": "短任务期限"
}
```

模型使用 `kind: "model"`、`content: { "binding_ref": "connection-…", "model": "允许的模型名" }`。已有配置使用目录返回的当前 `generation`；服务器分配单调递增版本，客户端不能指定发布覆盖某个版本。

预览返回规范化 `command`、`preview_digest`、变化、采样时间／来源和旧 Run 引用（最多显示 100 条并给总数／截断标识）。`POST /v1/configurations/commands` 提交原 `command` 加 `preview_digest`，请求头必须有稳定 `Idempotency-Key`。A 还发送 `X-Configuration-Actor`／`X-Configuration-Workspace`，防止另一标签切换共享会话后误以另一个身份执行。API 始终从真实鉴权主体推导 actor／workspace，不接收正文角色或工作区授权。

启用／停用正文为 `action: "enable" | "disable"`、kind、name、固定 version、expected_generation、reason，也先预览。预览本身不授予运行能力、不产生兼容性证明。

命令回执包含 command_id、actor、workspace、action、generation、固定修订和记录时间。同身份／工作区／key／正文重复返回原回执；同 key 改正文是 `configuration_command_conflict`；旧 generation 是 `configuration_conflict`。配置状态、命令回执和所属审计同 SQLite 事务提交；写入失败不产生可用新配置。仅确认该 key 未提交且明确业务拒绝时返回 `command_status: not_applied`，503／断连保持待确认。

普通 Run 支持：

```json
{
  "prompt": "Return three apples and integer 3.",
  "environment": { "profile_id": "short-task", "version": "1" },
  "model": { "profile_id": "json-lab", "version": "1" },
  "output_contract": "summary-value@1"
}
```

01–04 的 `profile: "json-lab@1"` 旧请求仍按最初默认固定引用兼容，不能和 environment/model 混用。原 key 回放先于今日配置解析、可用性判断和输入解析，所以停用、目录变更或新的启动默认不会破坏原 key 找回。提交摘要与清单摘要分离；新修订会冻结完整 runtime、model、endpoint、服务端凭据引用、provider 和期限，状态更新拒绝改写已冻结清单。

`GET /v1/configurations/audit` 仅为本工作区配置管理操作历史，固定字段、最多最近 100 条，含读取自身的一次留痕。它不提供普通 Run／平台审计筛选或导出，也不授予 Ticket20 的独立通用审计权限。健康提供登记修订启用数、不可用数、观测时间、来源和覆盖，模型兼容性一直是 unverified。

## 服务端允许集与实际路由

私有配置保留 `profile` 为初始兼容入口，并可添加 `approved_profiles: Profile[]`。这些是平台运维批准的实际执行材料和授权范围，**不自动发布成 A 的新修订**。A 发布可以组合其中的 runtime／model 连接，并在允许集中选择镜像、模型、缩短期限；每个镜像分别限制期限。模型连接与 runtime 分开登记，换模型不必重发环境，换环境不改模型修订。

服务端连接身份固定 endpoint、secret 引用和用途授权引用；runtime 身份固定 mode、Node／Claude SDK／CLI、OpenSandbox provider、节点和 Docker runtime。A 不能任意填写端点、环境变量名、镜像外部地址、挂载、脚本、额外网络权限、工具或「已验证」状态。注册新的外部能力需要运维先将准确获准材料加入私有允许集；A 中的选择不自行扩大授权。模式和用途身份也是连接身份的一部分。

独立 provider 目录使用：

```json
{"providers": [{"ref": "sandbox-approved@1", "endpoint": "https://获准执行服务", "api_key_ref": "获准服务端变量名"}]}
```

每份 live profile 的 provider_ref／provider_endpoint 必须精确匹配。旧 `opensandbox: { domain, api_key_ref }` 兼容为默认 profile 的 provider 绑定，不能同时重复登记同一 ref。provider 的 endpoint／变量引用映射写入数据库后不可在同一身份下改绑；新 provider 必须使用新身份，旧回收责任需要保留旧 provider 绑定。

`main.ts` 只读取私有目录明确列出的变量名；API 输入不进入 `process.env`。模型 endpoint／model／secret／用途允许集一致校验，不能通过选择任意模型端点转发另一个账号 secret。修订语义快照与预览仅显示不透明 credential／approval 身份，不返回变量名或密钥值；旧绑定退出当前可选目录后，已发布内容仍能解释。

`RoutedSandbox` 每次根据 Run 的冻结 profile 选择实际 provider 和模型连接。准备、输入、执行、回收都使用该 Run 的 provider；没有全局 provider 冒充多修订。新执行严格匹配允许 runtime／image／model／connection；回收只校验原 mode／provider_ref／endpoint，不因旧镜像或模型退出执行目录而丢失回收能力，也绝不回退到新 provider。已接纳 Run 停用后仍按原清单运行；移除实际部署绑定属于运维配置变更，会使缺失绑定明确失败／未知，不能视为普通停用。

## 旧库迁移与证据边界

迁移保留 registered_profile 不可变校验，从旧 Run 的实际冻结 profile 补建独立历史引用，另登记当前初始 profile。旧 Run 的清单和摘要不重写；清理使用原 provider。已注册组合 id 的原地修改继续拒绝。fixture 与 live 从不静默互换。

04 历史清单保存 provider_ref 与 provider_endpoint，**没有保存 `opensandbox.api_key_ref` 到环境变量的历史映射**。05 起持久固定私有部署给定的映射，不能由此追认 04 未记录的变量名或证明曾用同一凭据。当前迁移实测为 fixture；若接入具有未完成回收责任的旧 live 数据库，运维必须核对原 provider 范围与私有部署依据，缺少依据不能宣称旧凭据映射／资源消失已验收。本轮未读取现有账号凭据弥补历史，也未部署 live。

## 验证账本

| 层次 | 命令／证据 | 结论 |
| --- | --- | --- |
| 类型／构建 | `npm run typecheck`、`npm run build` | 通过 |
| 配置 API 与故障、provider 路由 | `npx tsx --test tests/configurations.test.ts tests/profile-routing.test.ts` | 8／8 通过；公开 API、SQLite 故障、受控执行端、真实 HTTP SDK 回收编解码 |
| 完整确定性 suite | `npm test` | 53／53 通过；含 04 的真实 30 秒等待和 SSE 边界 |
| 编译入口／真实进程重启 | `npx tsx scripts/verify-local.ts`（先 build） | 发布固定修订、普通 Run、停用、重启、命令回放、旧 key、排他锁通过；fixture |
| A 浏览器 | `npm run test:browser` | 完整报告见本票证据；配置聚焦 3／3 通过 |
| 真实模型／OpenSandbox Docker／Linux 隔离 | 需要准确获准 profile／凭据用途／节点与镜像 | 未执行；浏览器 live-mode 只验证展示，执行端明确拒绝调用 |
| 人工验收 | 用户明确确认 | 未执行 |

证据目录：[ticket05](../../.scratch/v0/evidence/ticket05/)。TDD 记录和审查分别见 [实施证据](../../.scratch/v0/evidence/ticket05/implementation.md)、[双轴审查](../../.scratch/v0/evidence/ticket05/review.md)。所有 PASS 仅限明确标注的 seam，不是模型兼容性、真实资源删除或综合 AC 关闭证据。

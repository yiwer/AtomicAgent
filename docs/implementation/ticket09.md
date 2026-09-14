# Ticket09 — 取消裁定与实际停止

实现调用方／同工作区维护者 API 和 A 取消入口、原子终态裁定、30 秒宽限、独立停止及回收观测。确定性 API／故障、真实 Windows 受控子进程、OpenSandbox HTTP 协议与 Chromium 证据分开记录于[验证清单](../../.scratch/v0/evidence/ticket09/verification.md)。真实获准模型和 Linux OpenSandbox 运行／隔离／物理回收仍未验收，因此本票 AC 保持未勾选。

## 启动与最短 A 路径

项目根目录、Node 24.18.0；已有 `.local/config.json` 时：

```powershell
npm ci
npm run build
npm start
# 仅首次且本地配置不存在：npm run setup:local
```

打开 `http://127.0.0.1:4310`，用现有有权身份登录。提交任务，详情点击「取消任务」。页面显示取消裁定、稳定取消请求 ID／发起者／时间、实际停止、30 秒宽限截止、强停意图、核验来源与时间及独立回收；刷新仍查询同一持久事实。网络错误显示「取消结果待确认」，再次点击同一任务的取消或「核对取消请求」安全重放。浏览器跨标签切换身份后，旧页面发起的取消被服务端拒绝。

本地默认 JSON fixture 很快完成；已经成功时取消按钮隐藏。可重现执行中取消的隔离浏览器场景：

```powershell
npx playwright test tests/cancellation.spec.ts
npx tsx scripts/verify-cancellation-process.ts
npx tsx --test tests/cancellation.test.ts tests/opensandbox.test.ts
```

浏览器测试使用独立临时库和显式 fixture，真实等待 30 秒。进程验证单独启动自己持有的 Node 子进程，等待真实 30 秒，强停并观察 `close`，核验资源集合为空；不读取或停止用户其他进程。

## API 与裁定

`POST /v1/runs/{run_id}:cancel`，JSON body `{}`。Bearer 或现有会话认证；只允许同工作区 owner 或 maintainer，其他 caller／工作区返回 404，health 返回 403。浏览器发送 `X-Cancellation-Actor` 与 `X-Cancellation-Workspace`，不匹配会话时为 403 `cancellation_identity_changed`。任意扩展 body 字段被拒绝，调用者不能提供进程／资源／命令／停止证据。

HTTP 200 返回同一个公开 Run 投影，附 `cancellation` 与 `stop`。取消是每 Run 一次的固有操作：首次请求由服务端生成 `operation_id`，保存发起者、角色、时间与 `accepted`／`already_terminal` 裁定。重复请求（包括其他有权维护者）查询同一 receipt，不重置宽限，也不改变原发起者。重复访问仍记实际请求者审计。无需客户端另造幂等键。

取消与 Result 提交均通过 SQLite `BEGIN IMMEDIATE` 中的 Run 更新裁定。取消先提交时业务状态为 `cancelled`，结果不可发布；成功先提交时迟到取消记录 `already_terminal`，原 Result／Artifact 保留。业务终态表示裁定，不能解释为物理停止。旧能力事件、输入装载完成、Attempt 启动与迟到 Result 不得改写取消终态；staged Artifact 在取消后清除，原有源 Artifact 不受影响。

排队取消没有 Attempt／allocation，stop=`not_started`、cleanup=`complete` 的来源分别为平台未启动／无创建意图。准备取消也没有 Attempt，但 `creation_pending`／`input_copy_pending` 保留不确定资源责任；先前删除返回 absent 仍不能掩盖未返回的资源创建或输入写入。晚返回的资源 ID、复制完成事实被记录并触发再次清理；存储写失败仍尝试处置已知不可变资源。进程关闭后晚返回只能进行资源处置，不能伪造已持久核验；旧操作责任仍在库中。

## 执行停止与恢复

执行中的取消先可靠提交意图，再触发平台 AbortSignal 和冻结 provider 的 graceful marker。生产 OpenSandbox 写 `/workspace/cancel.json`，受控 runner 按 Run／Attempt 校验标记后将取消传到 Claude SDK AbortController，禁止后续工具授权；该信号及 SDK 返回都不是停止证据。派发路径在连接前和启动命令前检查取消，不能在已取消后开始一条新命令。

到持久 `grace_deadline_at`（原请求加 30 秒），执行层按冻结 provider／不可变 sandbox ID 强停整个 sandbox；仅在 DELETE 之后新 GET 得到 404，才记录 stop=`stopped`。403、资源仍存在、请求异常或没有实现可核验 forceStop 的适配器均保持 unknown。stop 观测与 cleanup 查询／审计独立；不根据 stop 字段自动宣告删除完成。fixture 的实际本地文件执行持有 ChildProcess 对象并等待 close，绝不按一个可复用的裸 PID 扫描杀进程。

停止未知时保留执行槽，不放行下一 Attempt。独立协调器按每 Run 1、2、4、8、16、30 秒上限退避继续核验，持久 stop checks／retry_at；准备／独立回收未知最多每 30 秒重试。重启沿同一取消意图、宽限和 provider 路由继续处置，不重做 Agent。旧资源创建回执丢失时用原 operation 元数据处置，空 listing 不能证明未来不会出现资源；没有可靠闭合证据时保留未知。更完整的 provider 创建／启动对账、worker 接管及人工回收分别仍属 Tickets14／15／17。

取消意图提交失败返回 503，不声称已接受；立即阻止本进程新增接纳／配置授权／执行，原已接纳 key 仍可查回。对已经读出的 Run／resource 保留有限内存停止路径：仍以原请求 30 秒为强停界限，停止和回收不能被后续观测写失败阻断。缺失的取消审计不补造成当时已记录；恢复后可能为 `execution_lost`，而非伪造 cancelled。持久资源意图在进程重启后仍支持处置。本票故障实验涵盖 SQLite 写拒绝与读取暂不可用；协调器保留已读取的不可变资源身份，读故障不使timer崩溃或阻断处置。完整核心记录退化模式和应急记录落盘属于 Ticket21。

`run.cancel-request` 保存实际授权主体／重复请求者，`run.cancel-decision` 保存裁定，`execution.force-stop-intent`／`execution.stop-observed` 和既有 cleanup 审计保存有界身份、来源、时间及结果。SSE 从同一持久 Run 生成取消／停止投影。`/internal/health.cancellation` 为本工作区带来源、查询时间、最近实际观测时间的接受／未启动／待核验／未知／已停止／未完成回收计数，无 Run ID、提示词或凭据，不能当作实时 provider 探针。

## 外部验收条件

现有 Ubuntu `159.75.158.26`／`agent.91boy.cn` 与 SSH 信任预检记录不等于部署或隔离合格。仍待获准 endpoint/model、服务端 secret 环境变量绑定及用途／计费授权，方可用固定 Claude SDK 0.3.270 + OpenSandbox 0.1.11 在 Linux 实测执行中取消、子进程树消失和 provider 资源删除，核对 Docker／gVisor。未采用 Qwen 个人套餐，未读取无关凭据、计费调用或远端部署。浏览器自动化通过也不等于用户人工综合验收。

# Ticket04 — 有限等待与可恢复进度

本票实现有限提交等待、持久 RunEvent 及 A 详情断线续看。确定性执行端贯穿真实本机 HTTP、SQLite、TCP 和 Chromium；真实模型、Linux/OpenSandbox 部署及用户人工验收仍未完成，综合 AC-06／AC-23／A-AC-01 不勾选。

## 运行与最短演示

沿用 Node 24.18.0 和已有本地配置：

```powershell
npm run build
npm start
```

首次环境按 [Ticket01](ticket01.md) 初始化；私下读取本地配置令牌登录 <http://127.0.0.1:4310>，不要把令牌写入工单或截图。

1. 提交任务并查看详情中的进度连接状态、事件序号、业务状态及独立回收状态。刷新、关闭页面并通过同一 Run 地址重新打开，继续读取权威结果。普通 fixture 的输出固定；不宣称理解任意提示词。
2. 调用 `POST /v1/runs?wait_seconds=1`，保持原 Bearer、Idempotency-Key 和 `prompt/profile/output_contract/inputs` 正文。短任务在期限内终结返回 HTTP 200、Run、`result` 与 `artifacts`；业务失败同样返回 200，但明确 `failed/timed_out`、受控 `failure` 和 `result:null`。HTTP 200 本身不代表业务成功。
3. 等待参数默认 0，支持 0–30 秒、至多三位小数；超界、空值、重复值或非法值返回 400 `invalid_wait_seconds`。等待截止仍非终态返回 202 和持久身份；默认 0 保持原 202 行为。query 不进入提交正文摘要、执行清单或总期限，改变 wait 后可用原 key 找回同一个 Run。原期望 workspace/actor 提交防护继续生效。
4. `GET /v1/runs/{id}/events` 读取 SSE；重连携带 `Last-Event-ID: {run_id}:{sequence}`，或查询 `?cursor={run_id}:{sequence}`。header 优先。按序号去重，只读取该游标之后的事件。未来游标返回 409，非法／异 Run 游标 400；过期返回 410 `event_cursor_expired`，附 `recovery:query_run`、`run_url`。随后读取该 Run 与 `/result`。
5. 可直接运行 `npx tsx --test tests/events.test.ts`。实验包含真实 30 秒等待、连接断开、暂停 TCP 消费和 100 次正常恢复产生的多页回收观测。`npx playwright test tests/events.spec.ts` 展示受控两秒任务在运行中关页、网络恢复、重复帧、done／EOF 和过期游标回到权威查询。

## 事实与资源边界

- Run 状态变化、必要审计及进度投影同一 SQLite 事务落盘；每个 Run 的事件序号从 1 单调递增，`event_id` 与 SSE `id` 均为 Run＋序号。包含 version、Run、序号、发生／记录时间、投影类型和可信平台来源；排队事件的 Attempt 为 null。没有对外可见事实变化的内部资源写入不产生新事件。
- 进度仅含 Attempt、状态、阶段、受控失败类别、校验状态及回收状态／观测时间，不含 prompt、业务 Result、原始模型会话、stdout、宿主资源身份、URL 或 secret 引用。业务 Result 只由授权提交等待／查询交付。进度不替代责任审计；SSE 访问写 `run.events.read`，重播不会重新执行、重记接受或累加成功数。
- 旧数据库在资源恢复后、接纳新工作前补一个标为 `run.snapshot` 的当前快照。时间表示快照建立时刻，不虚构历史阶段。初始化写入失败会拒绝启动新工作；不把快照初始化插到健康读取或资源恢复之前。
- 脱敏事件在执行中不提前过期，终态后七天停止事件读取；未完成回收不延长事件公开窗口。权威 Run/Result 记录的物理到期删除与最小回收责任留存仍由后续留存票交付，当前过期事件明确退回查询，不承诺旧记录无限可查。
- 连接与 Run 独立。HTTP 超时、SSE 断开、关页、进度窗口结束不调用取消、不改变原 deadline、不重启 Attempt。成功终态后继续推送清理观测；业务和回收分别显示。
- SSE 每次只取 32 条持久事件，不创建无界订阅队列。socket 背压暂停读取，drain 后接续；五秒未 drain 断开。流寿命 30 秒，到期停止 pump、最多再给一秒 flush，之后释放 socket；客户端从已消费游标重连。每身份最多 8 条、每进程最多 128 条连接，超出 429。连接关闭释放 timer、drain listener 和本地登记。
- 每批发送前重新认证原请求的会话，250 ms 周期也在无新事件时核对失效。登出和会话轮换撤销请求携带的旧 session，过期／撤销后不再发送数据。浏览器观察请求携带期望 actor/workspace，只能收紧服务端授权；跨标签页更换共享 cookie 后不会偷偷用新身份恢复旧观察。健康角色不能读取事件，普通调用者／维护者仍按原 Run 权限隔离。
- A 将游标存在绑定 workspace、actor、Run 的标签页 sessionStorage。重复序号不重复应用，已保存游标用于刷新重连。事件仅触发权威查询；done 文本、EOF、错误帧与进度状态绝不提交业务成功。断线时查询 Run，再有界延迟重连；游标过期停止事件恢复，继续已有权威刷新。关闭详情、登出、pagehide 释放消费者。
- `/internal/health` 增加 `events`：同工作区持久事件数及数据库观测时间／来源，以及本地活动连接数及观测时间／来源。它们是有限覆盖的事实和连接统计，重放不增加持久事件数；没有真实模型探测，模型仍为 unknown，不替代 Ticket23 总览。

## 验证与未完成条件

详见 [证据账本](../../.scratch/v0/evidence/ticket04/verification.md)。公开 API 测试使用独立临时库和明确标识的 SandboxPort；真实 socket／浏览器故障与执行替身分别列账。没有调用未授权模型或远程服务，没有 Docker/gVisor、生产网络或人工验收证据。

真实验收继承 Ticket01 所需获准模型 endpoint、model、服务端 secret 变量引用、计费用途、固定 Linux/OpenSandbox/镜像身份。条件到位后用同一公开等待／断连／重放路径核对真实模型执行计数、权威结果与资源核验；不能用本票确定性通过关闭这些门槛。

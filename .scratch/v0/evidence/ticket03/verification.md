# Ticket03 验证账本

日期：2026-09-14（Asia/Shanghai）。基线：`969a632e6c6e4ec1ffddbb025ca18588203c6dcb`。新上下文实施 agent 使用 implement／TDD；批准 seam 为公开 API、持久恢复、执行计数和 A 展示。

## RED → GREEN

1. `npx tsx --test tests/idempotency.test.ts` 首次失败：相同 file_id/path 仅交换对象字段顺序，期望 202，实际 409。改为规范提交摘要后通过。
2. 公开健康观测测试首次失败：`health.submissions` 不存在。补同工作区持久审计计数、时间与来源后通过。
3. `npx playwright test tests/idempotency.spec.ts` 首次失败：接纳响应丢失后刷新，“找回未确认提交”不存在。补身份绑定的原 key/body 保存与明确找回入口后通过。
4. 审查增量先新增浏览器回归并观察两项失败：恢复时真实 API 返回 403 导致待确认入口消失；另一个标签页改变共享 Cookie 后旧页面未阻止跨身份提交。修复后两项通过，并补公开 API 的 `not_accepted` 判据测试。

## 最终本地检查

| 命令 | 结果 | 证据含义 |
| --- | --- | --- |
| `npm run typecheck` | PASS | TypeScript 类型检查 |
| `npm run build` | PASS | 编译输出可生成 |
| `npm test` | 37/37 PASS | 01–03 公开 API、文件、故障、适配器与本机网络实验；含受控外部系统 |
| `npm run test:browser` | 6/6 PASS | Chromium 真实页面/API；新幂等4例，既有提示词/文件2例 |
| `node --test dist/tests/idempotency.test.js dist/tests/submission-recovery.test.js` | 6/6 PASS | 编译后的实际 API、子进程与 TCP 路径 |

最终检查运行于代码快照 `9d23ee62d411cecd5493c67aad987a8b65b36ec5`；初始快照 `69c1eb8` 的 36/36、4/4、5/5 属审查前历史结果。

测试控制台告警仅为 Playwright 的 NO_COLOR/FORCE_COLOR 配置提示；无测试失败。

## 输入、动作、观测

- API：12 次并发同身份、同 key／正文返回一个 Run；改变 prompt、profile、contract、inputs 为 409。同 actor 不同 workspace 及同 workspace 不同 actor 各自接纳独立 Run，越权读取为 404。
- 文件：上传真实三字段 CSV；交换 binding 的 JSON 字段顺序可重放。等待完整执行并重启后，loaded 为 true 而清单摘要不变。时间 seam 前移两天后旧 key 仍找回原 Run，新 key 引用过期源为 410，受控执行数保持 1。
- 失败：不合格输出 Run 重启后同 key 恢复原失败身份和摘要；新 key 是新 Run，提交摘要相同但固定期限导致清单摘要不同。
- 健康：同工作区 accepted=1／replayed=1／conflict=1 持久到重启后；其他工作区不计入，来源和观测时间存在，模型仍未知，caller 读取 health 为 403。
- 网络／恢复：`tests/submission-recovery.test.ts` 启动真实子进程和 HTTP 代理。代理确认上游 202 后销毁客户端 socket，客户端没有收到接受响应；16 次并发重传，随后 SIGKILL 已启动 Attempt 的控制进程。新 PID 打开同一 SQLite 返回原 Run／Attempt、failed/execution_lost。实际输出：`upstream_acceptance=202; client_response=TCP_reset; concurrent_retries=16; controller_processes=2; Run=1; Attempt=1; controlled_SandboxPort_starts=1; actual_model_starts=unverified`。
- A：路由层先让真实服务接受，再丢弃浏览器响应；刷新显示找回入口。编辑提示词后找回仍发送原 key／正文，结果恢复原 Run，列表增量为 1。登出、其他身份登录／刷新无该待确认入口且越权 API 为 404；原身份登录可明确找回。
- 授权恢复：路由层将恢复请求送至真实 API，使用同 actor/workspace 的 health 权限令牌，实际得到 403；A 保留原 key 并在权限恢复后找回原 Run。另一案例在第二个同源标签页实际登录另一身份、改变共享 Cookie；旧页面恢复请求被服务端期望身份检查拒绝为 403，另一身份列表没有新增任务。
- 明确未接纳：不存在的 key 因不可用 profile 被业务拒绝，返回 `submission_status=not_accepted`；原 key 已绑定后的冲突、health 403、无效身份 401 均不带此声明。

截图：[待确认提交](ticket03-pending.png)、[恢复后的同一 Run](ticket03-recovered.png)。已目视检查恢复详情，无遮挡正文或错误状态；原有移动端测试仍通过。本证据是浏览器自动化和 agent 视觉检查，不是用户人工验收。

## 双轴审查

固定点采用以上基线，Spec 为 `.scratch/v0/issues/03-idempotent-submission-recovery.md`。两个独立只读 reviewer 并行审查 `969a632...69c1eb8`，再分别复核 `69c1eb8...9d23ee6`。reviewer 未重复执行测试；本票实施 agent 执行最终检查。

### Standards

初审 0 项文档标准违规、0 项值得报告的 baseline smell。核对领域、tracker、ADR 0003／0004／0006 与批准的 TDD seam，记录区分实际网络和受控执行证据。增量复核新增 0；期望身份只用于与服务端身份比较，未成为授权来源；明确未接纳判据符合恢复责任边界。

### Spec

初审 1 项 P1：恢复请求仅依赖内存 me 和共享 Cookie，另一同源标签页切换身份可使原 pending 被接纳为另一身份的新 Run。已在 `9d23ee6` 修复为服务端接纳前比对期望 workspace／actor，新增双标签页 RED→GREEN。root 同时发现恢复 403 不证明旧任务未接纳，补 `not_accepted` 严格判据与真实 API 403 后保留原 key 的回归。Spec 增量复核 0 剩余问题，无剩余 P1。

两轴最终：Standards 0，Spec 0；真实综合验收仍受下述门槛阻塞。

## 未完成门槛

- 真实 Claude SDK／模型执行次数：未验证；SandboxPort 计数不可替代。
- Linux/OpenSandbox/Docker 真实部署及资源／模型恢复：未验证；本机跨进程不替代生产进程锁和容器隔离验收。
- 用户人工验收：未执行。
- AC-05、A-AC-01 综合勾选保持未完成；已实现下游可使用的接口不释放这些门槛。

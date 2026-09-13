# Ticket04 验证账本

日期：2026-09-14。基线：`2161c01d7660b109e03b7ff7d6bebfc944ba7234`。本票通过新上下文实施，按已批准公开 API／真实 HTTP/SSE、浏览器、持久结果 seams 使用 TDD；没有执行或伪造 `/clear`。

## RED → GREEN

1. 有限等待首例：RED 为 202 不等于预期 200；GREEN 返回持久校验结果，同 key 改 wait 后身份／期限／两种摘要不变。
2. 事件重放首例：RED 为 `/events` 404；GREEN 事件序号 1–5、稳定身份、排队无 Attempt、终态与回收独立，重启后重放字节字段一致。
3. 轮换 session／过期窗口：RED 为旧 cookie 仍返回 200；GREEN 旧 cookie 401、长连接停发、八小时会话失效、终态七天后游标 410 并附权威查询路径。
4. 浏览器首例：RED 为无进度区域；GREEN 运行中关页后同一 Run 恢复。增量 RED 暴露刷新已存游标却无序号说明，已显示恢复序号。
5. 中间检查纠正：旧库 snapshot 初始化曾误放健康聚合，现移到资源恢复后明确初始化；背压改为 drain 暂停／超时，统一流结束停止 pump 并有界 flush。浏览器注入路由一度误拦 `events.js`，缩窄到 Run events API；旧幂等测试在恢复按钮刚显示、请求未完成时过早移除路由，改为等待按钮可用后移除。TypeScript 拒绝测试客户端 unsupported `highWaterMark`，已移除该选项，保留真实分段慢读。

## 层次和证据

| 层次 | 输入／动作及观察 | 结果／出处 |
| --- | --- | --- |
| 类型／构建 | 当前产品及测试代码 | `typecheck.txt`、`build.txt` 通过 |
| 聚焦 HTTP/SSE | 原 key 改等待、失败终态、身份隔离、session轮换／失效、7天过期、配额、旧库升级、多页慢读 | 7 项已通过；公开 HTTP seam |
| 全部确定性测试 | `npm test` | 44/44、0跳过，`full-tests.txt` |
| 编译后 HTTP/SSE | `node --test dist/tests/events.test.js` | 执行记录见 `compiled-events-tests.txt` |
| 实际网络 | 30 秒计时、等待请求 abort 断开客户端连接、SSE IncomingMessage.pause，30 秒流释放；Run仍running，释放受控执行后同一Run成功 | 包含在 events 测试；首次实际耗时约30.07秒，整个案例约30.68秒 |
| 真实多页消费 | 正常恢复100次，外部受控provider回收观测生成105条持久事件；真实HTTP每段慢读100ms，消费到80后断开，游标继续81–105 | 已通过；单Run／单受控执行，不查询内部计数来判PASS |
| 持久恢复 | app关闭／重开同库，旧schema移除events表后启动迁移；授权调用者直接读snapshot、不先调用health | 已通过；这不是独立新进程部署验收 |
| 浏览器 | Chromium＋真实API/SQLite，受控执行延迟2秒，运行中关页／重开、offline、重复帧、done/EOF、410 | 新增3项通过；完整浏览器回归记录 `browser-tests.txt` |
| 敏感出口 | prompt含合成secret/URL，执行替身返回含secret的非法候选 | 事件无prompt/原始会话/secret/资源身份；失败不交付Result |
| 真实模型／Linux／OpenSandbox／Docker/gVisor／生产网络 | 尚未提供本票适用授权profile及部署条件 | 未执行 |
| 人工验收 | 用户实际体验并明确确认 | 未执行 |

API过期测试使用可注入的观测／会话时钟推进时间；执行清单的实际 deadline 仍由原执行时钟创建。浏览器410、重复帧、done/EOF为传输边界受控注入，页面最终结果来自实际API；它们不冒充生产网络故障。局部实验不证明云端慢网络吞吐、长稳或真实模型完成率。

## 审查

固定范围 `git diff 2161c01d7660b109e03b7ff7d6bebfc944ba7234...HEAD`，Spec 为 `.scratch/v0/issues/04-bounded-wait-resumable-sse.md`。产品 checkpoint 后使用 code-review 的两名独立 reviewer 并行审查，结果与修复将记录在 `review.md`。

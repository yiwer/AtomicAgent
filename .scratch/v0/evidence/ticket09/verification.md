# Ticket09 验证记录

固定实施基线：`49bcc610c8427d3276bf405dbe3507e1f60b7c19`。TDD 预授权 seam：公开 API/A、生命周期、provider、SQLite／object storage、取消时钟。产品的取消时钟与 Ticket04 观察／会话时钟分开；生产均使用 Date.now，测试只从服务创建参数注入，HTTP 不能改时钟或宽限。

| 层次 | 输入／动作与可观察结果 | 证据／结论 |
| --- | --- | --- |
| TDD 首切片 | queued cancel endpoint 从404红灯到200；重放、越权和重启不产生Attempt／sandbox | tests/cancellation.test.ts；通过 |
| 取消生命周期／故障 | 准备晚回执、复制晚完成、executing 29,999／30,000ms、迟到成功、已成功迟到取消、未知退避/slot/重启、意图/观测SQLite失败、产物转存取消 | 9个取消专属测试通过；不等于实际模型证据 |
| OpenSandbox真实客户端协议 | 实际HTTP DELETE+GET：资源存在→unknown，404→stopped，权限/空listing不能闭合创建责任，已取消不可启动 | tests/opensandbox.test.ts 4/4；本地受控HTTP provider，不是Linux部署 |
| 全部确定性回归 | Ticket01–09 公共语义 | [tests.txt](tests.txt)：114/114通过；后续review修复另记 |
| 类型／构建 | tsc --noEmit / tsc | [typecheck.txt](typecheck.txt)、[build.txt](build.txt)：通过 |
| 实际Windows受控进程 | 自己创建的Node子进程保持运行；取消后30,085ms才force；close回执已观测，资源集合0，迟到结果不提交 | [process-stop.json](process-stop.json)：通过；真正运行了本地进程，不是仅AbortSignal |
| 真实Chromium | API取消、断网错误恢复、刷新持久、重复核对、30秒停止与独立回收、390px手机无横向溢出 | cancellation.spec.ts 1/1通过；[desktop](cancel-desktop.png)、[mobile](cancel-mobile.png)；全浏览器回归见browser.txt |
| 获准模型／Linux sandbox | 实际Claude执行取消、进程树/资源消失 | 未执行，待模型配置及用途/计费授权和部署资格；不能用本地进程与HTTP协议实验替代 |
| 人工综合验收 | 用户按A路径核验全部真实层 | 未执行；AC-07／A-AC-01取消部分未关闭 |

浏览器初跑30秒默认测试预算不足，随后明确45秒预算，真实宽限仍30秒，聚焦复跑通过；未缩短生产宽限。产物转存取消测试按既有契约确认metadata可查removed、download-link为409 file_incomplete，未擅改成TTL过期410。

## 双轴审查与提交

实施checkpoint、Standards／Spec初审、修复复核与证据提交SHA将在完成后追加；固定checkpoint不会amend。

# Ticket09 验证记录

固定实施基线：`49bcc610c8427d3276bf405dbe3507e1f60b7c19`。TDD 预授权 seam：公开 API/A、生命周期、provider、SQLite／object storage、取消时钟。产品的取消时钟与 Ticket04 观察／会话时钟分开；生产均使用 Date.now，测试只从服务创建参数注入，HTTP 不能改时钟或宽限。

| 层次 | 输入／动作与可观察结果 | 证据／结论 |
| --- | --- | --- |
| TDD 首切片 | queued cancel endpoint 从404红灯到200；重放、越权和重启不产生Attempt／sandbox | tests/cancellation.test.ts；通过 |
| 取消生命周期／故障 | 准备晚回执、复制晚完成、executing 29,999／30,000ms、迟到成功、已成功迟到取消、未知退避/slot/重启、意图/观测SQLite失败、产物转存取消 | 最终10个取消专属测试通过（含记录读取暂不可用）；不等于实际模型证据 |
| OpenSandbox真实客户端协议 | 实际HTTP DELETE+GET：资源存在→unknown，404→stopped，权限/空listing不能闭合创建责任，已取消不可启动 | tests/opensandbox.test.ts 最终6/6（含connect和request上传取消）；本地受控HTTP provider，不是Linux部署 |
| 全部确定性回归 | Ticket01–09 公共语义 | 初始[tests.txt](tests.txt)114/114；最终[tests-final.txt](tests-final.txt)119/119通过 |
| 类型／构建 | tsc --noEmit / tsc | 最终[typecheck-final.txt](typecheck-final.txt)、[build-final.txt](build-final.txt)：通过 |
| 实际Windows受控进程 | 自己创建的Node子进程保持运行；取消后30,085ms才force；close回执已观测，资源集合0，迟到结果不提交 | [process-stop.json](process-stop.json)：通过；真正运行了本地进程，不是仅AbortSignal |
| 真实Chromium | API取消、断网错误恢复、刷新持久、重复核对、30秒停止与独立回收、390px手机无横向溢出 | cancellation.spec.ts 1/1通过；[desktop](cancel-desktop.png)、[mobile](cancel-mobile.png)；全浏览器回归见browser.txt |
| 获准模型／Linux sandbox | 实际Claude执行取消、进程树/资源消失 | 未执行，待模型配置及用途/计费授权和部署资格；不能用本地进程与HTTP协议实验替代 |
| 人工综合验收 | 用户按A路径核验全部真实层 | 未执行；AC-07／A-AC-01取消部分未关闭 |

浏览器初跑30秒默认测试预算不足，随后明确45秒预算，真实宽限仍30秒，聚焦复跑通过；未缩短生产宽限。产物转存取消测试按既有契约确认metadata可查removed、download-link为409 file_incomplete，未擅改成TTL过期410。

## 双轴审查与提交

实施checkpoint：`7e21860ae1fa136860fdf62b4b9ec73336af91ef`。修复checkpoint：`56e940d06c3705cd0f65bb876f4e273fcbe06401`。两者均保留，没有amend；证据收尾为其后的独立文档提交。

最终验证：修复后[typecheck-final.txt](typecheck-final.txt)、[build-final.txt](build-final.txt)通过，[tests-final.txt](tests-final.txt) **119/119**；取消专属10/10、OpenSandbox协议6/6。新增覆盖Skill权限journal期间取消、research初始journal期间取消，以及SQLite记录读取暂不可用。provider新增实际HTTP connect／request上传期间取消均command=0。保留初始checkpoint原始日志，以区分修复前后的覆盖。

真实Chromium全套 **17/17**，见[browser.txt](browser.txt)，其中取消1/1实际等待30秒；截图已视觉核对包含取消／停止／独立回收核心字段，390px无横向溢出。浏览器位于7e21860；后续修复没有UI变化，相关backend故障/引擎边界由119项回归核验。

双轴初审Standards为0硬性违反、2条P3重复逻辑建议，Spec为0已确认可行动问题；另根代理发现并复现2个取消授权／query启动竞态，均红绿修复。Standards额外指出读取失败timer风险，以真实SQLite临时改名故障验证并修复。56e940d复核Standards／Spec均为 **0剩余可行动问题**；[审查报告](review.md)分别保存两轴和根审来源。

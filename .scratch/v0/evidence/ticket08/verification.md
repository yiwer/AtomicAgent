# Ticket08 验证账本

## 分层结论

- API／SQLite／本地对象存储／真实 Node 子进程：确定性执行模型替身；文件处理器实际计算输入，不调用模型。
- OpenSandbox：已安装生产 SDK 和 OpenSandboxAdapter 的真实本地 HTTP 交互，provider 为受控外部 double；验证独立目标回读和损坏／不完整／符号链接拒绝。不是实际 Linux sandbox、模型或隔离证明。
- A：真实 Chromium 访问产品 HTTP 和持久状态，使用上述执行替身；包含刷新、选择网络故障恢复、直接 API 越权及下载。截图位于本目录，移动图滚到来源和副本核心区域。
- 两次真实模型任务、实际 Linux Docker/gVisor、人工综合验收：未执行，外部输入见实施说明。AC 保持未勾选。

## RED / GREEN

首个显式 artifact_id 提交通过 API 测试先观察 RED：400 而预期202；实现后 GREEN，核验新 Run、新 binding_id、固定来源、独立副本与重启回放。复制失败／健康观测测试先观察 RED（artifact_reuse 未提供），补持久来源计数后 GREEN。其他反例按同公共 seam 增量加入。

受控 Date 分别推进到源剩余1秒：接纳读、prepare、装载读、复制窗口中到期均失败且无 Attempt；副本确认后到期并物理删除临时实验中的源字节，新任务仍成功。此删除仅为测试 BlobPort 故障／时间设施，不是 Ticket18 物理清扫实现。替换源字节、元数据不完整、超输入上限、Markdown、越权、危险路径、复制失败及另一消费者成功复用均有反例。原 Run Result 和幂等身份不受新失败影响。

完整命令与原始输出：typecheck.txt、build.txt、full-tests.txt、browser-tests.txt。精确计数、review与提交基准在 review.md 中补记。

实际模型／远端服务未调用；无邮件、Slack等外发消息。日志只记录测试输出、受控错误类别，不含认证秘密。

当前完整 suite：103/103；完整 Chromium：16/16；A研究 MCP 切回文件任务调整后聚焦 Chromium：1/1。typecheck / build 通过。

Standards命名修复后聚焦Chromium1/1，原始输出browser-review-fix.txt；双轴结果见review.md。

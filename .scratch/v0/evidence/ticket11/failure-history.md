# Ticket11 失败与适用范围

以下失败按原 Run、原工具句柄保留，没有覆盖成 PASS；所有最终结论以 verification.md 的最终镜像组为准。

| 阶段 | 实际失败 | 处理和边界 |
|---|---|---|
| TDD | limits路由404；并发仍串行；产物超限未归因；历史单槽测试前提不适用 | 完成API/调度/错误映射；09测试显式发布并发1，保留unknown占位断言。旧完整回归62572中断不记PASS。 |
| UI | 首轮全套因“变更说明”label匹配多个控件失败，34275中断 | 改为“限额调整理由”，完整19/19重跑；修复small与下一label粘连并目视两尺寸。 |
| 镜像 | apt下载长时间无进展；首版limits.patch malformed；一次tsc失败但PowerShell继续构建 | 明确停止原apt作业后用已批准精确10镜像离线增量构建；修补patch；noEmitOnError和构建退出码检查。不把构建中的失败镜像当可执行版本。 |
| 工具调用 | PowerShell双引号里的远端命令替换误在本地执行，意外拉取并启动node:latest | 没有运行实验或模型；明确移除该自有容器ea049c…及新镜像，不动10镜像和既有服务。之后使用精确image和上传脚本。 |
| 早期prepare | bb12a94a…、21125046… provisioning_failed/cleanup unknown，无Attempt | supervisor工作目录/容量最大值处理失败；修复并保留原记录，独立guardian后续对账原资源，见ledger。 |
| 初次实际组 | 默认任务受默认bridge hairpin影响延迟，后恢复并成功；artifact预算成功；deadline c20a9270… 被固定provider的60秒最小lease以422拒绝 | 该组整体FAIL；模型改为自有网络后原Run继续，无期限重置。provider lease取≥60，但supervisor/guardian仍用原deadline。记录在physical/intermediate-normal。 |
| 49ac正常组 | 三组全部成功 | 属于中间版本证据；最终ce8d另跑normal三组，不混用版本。 |
| 第一压力 | Run7f559a68… CPU throttle/tmpfs ENOSPC成功；内存进程137，但产品最终deadline_exceeded | 整组FAIL；SDK stdout真实每行无换行，join('')破坏计数。改为分行解析，保存真实segments。 |
| 第二压力 | f5777c8b… runtime_failed，resource_limits null；host observer遇到正在写入JSON解析失败，恢复观察原driver但资源已结束 | 有界读取JSON；provider execd就绪不表示entrypoint资源文件已生成，执行前原期限内等待受保护文件。没有把观察timeout当成进程死亡。 |
| 中间压力 | 9643镜像9b8e7f12…完整PASS | 之后补callback抛错反例，发现SDK0.1.11 headers后解绑AbortSignal；不能仅靠abort停止SSE。修为原资源forceStop＋独立拒绝，ce8d最终重测。 |
| observer | 初版inspect把任何非零当absent，且按服务名查找后kill | 未用它作为最终收尾PASS；改为原完整ID＋明确No such object/container，其他为unknown；服务ID来自初始services.txt并校验自有label。Linux反例覆盖Docker失败不能报absent。 |
| 归档工具 | 非root复制权限拒绝；Docker volume缺失文本是“get NAME: no such volume”，初版collect拒为unknown；容器argv中的glob未展开 | 只读collector支持已观察的明确缺失形状；sudo只操作已授权自有目录；哈希改由受限容器shell展开并逐个比对。未将非零泛化为不存在。 |
| 本机临时清理 | 对已核对位于工作区内的normal-temp、Python缓存、三个归档执行删除，两次被自动审批拒绝，返回blocked by policy | 没有更换工具规避；保留未跟踪文件、排除提交。远端自有资源清理已独立完成。 |

物理失败的原始 JSON/log 位于 physical/failed-* 与 physical/intermediate-*。其中业务cleanup unknown不被事后手改为complete；独立 resource-ledger.json 记录后来原资源的明确消失。真实模型、gVisor、生产容量与人工体验是未验收项，不是被确定性实验覆盖的PASS。

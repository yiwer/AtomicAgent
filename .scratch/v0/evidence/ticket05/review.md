# Ticket05 双轴审查

固定点：`fb7b1082a0fccee497ec3deea40505fc191f74ea`。Spec：`.scratch/v0/issues/05-environment-model-revisions.md`。初审快照 `e6b4041`，两位独立只读 reviewer 并行执行；root 的推进账本不在审查／提交范围。

## Standards

初审 1 项文档规范缺口（P2）：`docs/domain-model.md` 的 ConfigurationRevision 核心属性要求内容摘要；实现只有 binding hash 和命令 preview digest，未覆盖独立修订内容。现为迁移／发布写入不可变 content+definition 的 content_digest，排除 enabled；新增缺字段 RED→GREEN 回归。另有 2 项非阻断启发：Content 的可选字段类型、kind 分支重复；已有运行时输入校验，无已证实绕过，不为启发项新增多态框架或扩票。

未发现其他具体规范违例。事务写入、冻结 Run 选择、回收身份、真实 actor／workspace 与未知外部验收表述符合所读规范。

## Spec

初审 2 项：

- P1：旧 live 清单未保存历史 provider 凭据变量映射，首次05启动直接登记今日映射后回收，可能把错误账号404当资源消失。现有未终态或未完成回收的旧live责任且未绑定provider时，必须先有精确私有部署确认；缺确认在任何恢复HTTP前拒绝。确认摘要和绑定审计同事务；已登记身份不能改绑。受控错误账号404回归证明未确认0调用，并保持声明与真实历史取证分离。
- P2：编辑非首镜像时先设置首镜像max再恢复历史镜像，导致60秒合法配置被30秒上限阻塞。现恢复镜像后重算该镜像期限；真实浏览器回归确认后续修订发布成功。

未发现scope creep；其它独立修订、实际语义预览、冻结调度、停用只影响新接纳、命令身份、事务、并发与恢复符合本票。真实模型／部署／人工仍未取证。

## 修复验证

修复后 types/build通过；完整suite54/54、Chromium13/13、编译后配置API／路由／迁移9/9、编译main真实进程重启通过。初审共 Standards 1 项可执行缺口＋2 项非阻断启发；Spec 2 项可执行缺口。3 项可执行缺口均已修复，待固定修复提交的独立复核记录。

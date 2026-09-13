# Ticket04 双轴审查

审查范围：`git diff 2161c01d7660b109e03b7ff7d6bebfc944ba7234...a5d4b2b`。

提交：`a5d4b2b feat(ticket04): add bounded submission waiting and resumable Run events`。

Spec：`.scratch/v0/issues/04-bounded-wait-resumable-sse.md` 及直接相关 PRD/API/validation/domain/ADR。

Standards：CLAUDE、docs/agents 规则、CONTEXT、领域模型及 accepted ADR 0003/0004/0006；附 code-review 的完整十二项 smell baseline。两个 reviewer 使用独立新上下文并行、只读审查，没有自行重跑测试。

## Standards

初审：0 项规范违反；1 项低优先级启发式发现。

- P3 Duplicated Code：`src/app.ts` 新增会话轮换 Cookie 解析与认证重复，logout 还使用不同正则语义。建议提取统一 session-cookie reader。这是代码异味判断，不是仓库规则违规。
- 其余 Run／连接分离、事件与审计关系、事务持久化、授权、独立回收、浏览器权威查询、测试及证据边界未发现可行动问题。

修复：提取 `sessionId(request)`，认证、轮换、登出三处统一解析。两个公开 HTTP session／等待登出用例及类型检查通过；原 reviewer 已复核，剩余 Standards 问题 0。

## Spec

0 项发现。有限等待独立于幂等、清单和总期限；事件顺序／授权／恢复、运行中保留和终态七天窗口、连接／session边界、浏览器去重与权威状态读取、独立回收均符合本票。原 Spec reviewer 随后复核统一session、单调等待时钟与新增公开测试，仍为0项新问题。

审查不代表真实模型／部署／人工验收。物理留存删除保持后续票范围。

## 修复后验证

新增公开行为验证：观测时钟推进八天，仍执行的 Run 不提前丢失事件；等待同一 Run 期间登出，旧等待连接返回401而不交付结果，原Run继续成功／期限不变。有限HTTP等待采用单调时钟，避免系统时间校准改变连接等待上限；执行清单总期限仍沿用已有领域时钟。

最终类型、构建、全部测试、编译后HTTP/SSE及浏览器结果见 [verification](verification.md) 与同目录原始输出。

结论：Standards 初审1个P3、修复复核0剩余；Spec 0发现。两轴分别保留，不合并排序。

# Ticket08 审查与验证

整票基线：`d21a5163cf4517629a7888236615a449dc0db78f`。
固定审查 checkpoint：`0c5115e4d1ec9ebffbd26f41eaf857610236066e`，未 amend。
独立修复提交：`7fd487d475fe8cfe7b0f60569fabc22451a0f8c8`。

验证：typecheck / build 通过；完整 Node suite 103/103；完整 Chromium suite 16/16。随后 A 的研究 MCP 组合冲突和移动摘要换行调整，聚焦 Chromium 复用流程1/1，覆盖已有 MCP 选择自动切回文件任务并给可见提示。命名审查修复后再次聚焦 Chromium1/1。目标文件有已安装生产 OpenSandbox SDK 真实 HTTP 适配器4项反例／正例，提供者为外部 double。

## Standards

独立只读 reviewer 核对 CLAUDE.md、领域与 tracker 约定、CONTEXT、领域模型、PRD 及 accepted ADR 0001–0006；未找到适用 AGENTS.md。未发现可确认的文档规范违规。

一项非阻塞判断：Mysterious Name，低优先级。web/app.js 新增 `uploaded = source` 使 uploaded 同时表示上传 InputObject 和显式引用 Artifact，名称不能准确表达职责，建议 selectedInput。已在独立修复提交全路径重命名；复核确认原 finding 关闭，无遗留 uploaded，无新增规范违规或 smell。复核为静态检查，未独立重跑测试。

## Spec

独立只读 reviewer 未发现本次差异引入的阻断性实现缺陷。

(a) 验收仍部分完成。票第23行要求“两次真实任务配合受控时间／复制故障”，第31行要求“不以模拟控件或替身结果代替真实路径”。产品 API、SQLite、实际文件处理及 Chromium 已覆盖；OpenSandbox 测试使用受控 HTTP double，真实模型／Linux／人工综合 AC 未执行。账本如实区分，不能关闭 AC；已有继续代码授权，无需重新索取模型调用许可。

(b) 未发现未经请求的范围扩张。source/copy 展示、装载审计及健康计数对应关键事实持久化、审计、新鲜度健康／异常来源。单输入固定统计契约沿用既有任务范围，通用多输入能力未冒充交付。

(c) 关键边界符合规格。Files 冻结 UUID／摘要／归属／原期限，接纳、装载和复制确认均复核；目标由适配器回读验证。确认后执行不再读取源，副本随新 sandbox 回收。接纳先回放，跨异步源读取窗口再对账；运行摘要排除 loaded／loaded_at 变化，业务重做创建新 Run。

Spec reviewer 未重新运行测试。后续修复仅名称，不改变上述行为。

Standards：初审0硬违规、1低优先级判断，修复复核后0未解决；Spec：0实现缺陷、0范围扩张，1项真实验收未完成事实。两轴不互相抵消，不能把代码审查通过解释为综合 AC 通过。

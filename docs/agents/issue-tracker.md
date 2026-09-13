# Issue tracker: Local Markdown

- 实施票位于 `.scratch/v0/issues/<NN>-<slug>.md`，一票一文件，从 01 按依赖顺序编号。入口为 [票务计划](../../.scratch/v0/ticket-plan.md)。
- PRD 唯一正文为 [docs/PRD-v0.md](../PRD-v0.md)；[spec 入口](../../.scratch/v0/spec.md) 仅提供引用。
- 每票保留 What to build、Blocked by、Status、验收标准、验证及失败／重试边界。Blocked by 只列直接依赖的编号和标题。
- 分诊状态按 [标签表](triage-labels.md)。ready-for-agent 不表示阻塞已解除或实现完成；开工前读取所有直接阻塞票的完成证据，并核对外部实施输入。
- 完成一个 frontier 票后重新按阻塞关系计算可领取集合。每票独立记录实现状态、验证证据和用户验收，不由票号顺序推断完成。
- 讨论追加到对应文件的 Comments 节，保留历史；获取任务即读取指定编号或路径的文件。
- 发布到 tracker 指创建或更新本地文件，不表示发布 GitHub／Linear；保持父规格状态，实施票完成不自动关闭父规格。
- 需要改动已批准范围或依赖时，在票务计划记录原因，并同步相关票与 PRD，避免保留相互冲突的承诺。

# v0 规格发布配置草案

状态：历史草案，已由 2026-09-14 用户接受的 [v0＋A 配置](../.scratch/v0/tracker-plan.md)取代。当前使用本地 Markdown tracker、默认标签及 CLAUDE.md 入口；PRD 正文保留原地址。以下内容保留为当时提案，不是当前执行约定。

推荐使用本地 Markdown tracker，保留默认标签，并创建 CLAUDE.md 作为工程技能入口。它描述开发协作约定，不作为任务 sandbox 的配置来源。本草案只配置规格追踪，不拆实施票、不建立远程仓库。

选择后将 v0 PRD 正文移至 `.scratch/v0/spec.md`，标记 `Status: ready-for-agent`，保留现有 PRD 地址作为跳转入口，避免维护两份正文。ready-for-agent 表示规格可供后续 agent 工作，不表示产品已实现或技术验证已通过。

## 拟创建的 CLAUDE.md 内容

```markdown
## Agent skills

### Issue tracker

使用本地 Markdown 跟踪规格和任务。见 docs/agents/issue-tracker.md。

### Triage labels

使用默认五种分诊标签。见 docs/agents/triage-labels.md。

### Domain docs

采用单一领域：根 CONTEXT.md 与 docs/adr/。见 docs/agents/domain.md。
```

也可将同一入口写入 AGENTS.md；只创建选定的一份。

## 拟创建的 docs/agents/issue-tracker.md 内容

```markdown
# Issue tracker: Local Markdown

规格和任务记录位于 .scratch/<feature>/。

- 规格：.scratch/<feature>/spec.md。
- 实施任务：.scratch/<feature>/issues/<NN>-<slug>.md，一票一文件，从 01 编号；本次不拆票。
- 分诊状态：文件开头使用 Status: 行，标签见 triage-labels.md。
- 追加讨论：在对应文件的 Comments 节追加，保留历史。
- “发布到 tracker”表示创建或更新本地规格／任务文件，不表示已发布到远程服务。
- “获取任务”表示读取用户指定路径或编号对应的文件。
```

## 拟创建的 docs/agents/triage-labels.md 内容

```markdown
# Triage Labels

| 标准角色 | 项目标签 | 含义 |
| --- | --- | --- |
| needs-triage | needs-triage | 维护者需评估 |
| needs-info | needs-info | 需补充信息 |
| ready-for-agent | ready-for-agent | 规格已明确，可交由 agent 工作 |
| ready-for-human | ready-for-human | 需要人工实施 |
| wontfix | wontfix | 不实施 |
```

## 拟创建的 docs/agents/domain.md 内容

```markdown
# Domain Docs

项目为单一 AtomicAgent 领域。探索前读取根 CONTEXT.md 和相关 docs/adr/ 决策；对象关系参考 docs/domain-model.md。

使用领域术语表中的名称，不静默改用被排除的同义词。规格采用 .scratch/v0/spec.md；API 细节和专项验收使用该规格引用的文档。

与 accepted ADR 冲突时明确指出，不静默覆盖。研究建议、实现结果和验收证据分别记录，未验证不能标为通过。
```

若选择现有远程项目，需提供仓库／项目地址；按实际 tracker 改写发布配置，保持 v0 内容不变。

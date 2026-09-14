# v0＋A 本地 tracker 配置记录

日期：2026-09-14  
**Status: applied — 用户回复“接受”，本地配置及 33 张实施票已发布。**

采用本地 Markdown、默认五类分诊标签及单一 AtomicAgent 领域。工程入口选择 CLAUDE.md；当前配置如下：

- [CLAUDE.md](../../CLAUDE.md)：工程入口，含项目定位、进度事实、运行与验证命令及按场景分支的文档入口。
- [Issue tracker](../../docs/agents/issue-tracker.md)：一票一文件、直接依赖、frontier 与证据约定。
- [Triage labels](../../docs/agents/triage-labels.md)：默认五类分诊标签。
- [Domain docs](../../docs/agents/domain.md)：术语、不变量、ADR、PRD 和 tracer-bullet 交付约定。
- [票务计划与实施票入口](ticket-plan.md)：33 票及 PRD／A／专项验收覆盖。
- [规格入口](spec.md)：指向 [PRD 唯一正文](../../docs/PRD-v0.md)，不复制或移动正文。

此次批准采用保留 PRD 地址的方案，未迁移正文；管理台正式范围已同步 PRD 第 10 节。当时的配置草案已随本记录生效而删除。

此记录仅证明本地票务配置与发布，不表示已初始化 Git、建立远程 tracker、实现产品或通过真实运行验收。

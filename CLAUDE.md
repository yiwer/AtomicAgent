# AtomicAgent

调用后端提交一项 Agent 任务，平台在独立 sandbox 中运行固定的 Claude 引擎完成它，交付经平台校验的 Result 与 Artifact。当前范围 v0＋A：任务 API ＋ 运维管理台，按 33 张 tracer-bullet 票逐票推进。

## 现在在哪

[实施推进记录](.scratch/v0/execution-progress.md) 是唯一的进度事实：每票实现到哪、提交了哪些 commit、哪些验收仍未完成、当前人工停点在哪。动手前读它，不从票号顺序推断完成度。

## 跑起来

```bash
npm ci && npm run setup:local && npm run build && npm start
```

- `setup:local` 生成 `.local/config.json`（随机令牌、fixture profile、端口 4310），以 `wx` 写入，已存在时报错退出。
- `npm test` 和 `npm run test:browser`（Playwright 自起 4311）直接跑源码，不需要先 build；`npm start` 跑 `dist/`，需要。
- 本机默认 fixture：不调模型、不起容器。`opensandbox` profile 只在 Linux 启动，另需独立 guardian、`isolation_qualified_images` 精确 digest 和 provider 绑定。

## 每次都适用

**冻结**：ExecutionManifest 和 ConfigurationRevision 固定后不改写。新策略只作用于后续请求，既有 Run 按原清单交付、停止和清理。

**分账**：确定性实验、真实引擎／模型、真实网络、业务内容、Docker、gVisor、通知投递、浏览器、人工验收各记各的账。fixture 跑通就写「确定性通过、真实未验收」。

**未知≠零**：观测缺失、超时、权限不足、列表不完整都记 unknown。删除请求已发出、Agent 自述成功、进程退出 0 都不是结果证据。

**术语**：用 [CONTEXT.md](CONTEXT.md) 里的名字（Run、Attempt、Artifact、CleanupObligation……），不用 _Avoid_ 排除的同义词。

## 去哪找

| 什么时候 | 读哪份 |
| --- | --- |
| 改代码、定位模块、跑验证脚本前 | [代码地图](docs/agents/codebase.md) |
| 写验收结论、归档证据、关票前 | [证据分账](docs/agents/evidence.md) |

## Agent skills

### Issue tracker

领取、拆分或更新任务时，按 [本地 Markdown tracker](docs/agents/issue-tracker.md) 操作；实施票一票一文件。

### Triage labels

变更票的分诊状态时，使用 [默认标签](docs/agents/triage-labels.md)。

### Domain docs

探索或实现任务前，读取 [领域约定](docs/agents/domain.md)，按其中入口定位术语、不变量、PRD 和相关 ADR。

# Ticket11 — 可执行限额与独立到期

实现、最终回归、真实 Linux 限额／全控制面故障实验及双轴审查完成。停在 Ticket11 等待用户人工 smoke 和实际体验；真实模型、gVisor、生产容量及人工 AC 未验收，不开始 Ticket12。

固定基线 `052a144f730ff0db6e5332cef384c2d2b7f99e18`；实现 checkpoint `f94d33614ad10d87be1c683409f8995e2122b646`；独立修复 `91621998077e53d2f6ffb7dfd9789e9d0f6d146e`。后者通过 139/139 测试、19/19 浏览器测试、构建和 Linux 3/3 guardian 测试；[验证账本](../../.scratch/v0/evidence/ticket11/verification.md)、[双轴审查](../../.scratch/v0/evidence/ticket11/review.md)、[失败历史](../../.scratch/v0/evidence/ticket11/failure-history.md) 分别保存证据与适用边界。

## 登记、冻结与调度

| 字段 | 初始值 | 登记范围 |
|---|---|---|
| concurrency | 2 | 1–2，整数；平台全局容量为 2 |
| total_timeout_seconds | 3600 | 1–3600，整数秒 |
| input_bytes | 52428800 | 1–52428800，整数 bytes |
| artifact_bytes | 104857600 | 1–104857600，整数 bytes |
| cpu | 2 | 0.25–2，步长 0.25 |
| memory_mib | 4096 | 128–4096，整数 MiB |

工作区限额为 SQLite 中不可变的发布修订。维护者在 A 的“额度与限制”或 API 中填写全部六字段及理由，预览、校验 expected_revision 和 preview_digest 后发布。发布修订、原命令回执和审计同事务提交；丢响应后页面保存的原命令身份可恢复，不能靠“修订号变了”推定成功。caller 只读；health 身份无管理与业务数据权限。未知／原型继承键、缺字段、越界值均拒绝。

每个新 Run 可在 policy 范围内收紧五项执行限制；concurrency 是调度策略，不能由任务覆盖。有效总期限取请求／工作区策略与冻结环境 timeout 的较小值，从 accepted_at 开始，覆盖排队、准备、Agent、产物收集和 Result 提交。阶段恢复不重置期限、不创建第二 Attempt。历史 json-lab@1 仍为 60 秒；新 `setup:local` 使用独立 json-default@1、3600 秒，不修改旧登记或清单。请求希望 3600 秒但选择旧 60 秒环境时仍只有 60 秒。真实短实验登记 provider-limits@1 为 120 秒，因此该环境不是新默认 60 分钟的证明；新默认入口有实际 setup/API 测试。

调度和健康共用实际占用谓词：活动调用、running、未完成的原资源处置、stop unknown 都占位。降低并发只阻止后续超额启动，不杀既有执行。业务 cancelled 不等于释放槽位。排队到期可没有 Attempt；成功提交事务再次检查原期限，越界不提交 Result。

## 执行层与事实来源

Live prepare 要求独立 guardian 已持久登记原 Run、创建 operation、deadline 和精确 image，且能新鲜连接 Docker。之后才向固定 patched OpenSandbox 分配 CPU、内存和 pids128。新镜像仍须 private `isolation_qualified_images` 精确资格与 Ticket10 的无 secret 隔离探针，缺能力不能先启动模型。

可信 entrypoint 在 `/workspace` 挂载 tmpfs，大小参数为输入上限＋产物上限＋32 MiB；固定默认为 190840832 bytes。tmpfs 按内核页粒度实现容量，非整页参数可能向上舍入，不能把此参数当成逐 byte 无超调的 Artifact 配额。初始受保护记录包含 cgroup v2 的 cpu.max、memory.max、memory.events、原期限和 tmpfs 挂载参数；provider execd 就绪早于该文件时只在原期限内有界等待，文件校验通过后才读取模型凭据、执行 CLI。

CPU 配额是节流型限制；不会因满 CPU 自动将任务标失败。内存是 RAM cgroup 上限；固定 provider 的 Docker MemorySwap 为 RAM 的两倍，不能把 RAM 上限声称为 RAM＋swap 总上限。内存预算归因要求同一 cgroup 的 max、oom、oom_kill 都相对初始值增加；exit137 本身不作证明。确认后立即尝试原资源强停，独立释放执行等待，再持久化预算终止；观测写入失败也不阻止该停止尝试，并让控制面停止接受后续执行。SDK0.1.11 对已返回 headers 的 SSE 会解除 abort 转发，因此这里不依赖单独 abort 来证明停止。

输入在上传和 Run 绑定时按有效容量拒绝；产物在 runner 采样、最终收集和持久 staging 时检查累计大小。采样可能短暂越界，最终不得发布超限 Artifact；tmpfs 是另一个有限的文件系统保护。产物超限为 budget_exceeded/artifact_bytes，内存预算为 budget_exceeded/memory_mib，总期限为 deadline_exceeded/total_timeout_seconds。终态与 stop、cleanup 独立观察；写 marker、删除回执或 SDK 连接结束不等于 stopped。硬金额约束明确返回 422 hard_money_limit_unsupported，不伪装为已执行的预算。

独立 guardian 是持有 Docker socket 的可信本机服务，和 API、worker、provider、Agent 分离；任务容器没有该 socket。它只处理已经登记的 guardian/operation/Run 标签和精确批准 image，持久保留原完整 Docker IDs、限定命名卷及卷 fingerprint。创建结果未知时保留 intent，即使到期扫描为空也继续发现晚创建；已知资源按原 ID 重试。某资源或某 intent 失败只把自身标 unknown，不能阻止其他到期资源。独占 flock、SQLite FULL 和私有 Unix socket 支持同一登记重启恢复。

entrypoint 自身有原 deadline 定时器，guardian 在原 deadline 独立删除主容器、sidecar 及已登记运行卷。provider 最短 lease 为 60 秒，但短于 60 秒的任务仍由原绝对期限控制；不会获得第二段期限。guardian 失联、Docker 失败或扫描超 5 秒未更新时健康为 unknown；健康展示查询时间、观测时间、freshness、覆盖范围及未解责任。它不是另一个全机容器清理器。

审计包含 limits.register、limits.publish、limits.execution-observed、limits.terminate，并沿用不可变 allocation 和停止／清理记录。模型与工具仍使用 Ticket10 的 requested/admitted 和同调用 ID 收尾，partial／unknown 保持；本票没有扩大能力或 syscall 审计覆盖。

## 可运行版本与最短人工路径

Node 24.18.0，在仓库根执行：

```powershell
npm ci
npm run build
# 首次全新安装、没有 .local/config.json 时：npm run setup:local
npm start
```

本轮 root 为人工验收另备 `.local/manual-smoke-ticket11/config.json`（独立 SQLite、端口4312、json-default@1）；该文件不是公开提交的一部分。使用它时，在启动前设置 `$env:ATOMIC_CONFIG='.local/manual-smoke-ticket11/config.json'`。保留原4310进程，勿复用未知旧数据库。登录用该私有配置中的 maintainer token。

最短路径：额度与限制→将 artifact_bytes 设为1，填写理由→预览→确认发布→上传四行 CSV 并选文件任务→观察 budget_exceeded/artifact_bytes、无成功 Result，另看 stop 与 cleanup→恢复104857600→以新 Run 重做→观察结果和两个可下载产物→刷新核对版本与结果不变。完整输入、期望合计12.6和人工记录由 root 的 [人工清单](../../.scratch/v0/manual-smoke-after-ticket11.md) 管理。

本地正常 fixture 使用真实 main/API/SQLite/UI，却不执行模型或 cgroup。它完成太快，无法可靠手动观察运行中取消和排队；这些人工项查阅本票真实 Linux／确定性证据或等待获准真实模型，不加入产品延时、故障注入开关。模型授权尚缺，未读取或使用个人套餐凭据。用户尚未反馈人工结果，AC 全部保持未勾。

## 真实复现与清理

最终镜像 `sha256:ce8d0083a606a9a45b8667e60ccd442681056be1e6c6c0993249d66aa022aac4`；server `sha256:7c3decc295f65c5b1224d8fc4e8fbaf4a06b3b4710d62247e8238b4fd9d14f14`。36 个 dist/src 文件与9162199本机构建逐一相同。Linux 实验使用真实固定 SDK／CLI、OpenSandbox 与合成 HTTPS 模型协议，未执行真实模型推理。默认 cgroup 上限与获准0.25CPU/384MiB压力分开记录，宿主3723MiB不支持声称2×4GiB生产容量合格。复现脚本、版本和精确五 Run 见验证账本。

2026-09-14T03:21:36Z，全部30登记任务资源与11运行卷已确认不存在；自有服务／网络／合成证书与远端临时目录已清理，原五服务healthy。保留最终两个11镜像、原10镜像及共享构建层，不做全局 prune。本机 normal-temp、三个 ticket11 归档及 Python 缓存的删除被自动审批拒绝，保留为未跟踪临时文件，不进入提交。

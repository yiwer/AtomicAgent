# Ticket10 验证账本

记录日期：2026-09-14。本票完整范围保留，AC 未由自动化代勾。实现说明：[ticket10.md](../../../../docs/implementation/ticket10.md)。所有实验仅操作自有临时资源；未改宿主全局配置、未触碰既有五个服务、未使用真实模型 key 或付费模型。

## 分层结果

| 层 | 输入与动作 | 可观察结果 | 证据 |
|---|---|---|---|
| TDD / 确定性 | 路径/符号链接、gateway HTTP、并发许可、取消混合快照、旧镜像与缺失证据等红绿切片 | checkpoint 127/127；审查修复后完整 128/128 | [tests-final.txt](tests-final.txt)、[tests-reviewed.txt](tests-reviewed.txt) |
| 取消迁移窄修复 | 旧/新历史协议、隔离镜像撤资格、任一路径403；真实 SDK 对受控 HTTP 接口 | 中间修复8/8；最终10/10聚焦通过，typecheck通过 | [legacy-cancel-tests.txt](legacy-cancel-tests.txt)、[revoked-image-cancel-tests.txt](revoked-image-cancel-tests.txt)，最终提交82350d0 |
| 构建 | npm run typecheck；npm run build | 通过；最终物理镜像 32 个核心 JS 与 4574a6e 构建一致 | [build-comparison.json](build-comparison.json)、[runtime-manifest.txt](runtime-manifest.txt) |
| 浏览器 | 真实页面/API/SQLite，明确 fixture 执行源 | 完整 18/18；桌面、手机及滚动边界区目视可读，无横向溢出 | [browser-reviewed.txt](browser-reviewed.txt)、[桌面](boundary-desktop.png)、[手机](boundary-mobile.png)、[边界区](boundary-mobile-evidence.png) |
| 实际 CLI / Linux | 固定 SDK+bwrap/setpriv，原始 Node 文件/socket 攻击、两次真实 CLI 会话、自有协议接收端 | 父 secret/proc/外路径读取拒绝、原始网络不可达、业务写 0、子进程停止、后次空间无污染 | [isolation-cli.json](isolation-cli.json)；诊断标签 run-cli/run-b **不是持久 Run** |
| 中间目录交换 | 同一最终镜像内自有攻击进程交换目录/符号链接，同时读取控制文件 | 980 次交换，outside_read=false，UID1000/空 CapBnd/NoNewPrivs1；停止整个 namespace 后采集 | [path-swap.jsonl](path-swap.jsonl) |
| 真实 provider 预检 | SDK0.1.11 → 固定 patched server → Docker/execd 创建；尚未启动 Agent | sandbox 非 privileged、无 Docker socket，sidecar 三端口的 HostConfig 与 NetworkSettings 全为 127.0.0.1；资源删除 | [bootstrap-host-preflight.txt](bootstrap-host-preflight.txt) |
| 真实产品四 Run | API → SQLite Worker → SDK0.1.11 → server → execd → bwrap → SDK0.3.270/bundled CLI → 自有 HTTPS 协议 | A policy_denied；B/C/D succeeded；全部 cleanup complete | [provider-runs.jsonl](provider-runs.jsonl) |
| 主机独立观测 | 四个实际 sandbox 及四个 sidecar，不依赖业务 cleanup 字段 | 12 个发布端口均 loopback；8 个精确资源 ID 后续 inspect 不存在 | [provider-host-observations.jsonl](provider-host-observations.jsonl)、[provider-resource-absence.jsonl](provider-resource-absence.jsonl) |
| 审查 | 固定 baseline/checkpoint，两个 fresh 只读轴 | 两轴所报问题修复并复核关闭；不是重跑验证 | [review.md](review.md) |
| 真实模型 / gVisor / 人工 | 尚无获准模型账号；宿主无 gVisor；用户尚未人工确认 | **未验收** | 本账本与票未勾选 AC |

最后 0585393/82350d0 只改变平台的历史停止 marker 兼容分支及 HTTP 测试，没有改变最终物理镜像内的隔离 runner。完整 128/128 和浏览器 18/18 对应 4574a6e；最终追加聚焦 10/10 与 types，不虚称重新跑过完整套件或四 Run。

## 四 Run 的真实污染链

最终执行窗口 2026-09-14T01:43:49–01:44:20Z，使用相同最终 runtime `sha256:f26adbee7fb83c4f8ee6f008793dde0c96de93591c30e210832a1aa4876a008a`。

| 场景 | Run | 实际行为与结果 |
|---|---|---|
| A | 19102efe-357a-4f41-8cc2-c1f2277b0183 | 文件任务；受控模型请求非 allowlist Bash，被 policy_denied 阻断。实验 harness 在同一已分配资源中事先创建 a-canary、配置标记、真实持续心跳子进程；这是受控注入，不声称模型生成了 canary。 |
| B | 9d0ba79c-3ecd-4342-972b-825061906916 | 新 Run/Attempt/资源；prepare 实际核对 A 的任务文件、配置标记和心跳均不存在；真实 CLI 生成符合合成协议的结果。 |
| C | 28b30ab3-05fb-40b2-b258-4ba3c07aa1fa | 合法文件输入；真实 exact Bash 运行固定统计程序，结果和两个 Artifact 校验成功。 |
| D | 3ceedff9-da96-4aff-9855-dca0cbdd1ed0 | 实际 SDK in-process MCP 并行读取两个固定 snapshot，两个成功来源及 Markdown 结果；本轮 **没有公开 GET**，不挪用 Ticket07 的网络证据。 |

原始记录含 Run/Attempt/resource 与 canary 关联、准入/执行/收尾调用 ID。A 的外层资源及 sidecar 物理删除，后续 B/C/D 路径实际核查为空；独立内层攻击实验进一步证明心跳子进程停止。凭据为合成值，跨 Run 隔离证明来自独立空间/无父 env 暴露及每次重新启动，不能延伸为真实账户会话内容验收。最终四 Run 合计七个模型协议请求；接收端累计 14 包括旧端口修复前一轮，业务写为零。

## 精确环境与清理

Ubuntu 24.04、Docker 29.1.3、runc；无 gVisor。Node 24.18.0、SDK 0.3.270、bundled CLI 2.1.270、OpenSandbox SDK 0.1.11。

- server 源码：`d8cfce39dc1d846e580510ca44f44c495cbe95c4`，补丁 SHA256 `dbb2f8cb05f76d1eaddf205fff1c5150ee5485346053a815b07139feb9f2672b`，最终 server image `sha256:0f5fa5a6f63e55c973a81767de0fe19fdc061a69cdd469666f050582073c8bc6`。是 patched OpenSandbox，不是原版能力声明。
- Node base `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`；execd v1.1.0 `sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2`；egress v1.1.7 `sha256:db7345d567b0970f384b8e3fa7a93a71b7f43d4b16bb2009de34096e9a87b3b5`。
- 每 Run 外层保留配置的 CPU2/4GiB 上限、pids128；主机总内存约 3723MiB，小于上限，未伪称满足生产容量。仅串行一个 Run sandbox，独立 CLI 实验使用 512MiB/0.5 CPU。实际用量样本在 host observations，容量/压力验收未完成。
- 自有模型 HTTPS receiver 仅发布至 Docker bridge gateway 172.17.0.1:43811，使用合成证书/key；server host network 仅监听 127.0.0.1:43810，SDK 通过认证 server proxy。任务/egress 发布端口全部 loopback；固定 bridge 与 patched server 为必要前提。
- 所有执行句柄已退出，四 sandbox/sidecar 和预检资源已删除。自有 server/model 容器、空自有网络、三个精确 `/tmp/atomicagent-ticket10-*` 实验目录均删除（包括合成私钥）。既有五个服务仍 healthy，结束时 available RAM2238MiB、磁盘26GiB。[cleanup.txt](cleanup.txt)
- 保留五个自有镜像与共享构建缓存/拉取镜像用于复现，没有活跃任务资源。镜像显示大小含共享层，不能简单相加。[retained-images.txt](retained-images.txt)

## 可运行命令

仓库根、Node24.18.0：

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:browser
npx tsx --test tests/opensandbox.test.ts
```

Linux 完整物理实验的独立步骤在 [reproduce.md](reproduce.md)。当前 checkout 的修复可构建新 digest；不得拿历史 f26 digest 声称新构建位级相同，须重新运行资格探测。生产镜像构建入口：

```bash
docker build -f deploy/Dockerfile.runner --build-arg NODE_IMAGE=node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d -t atomicagent-runner-ticket10 .
docker build -f deploy/Dockerfile.opensandbox -t atomicagent-server-ticket10 .
```

上述构建本身不注册 live 资格、不部署、不调用真实模型。UI 最短路径见实现说明。实际浏览器自动化与工程师目视均已执行，仍未得到用户人工验收确认。

# 代码地图

Node 24 ＋ TypeScript，没有 Web 框架：`node:http` 起服务，SQLite 落盘，Claude Agent SDK 调模型，OpenSandbox 管执行空间。`src/` 是平铺的，按下面的职责分组读；分组与 [领域模型](../domain-model.md) 的四组职责一致。

## 进程边界

同一份代码分布在四种进程里，权限各不相同。改动涉及凭据、隔离或回收时，先确认自己在哪一层。

| 进程 | 入口 | 持有什么 |
| --- | --- | --- |
| API／worker | `src/main.ts` → `src/app.ts` | 配置、SQLite、产物、provider 凭据；没有 Docker socket |
| 容器可信 entrypoint | `src/sandbox-supervisor.ts` | cgroup v2 与 tmpfs 事实，校验通过后才放行模型凭据 |
| 容器内 Agent | `src/runner.ts` → `src/isolated-query.ts` | 私有 network namespace，唯一上行是 `src/isolation-bridge.ts` 绑定的模型 socket |
| 宿主 guardian | `deploy/guardian.py` | Docker socket 与到期删除权；独立于控制面，控制面故障时仍能停 |

`src/isolation-probe.ts` 是不发凭据、不起 CLI 的能力探针，只在固定 digest 的镜像里跑。

## src/：按职责

**接纳与 API**

- `app.ts` — 全部 HTTP 路由、鉴权、请求校验、`web/` 静态资源；改 API 从这里进，也是最大的文件
- `main.ts` — 配置读取，profile／provider／secret 绑定校验，数据库进程锁（陈旧锁 fail closed）
- `domain.ts` — `Run`、`Profile`、`Identity`、`Failure` 等核心类型
- `submission.ts` — 幂等摘要：content／manifest／submission digest
- `store.ts` — SQLite 持久化
- `events.ts` — SSE 事件与恢复游标

**输入与配置**

- `files.ts`、`file-contract.ts`、`file-validator.ts`、`sandbox-files.ts`、`bounded-file.ts` — 上传、大小上限、输出文件校验、有界读取
- `blob-store.ts` — 产物落盘
- `configurations.ts` — 配置修订的登记、预览、发布、停用
- `profile.ts`、`profile-routing.ts` — profile 校验与 fixture／opensandbox 路由
- `limits.ts`、`resource-limits.ts` — 限额默认值、有效限额、cgroup／tmpfs 证据
- `usage.ts` — InvocationRecord／UsageEntry、观测校验、只追加合并与归一化；估计与确认分桶，未知不填零
- `skills.ts`、`research.ts` — Skill 与只读 MCP 的绑定和证据结构

**执行**

- `worker.ts` — 调度、执行槽位、阶段推进
- `claude-execution.ts` — Claude Agent SDK 适配
- `opensandbox.ts`、`fixture-sandbox.ts` — 两种 `SandboxPort` 实现
- `guardian.ts` — guardian 客户端
- `model-gateway.ts`、`execution-boundary.ts`、`action-permit.ts` — 调用边界的授权与观测
- `cancellation.ts` — 取消裁定与 30 秒宽限
- `research-execution.ts`、`research-snapshots.ts`、`process-data.ts` — 文件处理与资料研究两条业务路径

## 前端

`web/` 是无构建的原生 ES module，由 `src/app.ts` 直接读盘提供：`index.html` ＋ `app.js`（任务）、`configurations.js`（配置）、`limits.js`（限额与工作区用量）、`usage.js`（用量词汇与渲染）、`events.js`（SSE）。

`docs/prototypes/admin-console-prototype/` 是选型阶段的模拟原型，用模拟数据；它是设计证据，不是产品代码，也不提升为实现。

## 验证

| 命令 | 覆盖 |
| --- | --- |
| `npm run typecheck` | `src`、`tests`、`scripts`、`playwright.config.ts` |
| `npm test` | `tests/*.test.ts`，Node test runner |
| `npm run test:browser` | `tests/*.spec.ts`，Playwright 自起 4311 |
| `npx tsx scripts/verify-local.ts` | 构建产物与进程锁的发布前检查 |
| `python3 tests/guardian_test.py` | guardian 生命周期与 Docker API 故障边界，只在 Linux |

| `npx tsx scripts/verify-usage-release.ts` | 构建产物上的用量归一化、额度视图、授权与重启持久性 |

`scripts/` 下其余脚本（`verify-*.ts`、`observe-*.py`、`controlled-model.ts`、`pressure-workload.ts`、`provider-canary.ts`、`start-limits-experiment.sh`）是需要真实环境的一次性实验，不并入 `npm test` 的计数；结论按 [证据分账](evidence.md) 归档。

## 部署

`deploy/` 持有 Dockerfile、guardian、OpenSandbox 的隔离与限额两份 patch，以及由管理员安装的 `cloud-deploy.py`；`.github/workflows/deploy.yml` 是 CI。运行边界、发布事务与回滚见 [云端验收部署](../cloud-deployment.md)。

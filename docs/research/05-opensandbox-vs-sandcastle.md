# OpenSandbox 与 Sandcastle：面向 AtomicAgent 的源码对比

访谈更新：用户已接受本文推荐，决策见 [ADR 0005](../adr/0005-opensandbox-with-claude-sdk.md)。随后要求更宽泛的时间窗口，任务默认期限调整为 60 分钟；本文仍是源码证据，不代表运行验收。

研究日期：2026-09-13。本文为选型依据，**不是选型决议或运行验收**。依据 [需求基线](../requirements-baseline.md)：固定 Claude Code／Agent SDK；文件处理与资料研究；任务与 HTTP 连接分离；终态清理执行空间；产物保留 24 小时；记录保留 7 天；登记配置按请求组合。没有部署、运行供应商代码或读取凭据。

## 1. 结论与推荐

**推荐 OpenSandbox 作为首期执行环境底座，AtomicAgent 自建任务控制平面与薄 Claude Agent SDK 执行适配；Sandcastle 作为 Agent 编排、结果提取与开发者体验的源码参考。** 首轮使用独立 Linux 主机和 Docker，随后以同一工作负载验证 gVisor；这是针对当前范围的工程判断，不是性能或安全排名。

两者有执行环境管理的交集，但主要处于不同层：OpenSandbox 是通用 Sandbox API/生命周期平台；Sandcastle 是以 Git 仓库、分支、worktree、commit/merge 为核心的 TypeScript Coding Agent 编排库。Sandcastle **已经支持程序化 `run()`、`createSandbox()`、结构化输出和自定义 SandboxProvider**，不能将它归类成只有 CLI 或没有结果协议的项目。[OpenSandbox 架构][os-arch]、[Sandcastle README][sc-readme]、[SandboxProvider][sc-provider]

当前通用文件任务不要求 Git、回合跨任务复用或合并代码，反而要求执行空间可靠回收、受限资源与网络、独立结果提交。直接采用 OpenSandbox 能减少对 Sandcastle 默认工作流和保留策略的改造。**OpenSandbox 也不直接提供本产品的 durable Run、幂等提交、24 小时产物交付、7 天业务记录或成功判定**；这些仍由 AtomicAgent 实现。

## 2. 样本固定与研究边界

| 项目 | 本次固定源码 |
| --- | --- |
| Sandcastle | `mattpocock/sandcastle`，SHA `e99f832f26dc9d245c019a9ddd19fa5dee792427`；该提交 `package.json` 版本为 `0.12.0`。这不等于验证了 npm 当前发行内容。 |
| OpenSandbox | `opensandbox-group/OpenSandbox`，SHA `60bca638497d9c50e948928b8b15fe22328afee3`；复核架构、生命周期协议、secure runtime 与 Credential Vault 指南。 |

来源：[Sandcastle package.json][sc-package]、[OpenSandbox 固定提交][os-commit]。OpenSandbox 的宽范围调研见 [平台候选报告](02-sandbox-platforms.md)，本篇聚焦两者与已确认需求的差异。测试文件只作实现意图证据，本次未运行这些测试。

## 3. 能力与补齐责任

“原生”指所查接口或实现已包含此能力；“需补齐”指 AtomicAgent 仍需实现；“待验证”不作能力否定。

| 需求 | OpenSandbox | Sandcastle | 对 AtomicAgent 的影响 |
| --- | --- | --- | --- |
| 创建、查询、删除独立环境 | 原生生命周期服务与 Sandbox 身份 | 原生进程内 provider handle、one-shot 和可复用 handle | 两者都需绑定平台 Run；Sandcastle handle 不是持久任务记录。 |
| 执行 Claude | 提供环境、命令、文件接口，需配置引擎 | 原生 `claudeCode()` CLI 适配 | 已固定单引擎，多引擎适配收益暂不大。 |
| 无 Git 的文件/研究任务 | 通用容器、文件与命令接口，不要求仓库 | 公共高层生命周期围绕 Git；head 路径仍执行分支发现，named branch 创建 worktree | 可给任务初始化临时 Git 仓库，但这是额外适配；本次没有核实到高层无 Git 模式。 |
| schema 结果 | 需平台/Claude SDK 提供 | 原生 `Output.object()`：标签提取、JSON 解析、Standard Schema 校验；可配置修正重试 | 两者都需平台校验必需产物并独立提交。 |
| 资源上限 | 生命周期协议含 CPU/内存等字段，实际后端必须验证 | Docker provider 原生 `cpus`；所查 `DockerOptions` 与启动实现未见 memory 参数 | 2 vCPU/4 GiB 的实验边界在 Sandcastle 默认 Docker 适配上需补齐 RAM 控制。 |
| 出站策略 | 原生 egress 策略与可选 Credential Vault | Docker `network` 选择；默认 bridge；所查接口未提供目标/动作 allowlist 或 Vault | 只读 MCP 还须工具权限和服务端授权，允许域名不等于只读。 |
| 显式取消、累计期限 | 可终止命令/删除环境，平台需累计 deadline 与回收核对 | 原生 AbortSignal、idle timeout、completion grace；实际 Docker 进程终止存在下述证据缺口 | Promise 取消不能直接作为进程清理验收。 |
| 任务终态后清理 | 原生环境删除；平台负责失败重试、核对、外部存储清理 | 原生 close；dirty worktree 默认保留，主机日志/捕获会话不随容器删除 | Sandcastle 默认行为需按平台保留政策重新配置/封装。 |
| 客户端断线后继续、重启恢复、幂等 | 需补齐业务控制平面 | 需补齐业务控制平面；会话 resume 不等于 Run 恢复 | 不能把任一 SDK Promise 直接挂在 HTTP 请求作用域并宣称已满足。 |
| 24 小时产物、7 天记录、成功提交 | 需补齐 | 需补齐 | 独立存储、授权、到期删除与结果事务属于 AtomicAgent。 |
| 版本化环境/Skills/MCP 组合 | 需平台登记、解析、加载验证 | 有 env、hooks、文件准备扩展，但需同样的登记与加载验证 | 不能直接向调用方开放任意 host hook、挂载、设备或 shell 命令。 |

表中源码依据：[OpenSandbox 生命周期协议][os-api]、[架构][os-arch]、[Sandcastle 高层生命周期][sc-lifecycle]、[Worktree 创建与关闭][sc-create]、[Docker options/exec][sc-docker]、[输出定义][sc-output]、[提取校验][sc-extract]、[Agent 适配][sc-agent]。表中的平台责任为依据需求与接口差异得出的设计判断。

## 4. Sandcastle 值得借鉴的部分与不适配的默认值

### 程序化 API 与结构化结果确实存在

`run()` 负责一次调用的生命周期；`createSandbox()` 支持同一环境多次执行、`exec()` 和显式 `close()`。内置 Docker/Podman 为 bind-mount provider，Vercel 为 isolated provider，另有无隔离的 host 模式；可通过工厂函数扩展 provider。[README][sc-readme]、[provider 类型][sc-provider]

`Output.object()` 使用 Standard Schema；提取器寻找 stdout 中最后一个完整标签，解开可选 Markdown fence、解析 JSON、执行 schema 校验。缺标签、JSON 无效或 schema 不符会抛 `StructuredOutputError`；`maxRetries` 默认 0，开启后通过续接会话反馈格式错误。此机制是输出后校验，不能等同于模型原生约束生成或产物事务。现有测试覆盖解析错误、schema 错误、异步校验等。[Output][sc-output]、[extractStructuredOutput][sc-extract]、[测试][sc-extract-test]

### Git、挂载和执行权限

默认 bind-mount `run()` 采用 head 策略，直接使用宿主仓库工作目录；named branch 路径使用 worktree；isolated provider 默认 merge-to-head。`SandboxLifecycle` 在未指定分支时执行宿主 `git rev-parse --abbrev-ref HEAD`；因此不能从“可自定义 cwd”推出支持无 Git 的公共高层调用。[README][sc-readme]、[分支发现源码][sc-lifecycle]

`Orchestrator` 调用 provider 时传 `dangerouslySkipPermissions: true`；Claude provider 默认形成 `--dangerously-skip-permissions`，但已支持显式 `permissionMode` 覆盖，不应误写成无法调整。平台若需要无人值守与外部只读，仍要在 MCP 工具、凭据和网络层实施权限，不能仅依赖 Agent 提示词。[Orchestrator:143][sc-orchestrator]、[Claude provider:1181][sc-agent]

### 清理有实现，但清理结果证据不足

`createSandbox().close()` 会先调用 provider close，再检查 worktree：脏目录保留并返回 `preservedWorktreePath`，干净目录尝试删除；对应测试明确验证了这两种行为。这是保护开发成果的设计，对“所有任务终态清理执行空间”需要额外适配。[close:1083][sc-create]、[close 测试][sc-create-test]

Docker 的 `removeContainer()` 依次调用 `docker stop` 和 `docker rm`，两步均 `Effect.ignore`；所以它是 best-effort 清理，**close 返回本身不能区分确已删除与删除失败**。不能据此声称 Sandcastle 不会清理，也不能将返回视为资源已消失的证明。AtomicAgent 应保留资源身份、独立查询、失败重试与后台回收。[DockerLifecycle:176][sc-docker-life]

### 取消接口与进程生命周期存在待验证差异

公开注释称中途 abort 会杀掉 agent 子进程；实现中 `Orchestrator` 监听 AbortSignal 并竞速中断，`makeSandboxFromHandle` 用 `Effect.tryPromise` 包裹 handle，所查 Docker `exec` 只 spawn `docker exec`，没有接收 signal 或注册 kill/cancellation finalizer。因此，**这条 Docker provider 路径尚不能从源码证明 abort 一定终止容器内 Agent 及后代进程**。特别是可复用 `createSandbox().run()` 取消后保留 handle，不能依赖 one-shot 最后销毁容器的路径替它证明清理。[公开 run 注释][sc-run]、[Orchestrator][sc-orchestrator]、[包装层:99][sc-factory]、[Docker exec:250][sc-docker]

这是一项源码差异推断，不是已运行复现的 bug。验收应在 Docker 内启动受控长进程，取消后核对 PID、后代进程及资源消失；另测显式 close、父 Worker 崩溃与到期回收。idle timeout 随输出重置，不等于任务累计 deadline。[run 配置][sc-run]

### 日志、会话与凭据留存

`run()` 默认写 `.sandcastle/logs/` 文件；可选 stream callback，verbose 会包含原始 stdout。Claude provider 默认 `captureSessions: true`，bind-mount 执行路径将主会话及可用子 Agent 会话复制到宿主；默认宿主路径指向 `.claude/projects`。会话搬运主要改写 cwd，并非脱敏管线；这些文件在容器外，不能靠容器 close 删除。[run 日志配置][sc-run]、[捕获分支][sc-orchestrator]、[会话捕获实现][sc-agent]、[SessionStore:55][sc-session]

Docker 启动将 env 展开成 `-e KEY=value` 参数；这属于普通容器环境注入，不能视为秘密对执行进程不可读。本次没有发现该链路自带自动脱敏、统一保留 TTL 或秘密代理，也没有读取任何真实 secret。采用时应禁用不需要的宿主捕获、使用任务专属目录并落实删除策略，另设计凭据代理。[DockerLifecycle:126][sc-docker-life]

## 5. OpenSandbox 原生能力的真实边界

固定提交的架构和 OpenAPI 提供 Sandbox 创建、查询、删除、续期、资源参数、命令/文件操作与可选 egress。Docker 适合单机，Kubernetes 是另一运行后端；`secure_runtime` 可配置 gVisor/Kata 等，不代表默认 Docker 已具有独立内核或已经完成生产隔离验收。[架构][os-arch]、[生命周期协议][os-api]、[Secure runtime][os-secure]

Credential Vault 将真实凭据放在 egress sidecar，按 scheme/host/port/method/path 匹配后注入；要求 `dns+nft`，并有透明代理兼容性限制。这比普通环境变量注入更贴近本平台的秘密边界，但仍需真实模型/MCP 的 TLS、流式调用、路径规则与拒绝行为验证。[Credential Vault][os-vault]

创建配置受理、命令退出、网络策略写入、环境删除和业务成功必须分别判定；协议字段不保证各 backend 实现等价。OpenSandbox 不能替平台决定研究结论正确、MCP 工具是否业务只读、结果是否提交或记录是否已到期删除。

## 6. 是否组合，以及最小验证门槛

**技术上可以组合**：通过 Sandcastle `createIsolatedSandboxProvider()` 接 OpenSandbox，映射创建、流式执行、文件传输和 close。provider 契约要求实时 `onLine`，不能拿运行结束后的 buffered stdout 冒充流。[SandboxProvider][sc-provider]

**首期不推荐组合**：它会同时引入 OpenSandbox 资源适配和 Sandcastle 的 Git、会话、日志、关闭语义；固定 Claude 引擎后，多 Agent provider 的抽象价值有限。若后续出现真正的仓库任务、并行 coding agent、分支合并/评审流程，再用同样验收门槛评估组合，而不把临时 Git 包装推广为通用任务模型。

**Sandcastle 更适合的场景**是任务本身就以修改仓库为交付：例如从 issue 实现变更、多个 Agent 分支并行、实现后在同一环境跑测试再交给另一个 Agent 评审，最后收集 commit 并合并。此时 worktree、分支策略、会话恢复与保留未提交改动能直接解决开发流程问题，`run()` 的接入成本也可能更低。其 README 原生展示 implement-then-review 和 warm sandbox `exec()` 验证流程；这属于明确的产品优势，不能因不符合本平台的默认数据生命周期而视为通用缺陷。[README][sc-readme] 接到 PR 发布仍需调用方授权和独立提交边界，本研究未验证完整 PR 自动化。

推荐进入选型实验前固定 SDK/CLI、镜像 digest 和底座版本，验证：

1. 无 Git 的 CSV/JSON 处理与真实来源研究各完成一次；schema、必需产物、配置加载均有证据。
2. 2 vCPU、4 GiB、登记的累计期限和显式取消真实生效；断连继续；Worker 失联不静默重复执行。
3. 禁止出口与只读 MCP 工具限制真实拒绝；敏感配置不进入持久日志或主机共享会话目录。
4. 产物先转存再提交成功；删除 sandbox 后仍可下载；24 小时到期删除与 7 天元数据保留分开验收。
5. 删除失败可识别、可重试；创建响应丢失后可查到原资源；A 任务在 HOME/缓存/后台进程留下的标记不被 B 任务继承。

这五项是本平台验收设计，不宣称候选已通过。两者都不能仅凭示例运行成功关闭这些要求。

[sc-readme]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md
[sc-package]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json
[sc-provider]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts
[sc-run]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts
[sc-lifecycle]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxLifecycle.ts#L201
[sc-create]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/createSandbox.ts#L1083
[sc-create-test]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/createSandbox.test.ts
[sc-docker]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/docker.ts#L250
[sc-docker-life]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/DockerLifecycle.ts#L126
[sc-agent]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L1181
[sc-orchestrator]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Orchestrator.ts#L123
[sc-factory]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxFactory.ts#L99
[sc-session]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SessionStore.ts#L55
[sc-output]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Output.ts
[sc-extract]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/extractStructuredOutput.ts
[sc-extract-test]: https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/extractStructuredOutput.test.ts
[os-commit]: https://github.com/opensandbox-group/OpenSandbox/commit/60bca638497d9c50e948928b8b15fe22328afee3
[os-arch]: https://github.com/opensandbox-group/OpenSandbox/blob/60bca638497d9c50e948928b8b15fe22328afee3/docs/architecture/index.md
[os-api]: https://github.com/opensandbox-group/OpenSandbox/blob/60bca638497d9c50e948928b8b15fe22328afee3/specs/sandbox-lifecycle.yml
[os-secure]: https://github.com/opensandbox-group/OpenSandbox/blob/60bca638497d9c50e948928b8b15fe22328afee3/docs/guides/secure-container.md
[os-vault]: https://github.com/opensandbox-group/OpenSandbox/blob/60bca638497d9c50e948928b8b15fe22328afee3/docs/guides/credential-vault.md

# 单任务 Coding Agent Sandbox：平台候选与隔离设计

研究日期：2026-09-12。范围：为一次 API 请求提供隔离运行环境的开源平台、托管对照与底层技术。本文是需求访谈的研究输入，不是技术选型决议。访谈最新输入：首批调用方为自有后端，需要保留自托管能力；实际部署方式待建议，公有多租户、Windows 工作负载尚未确定。事实来自实际打开的第一方文档或源码；`main` 与云文档是当日观察，实施前应固定版本并做兼容性实验。

## 1. 先区分三个层次

| 层次 | 解决的问题 | 本次候选 | 不能替代的责任 |
| --- | --- | --- | --- |
| AtomicAgent 任务控制平面 | 接收任务、解析配置、预算、Agent 适配、收集/验证结果、取消与重试 | 待设计 | 任务成功标准、外部副作用语义、产物授权 |
| Sandbox 平台 | 创建/销毁环境、执行命令、文件传输、网络与资源控制 | OpenSandbox、E2B；Daytona、Modal 作托管对照 | 不知道 Agent 是否正确完成业务任务 |
| 隔离底座 | 进程/内核/虚拟化边界 | gVisor、Kata、Firecracker | 不直接提供完整任务 API、队列、租户与结果协议 |

这是面向本产品的**分析划分**。OpenSandbox 官方明确拆分 public contracts、lifecycle server、runtime provider 与 execd/egress；E2B 也区分 API 控制平面与 VM orchestration 数据平面。[OpenSandbox 架构](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/index.md)、[E2B 架构](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)

关键推论：**一次 Run 可以拥有一个临时 Sandbox，但 Run 的完成记录不应随 Sandbox 销毁而消失。** 同时，`sandbox created`、`command exited`、`agent finished`、`result validated` 是不同证据，不能共用一个 success 布尔值。

## 2. 候选现状：开源边界发生了变化

| 候选 | 当日核实的定位与开源状态 | 对 AtomicAgent 的研究价值 |
| --- | --- | --- |
| **OpenSandbox** | 原 `alibaba/OpenSandbox` 官方地址重定向到 `opensandbox-group/OpenSandbox`；Apache-2.0；包含协议、生命周期服务、Docker/Kubernetes 后端和执行组件。不是第三方同名 fork。 | 最直接的可自托管 Sandbox API 参考；优先做窄接口原型。 |
| **E2B runtime** | 原 `e2b-dev/infra` 重定向 `e2b-dev/runtime`；runtime 仓库 Apache-2.0；本地开发要求 Linux/KVM，包含多个控制与执行服务。 | microVM、快照恢复、数据平面与控制平面分工的重点源码；可同时评估云 API 与自托管路径。 |
| **Daytona** | 官方公共旧仓库声明：2026 年 6 月起核心开发迁至私有代码库，旧仓库不再更新、修复或发布；README 链接的历史 `v0.190.0` LICENSE 是 AGPLv3。 | 当前云服务可作为体验与 API 对照；**不能把当前云文档能力当成持续维护的开源版本能力**。 |
| **Modal** | `modal-labs/modal-client` 是 Apache-2.0 官方 SDK 仓库。此次核实的开源范围是客户端；未核实到完整云控制平面的自托管源码。 | 托管计算与 Sandbox 生命周期/文件/快照 API 对照；不能列作已验证的开源自托管平台。 |

来源：[OpenSandbox 官方仓库](https://github.com/opensandbox-group/OpenSandbox)、[OpenSandbox LICENSE](https://raw.githubusercontent.com/opensandbox-group/OpenSandbox/main/LICENSE)、[E2B README](https://github.com/e2b-dev/runtime/blob/main/README.md)、[E2B LICENSE](https://raw.githubusercontent.com/e2b-dev/runtime/main/LICENSE)、[Daytona 停止维护公告](https://github.com/daytonaio/daytona)、[Daytona 历史 LICENSE](https://github.com/daytonaio/daytona/blob/v0.190.0/LICENSE)、[Modal SDK 仓库](https://github.com/modal-labs/modal-client)。这里仅记录文件身份与维护事实，不对商业使用的具体法律义务作判断。

Daytona 重大变化的官方原文摘录：

> As of June 2026, Daytona's core development has moved to a private codebase.

摘自 [daytonaio/daytona 当前 README 的 Important 公告](https://github.com/daytonaio/daytona)，2026-09-12 实际打开核实。公告同时说明旧仓库不再维护。实施评估时应复核该公告及所选历史 tag，避免将旧的“open-source platform”介绍沿用为当前核心的开源承诺。

### OpenSandbox：最值得先验证的通用平台接口

**已核实事实。** 单机可用 Docker，集群可用 Kubernetes；通过 `secure_runtime` / RuntimeClass 接入额外隔离，官方给出 gVisor、Kata 等配置。配置的 runtime 不可用时，服务启动校验会失败。因此，“用了 OpenSandbox”不等于“已经使用 microVM”，需要检查实际创建实例的 runtime。[Secure Container 指南](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/secure-container.md)

生命周期协议包含 image/snapshot 启动源、环境变量、CPU/内存等资源字段、volumes、网络策略、到期续期、暂停恢复；文件和命令是独立执行接口。能力存在于协议不保证每个后端完整实现，应保留 provider capabilities 检查。[生命周期 OpenAPI](https://github.com/opensandbox-group/OpenSandbox/blob/main/specs/sandbox-lifecycle.yml)

**必须保留的语义差异。** Docker pause 是容器暂停；Docker snapshot 是镜像提交。Kubernetes BatchSandbox 当前单副本 pause/resume 以 rootfs 镜像保存并重建运行时；公共 snapshot API 的通用 Kubernetes 实现仍是不同事项。这不足以推出“任意后端都恢复了进程内存与正在运行的 Agent”。[OpenSandbox 架构：Pause, Resume, Snapshots](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/index.md#75-pause-resume-and-snapshots)

**warm pool。** 客户端 pool 提供 acquire，领取后由使用者 destroy/kill，没有把使用过实例归还的 release；Redis 可以共享空闲实例 ID 与期限，内存 store 只适合单进程；max_idle 只限制空闲缓冲，不限制借出的实例或 direct-create fallback。池配置更新需要新的池命名空间。[客户端池指南](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/client-pool.md)

**凭据与出口。** Credential Vault 将真实凭据置于 egress sidecar，工作负载使用空值/占位值；出站请求按 scheme/host/port/method/path 匹配后注入凭据。它要求 `dns+nft`，不接受仅 DNS 过滤，并依赖透明 HTTPS 拦截；文档列出与额外透明 service mesh sidecar 的限制。[Credential Vault 指南](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/credential-vault.md)

**推断与待验证。** 这是把真实模型/MCP 凭据移出 Agent 文件系统的强参考，但“凭据不可读取”不等于“凭据不可滥用”：Agent 仍可能调用被允许的服务。AtomicAgent 需要限定用途、目标和预算。自托管成本至少含 Linux/runtime 运维、镜像更新、出口代理、状态持久化、对象存储或产物存储；多租户授权模型仍需单独验证，不能从 API key 鉴权推导完整租户隔离。

### E2B：microVM 与快照恢复的系统参考

**已核实事实。** 每个 Sandbox 是 Firecracker microVM；模板预启动后保存 memory、disk、VM state，创建时恢复快照。内存按 page fault 懒加载，rootfs 使用写时复制；网络有独立 namespace/slot 与 nftables 出口控制；envd 提供进程、流与文件 API。控制平面维护身份/配额/放置，执行节点管理 VM。[E2B 架构](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)

**自托管与凭据边界。** 官方本地开发包含 Postgres、Redis、ClickHouse 与监控等组件；运行要求 Linux/KVM。[E2B 开发说明](https://github.com/e2b-dev/runtime/blob/main/README.md#developing) 架构文件还出现由 `orchestrator-ee` 等外部后端处理的能力；因此必须逐项区分公共 runtime、云和企业扩展，不能把架构文档所有能力视为开源开箱即用。

**推断与待验证。** 它更适合作为明确需要 microVM 隔离、快照恢复时的候选。完整自托管引入的服务面比单机 Docker 原型更大，但这不是成本排名；实际运维成本取决于规模、现有基础设施与团队经验。需验证 Agent 启动后的就绪耗时、CLI/工具兼容性、网络代理限制、清理行为以及具体部署开放的配额与凭据能力。

### Daytona：当前服务有多种隔离类别，旧源码不能代表它

**已核实事实。** 当前 Isolation 文档分别列出 Container、Linux VM/Windows VM、GPU；VM 类拥有独立内核，CPU/内存/磁盘有 hard limits；组织授权、网络隔离与运行时隔离分别描述。[Daytona Isolation](https://www.daytona.io/docs/en/isolation/)

出口配置有 block-all、CIDR/domain allowlist 以及上游 HTTP(S) proxy；默认访问策略还受组织 tier 影响。因此同一 create 参数在不同账户条件下需做实际可达性校验。[Daytona 网络限制](https://www.daytona.io/docs/en/network-limits/)

warm pool 保存预创建且运行中的实例，按 snapshot、region、默认 resources、默认用户匹配；带自定义环境变量、volumes 或 secrets 的创建请求不满足命中条件；池占用组织资源配额并自动补充。[Daytona Warm Pools](https://www.daytona.io/docs/en/warm-pools/)

**推断。** 用户要求每请求配置环境与 MCP/skills，可能降低预热命中率。因此要实验“镜像固化公共依赖，领取后注入请求材料”的两阶段准备方式；不能直接承诺任意配置的请求都获得 warm pool 延迟。当前服务与停更历史自托管代码应分成两条候选记录。

### Modal：托管体验对照，注意 request 与 hard limit

**已核实事实。** 默认 Sandbox 文档使用 gVisor 路径；另有 **VM Sandboxes Beta**，通过实验选项启用真实 Linux kernel。[Modal 安全说明](https://modal.com/docs/guide/security)、[VM Sandboxes](https://modal.com/docs/guide/vm-sandboxes)

网络可全部阻断，也可用出站 CIDR/domain allowlist；不要把环境变量里的模型 token 当作网络授权策略。[Sandbox Networking](https://modal.com/docs/guide/sandbox-networking)

资源 `request` 允许有容量时 burst；文档提供独立上限参数，计费基于 request 和实际使用的较大者。因此 `cpu=…` 这样的保证容量不应被平台抽象为硬预算上限。[Sandbox Resources](https://modal.com/docs/guide/sandbox-resources)

快照分 filesystem、directory、memory。内存快照仍标为 **Alpha**；TCP 连接、TTL、环境变量/秘密残留等快照限制需要查看具体类型。文件系统快照不应被平台命名为可恢复运行中的 Agent 会话。[Sandbox Snapshots](https://modal.com/docs/guide/sandbox-snapshots)

**推断。** 可用它验证“API → 环境 → agent → 产物”的开发体验与托管运行成本。SDK 开源不会自动给产品提供服务端可迁移性；平台适配接口应该保留终止、超时、产物读取与资源上限的明确语义。

## 3. 隔离底座：为何不是三个互换品牌

| 技术 | 第一方确认的机制 | 对本产品的验证重点 |
| --- | --- | --- |
| gVisor | 用户态 application kernel 截获应用系统调用；`runsc` 接 OCI/Docker/Kubernetes。官方明确承认系统调用兼容性与 syscall 密集负载开销取舍。 | 固定版本 Agent、Node/Python、浏览器、包管理、文件监听、测试框架是否工作；避免仅用 echo 验证。 |
| Kata Containers | 以轻量 VM 接入容器生态；独立内核与硬件虚拟化，支持不同 hypervisor 和 OCI/CRI。 | 实际 RuntimeClass、所选 hypervisor、内核/挂载/设备支持、镜像大小与节点容量。 |
| Firecracker | 基于 Linux KVM 的最小 VMM；可配置 vCPU、内存、磁盘与网卡；官方强调安全性依赖正确配置的 Linux host，生产另有 Jailer。 | KVM/宿主支持、guest image、存储/快照与网络运维；不能认为安装二进制就获得完整平台。 |

来源：[gVisor 官方介绍](https://gvisor.dev/docs/)、[Kata 官方介绍](https://katacontainers.io/)、[Firecracker 官方仓库](https://github.com/firecracker-microvm/firecracker)。此表没有性能排名；不同机制的延迟与密度必须使用相同工作负载实测。

## 4. 面向 AtomicAgent 的设计候选（尚未决定）

1. **Run 与 Sandbox 分离。** Run 持久保存请求摘要、版本、预算、状态、结果与产物 manifest；Sandbox 是执行资源。一个 Run 的自动重试应创建独立 Attempt，避免把旧执行迟到结果记到新执行上。
2. **创建环境分两段。** 可复用的 runtime image/profile 固化 Agent 与常用工具；每次领取后再注入初始文件、请求级 skills/MCP 配置和短期能力。环境准备成功必须有 readiness 证据，不能以 VM 启动结束代替。
3. **优先复用无用户数据的模板/预热实例。** 用过的实例默认销毁。若后续要跨请求复用，先定义状态归属与擦除验收；清空工作目录无法证明进程、HOME、缓存、credentials、网络连接都已重置。
4. **权限归平台控制。** 不把调用方输入的 host mount、privileged、任意 MCP command、镜像 registry 凭据原样传入底层。应先区分“允许自定义”和“平台允许执行”；模板、skill、MCP 配置都可能携带可执行代码。
5. **产物独立提交。** Agent 输出一个受版本控制的 manifest；宿主侧校验声明路径、类型、大小、内容哈希与输出 schema，再保存到 Run 所属的产物存储。只把已提交的对象发给调用方，Sandbox 销毁后仍可按保留期下载。
6. **出口策略与数据访问分离。** 允许访问 LLM/MCP 域名只是第一层；真实能力还要限定目的、动作、预算和有效期。HTTPS 凭据代理可降低秘密泄漏风险，但工具 API 自身仍可能产生外部写入。
7. **预算至少分开五类。** 排队截止、准备截止、Agent 执行时长、模型消费预算、CPU/内存/磁盘/产物上限。托管服务配额、资源 request 与平台 hard limit 不混为一个 timeout。
8. **清理可观察。** 回答可完成但资源销毁失败，应有独立 cleanup 状态与后台回收；HTTP 客户端断开不应成为资源生命周期的唯一驱动。

以上是由候选实现差异推导的需求方向，未在当前项目部署验证；不自动写入 accepted ADR。

## 5. 条件化推荐与最小验证实验

**推荐候选顺序，不是实施顺序承诺：** 若重视自托管和明确接口，先以 OpenSandbox 验证任务垂直闭环；若明确需要 microVM/进程快照，再把 E2B runtime 纳入同场实验。若第一阶段允许托管，E2B Cloud 或 Modal 可作快速对照。Daytona 当前云 API 可读可测，历史开源版本的维护成本需要单列。没有必要第一版同时接入全部平台。

### 针对“自有后端调用、保留自托管”的部署建议

**建议第一轮用一台独立 Linux 主机承载 OpenSandbox + Docker，先完成受控内部任务验证，同时保持 SandboxProvider 接口。** 该建议是降低首轮运维变量的工程判断，依据是 OpenSandbox 官方支持 Docker 单机后端，以及 gVisor 可接入 Docker runtime；不要求先建立 Kubernetes 集群。[OpenSandbox Secure Runtime](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/secure-container.md)、[gVisor Docker 接口说明](https://gvisor.dev/docs/)

| 路径 | 首轮真实成本判断（定性推断，未做账单基准） | 适用边界与升级触发 |
| --- | --- | --- |
| 独立 Linux 主机 + Docker | 主要是一个执行节点、Docker/镜像仓库、生命周期服务、结果持久存储和清理监控；排查路径短。节点故障会同时影响控制与执行，需明确备份、容量上限和失败回收。 | 受控输入、内部迭代与协议验证。调用方可信不等于模型生成代码、下载依赖或初始文件可信；不凭内部调用身份宣告生产隔离验收通过。 |
| 同一架构换 gVisor/runsc | 在 Docker 基础上增加 runtime 部署、兼容性回归、文件/系统调用性能测量；无需为此引入 Kubernetes。 | 希望缩小工作负载对宿主内核直接接触面，且 Agent 工具链可通过兼容性实验时，作为第一生产隔离候选。 |
| Kata 或 E2B/Firecracker | 增加 KVM/宿主与 guest kernel、镜像/快照、网络/存储调优；E2B 的现成控制平面还带有数据库、缓存与观测组件。单机也可研究，不意味着必须集群。 | 要求独立内核边界、需要内核功能或可恢复进程快照时纳入；由实际威胁模型与工作负载决定，不按“更先进”决定。 |
| Kubernetes | 增加集群、调度、存储、网络策略、runtime class、控制器与升级维护面；已有成熟集群时增量成本可能较小。 | 多节点容量、组织运维标准或高可用需求实际出现后再考虑；首个可验证请求不需要以 K8s 为前置条件。 |

在尚无负载与 SLA 数据时，不声称自托管比云更便宜。自托管成本应计入空闲/预热资源、峰值冗余、存储/出口、升级与值守，而不只是单台服务器租金。第一轮应测完整任务成功率、总时延、准备时间占比和单任务资源峰值，再决定是否需要预热或增加节点。

| 实验 | 最小负载/故障 | 必须记录的验收证据 |
| --- | --- | --- |
| E1：完整请求 | 固定版本 Agent，输入小型源码仓库与 JSON 数据，要求生成结构化结果及一个文件；配置一项 skill、一个只读 MCP | create → ready → agent started → result emitted → schema validated → artifact committed → sandbox deleted 的 ID、状态和耗时；真实结果校验 |
| E2：延迟拆解 | 相同镜像与文件量，分别测无缓存、模板命中、预热命中；串行与小突发并发 | 区分 queue、provision、prepare、agent/model、upload；报告样本数及 p50/p95，禁止把供应商营销数字当端到端 SLA |
| E3：跨请求隔离 | A 写文件/HOME/缓存、启动后台进程；销毁后 B 在同模板创建 | B 无法读取 A 的标记；无遗留进程/挂载/秘密；provider 资源列表和存储保留规则一致 |
| E4：资源与取消 | CPU/内存/磁盘超额，CLI 挂起，调用端断线，取消与结果同时发生 | hard limit 真正生效；明确一个终态；迟到事件不覆盖；取消后的进程与计费资源收敛；不能只看 SDK 返回 |
| E5：网络/凭据 | 允许模型与 mock MCP；尝试未授权域名、直连 IP、重定向；撤销凭据后再次访问 | 允许路径成功，禁止路径被执行层拒绝；Agent 文件/进程参数/日志无真实秘密；授权动作范围可证明 |
| E6：产物与失联 | 产物超量、路径越界/符号链接、写到一半；结果上传后响应丢失；重放同一幂等键 | 产物 manifest 一致；半成品不冒充完成；查询能重取已提交结果；重复请求不产生不可识别的第二次外部动作 |
| E7：快照语义（条件实验） | 文件、内存计数器、后台进程、TCP 连接分别在暂停前后观察 | 明确恢复的是 image、rootfs 还是完整进程状态；凭据与时间有效性重新检查；不从 snapshot API 名称推断语义 |

实验应先使用受控 mock 服务验证运行平台，再用真实付费模型做少量完整闭环。mock PASS 只能证明所模拟边界，不是 provider 实际执行、网络或账单的验收证据。所有实验需固定 Agent、SDK、镜像 digest、runtime 与区域；当前研究尚未执行这些实验。

## 6. 访谈依赖清单（部分已得到回答）

本报告的通用问题清单保留如下；最新已确认边界及剩余问题以 [访谈记录](../interview-log.md) 为准，不重复要求用户决定已确定事项。

- 调用方是否可信，能否提交任意镜像、shell 初始化、skill 脚本与 MCP 启动命令？“环境配置”具体授权到哪层？
- 首个场景需要纯文本/JSON、可下载文件，还是允许部署、发送消息、修改第三方系统等外部副作用？
- 单次请求可接受的排队、冷启动与运行时间分别是多少？同步 HTTP 是便捷外观还是唯一协议？
- 首期运行于个人/团队自托管、私有网络、托管云还是公开多租户服务？是否存在数据驻留要求？
- 模型和 MCP 的凭据由平台提供还是调用方提供？能否使用代理或短期凭据，是否存在必须端到端直连的服务？
- 请求结束后仅保留结果，还是要保留可重进的环境/会话？若没有后者，完整内存快照的业务收益是什么？

这些答案会改变隔离与运行方式，当前不能仅凭“sandbox”一词确定 Docker、gVisor 或 microVM。

# Ticket10 — 隔离执行与只读边界

状态：实现、确定性回归、真实 Linux/provider 协议实验及双轴审查完成；真实模型内容、gVisor 和用户人工综合验收未完成，票的 AC 不代勾。

固定审查基线 `6b84a52dc068eaedb2b2e75fde17375d5af6268c`；实现 checkpoint `60cb7f40f117ff4f3f5dc85a456434eb13f9e49e`；审查修复 `4574a6e3f6ec64d4a05b6079435bd26173ab1c68`；取消迁移中间修复 `05853934a07d8f6700063343c81d2edf0bef0dac`，最终兼容修复 `82350d03082ccc86402fd190f64dbea26df724cb`。证据和复现入口见 [验证账本](../../.scratch/v0/evidence/ticket10/verification.md)、[审查](../../.scratch/v0/evidence/ticket10/review.md) 与 [失败历史](../../.scratch/v0/evidence/ticket10/failure-history.md)。

## 行为与可信边界

新 live Run 必须使用平台私有 `isolation_qualified_images` 中的精确镜像，并通过不读取模型凭据、不启动 Agent 的真实命名空间探测。旧已登记镜像不会自动合格：缺资格或能力失败返回 `isolation_unavailable`，模型 secret 读取和 Agent 派发均为零。成功必须同时有合法 enforced 边界、持久准入以及实际模型调用的 started/completed 证据；缺 journal 不能继承旧 runner 的成功候选。请求方不能覆盖 bootstrap 扩展或资格清单。

每 Run 的外层 OpenSandbox 容器承载 root 可信 runner；真实 Claude SDK 0.3.270 启动其 bundled CLI 2.1.270，经过 bwrap 私有 PID/net/IPC/UTS 和 setpriv 后以 UID/GID 1000、空 capability bounding set、NoNewPrivs 执行。没有替换 SDK 或引擎。该可运行部署需要外层 CAP_SYS_ADMIN + NET_ADMIN、seccomp/AppArmor unconfined，并采用固定源码的 OpenSandbox 补丁；这是明确的可信计算基，不是 Docker 默认配置或 gVisor 强隔离证明。内层禁用 user namespace，因为本机实验中的固定 Bun CLI 在所测 user namespace 映射下中止；没有通过修改宿主全局策略或 privileged 容器掩盖失败。

CLI 只获得本次任务 `/workspace` 可写映射、只读运行时、私有 `/proc` 和一个固定 Unix 代理 socket。完整请求、结果、许可回执和 journal 位于不可写的 `/run/atomicagent` 控制目录；任务仅能读取最小输入描述，公开 `input/...` / `output/...` 契约不变。CLI 环境只有合成模型凭据，不能读取父 runner 的真实 key 或控制目录；模型凭据只在父 gateway 向已冻结 endpoint 发请求时注入。

模型所需 POST `/v1/messages` 是单独的平台模型动作。gateway 固定模型和路径，拒绝业务写路径、CONNECT、absolute URL、重定向、未准入模型、供应商服务器工具／外部 MCP／container 能力和 URL 型 image/document 来源；SDK 的 `HEAD /api/hello` 在本地应答，不转发 key。业务来源仍使用 07 的登记只读 MCP：精确 source_id、HTTPS 全 URL allowlist、GET、redirect:error；本票没有扩展成通用远端 MCP 或任意网络客户端。内层没有直接外网，绕过工具的原始 socket 也不能走父网络。

工具继续沿用 06 的 Skill 和 exact Bash allowlist。文件读取拒绝路径穿越、符号链接、硬链接和非法路径；父进程在整个内层进程树退出后才收集文件，消除可写中间目录在检查与打开之间被攻击进程交换的并发前提。单独的 lstat + O_NOFOLLOW helper 不被声称为通用 openat2 原子保证。

## 准入、终态与观测

外部动作先在受保护 journal 写 requested，runner 等待本次 Run/Attempt/call 唯一许可文件。adapter 通过 Worker 的 SQLite 原子边界检查终态、身份并持久写 admitted；成功后才回传许可。journal 写入串行、fsync、原子替换；许可有界等待，丢失、取消、存储失败和不匹配均失败关闭。重复或旧快照不能忘掉已经保存的许可。

`requested` 和 `admitted` 不等于实际执行。gateway/受控 handler 的调用和结果形成观测；SDK PreToolUse 只证明工具获准，PostToolUse/Failure 才确认收尾，不捏造 Bash 启动事件。已有准入但没有收尾的调用保持 unknown。终态后新的调用不能得到许可；取消前已原子准入的调用属于在途动作，其已知 ID 的 completed/failed/unknown 可以迟到保存，但不能改变业务终态或 Result。同一批次若同时有新请求和旧调用收尾，先保存合法收尾再拒绝新准入，不能因抛错回滚整批证据。

所有源材料有界且使用字段允许清单，不保存提示词、请求 payload、响应正文或密钥。Run 查询、刷新后的 A 页面和健康投影读取同一事实。健康包含查询时间、实际观测时间、新鲜度和 unknown 计数；不把数据库投影当实时 provider 探针。审计始终标 partial，未观察到的系统调用不冒充完整覆盖；要求 complete 的请求／配置失败关闭。权限、所属工作区与关键持久状态仍在服务端裁定。

## 升级与取消兼容

05–09 已冻结的旧 manifest 和 provider 清理身份保留。未合格的旧镜像不能再启动新 Agent，也不能先提权、传 secret 再事后失败。升级时已经运行的旧 Run 仍读取 `/workspace/cancel.json`（node），新隔离 runner 读取 `/run/atomicagent-cancel.json`（root）。执行资格可以撤销，不能用当前资格清单推断历史停止协议。因此平台先尝试新 root marker，再独立尝试旧 node marker；任一路径失败仍尝试另一路径，最后报告失败，不把写入成功当作已停止。仅向原不可变资源写两个固定兼容标记，不授予重新 prepare/execute 的权利。09 的 30 秒强停、资源不确定责任和独立 cleanup 不变。

生产需先构建、审查并登记新镜像 digest，部署固定 patched server 和只在 loopback 发布的 execd/egress 端口，再对同一配置执行能力探测。原版固定 server 不满足本票必要的 NET_ADMIN 与全端口 loopback 条件。server 接触 Docker socket，属于可信控制面；任务容器没有 Docker socket。实际实验 server 用 host network 但仅监听 127.0.0.1:43810；不能仅凭 server 的主端口私有就推断 sidecar 私有。

## 运行与最短人工路径

使用 Node 24.18.0，在仓库根执行：

```powershell
npm ci
npm run build
# 仅首次且本地配置不存在：先 npm run setup:local
npm start
```

本地默认 fixture 不证明隔离。可运行边界状态的 fixture UI 演示服务：`npx tsx tests/browser-server.ts`，打开 `http://127.0.0.1:4311`，使用测试身份 `browser-test-only-credential-00000000000000000000` 登录，提交 `boundary-denial-fixture`。查看任务失败原因、边界来源、partial/unknown、调用 ID 与 denied，刷新核对一致；手机滚动到边界区域。该服务只用临时库，Ctrl+C 清理。自动重现同一路径：`npx playwright test tests/execution-boundary.spec.ts`。

真实路径见验证账本中的 Linux 命令；获准模型账号后，在合格部署用恶意文件／研究任务核验同一页面，并用第二个新 Run 确认干净空间。当前未获得 endpoint/model/服务端 secret 变量及计费用途授权，没有调用个人套餐或读取无关凭据。本票物理实验已用真实 SDK/CLI/provider 配合自有合成 Anthropic 协议接收端闭合可独立验证的系统边界，不能代替模型推理和用户人工验收。

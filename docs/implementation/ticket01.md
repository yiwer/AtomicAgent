# Ticket01 — 提示词到已校验 JSON

本票已建立可运行的 API、持久化、执行适配器及 A 任务工作区。**真实 Linux／Docker／模型验收尚未完成，ticket01 尚不能关闭。** 当前只配置确定性实验 profile；它不调用模型，也不创建真实容器。

## 启动与最短演示

要求 Node **24.18.0**、npm，工作目录为项目根目录。

```powershell
npm ci
npm run setup:local
npm run build
npm start
```

`setup:local` 只在首次执行，生成 `.local/config.json` 中的随机访问令牌，不覆盖已有文件，不在终端打印令牌。当前工作区已生成该文件。打开 <http://127.0.0.1:4310>，在本机私下读取配置中的 `identities[0].token` 并登录；不要将配置或令牌贴入日志、工单或截图。

1. 顶部核对服务端返回的 `local-maintainer / atomicagent-lab` 身份，页面明示确定性实验。
2. 提交默认提示词；打开详情，结果为 `{"summary":"three apples","value":3}`，校验通过，业务状态成功，回收状态单独显示。替身输出固定，不理解任意提示词。
3. 刷新页面、关闭后重新打开页面，取回同一 Run。正常停止并重新启动服务后重新登录，已提交结果仍可读取。
4. 原始 API 支持 `POST /v1/runs`、`GET /v1/runs`、`GET /v1/runs/{id}`、`GET /v1/runs/{id}/result`；使用服务端配置的 Bearer token。提交需要 `Idempotency-Key` 与如下正文：

```json
{"prompt":"Return summary \"three apples\" and integer value 3.","profile":"json-lab@1","output_contract":"summary-value@1"}
```

所有业务读取按调用身份隔离；维护者只能读取同工作区数据；health 角色只能读 `/internal/health` 和自己的身份。页面 token 交换为 HttpOnly、SameSite=Strict 的进程内会话 cookie，8 小时失效；重启须重新登录。服务仅监听 loopback，远程实验通过获准 SSH 转发访问，不直接暴露互联网。

## 已定稿窄契约

- 固定 `json-lab@1`、`summary-value@1`：非空、最多 500 字符的 `summary` 和整数 `value`，不接受多余字段。提示词最多 8000 字符，HTTP JSON 最多 16 KiB。不支持本票之外的文件、Skills、MCP、任意 schema 或配置编辑。
- SQLite WAL + FULL 同步事务保存 Run／幂等绑定／清单／授权／关键审计。登记修订持久固定，重启时在任何恢复动作前核对现有清单；模型、fixture／live 模式或 provider 地址变更均拒绝原地覆盖。真实配置应使用独立数据库，不能覆盖 fixture 实验库。创建意图先于 provider 请求，Attempt 意图先于 SDK 启动；结果和验证报告随权威终态一次提交。进程恢复不会重启已有 Attempt；失联执行明确失败并处置资源。
- 一个本地控制进程、一个执行槽位；期限包含排队、准备、执行和提交。原型中的并发 2 属后续限额／调度票，当前不代表容量验收。启动锁阻止第二个控制进程；非正常退出后的锁必须由维护者确认原进程已停止后移除，再重新启动，禁止在线删锁。
- 执行侧同时设置 OpenSandbox TTL、command timeout、SDK abort；平台到期不再等待准备／执行回执。未知创建不再次 create，未知启动不再次 execute；保留原操作身份和回收责任。无资源 ID 时可按归属查找处置，但空列表仍保留 unknown；完整创建对账归 ticket14。
- 已提交 Result 与回收状态独立。只有 provider 对不可变资源 ID 的新鲜 GET 404 才认定消失；DELETE 成功、GET 403、超时、空列表都不替代核验。启动时重试未完成回收，持续处置控制台与重试调度归 ticket17。
- 已有数据库与 schema 可读但终态／观测写入失败时，恢复仍使用已读取身份逐项尝试清理，随后拒绝启动新工作；记录恢复后补做核验。该窄路径已覆盖 SQLite 写锁，不代表不可读／损坏数据库下的完整灾难恢复；后者需 ticket21 的外部最小处置记录方案。回收审计独立保存业务无关的 outcome、资源／操作身份、来源与观测时间。
- 公共响应、健康、审计仅从允许字段投影，不输出 prompt、原始模型文本、SDK stderr、外部错误正文、宿主路径、secret 引用及令牌。业务 Result 是获授权的交付出口，不能当成遥测。健康含观测时间与 ticket01 覆盖范围，模型探测仍为 unknown；完整健康／异常消费归 ticket23／24。
- 错误区分 `provisioning_failed`、`runtime_failed`、`input_required`、`authorization_required`、`output_invalid`、`deadline_exceeded`、`execution_lost`、`artifact_commit_failed`。无人值守无人工等待，也无整项重跑。

## 真实执行入口与待提供输入

使用 [profile.example.json](../../deploy/profile.example.json) 在 Linux 节点生成私有配置；占位值会拒绝启动。需获准的确切模型／endpoint、用途与计费授权引用、模型 secret 环境变量引用、固定 OpenSandbox Docker 部署修订、Linux 节点身份和最终 runner 镜像 digest。模型及 provider secret 只从指定服务端环境变量解析，不读取其他账户配置，不切换套餐／模型。

2026-09-14 的 [外部预检](../../.scratch/v0/evidence/ticket01/external-preflight.md) 已确认用户提供的 Linux 节点可通过严格主机校验的 SSH 登录，Docker 已安装。模型 profile 的用途／凭据适用范围仍未解决；OpenSandbox、Node 与本票应用尚未部署，镜像 digest 和模型兼容性仍无真实证据。节点现有 `127.0.0.1:8080` 已占用，不能直接使用示例端口；适配器当前每个 sandbox 请求 `4Gi` 内存，而预检记录节点约 3.6 GiB 内存，部署前须核实实际可分配资源及登记限制，不能把此节点视为已通过容量验收。

```bash
# 由获准节点提供准确 digest；不会默认选择或拉取其他镜像。
docker build --build-arg NODE_IMAGE="<approved-node-24.18.0-image@sha256:digest>" \
  -f deploy/Dockerfile.runner -t atomicagent-runner:ticket01 .
# 将可由该节点 OpenSandbox 拉取的最终镜像 digest 填入私有 profile。
ATOMIC_CONFIG=.local/live-config.json npm start
```

runner 固定 Claude Agent SDK **0.3.270** 及该包携带的 CLI、Node **24.18.0**，OpenSandbox TypeScript SDK **0.1.11**，依赖完整性由 lockfile 固定。模型只经登记 endpoint 访问，网络策略默认 deny，只允许模型主机。Agent tools、Skills、MCP 均为空；禁用工程设置继承，单轮返回候选 JSON，再由平台 schema 校验。SDK `outputFormat` 的自动重提示可能与“不修复”冲突，因此本票不用该路径；模型的原生 structured-output／工具循环兼容性仍未取证，不宣称已通过。

最短真实验收：在获准配置下走与上面相同的 API→A→刷新→Result 路径；记录 profile／image digest／Run／Attempt，并在 OpenSandbox 节点独立核对资源停止与消失。确认 summary 与整数 3 的业务内容。再执行缺输入、授权失败与 schema 不合格情形，确认不等待人工、不修复、不重跑。所有 real-profile 证据须独立归档，不能使用 fixture 报告关闭 AC-27。

## 验证账本

| 层次 | 命令／证据 | 结论 |
| --- | --- | --- |
| API／持久化／故障契约 | `npm run test:run` | 10 项通过 |
| SQLite 写入故障／写锁 | `npx tsx --test tests/persistence-faults.test.ts` | 3 项通过，仍可读的既有 schema |
| OpenSandbox SDK 的真实 HTTP 编解码／回收判定 | `npx tsx --test tests/opensandbox.test.ts` | 2 项通过，本地受控 HTTP 服务；不是 Docker 验收 |
| 类型／构建 | `npm run typecheck`、`npm run build` | 通过 |
| 浏览器 | `npx playwright install chromium`、`npm run test:browser` | 1 项通过；真实 Chromium + 真实 API／SQLite + fixture |
| 完整测试 | `npm test` | 15／15 通过，0 跳过 |
| 构建入口／跨进程重启／排他锁 | `npm run build` 后 `npx tsx scripts/verify-local.ts` | 通过；fixture，隔离临时库，审计子进程已停止 |
| 生产依赖审计 | `npm audit --omit=dev` | 0 漏洞；不包含开发工具依赖 |
| Linux 节点／SSH／Docker 安装预检 | [外部预检](../../.scratch/v0/evidence/ticket01/external-preflight.md) | SSH 已打通；只读观测通过，不是部署或隔离验收 |
| OpenSandbox 部署／真实 SDK／模型／网络／内容 | 确切获准 profile、镜像与部署仍待落实 | 未执行；模型用途／凭据适用范围未解决 |
| 人工验收 | 用户确认 | 待确认 |

本票不关闭后续票或父规格。7 天记录保留、文件保留、审计查询导出、完整部署资格等按原计划后续切片交付。

现有接口、证据复核及下游复用边界见 [本票实施交接](../../.scratch/v0/evidence/ticket01/implementation-handoff.md)。接口可供后续实现评估复用，不表示本票综合 AC 已通过或依赖关系已放行。

执行输出见 [完整测试记录](../../.scratch/v0/evidence/ticket01/unit-tests.txt)、[浏览器测试记录](../../.scratch/v0/evidence/ticket01/browser-tests.txt)；截图见 [桌面工作区](../../.scratch/v0/evidence/ticket01/workspace.png)、[任务详情](../../.scratch/v0/evidence/ticket01/detail.png)、[手机布局](../../.scratch/v0/evidence/ticket01/mobile.png)。[双轴审查](../../.scratch/v0/evidence/ticket01/review.md) 的已发现问题已修复并复审。

## SDK 依据

2026-09-14 核对 [OpenSandbox JavaScript SDK](https://open-sandbox.ai/sdks/javascript) 和已安装 0.1.11 的公开类型（创建／命令期限、网络策略、资源 GET／DELETE）。Claude 调用依据为 [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)、[structured outputs 文档](https://code.claude.com/docs/en/agent-sdk/structured-outputs) 与已安装 0.3.270 的公开类型。文档及类型匹配是适配实现依据，不能代替固定 profile 实测。

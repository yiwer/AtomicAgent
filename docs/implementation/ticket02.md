# Ticket02 — 文件输入、统计与独立产物交付

已实现真实 HTTP／SQLite／文件存储／A 页面链路，以及 OpenSandbox／Claude 文件执行适配。确定性执行端使用真实临时工作目录和独立 Node 子进程读写 CSV／JSON；它不调用模型，也不是 Docker 隔离证据。真实模型、OpenSandbox 部署与人工综合验收仍未执行，本票 AC 保持未勾选。

## 启动与最短演示

Node 24.18.0，项目根目录；已有 `.local/config.json` 时跳过初始化：

```powershell
npm ci
# 仅首次、配置不存在时：npm run setup:local
npm run build
npm start
```

打开 `http://127.0.0.1:4310`，按 [ticket01](ticket01.md) 私下读取现有配置的访问令牌并登录。选择 [八行 CSV](../../.scratch/v0/evidence/ticket02/data.csv)，点击「上传输入」看到已校验身份，再「提交任务」。详情应为有效 7、拒绝 1、总和字符串 `50`、alpha `22.5`、beta `27.5`。回收显示「已核验回收」后下载两个文件：有效 CSV 保留原顺序，拒绝 JSON 仅包含 r04。刷新或正常重启服务后重新登录，仍可取回同一 Run 和字节。用 [等价 JSON](../../.scratch/v0/evidence/ticket02/data.json) 重复执行。新业务执行使用新幂等键。

## 本票 API 定稿

所有接口要求 Bearer 身份或 A 的会话 cookie；health 无业务文件权限，维护者仅有同工作区访问权。单次文件处理使用一个 CSV／JSON，任务内位置限制为 `input/<安全文件名>.csv|json`；本票不开放任意脚本、schema、远程 URL 或前次产物复用。

| 操作 | 请求／行为 |
| --- | --- |
| 上传 | `POST /v1/files`；`X-File-Format: csv` 或 `json`，正文为 UTF-8 原始字节，最多 50 MiB。兼容 `{format,content}` JSON 包装，其传输上限 64 MiB。完整上传、格式校验和存储摘要复核后才返回 201／file_id。 |
| 输入查询 | `GET /v1/files/{file_id}` 返回授权内身份、摘要、大小、状态和到期时间，不返回宿主路径。 |
| 文件任务 | `POST /v1/runs`，必需 `Idempotency-Key`；正文见下。重复键先核对原提交摘要，再解析新输入，源文件后来过期不破坏原 Run 找回。 |
| Result | `GET /v1/runs/{run_id}/result` 返回已校验 JSON、ValidationReport 和 Artifact 清单；失败时 409。 |
| Artifact | `GET /v1/artifacts/{artifact_id}` 查询可用性。`POST /v1/artifacts/{artifact_id}/download-link` 签发身份绑定链接，有效期为五分钟和文件剩余期限的较小值。 |
| 下载 | `GET` 链接返回校验过摘要和大小的字节，仍需原授权身份。链接失效为 410，可在文件仍有效时重新签发；文件过期后不能续签，JSON／清单仍可查询。进程重启会使原签名失效，重新签发即可。 |

```json
{
  "prompt": "按十进制处理 value；负数和零有效，非数字行进入拒绝清单，保序输出有效 CSV、拒绝 JSON 和统计。",
  "profile": "json-lab@1",
  "output_contract": "data-statistics@1",
  "inputs": [{"file_id": "<上传返回的身份>", "path": "input/data.csv"}]
}
```

CSV 支持引号转义和 CRLF，列固定 `id,category,value`；JSON 为相同三字段的行数组，`id`／`category` 为非空字符串。十进制值可为字符串或 JSON 数字；数字从 Node 24 reviver 的原始词法内容取得，不经过二进制 Number 舍入。有效数格式为可选负号、1–30 位整数和可选 1–18 位小数；不采用科学记数法，其余值作为拒绝行。统计金额用规范十进制字符串交付。输出候选 JSON 沿用 runner 12,000 字节上限；文件总量上限 100 MiB，不能以模型自述替代文件内容。

## 执行与持久化边界

InputObject 先登记带归属的暂存责任，再写入控制进程独占存储目录，按 UUID 寻址，不使用请求路径。可引用前必须完整校验。Run 事务固定 InputBinding 的归属、位置、大小、摘要与期限；准备时重查可用性、读取摘要并装载独立工作副本，装载完成后才登记 Attempt。超限、越权、过期、重复目标、路径穿越、格式不匹配、符号链接、残缺或篡改字节均不会获得有效输入执行。

登记 `process-data@1` 工具只允许固定命令 `node /opt/atomicagent/dist/src/process-data.js`，不接受请求自带命令。真实路径在 sandbox 中由 Claude SDK 调用此命令；SDK 工具权限回调和 PreToolUse hook 均限制准确命令，环境设置／MCP 不继承外部配置。固定程序真实读取文件、计算、写入两个必需文件和完成标记；收集器拒绝越界／符号链接／超额，平台随后用独立的十进制求和实现验证统计和有序内容。固定程序不是后续 Skill 管理功能，也不宣称任意代码执行已授权。

产物先登记各自 Run／调用方／UUID 转存责任，写入后复核字节。同一对象写回执丢失先按原 key 对账，窄存储阶段最多追加两次尝试，原 Run 期限不重置；持续故障失败并保留未核验回收责任，不重做 Agent。完整跨中断阶段恢复和通用重试仍属后续票。验证通过并全部转存后，Artifact 可用性、24 小时到期时间、ValidationReport、Result 与终态在一个 SQLite 事务内提交；审计写失败一起回滚。未提交残留立即尝试删除，失败保持责任，启动恢复再次核验。已交付文件独立于 sandbox 清理。完整到期物理删除调度与七天记录保留归后续保留策略票；本票已在访问边界阻断到期文件。

随行为记录上传／绑定／装载、工具完成来源、转存意图／核验／提交、下载链接签发、传输开始／服务端结束或断开、残留回收观测。服务端完成写响应不表示调用后端确认收到。审计只保存受控动作、主体、对象身份、来源和时间，不保存文件正文、签名 URL、secret 或异常原文。`/internal/health` 提供同工作区未完成存储责任数和时间／来源，模型健康仍未知；完整审计查询和异常管理留在原票范围。

## 验证与真实门槛

聚焦命令：`npx tsx --test tests/files.test.ts tests/file-validator.test.ts`。完整检查：`npm run typecheck`、`npm run build`、`npm test`、`npm run test:browser`。结果和 RED／GREEN 记录见 [证据账本](../../.scratch/v0/evidence/ticket02/verification.md)。测试使用真实 API、SQLite、临时文件和子进程；存储故障通过 BlobPort 或真实 SQLite 触发器注入。30,000 行／类别检查的是验证器容量行为，不是端到端模型容量或延迟承诺。

实现依据核对已安装 OpenSandbox 0.1.11 的 `SandboxFiles.writeFiles/readBytes/getFileInfo` 公共类型与 `mapApiFileInfo` 源码；Claude SDK 0.3.270 的 `tools`、`canUseTool`、PreToolUse hook、`maxTurns` 类型。类型通过不证明真实 SDK／模型文件工具循环成功。

真实验收需要依 ticket01 落实获准 endpoint/model／secret 环境绑定和计费授权、固定 OpenSandbox 部署与 runner 镜像 digest。构建仍用 `deploy/Dockerfile.runner`，镜像必须包含本票新增处理器／收集器；`ATOMIC_CONFIG=.local/live-config.json npm start` 在获准 Linux 节点启动后，走相同 A 流程并独立核对 Run／Attempt／资源消失／下载字节。尚未调用真实模型、部署远程服务或获得用户人工验收，不能据本地测试关闭真实综合 AC。

# Ticket08 — 前次 Artifact 显式输入复用

实现 API、A、持久 InputBinding、生产 OpenSandbox 装载路径及独立副本回收。接纳和复制窗口校验通过后才开始一次新的 Attempt；前次 Run 的 Result、幂等身份、权限和原 Artifact TTL 不改写。确定性 API／本地子进程与真实 Chromium 验证见[证据](../../.scratch/v0/evidence/ticket08/verification.md)。两次真实模型任务、Linux sandbox、人工综合验收未执行，AC 不勾选。

## 启动和最短 A 验收

项目根目录，Node 24.18.0；已有 `.local/config.json` 时直接运行：

```powershell
npm ci
npm run build
npm start
# 仅首次且配置不存在时：npm run setup:local
```

打开 `http://127.0.0.1:4310`，使用现有授权身份登录。上传 [Ticket02 八行 CSV](../../.scratch/v0/evidence/ticket02/data.csv)，提交首个文件任务；总和 `50`、有效 7、拒绝 1。详情中点击「用作新任务输入 output/valid.csv」，提交区明确显示原 Artifact、原 Run 和期限。填写新任务提示词、独立选择本次配置，再点击「提交任务」。第二 Run 应有新身份和 Attempt，有效 7、拒绝 0、总和仍为 `50`。在「输入来源与独立副本」核对 binding_id、原 Artifact/Run、原期限、固定摘要、当前 Run/路径、装载时间与回收观测。刷新详情后仍保留；回收完成后下载新 Artifact，再打开第一 Run 下载原 Artifact，原期限不变。

测试中途断开产物查询再恢复，选择错误会显示在产物区，再次点击可恢复。选中输入后未知提交沿用 Ticket03 的原 key／原 body 对账；刷新后的待确认提交能找回原 Run。更换身份不转移输入授权，服务端仍校验归属。

TTL 和复制故障无需等待一天，运行聚焦测试：

```powershell
npx tsx --test tests/artifact-reuse.test.ts tests/opensandbox-artifact-reuse.test.ts
npx playwright test tests/artifact-reuse.spec.ts
```

## 已实现 API

`POST /v1/runs` 使用新的 `Idempotency-Key`；只支持固定 `data-statistics@1` 的一个数据输入：

```json
{
  "prompt": "仅处理本次显式输入，生成保序 CSV、拒绝 JSON 和十进制统计。",
  "profile": "json-lab@1",
  "output_contract": "data-statistics@1",
  "inputs": [{"artifact_id": "<前次 Result 清单中的 UUID>", "path": "input/previous.csv"}]
}
```

也可按 Ticket05 显式选择 environment/model 修订。既有 `{file_id,path}` 请求兼容；同一输入不能同时给两个 ID。路径只允许 `input/<安全文件名>.csv|json`，最多 50 MiB。CSV 列固定 `id,category,value`，JSON 为同字段行数组；前次 `output/valid.csv` 和 `output/rejected.json` 均可用于新的统计任务。Markdown 研究报告与任意 JSON 不符合本契约时明确 `400 input_contract_incompatible`，不伪装格式或继承研究授权。大 Artifact 超输入上限为 `413 input_limit`。完整通用多输入／任意文件处理不在本票固定契约内。

最早可判断时查权限、状态、源期限、类型、大小和目标路径；Artifact 在接受前读取完整字节并复核大小、摘要与内容契约。不存在／越权 `404 file_not_found`，过期 `410 file_expired`，不完整／替换内容 `409 file_incomplete`。每个新 Run 冻结自身 binding_id、源 UUID/Run、归属、摘要、大小、原期限及目标位置；file_id 是兼容的源对象键，source 明确其 Artifact 类型，并非新宿主长期存储对象。

准备时重新查固定源身份与期限、读取字节并复核。OpenSandbox 将其复制进本 Run 独立 sandbox，检查目标普通文件／大小并回读摘要；本地 fixture 同样写独立目录并回读验证。目标失败为 `input_copy_failed`，复制期间源过期为 `input_source_expired`，源身份或字节替换为 `input_required`；均无 Attempt／Result，仍回收新 Run 的临时空间。目标验证和源复核完成后，持久 `loaded=true`、`loaded_at` 才允许启动 Attempt。确认后原源过期甚至被移除，不影响已确认的新副本；新副本按新 Run 期限执行并随其 sandbox 回收。

既有 key 在源解析前先回放；并发接纳跨源 IO 的窗口也再次对账。源过期、配置停用不改变已接纳 Run；业务重做必须新 key，复制故障不自动重做 Agent、不续期原源。当前保留期物理清扫仍属 Ticket18，本票只落实来源存续检查与新 Run 副本回收，不删除可用的共享源。

`GET /v1/runs/{id}` 的 inputs 展示 source 与 copy 观测。copy.status 为 unconfirmed／loaded／removed，结合 cleanup_status/时间/来源判读；unconfirmed 不表示没有产生临时字节。Result 与资源回收保持独立。`input.bind` 审计在接纳事务内记录调用主体、源 UUID、新 binding_id 和 `platform:artifact-input`；装载与回收审计由 worker 持久化。`/internal/health.artifact_reuse` 提供带来源和时间的请求／确认／复制失败／源过期／未完成回收计数，范围仅为持久记录，不声称实时存储或模型探测通过。观测不输出文件正文、密钥或异常原文。

## 外部实测门槛

生产执行继续固定 Claude SDK 和 OpenSandbox：获准配置启动后走完全相同 API／A 入口，runner 接收新 Run 当前 input_path/format，旧会话、进程、prompt、Skills、MCP 与权限不会因 Artifact 引用传入。已有 Ubuntu `159.75.158.26`／域名 `agent.91boy.cn` 与 SSH 信任预检记录，不代表部署、镜像或隔离已合格。仍待获准的 endpoint/model、服务端 secret 环境绑定及用途／计费授权后完成两次真实模型任务，再核对源期限、实际副本和回收、下载及业务内容。未擅用 Qwen 个人套餐，未读取无关密钥、远端部署或调用计费模型。

# 云端验收部署

2026-09-14 用户要求把当前版本部署到 `159.75.158.26`、`agent.91boy.cn`，并为 `yiwer/AtomicAgent` 配置 GitHub CI 自动部署。这项交付不开始 Ticket12，不自动填写人工 smoke 或真实模型验收。

## 运行边界

- 入口 `https://agent.91boy.cn`，Nginx 终止 TLS、强制 HTTPS、设置 Secure 会话 Cookie、透传 SSE，应用仅通过宿主回环 `14310` 暴露。
- 当前是明确的 **fixture** 实例，使用正常 main/API、SQLite 与持久产物。没有调用真实模型，没有启动 OpenSandbox 任务容器。应用服务本身运行于非 root Docker 容器。
- 现有云端业务保持独立。应用容器没有 Docker socket、管理员密钥或模型凭据；上限 1 CPU / 768 MiB、只读镜像、受限临时盘。此上限是 fixture 服务容量，不代表已验收的任务沙箱配额。
- 私有配置 `/etc/atomicagent/config.json`，数据 `/var/lib/atomicagent/data`，备份 `/var/lib/atomicagent/backups`。配置与数据不随提交覆盖。访问令牌在私有配置的 `identities[0].token`，不写入仓库或 CI 日志。
- 默认 `json-default@1`、`cloud-smoke` 工作区，获准真实模型、独立 Guardian、镜像隔离资格及生产容量仍待接入验收。

## CI 与发布

[工作流](../.github/workflows/deploy.yml) 在 main push、main PR 和手动触发时执行类型检查、单元测试、Linux Guardian 测试、构建与浏览器测试。只有 main 的非 PR 运行可以进入 `production` 环境发布；Actions 固定 commit，Docker Node 基础镜像固定 digest。

CI 构建以完整 Git SHA 标记的镜像，通过专用 SSH 密钥流式传输。`ATOMIC_DEPLOY_SSH_KEY` 与 `ATOMIC_DEPLOY_KNOWN_HOSTS` 存储于 GitHub production 环境，主机身份严格校验。受限账号 `atomicagent-deploy` 不属于 Docker/sudo 组，只可通过 forced command 调用根拥有的部署程序；禁止转发、PTY 及其他 SSH 命令。CI 不获取应用访问令牌。

发布串行执行，过期的 main 提交跳过。安装脚本 [cloud-deploy.py](../deploy/cloud-deploy.py) 由管理员安装到 `/usr/local/sbin/atomicagent-deploy`；CI 不能覆盖它。脚本改动须经管理员同步后再部署。

单实例发布会短暂返回 503，并要求现有工作区无排队/占用，否则安全失败，稍后重跑。先停止原容器并确认身份，再临时快照 SQLite 与产物；启动新版本后验证鉴权、页面资源、健康来源及真实 API 的 fixture Run/Result。失败时恢复原镜像和发布前数据；没有可恢复的健康版本时保持 503。成功后删除并核验临时快照不存在，回滚时用原快照恢复数据并移除候选版本的探针写入，不留独立的长期产物副本。进程崩溃或磁盘错误可能中断此事务，运维必须立即核对 maintenance 状态、原容器身份和唯一数据／快照，恢复后清理残留；不能把残留快照当作长期备份。服务意外退出后的数据库锁保持 fail closed，必须先确认原进程已停止。

再次部署：GitHub Actions → **CI and cloud deployment** → **Run workflow** → `main`。应用更新后浏览器会话需重新登录；Run 和产物独立持久化。TLS 由现有 Certbot 定时续期机制管理。

## 验收

以实际 Actions run、HTTPS 鉴权、文件任务与重启持久性记录作为工程部署证据；CI 绿色或首页 200 本身不表示真实模型或人工体验通过。人工步骤沿用 [Ticket11 smoke](../.scratch/v0/manual-smoke-after-ticket11.md)，将入口改为云端地址并使用云端令牌。

部署与验证结果在执行后补充。

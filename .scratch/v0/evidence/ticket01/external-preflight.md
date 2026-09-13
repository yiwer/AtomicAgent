# Ticket01 外部输入预检 — 2026-09-14

用户提供实验节点 `159.75.158.26`、域名 `agent.91boy.cn`，随后将 SSH 私钥选择改为本机 `id_rsa`，并确认 SSH 用户为 `ubuntu`。完整私钥路径仅在会话／本机使用，不复制私钥至项目或服务器。

已检查：

- 域名 A 记录解析为上述 IP。
- 用户指定的两个 SSH 私钥文件均存在；最终选择为 `id_rsa`。没有输出私钥内容。
- `DASHSCOPE_TOKEN_API_KEY` 存在于当前进程环境；仅检查存在性，没有输出值或进行模型调用。用户明确表示它是中国区 Qwen Token Plan 个人版。
- 严格 SSH 主机校验失败，尚未进入用户公钥认证。已有 known_hosts 的 ED25519 指纹为 `SHA256:4qdrmHCKR5tKlZO0iUChH1hOucAAmSfSdbVGriNTUW4`；当前网络对端提供的指纹为 `SHA256:LZ06cn3MZSxJteK3G5QSk59b0qtpwY0f47W6hIjx4gE`。后者只是观测值，尚未受信。

尚未更新 known_hosts、登录服务器、检查其系统／Docker、部署域名服务、上传凭据或调用计费模型。更换客户端私钥不解决服务器主机身份不一致。

继续 SSH 前，由用户通过腾讯云控制台等可信入口核对：

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

只有可信入口确认当前指纹后才更新此主机的信任记录；不能用关闭 StrictHostKeyChecking 替代确认。

模型用途的最新核对见 [Qwen 个人版 profile 复核](../../../../docs/research/06-ticket01-qwen-personal-profile-check.md)。技术接入教程与套餐使用范围是不同证据；本轮没有把个人版登记为已通过后端用途验收的 profile，也没有擅自更换套餐或模型。

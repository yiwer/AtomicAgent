# Ticket01 外部输入预检 — 2026-09-14

## 当前结论：SSH 已打通

用户通过腾讯云控制台提供 ED25519 指纹 `SHA256:LZ06cn3MZSxJteK3G5QSk59b0qtpwY0f47W6hIjx4gE`，与重新扫描的公钥指纹一致。已先备份本机 known_hosts，再仅替换此 IP 的旧条目；严格主机身份校验保持开启。

- `ubuntu + id_rsa`：已进入用户认证，但返回 `Permission denied (publickey)`。
- `ubuntu + te_cloud.pem`：认证成功，远程 `id -un` 返回 `ubuntu`。后续采用这组已验证的连接资料。
- 本机 Windows OpenSSH 的 ssh-keyscan 在 sntrup761x25519 协商处报不支持；改用已安装 Git 的 ssh-keyscan 取回公钥，再按用户确认指纹核对。没有关闭主机校验。

只读环境观测：Ubuntu 24.04.4 LTS、Linux 6.8.0-124-generic x86_64、4 个逻辑 CPU、约 3.6 GiB 内存、约 28 GiB 可用磁盘。Docker Server 29.1.3、Nginx 已安装，`sudo -n` 可用，Nginx 配置检查通过，PATH 未发现 Node。

服务器已有其他容器与服务；127.0.0.1:8080 已占用，不能直接复用 OpenSandbox 示例端口。当前未发现 `/opt/atomicagent` 或 `agent.91boy.cn` 的 Nginx 站点配置。没有停止／修改既有服务，没有安装软件、部署 AtomicAgent、上传凭据或调用模型；上述资源观测不构成容量或 Docker 隔离验收。

SSH 外部阻塞已解除；真实模型 profile 的用途与凭据适用范围仍待解决。已向用户询问后端按量 API 的环境变量引用，或个人版对此实验的额外授权。

## 首次预检记录（后续主机确认见上文）

用户提供实验节点 `159.75.158.26`、域名 `agent.91boy.cn`，随后将 SSH 私钥选择改为本机 `id_rsa`，并确认 SSH 用户为 `ubuntu`。完整私钥路径仅在会话／本机使用，不复制私钥至项目或服务器。

首次已检查：

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

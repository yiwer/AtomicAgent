# Ticket10 失败、定位与证据范围

以下按实际迭代记录，早期诊断没有全部保存独立原始日志；不把回忆的诊断描述标成已归档原始输出。最终通过以 verification.md 所列原始文件为准。

1. 本机只有 Docker 客户端，desktop-linux daemon pipe 不存在。转到已获准 Ubuntu 实验节点；节点与 SSH 信任已知，不因本地 daemon 缺失声称无实验条件。
2. Docker 默认 bwrap namespace 创建失败；逐项试验 seccomp/AppArmor 与 user namespace。部分最小 Node 探测能运行，但固定 bundled Bun CLI 在所测 user namespace 映射中 abort。最后使用外层 SYS_ADMIN/NET_ADMIN、unconfined security options，内层 setpriv UID1000/空 bounding capabilities，不使用 user namespace。此结果不叫默认 Docker PASS，也不叫 gVisor PASS。
3. 初始查找 cli.js 不适用于实际固定 SDK 的原生 bundled CLI；使用实际 linux-x64 包的 claude 二进制，实测版本 2.1.270。只测 --version 不足，随后完成两次真实 SDK/CLI SSE 对话及完整 provider 四 Run。
4. 固定 server 对 secureAccess:true 返回 400（Docker backend 不支持）；networkPolicy 配自定义网络也返回 400（要求默认 bridge）。改为平台固定 secureAccess:false + 默认 bridge，并通过认证 server proxy；必须配合所有 execd/egress 端口 loopback 才构成完整部署条件。server 在另一个 bridge 容器内访问 host loopback 端口会 readiness 超时；最终自有可信 server 使用 host network 且仅监听 127.0.0.1。
5. 固定 SDK filesystem API 将权限数字按八进制文本解释，JS 0o700 变成十进制 448 被 server 拒绝。adapter 使用 API 接受的 700/600/400。随后发现 readBytes 的 limit 是行数限制，24 字节输入被裁去换行成为 23 字节，digest 校验正确拒绝；改为 HTTP Range 有界字节读取。未删除真实文件输入或放松 digest 来绕过失败。
6. 实际 CLI 发 HEAD /api/hello；这是正常兼容探测，现 gateway 本地 204，不转发凭据，不计业务写。模型 messages 必需 POST 与业务只读明确分开，额外供应商能力和 URL 来源拒绝。
7. 早期补丁只改 port_allocator 的 loopback 常量，遗漏 networking.py 两个 sidecar 0.0.0.0 硬编码。任务已通过也没有算端口安全通过；独立真实 host inspect 抓到该漏洞。保留 [旧四 Run](provider-runs-before-port-fix.jsonl)，仅说明当时任务协议链可运行。补丁修复后先做 credential-free 单资源全端口 HostConfig/NetworkSettings 预检，再用最终 server0f5/runtimef26 录制四 Run 与 observer。
8. 双轴 source review 发现 requested 被误称 started、工具调用缺一致 ID 收尾、终态阻断整批迟到收尾、模型非 2xx 误称 completed。4574a6e 修复，增加混合快照立即查询断言。最终物理镜像与全部 32 核心 JS 比对一致后再执行四 Run。
9. 最终 observer 已捕获四组真实 running/loopback 观测，但末尾匹配 Docker stderr 的 `No such object` 大小写，实际 Docker29 返回小写，导致 harness 断言失败。第一次直接重查仍保留该错误。随后修成大小写不敏感、有界等待，直接重查原 8 个不可变 ID，全部 absent，exit0；没有重建四个 Run 或把失败 observer 冒充通过。[原 running](provider-host-observations.jsonl) 与 [修后 absence](provider-resource-absence.jsonl) 分开。
10. 最后迁移核查发现旧 runner 必须继续收到原 workspace marker。0585393 按当前资格选择路径，SDK HTTP8/8通过，但 Spec 发现“新隔离镜像在途后被撤资格”仍会误判历史协议。82350d0 改成两个固定 marker 独立尝试，任一路径失败仍尝试另一条，且不把写入当物理停止；红6/8→绿10/10、types通过，Spec复核关闭。未重新执行 Linux 四 Run，因为新 runner 镜像及真实链未改变。

## 第一方实现依据

- 固定 [Docker service](https://github.com/opensandbox-group/OpenSandbox/blob/d8cfce39dc1d846e580510ca44f44c495cbe95c4/server/opensandbox_server/services/docker/docker_service.py)、[networking](https://github.com/opensandbox-group/OpenSandbox/blob/d8cfce39dc1d846e580510ca44f44c495cbe95c4/server/opensandbox_server/services/docker/networking.py)、[port allocator](https://github.com/opensandbox-group/OpenSandbox/blob/d8cfce39dc1d846e580510ca44f44c495cbe95c4/server/opensandbox_server/services/docker/port_allocator.py) 是补丁定位依据；原版 bootstrap 只增加 SYS_ADMIN，不能据此推断 NET_ADMIN 已生效。
- [Docker seccomp 文档](https://docs.docker.com/engine/security/seccomp/) 说明 namespace 系统调用限制；最终能力以真实主机探测为准。
- 固定 [隔离 session 指南](https://github.com/opensandbox-group/OpenSandbox/blob/d8cfce39dc1d846e580510ca44f44c495cbe95c4/docs/guides/isolation-sessions.md) 区分专用 isolation API；本产品走真实 commands.run 路径，由自身 runner 包裹 CLI，没有把普通 command 误当自动隔离 session。
- 固定 [filesystem download](https://github.com/opensandbox-group/OpenSandbox/blob/d8cfce39dc1d846e580510ca44f44c495cbe95c4/components/execd/pkg/web/controller/filesystem_download.go) 的 offset/limit 与 Range 是不同语义；实际 SDK HTTP/字节实验确认后修复。
- Node/SDK 精确版本来自 lockfile、实际已安装 package 和 Linux 二进制运行结果；没有凭最新在线文档替换固定引擎。

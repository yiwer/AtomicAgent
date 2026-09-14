# Ticket10 可复现实验步骤

这些是本票已执行实验的分步重建命令；输出目录和新构建 digest 会变化，不能直接沿用历史 PASS。只在自己获准的 Linux/Docker 实验节点运行，仓库根需要 Node24.18.0、npm、Python3、OpenSSL、curl 和 Docker 权限。没有真实模型凭据。固定 bridge gateway 必须为 172.17.0.1；端口 43810、43811、43820–43920 必须空闲。若前提不符，停止，不修改宿主网络或现有服务。先完成低资源 CLI 探测，再建 provider 实验；这不是生产自动部署脚本。

## 构建与独立 CLI

```bash
set -euo pipefail
test "$(node --version)" = v24.18.0
test "$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')" = 172.17.0.1
npm ci
npm run build
docker build -f deploy/Dockerfile.runner --build-arg NODE_IMAGE=node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d -t atomicagent-runner-ticket10 .
# 为独立实验添加脚本，生产 runner 本身不包含这些恶意输入 harness。
printf '%s\n' 'FROM atomicagent-runner-ticket10' 'COPY dist/scripts /opt/atomicagent/dist/scripts' > /tmp/atomicagent-ticket10-experiment.Dockerfile
docker build -f /tmp/atomicagent-ticket10-experiment.Dockerfile -t atomicagent-experiment-ticket10 .
runtime_image=$(docker image inspect atomicagent-experiment-ticket10 --format '{{.Id}}')
mkdir -p /tmp/atomicagent-ticket10-records
for script in verify-isolation verify-path-swap; do
  docker run --rm --label atomicagent.ticket=10 --network none --memory 512m --cpus .5 --pids-limit 128 \
    --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
    --security-opt no-new-privileges=true -e ATOMIC_ISOLATION_EXPERIMENT=ticket10 "$runtime_image" \
    node "/opt/atomicagent/dist/scripts/$script.js" | tee "/tmp/atomicagent-ticket10-records/$script.jsonl"
done
```

两脚本内部资源均是自建临时目录，结束停止并等待所持 namespace。`verify-isolation` 包含实际 SDK/CLI 与自有本地协议 receiver；不是直接调用付费 endpoint。`verify-path-swap` 的次数随调度变化，不以恰好 980 为通过条件。

## 自有 provider 与合成模型

下列固定目录若已经存在就停止并核对所有权，不覆盖。实验原样配置来自 [server-experiment.toml](server-experiment.toml)，其 API key 是公开的合成测试值，绝不可用作生产密钥。

```bash
test ! -e /tmp/atomicagent-ticket10-server
test -z "$(docker ps -aq --filter name=atomicagent-ticket10-server --filter name=atomicagent-ticket10-model)"
test -z "$(docker network ls -q --filter name=atomicagent-ticket10-net)"
mkdir -m 700 /tmp/atomicagent-ticket10-server
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=172-17-0-1.sslip.io \
  -addext subjectAltName=DNS:172-17-0-1.sslip.io \
  -keyout /tmp/atomicagent-ticket10-server/model.key -out /tmp/atomicagent-ticket10-server/model.crt
chmod 600 /tmp/atomicagent-ticket10-server/model.key
cp .scratch/v0/evidence/ticket10/server-experiment.toml /tmp/atomicagent-ticket10-server/config.toml
docker pull opensandbox/execd:v1.1.0
docker pull opensandbox/egress:v1.1.7
# 必须核对 pull 后 RepoDigests 与 verification.md 的固定 digest 一致；不一致即停止。
docker image inspect opensandbox/execd:v1.1.0 opensandbox/egress:v1.1.7 --format '{{json .RepoDigests}}'
docker build -f deploy/Dockerfile.opensandbox -t atomicagent-server-ticket10 .
network_id=$(docker network create --label atomicagent.ticket=10 atomicagent-ticket10-net)
model_id=$(docker run -d --name atomicagent-ticket10-model --label atomicagent.ticket=10 \
  --network "$network_id" --memory 128m --cpus .25 -p 172.17.0.1:43811:443 \
  -v /tmp/atomicagent-ticket10-server:/cert:ro -e ATOMIC_ISOLATION_EXPERIMENT=ticket10 \
  "$runtime_image" node /opt/atomicagent/dist/scripts/controlled-model.js)
server_id=$(docker run -d --name atomicagent-ticket10-server --label atomicagent.ticket=10 \
  --network host --memory 384m --cpus .5 -v /var/run/docker.sock:/var/run/docker.sock \
  -v /tmp/atomicagent-ticket10-server/config.toml:/etc/opensandbox/config.toml:ro atomicagent-server-ticket10)
# 合成 receiver 的 DNS、证书和连接实际检查，不使用 -k。
curl --fail --cacert /tmp/atomicagent-ticket10-server/model.crt https://172-17-0-1.sslip.io:43811/counts
curl --fail -H 'OPEN-SANDBOX-API-KEY: ticket10-controlled-server-key' http://127.0.0.1:43810/v1/sandboxes
```

首次 server 启动和拉取可能需要等待；curl 未就绪时读取自己 `server_id` 的日志再重试，不能把失败当通过。Docker socket 只挂到可信 server，绝不挂到任务容器；server 必须仅监听配置的 loopback 地址。上述低资源 server 限额不改变实际 Run 的 CPU2/4GiB 配置，主机容量不足时不能并行 Run 或声称容量合格。

## 先预检，再四 Run

在同一个 shell 保留 `runtime_image` 等变量。先启动 25 秒预检，在另一个终端定点 inspect 本次新资源（ID 从 bootstrap 输出读取），核对 sandbox 非 privileged/无 Docker socket，以及 sidecar 的 HostConfig.PortBindings 和 NetworkSettings.Ports 全为 127.0.0.1。

```bash
docker run --rm --network host --memory 256m --cpus .5 -e ATOMIC_ISOLATION_EXPERIMENT=ticket10 \
  -e ATOMIC_TEST_IMAGE="$runtime_image" "$runtime_image" \
  node /opt/atomicagent/dist/scripts/verify-provider-bootstrap.js
# 另一个终端，以本次输出的 sandbox ID 为过滤值：
# docker ps --filter label=opensandbox.io/id=<本次resource_id>
# docker inspect <实际container_id> --format '{{json .HostConfig}}'
# 从上项 NetworkMode 的 container:<sidecar_id> 读取精确 sidecar，再执行：
# docker inspect <实际sidecar_id> --format '{{json .HostConfig.PortBindings}} {{json .NetworkSettings.Ports}}'
```

仅预检确认后执行：

```bash
python3 scripts/observe-provider-isolation.py "$runtime_image" > /tmp/atomicagent-ticket10-records/host.jsonl &
observer_pid=$!
docker run --rm --network host --memory 256m --cpus .5 -e ATOMIC_ISOLATION_EXPERIMENT=ticket10 \
  -e ATOMIC_TEST_IMAGE="$runtime_image" "$runtime_image" \
  node /opt/atomicagent/dist/scripts/verify-provider-isolation.js | tee /tmp/atomicagent-ticket10-records/runs.jsonl
wait "$observer_pid"
# 如果仅末尾观察窗口不足，复核原记录中的精确八 ID，禁止重建替代资源：
python3 scripts/observe-provider-isolation.py "$runtime_image" /tmp/atomicagent-ticket10-records/host.jsonl
curl --fail --cacert /tmp/atomicagent-ticket10-server/model.crt https://172-17-0-1.sslip.io:43811/counts
```

脚本 assertions 检查 A拒绝、B/C/D成功、全部清理；真实文件/C和双快照MCP/D不可省略。canary 的 A/B 检查嵌入实际 prepare，原始输出保留关联。该协议 receiver 不进行模型推理，输出中的证据层标签不可改名。

## 退出与清理

成功或失败都要保留已创建的不可变 ID并清理。脚本 finally 尝试 provider cleanup；若中断先查本次精确 Run resource，不能对整台主机作 prune。停止自有 server 前，确认没有本轮遗留 sandbox/sidecar，observer 给出对应 ID 的 absent；不要仅凭 label listing 空就推断迟到 create 不会出现。

```bash
docker rm -f "$server_id" "$model_id"
for resource_id in "$server_id" "$model_id"; do
  if docker inspect "$resource_id"; then echo 'owned resource still present'; exit 1; fi
done
docker network inspect "$network_id" --format '{{json .Containers}}' # 应为空
docker network rm "$network_id"
test "$(realpath /tmp/atomicagent-ticket10-server)" = /tmp/atomicagent-ticket10-server
rm -rf -- /tmp/atomicagent-ticket10-server
rm -f -- /tmp/atomicagent-ticket10-experiment.Dockerfile
```

保留 records、精确 image digest 与必要缓存即可；不要保存证书私钥、模型真实凭据或临时发布包。宿主既有服务必须独立确认健康。这里的命令没有改写宿主 firewall、daemon 配置或任意其他容器。

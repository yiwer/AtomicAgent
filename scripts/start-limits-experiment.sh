#!/usr/bin/env bash
set -euo pipefail
cd /tmp/atomicagent-ticket11-work
test ! -e /tmp/atomicagent-ticket11-services
test "$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')" = 172.17.0.1
python3 - <<'PY'
import socket
for port in [43810,43811,*range(43820,43921)]:
    s=socket.socket();s.bind(('0.0.0.0',port));s.close()
PY
mkdir -m 700 /tmp/atomicagent-ticket11-services
mkdir -m 700 /tmp/atomicagent-ticket11-services/guardian /tmp/atomicagent-ticket11-services/records
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=172-17-0-1.sslip.io -addext subjectAltName=DNS:172-17-0-1.sslip.io -keyout /tmp/atomicagent-ticket11-services/model.key -out /tmp/atomicagent-ticket11-services/model.crt >/dev/null 2>&1
chmod 600 /tmp/atomicagent-ticket11-services/model.key
cat > /tmp/atomicagent-ticket11-services/config.toml <<'TOML'
[server]
host = "127.0.0.1"
port = 43810
api_key = "ticket11-controlled-server-key"
max_sandbox_timeout_seconds = 3600
[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.1.0"
[proxy]
resolve_internal = true
[store]
type = "sqlite"
path = "/tmp/ticket11.db"
[docker]
network_mode = "bridge"
port_range_min = 43820
port_range_max = 43920
pids_limit = 128
no_new_privileges = true
drop_capabilities = ["AUDIT_WRITE", "MKNOD", "NET_ADMIN", "NET_RAW", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_TIME", "SYS_TTY_CONFIG"]
sandbox_env = { NODE_EXTRA_CA_CERTS = "/etc/ticket11-model.crt" }
sandbox_binds = ["/tmp/atomicagent-ticket11-services/model.crt:/etc/ticket11-model.crt:ro"]
[egress]
image = "opensandbox/egress:v1.1.7"
mode = "dns"
[storage]
allowed_host_paths = ["/tmp/atomicagent-ticket11-services"]
TOML
docker network create --label atomicagent.ticket=11 atomicagent-ticket11-net
image=$(docker image inspect atomicagent-ticket11-runtime --format '{{.Id}}')
docker run -d --name atomicagent-ticket11-guardian --label atomicagent.ticket=11 --network none --memory 128m --memory-swap 128m --cpus .25 -v /var/run/docker.sock:/var/run/docker.sock -v /tmp/atomicagent-ticket11-work/deploy/guardian.py:/guardian.py:ro -v /tmp/atomicagent-ticket11-services/guardian:/guardian sha256:fd76ade0c607f27677bc04be3c60749f400eedc941d9e72967e19a4cedff80c2 python /guardian.py --directory /guardian --id ticket11 --egress-image sha256:db7345d567b0970f384b8e3fa7a93a71b7f43d4b16bb2009de34096e9a87b3b5
docker run -d --name atomicagent-ticket11-model --label atomicagent.ticket=11 --network atomicagent-ticket11-net --memory 128m --memory-swap 128m --cpus .25 -p 172.17.0.1:43811:443 -v /tmp/atomicagent-ticket11-services:/cert:ro -e ATOMIC_ISOLATION_EXPERIMENT=ticket11 "$image" node /opt/atomicagent/dist/scripts/controlled-model.js
docker run -d --name atomicagent-ticket11-server --label atomicagent.ticket=11 --network host --memory 384m --memory-swap 384m --cpus .5 -v /var/run/docker.sock:/var/run/docker.sock -v /tmp/atomicagent-ticket11-services/config.toml:/etc/opensandbox/config.toml:ro atomicagent-ticket11-server
docker inspect atomicagent-ticket11-guardian atomicagent-ticket11-model atomicagent-ticket11-server --format '{{.Id}} {{.Name}}' > /tmp/atomicagent-ticket11-services/records/services.txt

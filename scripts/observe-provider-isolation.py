"""Read-only Docker observations, restricted to the explicitly supplied experiment image."""
import json, subprocess, sys, time
from pathlib import Path

image = sys.argv[1]
assert image.startswith('sha256:') and len(image) == 71
def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()
def inspect(resource):
    return json.loads(docker('inspect', '--format', '{{json .HostConfig}}', resource))

seen = {}
if len(sys.argv) > 2:
    for line in Path(sys.argv[2]).read_text(encoding='utf-8-sig').splitlines():
        record = json.loads(line)
        if 'running' in record:
            seen[record['running']['resource_id']] = record['running']
deadline = time.monotonic() + (0 if seen else 100)
while time.monotonic() < deadline:
    for resource in docker('ps', '-q', '--filter', 'ancestor=' + image).splitlines():
        if resource in seen:
            continue
        config = inspect(resource)
        if not config['NetworkMode'].startswith('container:'):
            continue
        sidecar = config['NetworkMode'].split(':', 1)[1]
        egress = inspect(sidecar)
        bindings = egress['PortBindings']
        print(json.dumps({'observed_ports': bindings, 'resource_id': resource, 'sidecar_id': sidecar}), flush=True)
        assert bindings and all(binding['HostIp'] == '127.0.0.1' for values in bindings.values() for binding in values)
        assert config['Privileged'] is False
        assert {'SYS_ADMIN', 'NET_ADMIN'} <= set(config['CapAdd'])
        assert not any('/var/run/docker.sock' in value for value in config.get('Binds', []))
        observation = {'resource_id': resource, 'sidecar_id': sidecar, 'observed_at_epoch': time.time(),
                       'caps': config['CapAdd'], 'security_options': config['SecurityOpt'],
                       'memory_limit': config['Memory'], 'pids_limit': config['PidsLimit'],
                       'privileged': config['Privileged'], 'ports': bindings,
                       'mounts': config.get('Binds', [])}
        observation['resource_sample'] = docker('stats', '--no-stream', '--format', '{{json .}}', resource)
        seen[resource] = observation
        print(json.dumps({'running': observation}), flush=True)
    if len(seen) >= 4 and not docker('ps', '-q', '--filter', 'ancestor=' + image, '--filter', 'label=opensandbox.io/id'):
        break
    time.sleep(.15)

for resource, observation in seen.items():
    for identity in [resource, observation['sidecar_id']]:
        for attempt in range(100):
            result = subprocess.run(['docker', 'inspect', '--format', '{{.Id}}', identity], capture_output=True, text=True)
            if result.returncode != 0 and 'no such object' in result.stderr.lower():
                break
            time.sleep(.1)
        assert result.returncode != 0 and 'no such object' in result.stderr.lower()
        print(json.dumps({'absent': identity, 'observed_at_epoch': time.time()}), flush=True)
assert len(seen) >= 4, 'expected four actual Run resources'

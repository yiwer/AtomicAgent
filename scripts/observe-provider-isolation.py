"""Read-only Docker observations, restricted to the explicitly supplied experiment image."""
import json, subprocess, sys, time

image = sys.argv[1]
assert image.startswith('sha256:') and len(image) == 71
def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()
def inspect(resource):
    return json.loads(docker('inspect', '--format', '{{json .HostConfig}}', resource))

seen = {}
deadline = time.monotonic() + 100
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
        seen[resource] = observation
        print(json.dumps({'running': observation}), flush=True)
    if len(seen) >= 4 and not docker('ps', '-q', '--filter', 'ancestor=' + image, '--filter', 'label=opensandbox.io/id'):
        break
    time.sleep(.15)

for resource, observation in seen.items():
    for identity in [resource, observation['sidecar_id']]:
        result = subprocess.run(['docker', 'inspect', '--format', '{{.Id}}', identity], capture_output=True, text=True)
        assert result.returncode != 0 and 'No such object' in result.stderr
        print(json.dumps({'absent': identity, 'observed_at_epoch': time.time()}), flush=True)
assert len(seen) >= 4, 'expected four actual Run resources'

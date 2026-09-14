#!/usr/bin/python3
"""Single-node fixture deployment. Installed root-owned, never replaced by CI."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path('/var/lib/atomicagent')
DATA = ROOT / 'data'
GATE = Path('/etc/nginx/atomicagent-maintenance')
NAME = 'atomicagent-app'


def docker(*args, capture=False):
    return subprocess.run(['docker', *args], check=True, text=True,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          timeout=600).stdout


def start(image):
    docker('run', '-d', '--name', NAME, '--restart', 'unless-stopped', '--init',
           '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
           '--security-opt', 'no-new-privileges', '--pids-limit', '256',
           '--memory', '768m', '--memory-swap', '768m', '--cpus', '1',
           '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
           '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
           '-p', '127.0.0.1:14310:4310',
           '-v', f'{DATA}:/var/lib/atomicagent',
           '-v', '/etc/atomicagent/config.json:/run/atomicagent/config.json:ro', image)


def check(*args):
    return docker('exec', NAME, 'node', 'deploy/cloud-check.mjs', *args, capture=True)


def ready():
    for _ in range(30):
        try:
            check()
            return
        except subprocess.CalledProcessError:
            time.sleep(1)
    raise RuntimeError('Application readiness failed')


def deploy(revision):
    image = f'atomicagent-app:{revision}'
    # Docker accepts gzip on stdin. No source files or shell commands are uploaded.
    subprocess.run(['docker', 'load'], stdin=sys.stdin.buffer, stdout=subprocess.DEVNULL,
                   check=True, timeout=600)
    metadata = json.loads(docker('image', 'inspect', image, capture=True))[0]
    if metadata['Config']['Labels'].get('org.opencontainers.image.revision') != revision:
        raise RuntimeError('Image revision mismatch')
    old = subprocess.run(['docker', 'inspect', NAME], capture_output=True, text=True)
    previous = json.loads(old.stdout)[0]['Image'] if old.returncode == 0 else None
    snapshot = ROOT / 'backups' / f'{time.time_ns()}-{revision}'
    GATE.touch(mode=0o644)
    stopped = False
    backed_up = False
    try:
        if previous:
            # Fail without interruption if registered work remains. Gate prevents new requests.
            check('--idle')
            docker('stop', '--time', '45', NAME)
            stopped = True
            docker('rm', NAME)
        else:
            stopped = True
        # Only after the sole managed container is definitively stopped/absent.
        (DATA / 'runs.db.lock').unlink(missing_ok=True)
        snapshot.parent.mkdir(exist_ok=True)
        subprocess.run(['cp', '-a', '--', str(DATA), str(snapshot)], check=True)
        backed_up = True
        start(image)
        ready()
        print(docker('exec', '-e', f'DEPLOYMENT_REVISION={revision}', NAME,
                     'node', 'deploy/cloud-check.mjs', '--smoke', capture=True), end='')
        (ROOT / 'revision').write_text(revision + '\n')
    except Exception:
        if stopped:
            current = subprocess.run(['docker', 'inspect', NAME], capture_output=True)
            if current.returncode == 0:
                docker('stop', '--time', '45', NAME)
                docker('rm', NAME)
            if backed_up:
                DATA.rename(snapshot.with_name(snapshot.name + '-failed'))
                subprocess.run(['cp', '-a', '--', str(snapshot), str(DATA)], check=True)
            if previous:
                start(previous)
                ready()
                print('Previous image and pre-deployment data restored.', file=sys.stderr)
            else:
                # No healthy release exists; keep public traffic gated.
                raise
        GATE.unlink(missing_ok=True)
        raise
    GATE.unlink(missing_ok=True)
    print(f'Deployed {revision}')


if __name__ == '__main__':
    if len(sys.argv) != 2 or not re.fullmatch('[a-f0-9]{40}', sys.argv[1]):
        sys.exit('Expected an exact commit SHA')
    os.umask(0o077)
    ROOT.mkdir(exist_ok=True)
    with open('/run/lock/atomicagent-deploy.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(sys.argv[1])

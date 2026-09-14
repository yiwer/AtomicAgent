#!/usr/bin/python3
"""Single-node fixture deployment. Installed root-owned, never replaced by CI."""
import fcntl
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path('/var/lib/atomicagent')
DATA = ROOT / 'data'
GATE = Path('/etc/nginx/atomicagent-maintenance')
NAME = 'atomicagent-app'
BASE = ROOT / 'dependency-base.json'


def release_bytes(stream):
    def timed_out(_signal, _frame):
        raise TimeoutError('Release receive deadline exceeded')
    previous = signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(300)
    try:
        compressed = stream.read(6 * 1024 * 1024 + 1)
        if len(compressed) > 6 * 1024 * 1024:
            raise RuntimeError('Compressed release exceeds limit')
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as archive:
            raw = archive.read(5 * 1024 * 1024 + 1)
        if len(raw) > 5 * 1024 * 1024:
            raise RuntimeError('Decompressed release exceeds 5 MiB limit')
        return raw
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def read_release(stream, directory):
    """Extract only regular app files, never archive paths/links outside this build context."""
    total = 0
    seen = set()
    # Bound the whole tar before parsing PAX/GNU metadata, not just yielded file bodies.
    with tarfile.open(fileobj=io.BytesIO(release_bytes(stream)), mode='r:') as archive:
        for member in archive:
            name = member.name.rstrip('/')
            if len(name) > 512:
                raise RuntimeError('Release member name too long')
            parts = Path(name).parts
            if not parts or any(p in ('.', '..') for p in parts) or Path(name).is_absolute():
                raise RuntimeError('Unsafe release path')
            allowed = name in ('package.json', 'package-lock.json', 'deploy/cloud-check.mjs', 'deploy/Dockerfile.app') or name.startswith(('dist/src/', 'dist/scripts/', 'web/'))
            if name in seen:
                raise RuntimeError('Duplicate release member')
            seen.add(name)
            if len(seen) > 1024:
                raise RuntimeError('Too many release members')
            if member.isdir():
                if member.size != 0 or not (allowed or name in ('dist/src', 'dist/scripts', 'web', 'deploy')):
                    raise RuntimeError('Unexpected release directory')
                continue
            if not member.isfile() or not allowed:
                raise RuntimeError('Unexpected release member')
            total += member.size
            if member.size < 0 or total > 5 * 1024 * 1024:
                raise RuntimeError('Release exceeds 5 MiB limit')
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644)
    for path in directory.rglob('*'):
        if path.is_dir():
            path.chmod(0o755)
    if not {'package.json', 'package-lock.json', 'dist/src/main.js', 'web/index.html', 'deploy/cloud-check.mjs', 'deploy/Dockerfile.app'} <= seen:
        raise RuntimeError('Incomplete release')


def package_hashes(directory):
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            for name in ('package.json', 'package-lock.json')}


def build_release(revision, stream):
    base = json.loads(BASE.read_text())
    if not re.fullmatch('sha256:[a-f0-9]{64}', base['image']):
        raise RuntimeError('Invalid dependency base')
    with tempfile.TemporaryDirectory(prefix='release-', dir=ROOT) as temporary:
        directory = Path(temporary)
        read_release(stream, directory)
        if package_hashes(directory) != base['packages'] or hashlib.sha256((directory / 'deploy/Dockerfile.app').read_bytes()).hexdigest() != base['recipe']:
            raise RuntimeError('Dependency base mismatch; a full image is required')
        # The administrator owns this recipe. CI may not upload a Dockerfile or host script.
        (directory / 'Dockerfile').write_text('''ARG BASE
FROM ${BASE}
USER root
RUN rm -rf /opt/atomicagent/dist /opt/atomicagent/web /opt/atomicagent/deploy
WORKDIR /opt/atomicagent
COPY package.json package-lock.json ./
COPY dist/src ./dist/src
COPY dist/scripts ./dist/scripts
COPY web ./web
COPY deploy/cloud-check.mjs ./deploy/cloud-check.mjs
ARG REVISION
LABEL org.opencontainers.image.revision=$REVISION
USER node
CMD ["node", "dist/src/main.js"]
''')
        docker('build', '--network=none', '--build-arg', f'BASE={base["image"]}',
               '--build-arg', f'REVISION={revision}', '-t', f'atomicagent-app:{revision}', str(directory))


def remember_dependency_base(approved_recipe=None):
    observed = inspect_container()
    if observed is None:
        raise RuntimeError('No running dependency base')
    script = "const fs=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify(Object.fromEntries(['package.json','package-lock.json'].map(n=>[n,c.createHash('sha256').update(fs.readFileSync(n)).digest('hex')]))))"
    packages = json.loads(docker('exec', NAME, 'node', '-e', script, capture=True))
    recipe = approved_recipe or json.loads(docker('image', 'inspect', observed['Image'], capture=True))[0]['Config']['Labels'].get('atomicagent.dependency-recipe')
    if not isinstance(recipe, str) or not re.fullmatch('[a-f0-9]{64}', recipe):
        raise RuntimeError('Dependency recipe provenance missing')
    temporary = BASE.with_suffix('.tmp')
    temporary.write_text(json.dumps({'image': observed['Image'], 'packages': packages, 'recipe': recipe}))
    temporary.replace(BASE)


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


def inspect_container():
    result = subprocess.run(['docker', 'inspect', NAME], capture_output=True, text=True, timeout=30)
    if result.returncode == 0:
        return json.loads(result.stdout)[0]
    if result.stderr.strip() == f'Error: No such object: {NAME}':
        return None
    raise RuntimeError('Container inspection unknown; no state mutation is safe')


def ready():
    for _ in range(30):
        try:
            check()
            return
        except subprocess.CalledProcessError:
            time.sleep(1)
    raise RuntimeError('Application readiness failed')


def deploy(revision, mode='deploy'):
    image = f'atomicagent-app:{revision}'
    if mode == 'release':
        build_release(revision, sys.stdin.buffer)
    else:
        subprocess.run(['docker', 'load'], stdin=sys.stdin.buffer, stdout=subprocess.DEVNULL,
                       check=True, timeout=1200)
    metadata = json.loads(docker('image', 'inspect', image, capture=True))[0]
    if metadata['Config']['Labels'].get('org.opencontainers.image.revision') != revision:
        raise RuntimeError('Image revision mismatch')
    old = inspect_container()
    previous = old['Image'] if old else None
    snapshot = ROOT / 'backups' / f'{time.time_ns()}-{revision}'
    previously_gated = GATE.exists()
    GATE.touch(mode=0o644)
    stopped = False
    backed_up = False
    previous_healthy = False
    try:
        if previous:
            check()
            previous_healthy = True
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
            current = inspect_container()
            if current is not None:
                docker('stop', '--time', '45', NAME)
                docker('rm', NAME)
            if backed_up:
                # Public traffic stayed gated, so candidate writes are only release probes.
                shutil.rmtree(DATA)
                snapshot.rename(DATA)
            if previous:
                start(previous)
                ready()
                print('Previous image and pre-deployment data restored.', file=sys.stderr)
            else:
                # No healthy release exists; keep public traffic gated.
                raise
        if stopped or (previous_healthy and not previously_gated):
            GATE.unlink(missing_ok=True)
        raise
    # This is a transaction snapshot, not a second indefinite artifact archive.
    shutil.rmtree(snapshot)
    if snapshot.exists():
        raise RuntimeError('Snapshot deletion unconfirmed')
    GATE.unlink(missing_ok=True)
    if mode == 'deploy':
        try:
            remember_dependency_base()
        except Exception:
            print('Release healthy; dependency cache was not updated.', file=sys.stderr)
    print(f'Deployed {revision}')


if __name__ == '__main__':
    if sys.argv[1:] == ['--base']:
        print(BASE.read_text() if BASE.exists() else '{}')
        sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] == '--remember-base' and re.fullmatch('[a-f0-9]{64}', sys.argv[2]):
        check('--idle')
        remember_dependency_base(sys.argv[2])
        sys.exit(0)
    if len(sys.argv) not in (2, 3) or not re.fullmatch('[a-f0-9]{40}', sys.argv[1]) or (len(sys.argv) == 3 and sys.argv[2] not in ('deploy', 'release')):
        sys.exit('Expected an exact commit SHA')
    os.umask(0o077)
    ROOT.mkdir(exist_ok=True)
    with open('/run/lock/atomicagent-deploy.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else 'deploy')

"""Deployment must distinguish exact absence from an unavailable Docker daemon."""
import importlib.util
import io
import json
import hashlib
from pathlib import Path
from types import SimpleNamespace
import unittest
import tarfile
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cloud_deploy', Path(__file__).parent.parent / 'deploy/cloud-deploy.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentInspection(unittest.TestCase):
    def test_only_exact_original_name_absence_allows_initial_deployment(self):
        with patch.object(deployment.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stderr='Error: No such object: atomicagent-app\n', stdout='[]')):
            self.assertIsNone(deployment.inspect_container())
        for failure in ['Cannot connect to Docker daemon', 'Error: No such object: another-service']:
            with self.subTest(failure=failure), patch.object(deployment.subprocess, 'run', return_value=SimpleNamespace(
                    returncode=1, stderr=failure, stdout='[]')):
                with self.assertRaisesRegex(RuntimeError, 'inspection unknown'):
                    deployment.inspect_container()

    def test_original_immutable_image_is_retained_for_rollback(self):
        with patch.object(deployment.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout='[{"Image":"sha256:original","State":{"Running":false}}]', stderr='')):
            observed = deployment.inspect_container()
            self.assertEqual(observed['Image'], 'sha256:original')
            self.assertFalse(observed['State']['Running'])


def bundle(extra=None):
    files = {name: b'fixture' for name in ('package.json', 'package-lock.json', 'dist/src/main.js',
             'dist/scripts/check.js', 'web/index.html', 'deploy/cloud-check.mjs', 'deploy/Dockerfile.app')}
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for name, content in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
        if extra is not None:
            archive.addfile(extra, io.BytesIO(b'x' * extra.size))
    stream.seek(0)
    return stream


class DeploymentRelease(unittest.TestCase):
    def test_regular_application_files_are_readable_by_nonroot_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            deployment.read_release(bundle(), directory)
            self.assertEqual((directory / 'dist/src/main.js').read_bytes(), b'fixture')
            self.assertEqual((directory / 'dist/src').stat().st_mode & 0o777, 0o755)

    def test_traversal_links_and_oversized_files_are_rejected(self):
        for name, kind, size in [('web/../../escape', tarfile.REGTYPE, 0),
                                 ('web/link', tarfile.SYMTYPE, 0),
                                 ('web/huge', tarfile.REGTYPE, 5 * 1024 * 1024)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                member = tarfile.TarInfo(name)
                member.type, member.size, member.linkname = kind, size, '/etc/atomicagent'
                with self.assertRaises(RuntimeError):
                    deployment.read_release(bundle(member), Path(temporary))

    def test_changed_dependencies_cannot_reuse_the_approved_base(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / 'base.json'
            base.write_text(json.dumps({'image': 'sha256:' + 'a' * 64, 'packages': {},
                                        'recipe': hashlib.sha256(b'fixture').hexdigest()}))
            with patch.object(deployment, 'ROOT', root), patch.object(deployment, 'BASE', base), patch.object(deployment, 'docker') as docker:
                with self.assertRaisesRegex(RuntimeError, 'Dependency base mismatch'):
                    deployment.build_release('a' * 40, bundle())
                docker.assert_not_called()

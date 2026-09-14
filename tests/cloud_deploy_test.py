"""Deployment must distinguish exact absence from an unavailable Docker daemon."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
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

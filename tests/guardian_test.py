"""Guardian public lifecycle + real SQLite, deterministic Docker API failure boundary."""
import datetime
import ast
import importlib.util
import json
import os
import tempfile
import unittest
import urllib.parse
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('guardian',os.path.join(os.path.dirname(__file__),'../deploy/guardian.py'))
guardian=importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)


class GuardianRecovery(unittest.TestCase):
    def test_observer_requires_explicit_absence_for_the_original_full_id(self):
        source=os.path.join(os.path.dirname(__file__),'../scripts/observe-limits-experiment.py')
        with open(source) as document:tree=ast.parse(document.read())
        function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='inspect')
        import re
        from types import SimpleNamespace
        namespace={'re':re,'json':json,'command':lambda *args,**kwargs:SimpleNamespace(returncode=1,stderr='Cannot connect to Docker daemon',stdout='')}
        exec(compile(ast.Module(body=[function],type_ignores=[]),source,'exec'),namespace)
        with self.assertRaisesRegex(RuntimeError,'inspection_unknown'):namespace['inspect']('a'*64)
        namespace['command']=lambda *args,**kwargs:SimpleNamespace(returncode=1,stderr='Error: No such object: '+'a'*64+'\n',stdout='[]')
        self.assertIsNone(namespace['inspect']('a'*64))
        with self.assertRaisesRegex(RuntimeError,'inspection_unknown'):namespace['inspect']('b'*64)

    def test_expired_empty_intent_survives_restart_and_disposes_a_late_create(self):
        image='sha256:'+'a'*64;start=guardian.time.time();resources={}
        intent={'guardian_id':'test','run_id':'11111111-1111-4111-8111-111111111111','operation_id':'22222222-2222-4222-8222-222222222222','deadline_at':datetime.datetime.fromtimestamp(start+1,datetime.timezone.utc).isoformat(),'image':image}
        def docker(method,path):
            if path=='/version':return {}
            if path.startswith('/containers/json?'):return [{'Id':identity} for identity in resources]
            identity=path.split('/')[2].split('?')[0]
            if method=='DELETE':resources.pop(identity,None);return {}
            return resources.get(identity)
        with tempfile.TemporaryDirectory() as directory,patch.object(guardian,'docker',docker):
            service=guardian.Guardian(directory,'test',image);service.register(intent)
            with patch.object(guardian.time,'time',lambda:start+2):service.scan()
            self.assertEqual(service.health()['intents_retained'],1);service.db.close()
            resources['a'*64]={'Id':'a'*64,'Image':image,'Mounts':[],'Config':{'Labels':{'atomicagent_guardian':'test','atomicagent_operation':intent['operation_id'],'atomicagent_run':intent['run_id']}}}
            restarted=guardian.Guardian(directory,'test',image)
            with patch.object(guardian.time,'time',lambda:start+3):restarted.register(intent);restarted.scan()
            self.assertEqual(resources,{});self.assertEqual(restarted.health()['intents_retained'],1)
            with patch.object(guardian.time,'time',lambda:start+100):self.assertEqual(restarted.health()['status'],'unknown')
            restarted.db.close()

    def test_failed_older_resource_cannot_starve_later_expiry_and_restart_reconciles_same_ids(self):
        image='sha256:'+'a'*64
        start=guardian.time.time()
        intents=[{'guardian_id':'test','run_id':f'11111111-1111-4111-8111-{i:012d}','operation_id':f'22222222-2222-4222-8222-{i:012d}','deadline_at':datetime.datetime.fromtimestamp(start+10,datetime.timezone.utc).isoformat(),'image':image} for i in [1,2]]
        resources={str(i)*64:{'Id':str(i)*64,'Image':image,'Mounts':[],'Config':{'Labels':{'atomicagent_guardian':'test','atomicagent_operation':intent['operation_id'],'atomicagent_run':intent['run_id']}}} for i,intent in enumerate(intents,1)}
        fail=True
        def docker(method,path):
            if path=='/version':return {}
            if path.startswith('/containers/json?'):
                filters=json.loads(urllib.parse.parse_qs(urllib.parse.urlparse(path).query)['filters'][0])
                return [{'Id':r['Id']} for r in resources.values() if all(r['Config']['Labels'].get(k)==v for k,v in (label.split('=',1) for label in filters['label']))]
            identity=path.split('/')[2].split('?')[0]
            if method=='DELETE':
                if identity=='1'*64 and fail:raise ValueError('controlled_docker_failure')
                resources.pop(identity,None);return {}
            return resources.get(identity)
        with tempfile.TemporaryDirectory() as directory,patch.object(guardian,'docker',docker):
            service=guardian.Guardian(directory,'test',image)
            for intent in intents:service.register(intent)
            with patch.object(guardian.time,'time',lambda:start+11):
                for _ in range(3):service.scan()
            self.assertIn('1'*64,resources);self.assertNotIn('2'*64,resources)
            self.assertEqual(service.health()['unknown_intents'],1)
            service.db.close()
            restarted=guardian.Guardian(directory,'test',image)
            fail=False
            with patch.object(guardian.time,'time',lambda:start+12):restarted.scan()
            self.assertEqual(resources,{})
            self.assertEqual(restarted.health()['resources_unresolved'],0)
            self.assertEqual(restarted.health()['unknown_intents'],0)
            restarted.db.close()


if __name__=='__main__':unittest.main()

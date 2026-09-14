"""Authorized owned-resource experiments. No real model, broad discovery, or global Docker changes."""
import datetime
import json
import pathlib
import re
import subprocess
import sys
import time

image,mode=sys.argv[1:3]
assert mode in ['pressure','crash'] and image.startswith('sha256:') and len(image)==71
root=pathlib.Path('/tmp/atomicagent-ticket11-services/records')
def command(*args,check=True,timeout=15):
    result=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=timeout)
    if check and result.returncode:raise RuntimeError(result.stderr[:300])
    return result
def inspect(identity):
    result=command('inspect',identity,check=False)
    if result.returncode==0:return json.loads(result.stdout)[0]
    if re.fullmatch(r'[a-f0-9]{64}',identity) and re.search(r'No such (?:object|container):\s*'+re.escape(identity)+r'\s*$',result.stderr,re.I):return None
    raise RuntimeError('inspection_unknown: '+result.stderr[:300])
def record(value):
    value['observed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(json.dumps(value),flush=True)
def wait(check,seconds=50):
    end=time.time()+seconds
    while time.time()<end:
        result=check()
        if result:return result
        time.sleep(.15)
    raise RuntimeError('bounded_observation_timeout')
name='atomicagent-ticket11-'+mode
driver=sys.argv[3] if len(sys.argv)==4 else command('run','-d','--name',name,'--label','atomicagent.ticket=11','--network','host','--memory','256m','--memory-swap','256m','--cpus','.5','-v','/tmp/atomicagent-ticket11-services/guardian:/guardian','-v',str(root)+':/records','-e','ATOMIC_LIMIT_EXPERIMENT=ticket11','-e','ATOMIC_LIMIT_MODE='+mode,'-e','ATOMIC_TEST_IMAGE='+image,image,'node','/opt/atomicagent/dist/scripts/verify-provider-limits.js').stdout.strip()
assert inspect(driver)['Config']['Labels']['atomicagent.ticket']=='11' and inspect(driver)['Image']==image
record({'driver_id':driver,'mode':mode,'image':image})
accepted_path=root/mode/('memory-accepted.json' if mode=='pressure' else 'crash-accepted.json')
def read_json(path):
    try:return json.loads(path.read_text())
    except (FileNotFoundError,json.JSONDecodeError):return None
run=wait(lambda:read_json(accepted_path))
def find():
    found=command('ps','-aq','--filter','label=atomicagent_run='+run['run_id'],'--filter','label=opensandbox.io/id').stdout.strip().splitlines()
    return inspect(found[0]) if found else None
container=wait(find)
identity=container['Id'];sidecar_id=container['HostConfig']['NetworkMode'].removeprefix('container:');sidecar=inspect(sidecar_id)
assert not container['HostConfig']['Privileged']
assert all(m.get('Source')!='/var/run/docker.sock' for m in container['Mounts'])
for ports in [sidecar['HostConfig']['PortBindings'],sidecar['NetworkSettings']['Ports']]:
    assert all(binding['HostIp']=='127.0.0.1' for values in ports.values() if values for binding in values)
record({'run_id':run['run_id'],'resource_id':identity,'sidecar_id':sidecar_id,'deadline_at':run['execution']['deadline_at'],'cpu_nano':container['HostConfig']['NanoCpus'],'memory_bytes':container['HostConfig']['Memory'],'memory_swap_bytes':container['HostConfig']['MemorySwap'],'ports':sidecar['NetworkSettings']['Ports']})
def started():
    result=command('exec',identity,'cat','/run/atomicagent/boundary.json',check=False)
    if result.returncode:return False
    return any(c['boundary']=='model' and c['outcome']=='started' for c in json.loads(result.stdout)['calls'])
wait(started,20)
if mode=='pressure':
    sdk="import {Sandbox} from '@alibaba-group/opensandbox'; const s=await Sandbox.connect({sandboxId:"+json.dumps(container['Config']['Labels']['opensandbox.io/id'])+",connectionConfig:{domain:'http://127.0.0.1:43810',apiKey:'ticket11-controlled-server-key',useServerProxy:true,disableMetrics:true}});try{const r=await s.commands.run('cat /sys/fs/cgroup/memory.events',{uid:0,gid:0,timeoutSeconds:2});console.log(JSON.stringify({segments:r.logs.stdout.map(x=>x.text),exit:r.exitCode,error:!!r.error}));}finally{await s.close();}"
    sample=command('exec',driver,'node','--input-type=module','-e',sdk)
    record({'sdk_memory_sample':json.loads(sample.stdout)})
    before=command('exec',identity,'cat','/sys/fs/cgroup/cpu.stat').stdout
    stress=command('exec','-e','ATOMIC_LIMIT_EXPERIMENT=ticket11',identity,'node','/opt/atomicagent/dist/scripts/pressure-workload.js','cpu')
    after=command('exec',identity,'cat','/sys/fs/cgroup/cpu.stat').stdout
    stats=lambda text:dict(line.split() for line in text.strip().splitlines())
    assert int(stats(after)['nr_throttled'])>int(stats(before)['nr_throttled'])
    record({'cpu_before':stats(before),'cpu_after':stats(after),'work':stress.stdout.strip(),'behavior':'throttled'})
    quota=command('exec','-e','ATOMIC_LIMIT_EXPERIMENT=ticket11',identity,'node','/opt/atomicagent/dist/scripts/pressure-workload.js','workspace')
    record({'workspace_pressure':json.loads(quota.stdout)})
    memory_before=command('exec',identity,'cat','/sys/fs/cgroup/memory.events').stdout
    memory=command('exec','-e','ATOMIC_LIMIT_EXPERIMENT=ticket11',identity,'node','/opt/atomicagent/dist/scripts/pressure-workload.js','memory',check=False,timeout=20)
    record({'memory_before':stats(memory_before),'pressure_process_exit':memory.returncode,'pressure_process_exit_is_not_oom_proof':True})
    final_path=root/mode/'memory-result.json';final=wait(lambda:read_json(final_path),30)
    assert final['failure']=='budget_exceeded' and final['limit_termination']['dimension']=='memory_mib'
    assert all(final['resource_limits']['memory_events'][k]>int(stats(memory_before)[k]) for k in ['max','oom','oom_kill'])
    record({'terminal':final['status'],'failure':final['failure'],'dimension':final['limit_termination']['dimension'],'resource_evidence':final['resource_limits'],'stop':final['stop'],'cleanup':final['cleanup']})
else:
    services={name.removeprefix('/'):identity for identity,name in (line.split() for line in (root/'services.txt').read_text().splitlines())}
    server=services['atomicagent-ticket11-server'];guardian=services['atomicagent-ticket11-guardian']
    for owned in [server,guardian]:assert inspect(owned)['Config']['Labels']['atomicagent.ticket']=='11'
    command('kill','--signal','KILL',driver);command('kill','--signal','KILL',server)
    assert not inspect(driver)['State']['Running'] and not inspect(server)['State']['Running']
    record({'api_worker_killed':driver,'provider_killed':server,'independent_guardian_id':guardian,'independent_guardian_running':inspect(guardian)['State']['Running']})
wait(lambda:inspect(identity) is None and inspect(sidecar_id) is None,40)
record({'verified_absent':[identity,sidecar_id],'model_inference':'not-tested','gvisor':'not-tested'})
logs=command('logs',driver,check=False);(root/(mode+'-driver.log')).write_text(logs.stdout+logs.stderr)

"""Exact owned-resource cleanup. No daemon, firewall, baseline service or broad-prune mutations."""
import datetime
import json
import pathlib
import re
import shutil
import subprocess

def command(*args,check=True):
    result=subprocess.run(args,capture_output=True,text=True,timeout=30)
    if check and result.returncode:raise RuntimeError(result.stderr[:500])
    return result
def inspect(identity):
    result=command('docker','inspect',identity,check=False)
    if result.returncode==0:return json.loads(result.stdout)[0]
    if re.fullmatch('[a-f0-9]{64}',identity) and re.search(r'No such (?:object|container):\s*'+identity+r'\s*$',result.stderr,re.I):return None
    raise RuntimeError('inspection_unknown')
runtime='sha256:ce8d0083a606a9a45b8667e60ccd442681056be1e6c6c0993249d66aa022aac4'
hashes=command('docker','run','--rm','--label','atomicagent.ticket=11','--network','none','--memory','128m','--memory-swap','128m','--cpus','.25',runtime,'sh','-c','sha256sum /opt/atomicagent/dist/src/*.js').stdout
print(json.dumps({'source':'final-image-files','sha256sum':hashes}),flush=True)
owned=['53046152262c48fbfe6b00a60bef7655110668868c8a53250971baaed553c4d8','57171d3685ee8505ea329aafae28c40350c2b76e62aae8f4c72c30d6d1c6cf45','e050c6b1eafb4985b4d49027019e9340846040e48830475da525754606228a1e','e081959ae6be3283d477330bb2904923cfbb85bf81b7186e26f32ccfcf0a6de5','d64624271a8ca6abac81b917fc1d0c4b6dbf9a3f60d815f75242fc9cc4da8378','21709292b4d780d411d38afcfa05ed0dcd185b6055e673bdd30510b3197927d3','dea32264f90ec3e721d0ce715954025ac6a3c5d1ff605d1c6669141d463f3bda']
builders=['120731667d3bf3621f066786a8accbb0ae810e76721dac2bd35c1d4e292b1757','c3c07cf709f9790813be84ec2d8ec0e9ed1515d0365786f916e2587105daf4cb']
for identity in owned+builders:
    value=inspect(identity)
    if value is None:continue
    if identity in owned:assert value['Config']['Labels']['atomicagent.ticket']=='11'
    else:assert not value['State']['Running'] and value['Path']=='/bin/sh'
    print(json.dumps({'removing_original_id':identity,'name':value['Name'],'image':value['Image'],'status':value['State']['Status'],'exit':value['State']['ExitCode']}),flush=True)
    command('docker','rm','-f',identity)
    assert inspect(identity) is None
network='015d905cfbae16ac1b5c7a113e3168ee4826531e2a2e6d75ebaa661f338e0cf1'
value=json.loads(command('docker','network','inspect',network).stdout)[0]
assert value['Labels']['atomicagent.ticket']=='11' and not value['Containers']
command('docker','network','rm',network)
result=command('docker','network','inspect',network,check=False)
assert result.returncode!=0 and re.search('network '+network+' not found',result.stderr,re.I)
assert not command('docker','ps','-aq','--filter','label=atomicagent.ticket=11').stdout.strip()
assert not command('docker','volume','ls','-q','--filter','name=opensandbox-runtime-').stdout.strip()
for target in ['/tmp/atomicagent-ticket11-work','/tmp/atomicagent-ticket11-services']:
    path=pathlib.Path(target);assert str(path.resolve())==target and not path.is_symlink()
    shutil.rmtree(path)
    assert not path.exists()
for target in ['/tmp/atomicagent-ticket11-build.tgz','/tmp/atomicagent-ticket11-update.tgz','/tmp/atomicagent-ticket11-records.tgz']:
    path=pathlib.Path(target);assert str(path.resolve())==target and not path.is_symlink()
    path.unlink(missing_ok=True)
baseline=[]
for identity in command('docker','ps','-aq').stdout.splitlines():
    value=inspect(identity);assert value['Name'].startswith('/relaticle-') and value['State']['Running'] and value['State']['Health']['Status']=='healthy'
    baseline.append({'id':value['Id'],'name':value['Name'],'status':'healthy'})
assert len(baseline)==5
ports=command('ss','-H','-ltn').stdout.splitlines()
assert not any(re.search(r':(?:43810|43811|438[2-9][0-9]|439[01][0-9]|43920)\s',line) for line in ports)
print(json.dumps({'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'owned_containers_absent':owned+builders,'network_absent':network,'runtime_volumes_absent':True,'temporary_directories_and_synthetic_certificate_removed':True,'experiment_ports_clear':True,'baseline':baseline,'memory':command('free','-m').stdout,'disk':command('df','-h','/').stdout,'retained_images':command('docker','image','ls','--no-trunc').stdout}),flush=True)

"""Read-only exact-resource evidence projection for the authorized ticket11 experiment."""
import datetime
import hashlib
import http.client
import json
import pathlib
import re
import sqlite3
import socket
import subprocess

root=pathlib.Path('/tmp/atomicagent-ticket11-services')
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def docker(*args):return subprocess.run(['docker',*args],capture_output=True,text=True,timeout=10)
def inspect(identity):
    result=docker('inspect',identity)
    if result.returncode==0:return json.loads(result.stdout)[0]
    if re.fullmatch('[a-f0-9]{64}',identity) and re.search(r'No such (?:object|container):\s*'+identity+r'\s*$',result.stderr,re.I):return None
    raise RuntimeError('inspection_unknown')
def database(path):
    db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    return db
with database(root/'guardian/guardian.db') as db:
    guardian={table:[dict(row) for row in db.execute('SELECT * FROM '+table)] for table in ['intents','resources','volumes','observations']}
identities={row['id'] for row in guardian['resources']}
absence=[]
for identity in sorted(identities):
    value=inspect(identity)
    absence.append({'resource_id':identity,'source':'independent-host:docker-inspect-full-id','observed_at':stamp(),'status':'absent' if value is None else 'present'})
runs=[]
for path in sorted((root/'records').glob('*/runs.db')):
    with database(path) as db:
        for row in db.execute('SELECT document FROM runs'):
            run=json.loads(row[0]);run_id=run['run_id']
            counts={row[0]:row[1] for row in db.execute('SELECT action,count(*) FROM audit WHERE run_id=? GROUP BY action',(run_id,))}
            submissions=[dict(row) for row in db.execute("SELECT action,outcome,count(*) AS count FROM audit WHERE run_id=? AND action='run.accept' GROUP BY action,outcome",(run_id,))]
            runs.append({'directory':path.parent.name,'run_id':run_id,'attempt_id':run['attempt_id'],'status':run['status'],'failure':run['failure'],'deadline_at':run['manifest']['deadline_at'],'accepted_at':run['accepted_at'],'terminal_at':run.get('terminal_at'),'allocation':run['allocation'],'audit_counts':counts,'submission_outcomes':submissions})
services=[]
for line in (root/'records/services.txt').read_text().splitlines():
    identity,name=line.split();value=inspect(identity)
    assert value is not None and value['Config']['Labels']['atomicagent.ticket']=='11'
    services.append({'id':identity,'name':name,'image':value['Image'],'state':value['State']['Status'],'exit':value['State']['ExitCode'],'memory':value['HostConfig']['Memory'],'cpu_nano':value['HostConfig']['NanoCpus']})
volumes=[]
for value in guardian['volumes']:
    result=docker('volume','inspect',value['name'])
    absent=result.returncode!=0 and re.search(r'get '+re.escape(value['name'])+r':\s*no such volume\s*$',result.stderr,re.I)
    if result.returncode!=0 and not absent:raise RuntimeError('volume_inspection_unknown')
    volumes.append({'name':value['name'],'status':'absent' if absent else 'present','observed_at':stamp()})
class UnixHttp(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(3);self.sock.connect(str(root/'guardian/guardian.sock'))
connection=UnixHttp('localhost',timeout=3)
try:
    connection.request('GET','/health');response=connection.getresponse();assert response.status==200
    health=json.loads(response.read(8192))
finally:connection.close()
result={'observed_at':stamp(),'guardian_health':health,'guardian':guardian,'resources':absence,'volumes':volumes,'runs':runs,'services':services}
(root/'records/resource-ledger.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'observed_at':result['observed_at'],'recorded_resources':len(absence),'resources_absent':sum(r['status']=='absent' for r in absence),'volumes':len(volumes),'volumes_absent':sum(r['status']=='absent' for r in volumes),'runs':len(runs),'crash_run':[r for r in runs if r['directory']=='crash']}))

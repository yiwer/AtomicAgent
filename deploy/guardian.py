"""Independent, local-only expiry guardian. Requires its own durable directory and Docker socket.

It accepts immutable create intents before provider dispatch, watches only the registered
operation + Run + guardian labels and exact approved images, and retains intents so a
late create remains discoverable even after a prior empty Docker listing.
"""
import argparse
import fcntl
import datetime
import http.client
import http.server
import json
import os
import re
import socket
import socketserver
import sqlite3
import threading
import time
import urllib.parse


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class Docker(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(3)
        self.sock.connect('/var/run/docker.sock')


def docker(method, path):
    conn = Docker('localhost', timeout=3)
    try:
        conn.request(method, path)
        response = conn.getresponse()
        raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError('bounded_docker_response')
        if response.status == 404:
            return None
        if response.status >= 300:
            raise ValueError('docker_unavailable')
        return json.loads(raw) if raw else {}
    finally:
        conn.close()


class Guardian:
    def __init__(self, directory, identity, egress_image):
        self.identity, self.egress_image = identity, egress_image
        self.lock = threading.RLock()
        self.db = sqlite3.connect(os.path.join(directory, 'guardian.db'), check_same_thread=False)
        self.db.executescript('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS intents(operation TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, operation TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, observed_at TEXT NOT NULL);')
        self.db.execute('CREATE TABLE IF NOT EXISTS volumes(name TEXT PRIMARY KEY, operation TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL)')
        self.observed_at = None
        self.available = False

    def register(self, value):
        if set(value) != {'guardian_id','run_id','operation_id','deadline_at','image'} or value['guardian_id'] != self.identity:
            raise ValueError('invalid_intent')
        for field in ('operation_id','run_id'):
            if not re.fullmatch(r'[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}', value[field]):
                raise ValueError('invalid_identity')
        if not re.fullmatch(r'(?:.+@)?sha256:[a-f0-9]{64}', value['image']):
            raise ValueError('invalid_image')
        deadline = datetime.datetime.fromisoformat(value['deadline_at'].replace('Z','+00:00')).timestamp()
        document = json.dumps(value, sort_keys=True)
        with self.lock:
            old = self.db.execute('SELECT document FROM intents WHERE operation=?',(value['operation_id'],)).fetchone()
            if old:
                if old[0] != document:
                    raise ValueError('immutable_intent_conflict')
            else:
                if not time.time() < deadline <= time.time() + 3601:
                    raise ValueError('invalid_deadline')
                self.db.execute('INSERT INTO intents VALUES(?,?)',(value['operation_id'],document))
                self.db.commit()
        # Admission requires a fresh successful Docker inspection, not merely an HTTP server.
        docker('GET','/version')

    def scan(self):
        with self.lock:
            intents = [json.loads(row[0]) for row in self.db.execute('SELECT document FROM intents')]
        for intent in intents:
            labels = [f'atomicagent_guardian={self.identity}',f'atomicagent_operation={intent["operation_id"]}',f'atomicagent_run={intent["run_id"]}']
            filters = urllib.parse.quote(json.dumps({'label':labels}))
            resources = docker('GET','/containers/json?all=1&filters='+filters)
            if resources is None:
                raise ValueError('docker_unavailable')
            for item in resources:
                resource = docker('GET','/containers/'+item['Id']+'/json')
                if resource is None:
                    continue
                expected = resource['Config'].get('Labels') or {}
                if any(expected.get(key) != intent[field] for key,field in [('atomicagent_guardian','guardian_id'),('atomicagent_operation','operation_id'),('atomicagent_run','run_id')]):
                    raise ValueError('resource_identity_changed')
                sidecar = 'opensandbox.io/egress-sidecar-for' in expected
                image = self.egress_image if sidecar else intent['image'].split('@')[-1]
                if resource['Image'] != image:
                    raise ValueError('resource_image_changed')
                with self.lock:
                    self.db.execute('INSERT OR IGNORE INTO resources VALUES(?,?,?,?,?)',(resource['Id'],intent['operation_id'],'sidecar' if sidecar else 'sandbox','present',stamp()))
                    sandbox_id = expected.get('opensandbox.io/id') or expected.get('opensandbox.io/egress-sidecar-for')
                    for mount in resource.get('Mounts',[]):
                        if mount.get('Type') == 'volume' and mount.get('Name') == 'opensandbox-runtime-'+str(sandbox_id):
                            volume = docker('GET','/volumes/'+mount['Name'])
                            if volume is not None:
                                self.db.execute('INSERT OR IGNORE INTO volumes VALUES(?,?,?,?)',(mount['Name'],intent['operation_id'],json.dumps(volume,sort_keys=True),'present'))
                    self.db.commit()
            if time.time() < datetime.datetime.fromisoformat(intent['deadline_at'].replace('Z','+00:00')).timestamp():
                continue
            with self.lock:
                owned = list(self.db.execute('SELECT id,kind FROM resources WHERE operation=? ORDER BY kind DESC',(intent['operation_id'],)))
            for identity,kind in owned:
                # Persisted full Docker ID cannot target a replacement, even if names/labels are reused.
                observed = docker('GET','/containers/'+identity+'/json')
                if observed is not None:
                    docker('DELETE','/containers/'+identity+'?force=1&v=1')
                    observed = docker('GET','/containers/'+identity+'/json')
                status = 'absent' if observed is None else 'unknown'
                with self.lock:
                    self.db.execute('UPDATE resources SET status=?,observed_at=? WHERE id=?',(status,stamp(),identity))
                    self.db.commit()
            with self.lock:
                volumes = list(self.db.execute("SELECT name,fingerprint FROM volumes WHERE operation=? AND status!='absent'",(intent['operation_id'],)))
            for name,fingerprint in volumes:
                volume = docker('GET','/volumes/'+name)
                if volume is not None:
                    if json.dumps(volume,sort_keys=True) != fingerprint:
                        raise ValueError('volume_identity_changed')
                    docker('DELETE','/volumes/'+name)
                    volume = docker('GET','/volumes/'+name)
                with self.lock:
                    self.db.execute('UPDATE volumes SET status=? WHERE name=?',('absent' if volume is None else 'unknown',name))
                    self.db.commit()
        self.observed_at, self.available = stamp(), True

    def health(self):
        with self.lock:
            return {'source':'independent-guardian:docker-inspection','observed_at':self.observed_at,'queried_at':stamp(),'status':'available' if self.available else 'unknown','coverage':'registered-immutable-create-intents-only','intents_retained':self.db.execute('SELECT count(*) FROM intents').fetchone()[0],'resources_unresolved':self.db.execute("SELECT count(*) FROM resources WHERE status!='absent'").fetchone()[0]}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--directory',required=True)
    parser.add_argument('--id',required=True)
    parser.add_argument('--egress-image',required=True)
    args=parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',args.id) or not re.fullmatch(r'sha256:[a-f0-9]{64}',args.egress_image):
        raise ValueError('invalid_private_configuration')
    os.makedirs(args.directory,mode=0o700,exist_ok=True)
    os.chmod(args.directory,0o700)
    lock=open(os.path.join(args.directory,'guardian.lock'),'a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    guardian=Guardian(args.directory,args.id,args.egress_image)
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):
            pass
        def do_GET(self):
            self.reply(200,guardian.health()) if self.path=='/health' else self.reply(404,{'error':'not_found'})
        def do_POST(self):
            try:
                size=int(self.headers.get('Content-Length','0'))
                if self.path!='/register' or not 0<size<=4096:
                    raise ValueError('invalid_request')
                guardian.register(json.loads(self.rfile.read(size)))
                self.reply(200,{'registered':True})
            except Exception:
                self.reply(503,{'error':'guardian_registration_unavailable'})
        def reply(self,status,value):
            body=json.dumps(value).encode()
            self.send_response(status);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
        daemon_threads=True
    path=os.path.join(args.directory,'guardian.sock')
    # Exclusive lifetime flock proves any previous socket belongs to a terminated guardian.
    if os.path.exists(path):
        os.unlink(path)
    server=Server(path,Handler)
    os.chmod(path,0o600)
    def inspect():
        while True:
            try:
                guardian.scan()
            except Exception:
                guardian.available=False
            time.sleep(0.25)
    threading.Thread(target=inspect,daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close();os.unlink(path)


if __name__=='__main__':
    main()

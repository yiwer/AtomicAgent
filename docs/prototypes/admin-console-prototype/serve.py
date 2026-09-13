"""THROWAWAY UI server. Localhost only; no backend, credentials or persistence."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from functools import partial
import os

if os.environ.get('NODE_ENV') == 'production':
    raise SystemExit('This throwaway prototype is not a production application.')

root = Path(__file__).resolve().parent
server = ThreadingHTTPServer(('127.0.0.1', 8765), partial(SimpleHTTPRequestHandler, directory=str(root)))
print('AtomicAgent prototype: http://127.0.0.1:8765/?variant=A', flush=True)
print('Mock state only. Refresh to reset. Ctrl+C to stop.', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()

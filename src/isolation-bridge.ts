// Runs inside the private network namespace. The only reachable upstream is the bound model socket.
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
const server = createServer((incoming, outgoing) => {
 const upstream = request({ socketPath: '/run/atomic-model.sock', path: incoming.url, method: incoming.method,
  headers: { 'content-type': 'application/json', ...(incoming.headers['content-length'] ? { 'content-length': incoming.headers['content-length'] } : {}),
   ...(incoming.headers['anthropic-beta'] ? { 'anthropic-beta': incoming.headers['anthropic-beta'] } : {}) } }, response => {
   outgoing.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/json' }); response.pipe(outgoing);
  });
 upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
 incoming.pipe(upstream); outgoing.on('close', () => upstream.destroy());
});
server.on('connect', (_req, socket) => socket.destroy());
server.listen(3999, '127.0.0.1', () => {
 const child = spawn(process.argv[2]!, process.argv.slice(3), { env: process.env, stdio: 'inherit' });
 child.on('error', () => process.exit(1)); child.on('exit', code => { server.closeAllConnections(); server.close(() => process.exit(code ?? 1)); });
});

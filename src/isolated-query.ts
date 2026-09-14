import { spawn, type ChildProcess } from 'node:child_process';
import { query, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { chmod } from 'node:fs/promises';
import { ModelGateway, type BoundaryCall } from './model-gateway.js';
import { TaskError } from './domain.js';
import type { ClaudeRequest, QueryPort } from './claude-execution.js';

export function namespaceArgs(root: string, socket: string) {
 const parents: string[] = []; let path = '';
 for (const component of root.split('/').slice(1,-1)) { path += '/'+component; if(path !== '/tmp') parents.push('--perms','0755','--dir',path); }
 return ['--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
  '--perms', '0755', '--dir', '/opt', '--ro-bind', '/opt/atomicagent', '/opt/atomicagent', '--proc', '/proc', '--ro-bind', '/etc', '/etc', '--dev', '/dev', '--perms', '1777', '--tmpfs', '/tmp', '--dir', '/run',
  '--ro-bind', socket, '/run/atomic-model.sock', ...parents, '--bind', root, root, '--chdir', root, '--',
  '/usr/bin/setpriv', '--reuid', '1000', '--regid', '1000', '--clear-groups', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all'];
}
// No opt-out exists in the production runner: inability to create these namespaces fails before the CLI starts.
export async function isolatedQuery(request: ClaudeRequest, root: string, controlRoot: string, observe: (event: BoundaryCall) => Promise<void>) {
 if (process.platform !== 'linux') throw new TaskError('isolation_unavailable');
 const socket = join(controlRoot, 'model.sock');
 const gateway = new ModelGateway({ endpoint: request.endpoint, model: request.model, token: process.env.ANTHROPIC_API_KEY ?? '', deadline: Date.parse(request.deadline_at),
  tools: [...(request.output_contract==='data-statistics@1'?['Bash']:[]),...(request.skills?.length?['Skill']:[]),...(request.mcp?.length?['mcp__research__read_source']:[])] }, observe);
 await gateway.listen(socket);
 // The enclosing control directory stays root-only; the child receives only this capability socket bind.
 await chmod(socket, 0o666);
 try {
  await new Promise<void>((resolve, reject) => {
   const probe = spawn('/usr/bin/bwrap', [...namespaceArgs(root, socket), '/usr/local/bin/node', '-e', 'process.exit(0)'], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['ignore','ignore','pipe'] });
   let diagnostic = ''; probe.stderr.on('data', chunk => { if (diagnostic.length < 2000) diagnostic += String(chunk).slice(0,2000-diagnostic.length); });
   const timer = setTimeout(() => { probe.kill('SIGKILL'); }, 5000);
   probe.once('error', () => { clearTimeout(timer); reject(new TaskError('isolation_unavailable')); });
   probe.once('close', code => { clearTimeout(timer); const error = new TaskError('isolation_unavailable'); error.cause = diagnostic; code === 0 ? resolve() : reject(error); });
  });
 } catch (error) { await gateway.close(); throw error; }
 let child: ChildProcess | undefined, started = false, diagnostic = '';
 const stop = async () => {
  await gateway.close();
  if (child && child.exitCode === null && child.signalCode === null) {
   const stopped = new Promise<void>(resolve => child!.once('close', () => resolve())); child.kill('SIGKILL'); await stopped;
  }
 };
 const runQuery: QueryPort = async function* (input) {
  const aborted = () => { void stop().catch(() => {}); };
  input.options?.abortController?.signal.addEventListener('abort',aborted,{once:true});
  try {
   if(input.options?.abortController?.signal.aborted) throw new TaskError('execution_lost');
   const stream = query({ ...input, options: { ...input.options,
    env: { ...input.options?.env, ANTHROPIC_API_KEY: 'atomic-task-scoped-proxy', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3999' },
    spawnClaudeCodeProcess: options => {
     if (started) throw new TaskError('execution_lost'); started = true;
     child = spawn('/usr/bin/bwrap', [...namespaceArgs(root, socket), '/usr/local/bin/node', '/opt/atomicagent/dist/src/isolation-bridge.js', options.command, ...options.args],
      { cwd: root, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
     child.stderr!.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-2000); });
     return child as SpawnedProcess;
    },
   } });
   for await (const message of stream) {
    // Stop every descendant before parent validators read task files. This removes the mutable-directory race.
    if (message.type === 'result') { await stop(); yield message; return; }
    yield message;
   }
  } finally { await stop(); input.options?.abortController?.signal.removeEventListener('abort',aborted); }
 };
 return { query: runQuery, close: stop, diagnostic: () => ({ exit:child?.exitCode, signal:child?.signalCode, text:diagnostic }) };
}

// Runs only inside the pinned Linux image, never in the API process or developer workspace.
import { readFile, writeFile, open } from 'node:fs/promises';
import { runClaude, type ClaudeRequest } from './claude-execution.js';
async function main() {
 const request = JSON.parse(await readFile('/workspace/request.json', 'utf8')) as ClaudeRequest;
 const marker = await open('/workspace/attempt.started', 'wx', 0o600);
 await marker.writeFile(request.attempt_id); await marker.sync(); await marker.close();
 if (process.versions.node !== '24.18.0') return { failure: 'runtime_failed' };
 return runClaude(request, '/workspace');
}
try { await writeFile('/workspace/result.json', JSON.stringify(await main()), { flag: 'wx', mode: 0o600 }); }
catch { process.exitCode = 1; }

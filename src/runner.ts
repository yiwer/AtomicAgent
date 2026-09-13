// Runs only inside the pinned Linux image, never in the API process or the developer workspace.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile, writeFile, open } from 'node:fs/promises';
import { outputSchema } from './domain.js';

async function main() {
  const request = JSON.parse(await readFile('/workspace/request.json', 'utf8')) as {
    prompt: string; model: string; endpoint: string; deadline_at: string; attempt_id: string;
  };
  // Atomic execution marker survives a command-response loss. Never resume or restart a business execution.
  const marker = await open('/workspace/attempt.started', 'wx', 0o600);
  await marker.writeFile(request.attempt_id); await marker.sync(); await marker.close();
  const controller = new AbortController();
  const remaining = Date.parse(request.deadline_at) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return { failure: 'deadline_exceeded' };
  if (process.versions.node !== '24.18.0') return { failure: 'runtime_failed' };
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const messages = query({ prompt: request.prompt, options: {
      model: request.model, cwd: '/workspace', tools: [], mcpServers: {}, settingSources: [],
      permissionMode: 'dontAsk', canUseTool: async () => ({ behavior: 'deny', message: 'authorization_required' }),
      maxTurns: 1, persistSession: false, abortController: controller,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/workspace',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: request.endpoint,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        ANTHROPIC_MAX_RETRIES: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' },
      stderr: () => {},
      // Platform validates a single candidate. SDK outputFormat is deliberately unused: it may re-prompt to repair output.
      systemPrompt: `Return exactly one JSON value matching ${JSON.stringify(outputSchema)}. No markdown. If required input is missing, return {"error":"input_required"}. If authorization is missing, return {"error":"authorization_required"}. Do not ask questions or use tools.`,
    } });
    for await (const message of messages) {
      if (message.type !== 'result') continue;
      if (message.permission_denials.length) return { failure: 'authorization_required' };
      if (message.subtype !== 'success' || message.is_error) return { failure: 'runtime_failed' };
      if (Buffer.byteLength(message.result) > 12_000) return { failure: 'output_invalid' };
      let candidate: unknown;
      try { candidate = JSON.parse(message.result); } catch { return { failure: 'output_invalid' }; }
      const error = candidate && typeof candidate === 'object' && 'error' in candidate ? candidate.error : null;
      if (error === 'input_required' || error === 'authorization_required') return { failure: error };
      return { candidate };
    }
    return { failure: 'runtime_failed' };
  } catch { return { failure: controller.signal.aborted ? 'deadline_exceeded' : 'runtime_failed' }; }
  finally { clearTimeout(timer); }
}
try {
  const result = await main();
  await writeFile('/workspace/result.json', JSON.stringify(result), { flag: 'wx', mode: 0o600 });
} catch { process.exitCode = 1; } // No SDK errors, conversation, credentials or signed URLs go to stdout/stderr.

// Runs only inside the pinned Linux image, never in the API process or the developer workspace.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile, writeFile, open } from 'node:fs/promises';
import { outputSchema } from './domain.js';
import { fileSchema } from './file-contract.js';
import { collectFiles } from './sandbox-files.js';

async function main() {
  const request = JSON.parse(await readFile('/workspace/request.json', 'utf8')) as {
    prompt: string; model: string; endpoint: string; deadline_at: string; attempt_id: string; output_contract?: string; input_path?: string;
  };
  // Atomic execution marker survives a command-response loss. Never resume or restart a business execution.
  const marker = await open('/workspace/attempt.started', 'wx', 0o600);
  await marker.writeFile(request.attempt_id); await marker.sync(); await marker.close();
  const controller = new AbortController();
  const remaining = Date.parse(request.deadline_at) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return { failure: 'deadline_exceeded' };
  if (process.versions.node !== '24.18.0') return { failure: 'runtime_failed' };
  const fileTask = request.output_contract === 'data-statistics@1';
  const command = 'node /opt/atomicagent/dist/src/process-data.js';
  const permitted = (name: string, input: Record<string, unknown>) => fileTask && name === 'Bash' && input.command === command && !input.run_in_background && Object.keys(input).every(k => ['command', 'description', 'timeout', 'run_in_background'].includes(k));
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const messages = query({ prompt: request.prompt, options: {
      model: request.model, cwd: '/workspace', tools: fileTask ? ['Bash'] : [], mcpServers: {}, settingSources: [],
      permissionMode: fileTask ? 'default' : 'dontAsk',
      canUseTool: async (name, input) => permitted(name, input) ? { behavior: 'allow', updatedInput: { command, timeout: Math.min(remaining, 120_000) } } : { behavior: 'deny', message: 'authorization_required' },
      hooks: { PreToolUse: [{ hooks: [async input => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: permitted(input.tool_name, input.tool_input as Record<string, unknown>) ? 'allow' : 'deny',
          permissionDecisionReason: 'registered-process-data-only' } };
      }] }] },
      maxTurns: fileTask ? 8 : 1, persistSession: false, abortController: controller,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/workspace',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: request.endpoint,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        ANTHROPIC_MAX_RETRIES: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' },
      stderr: () => {},
      // Platform validates a single candidate. SDK outputFormat is deliberately unused: it may re-prompt to repair output.
      systemPrompt: fileTask ? `You must invoke Bash with exactly "${command}" once. This registered program reads the input file ${request.input_path}, computes exact decimal statistics and writes output/valid.csv and output/rejected.json. No other commands or tools are authorized. Return its statistics as exactly one JSON object matching ${JSON.stringify(fileSchema)}. Do not invent outputs. If input or authorization is missing, return the corresponding error JSON.` : `Return exactly one JSON value matching ${JSON.stringify(outputSchema)}. No markdown. If required input is missing, return {"error":"input_required"}. If authorization is missing, return {"error":"authorization_required"}. Do not ask questions or use tools.`,
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
      if (fileTask) {
        try {
          const output = await collectFiles('/workspace', candidate);
          return { candidate, execution: output.execution, files: output.files.map(file => ({ path: file.path, base64: file.bytes.toString('base64') })) };
        } catch { return { failure: 'output_invalid' }; }
      }
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

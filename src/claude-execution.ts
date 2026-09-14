import { runResearch } from './research-execution.js';
import type { McpBinding } from './research.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { outputSchema, TaskError } from './domain.js';
import { fileSchema } from './file-contract.js';
import { collectFiles } from './sandbox-files.js';
import { requestedSkills, verifySkill, type SkillBinding } from './skills.js';

export interface ClaudeRequest { limits?: import('./limits.js').ExecutionLimits; prompt: string; model: string; endpoint: string; deadline_at: string; attempt_id: string; run_id: string; output_contract?: string; input_path?: string; skills?: SkillBinding[]; mcp?: McpBinding[]; evidence_root?: string; onDenied?: () => Promise<void>; authorizeAction?: (boundary:'tool'|'mcp', invocation_id?:string)=>Promise<string>; finishAction?: (invocation_id:string,outcome:'completed'|'failed')=>Promise<void> }
export type QueryPort = (input: Parameters<typeof query>[0]) => AsyncIterable<SDKMessage>;
// Public engine boundary. The caller supplies an isolated task root; production uses /workspace only.
export async function runClaude(request: ClaudeRequest, root: string, runQuery: QueryPort = query, cancellation?: AbortSignal) {
  cancellation?.throwIfAborted();
  if (request.output_contract === 'research-report@1') return runResearch(request, root, runQuery, cancellation);
  const selected = request.skills ?? [], evidence = requestedSkills(selected);
  const controller = new AbortController(), remaining = Date.parse(request.deadline_at) - Date.now();
  const cancel = () => controller.abort();
  cancellation?.addEventListener('abort', cancel, { once: true });
  const fileTask = request.output_contract === 'data-statistics@1';
  const command = 'node /opt/atomicagent/dist/src/process-data.js';
  const pluginPath = join(root, 'registered-skills');
  const started = new Map<string, string>();
  const actions = new Map<string,string>();
  let initialized = selected.length === 0;
  let journalEntries = 0;
  let evidenceFailed = false;
  let capabilityFailed = false;
  const persist = async () => {
    if (++journalEntries > 40) throw new TaskError('required_capability_failed');
    for (const e of evidence) { e.attempt_id = request.attempt_id; e.observed_at = new Date().toISOString(); e.source = 'controlled-runner:skill-evidence'; }
    // A bounded fsync journal precedes permission grants; failure stops the tool. API imports only allowlisted fields.
    const file = await open(join(request.evidence_root ?? root, 'skill-evidence.jsonl'), 'a', 0o600);
    try { await file.writeFile(JSON.stringify({ run_id: request.run_id, attempt_id: request.attempt_id, skills: evidence }) + '\n'); await file.sync(); }
    finally { await file.close(); }
  };
  const skillFor = (name: string, input: Record<string, unknown>) => name === 'Skill' && typeof input.skill === 'string' &&
    Object.keys(input).every(k => k === 'skill') ? selected.find(s => s.entry === input.skill) : undefined;
  const permitted = (name: string, input: Record<string, unknown>) => !controller.signal.aborted && !evidenceFailed && !capabilityFailed && initialized && (Boolean(skillFor(name, input)) ||
    (fileTask && name === 'Bash' && input.command === command && !input.run_in_background && Object.keys(input).every(k => ['command', 'description', 'timeout', 'run_in_background'].includes(k))));
  const timer = setTimeout(() => controller.abort(), Math.max(1, remaining));
  try {
    if (!Number.isFinite(remaining) || remaining <= 0) throw new TaskError('deadline_exceeded');
    if (selected.length) {
      selected.forEach(verifySkill);
      await mkdir(pluginPath); await mkdir(join(pluginPath, '.claude-plugin'));
      await writeFile(join(pluginPath, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'atomic-registered', version: '1.0.0' }), { flag: 'wx', mode: 0o444 });
      for (const s of selected) {
        const directory = join(pluginPath, 'skills', s.entry.split(':')[1]!); await mkdir(directory, { recursive: true });
        const path = join(directory, 'SKILL.md'); await writeFile(path, s.markdown, { flag: 'wx', mode: 0o444 });
        if (await readFile(path, 'utf8') !== s.markdown) throw new TaskError('required_capability_failed');
        evidence.find(e => e.id === s.id)!.materialized = true;
      }
      await persist();
    }
    controller.signal.throwIfAborted();
    const messages = runQuery({ prompt: `Task request:\n${request.prompt}`, options: {
      model: request.model, cwd: root, tools: [...(fileTask ? ['Bash'] : []), ...(selected.length ? ['Skill'] : [])], mcpServers: {}, settingSources: [],
      skills: selected.map(s => s.entry), plugins: selected.length ? [{ type: 'local', path: pluginPath }] : [],
      permissionMode: fileTask || selected.length ? 'default' : 'dontAsk',
      canUseTool: async (name, input) => { if (permitted(name, input)) return { behavior: 'allow', updatedInput: name === 'Bash' ? { command, timeout: Math.min(remaining, 120_000) } : input }; await request.onDenied?.(); return { behavior: 'deny', message: 'authorization_required' }; },
      hooks: {
        PreToolUse: [{ hooks: [async input => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          let allowed = permitted(input.tool_name, input.tool_input as Record<string, unknown>);
          if(allowed) { try { const id=await request.authorizeAction?.('tool');if(id)actions.set(input.tool_use_id,id); } catch { allowed=false; controller.abort(); } }
          if (!allowed) await request.onDenied?.();
          const s = skillFor(input.tool_name, input.tool_input as Record<string, unknown>);
          if (s && allowed) {
            if (started.has(s.id)) allowed = false;
            else {
              const e = evidence.find(e => e.id === s.id)!; e.used = null;
              started.set(s.id, input.tool_use_id);
              try { await persist(); } catch { evidenceFailed = true; allowed = false; controller.abort(); }
            }
          }
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed && permitted(input.tool_name, input.tool_input as Record<string, unknown>) ? 'allow' : 'deny', permissionDecisionReason: 'registered-capability-only' } };
        }] }],
        PostToolUse: [{ hooks: [async input => {
          if (input.hook_event_name !== 'PostToolUse') return {};
          const action=actions.get(input.tool_use_id);if(action){await request.finishAction?.(action,'completed');actions.delete(input.tool_use_id);}
          const s = skillFor(input.tool_name, input.tool_input as Record<string, unknown>);
          if (s && started.get(s.id) === input.tool_use_id) {
            const e = evidence.find(e => e.id === s.id)!;
            e.used = true; e.invocation_id = input.tool_use_id;
            try { await persist(); } catch { e.used = null; e.invocation_id = null; evidenceFailed = true; controller.abort(); }
          }
          return {};
        }] }],
        PostToolUseFailure: [{ hooks: [async input => {
          if(input.hook_event_name==='PostToolUseFailure'){const action=actions.get(input.tool_use_id);if(action){await request.finishAction?.(action,'failed');actions.delete(input.tool_use_id);}}
          if (input.hook_event_name === 'PostToolUseFailure' && skillFor(input.tool_name, input.tool_input as Record<string, unknown>)) {
            capabilityFailed = true; controller.abort();
          }
          return {};
        }] }],
      },
      maxTurns: fileTask ? 8 + selected.length * 2 : 1 + selected.length * 2, persistSession: false, abortController: controller,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude-isolated'),
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: request.endpoint,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        ANTHROPIC_MAX_RETRIES: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' }, stderr: () => {},
      systemPrompt: (selected.length ? `Invoke each required Skill with the Skill tool and exactly its name, without args: ${selected.filter(s => s.must_use).map(s => s.entry).join(', ')}. ` : '') +
        (fileTask ? `Invoke Bash with exactly "${command}" once to process ${request.input_path}. Return its statistics as exactly one JSON object matching ${JSON.stringify(fileSchema)}. No other tools or commands are authorized. If input or authorization is missing return the corresponding error JSON.` : `Return exactly one JSON value matching ${JSON.stringify(outputSchema)}. No markdown. If input or authorization is missing return the corresponding error JSON.`),
    } });
    for await (const message of messages) {
      if (message.type === 'system' && message.subtype === 'init' && selected.length) {
        for (const s of selected) {
          const e = evidence.find(e => e.id === s.id)!;
          e.loaded = message.skills.includes(s.entry) && message.plugins.some(p => p.name === 'atomic-registered' && p.path === pluginPath);
          e.callable = e.loaded && message.tools.includes('Skill'); e.used = false;
        }
        await persist(); initialized = evidence.every(e => e.callable);
        if (!initialized) throw new TaskError('required_capability_failed');
      }
      if (message.type !== 'result') continue;
      if (evidenceFailed || capabilityFailed) throw new TaskError('required_capability_failed');
      if (!initialized) throw new TaskError('required_capability_failed');
      if (message.permission_denials.length) throw new TaskError('authorization_required');
      if (message.subtype !== 'success' || message.is_error) throw new TaskError('runtime_failed');
      if (selected.some(s => s.must_use && !evidence.find(e => e.id === s.id)!.used)) throw new TaskError('skill_use_unproven');
      if (Buffer.byteLength(message.result) > 12_000) throw new TaskError('output_invalid');
      let candidate: unknown; try { candidate = JSON.parse(message.result); } catch { throw new TaskError('output_invalid'); }
      const error = candidate && typeof candidate === 'object' && 'error' in candidate ? candidate.error : null;
      if (error === 'input_required' || error === 'authorization_required') throw new TaskError(error);
      if (fileTask) {
        let output; try { output = await collectFiles(root, candidate); } catch { throw new TaskError('output_invalid'); }
        return { candidate, execution: output.execution, files: output.files.map(file => ({ path: file.path, base64: file.bytes.toString('base64') })), skills: evidence };
      }
      return { candidate, skills: evidence };
    }
    throw new TaskError('runtime_failed');
  } catch (error) {
    for (const e of evidence) { e.attempt_id = request.attempt_id; e.observed_at ??= new Date().toISOString(); e.source = 'controlled-runner:skill-evidence'; }
    return { failure: evidenceFailed || capabilityFailed ? 'required_capability_failed' : controller.signal.aborted ? 'deadline_exceeded' : error instanceof TaskError ? error.code : initialized ? 'runtime_failed' : 'required_capability_failed', skills: evidence };
  } finally { clearTimeout(timer); controller.abort(); cancellation?.removeEventListener('abort', cancel); }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runClaude, type QueryPort } from '../src/claude-execution.js';
import { registeredSkills } from '../src/skills.js';

test('cancellation while a Skill permission journal is awaiting persistence cannot return a stale allow', async t => {
 const root=await mkdtemp(join(tmpdir(),'atomic-cancel-hook-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cancellation=new AbortController(),skill={...registeredSkills[0]!,id:'statistics',version:'1',must_use:true};let decision:unknown;
 const port:QueryPort=async function*({options}){
  yield {type:'system',subtype:'init',skills:[skill.entry],tools:['Skill'],plugins:[{name:'atomic-registered',path:join(root,'registered-skills')}]} as unknown as SDKMessage;
  const pre=options!.hooks!.PreToolUse![0]!.hooks[0]!;
  const pending=pre({hook_event_name:'PreToolUse',tool_name:'Skill',tool_input:{skill:skill.entry},tool_use_id:'cancel-race',session_id:'test',transcript_path:'',cwd:root},'cancel-race',{signal:new AbortController().signal});
  cancellation.abort();
  decision=(await pending as any).hookSpecificOutput.permissionDecision;
 };
 await runClaude({prompt:'test',model:'test',endpoint:'https://example.invalid',deadline_at:new Date(Date.now()+30000).toISOString(),attempt_id:'attempt',run_id:'run',skills:[skill]},root,port,cancellation.signal);
 assert.equal(decision,'deny');
});

test('controlled Claude SDK boundary isolates plugin discovery and records init separately from a successful Skill hook', async t => {
 const root = await mkdtemp(join(tmpdir(), 'atomic-claude-skills-')); t.after(() => rm(root, { recursive: true, force: true }));
 const skill = { ...registeredSkills[0]!, id: 'statistics', version: '1', must_use: true };
 const port: QueryPort = async function* ({ options }) {
   assert.deepEqual(options!.settingSources, []); assert.deepEqual(options!.skills, ['atomic-registered:data-statistics']);
   assert.deepEqual(options!.plugins, [{ type: 'local', path: join(root, 'registered-skills') }]);
   assert.equal(await readFile(join(root, 'registered-skills/skills/data-statistics/SKILL.md'), 'utf8'), skill.markdown);
   yield { type: 'system', subtype: 'init', skills: [skill.entry], tools: ['Skill', 'Bash'], plugins: [{ name: 'atomic-registered', path: join(root, 'registered-skills') }] } as unknown as SDKMessage;
   const pre = options!.hooks!.PreToolUse![0]!.hooks[0]!;
   const post = options!.hooks!.PostToolUse![0]!.hooks[0]!;
   const input = { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: skill.entry }, tool_use_id: 'tool-1', session_id: 'sdk-session', transcript_path: '', cwd: root } as const;
   const permission = await pre(input, 'tool-1', { signal: new AbortController().signal });
   assert.equal((permission as any).hookSpecificOutput.permissionDecision, 'allow');
   await post({ ...input, hook_event_name: 'PostToolUse', tool_response: { success: true } }, 'tool-1', { signal: new AbortController().signal });
   yield { type: 'result', subtype: 'success', is_error: false, permission_denials: [], result: '{"summary":"claimed","value":3}' } as unknown as SDKMessage;
 };
 const result = await runClaude({ prompt: 'Use the skill', model: 'test', endpoint: 'https://example.invalid', deadline_at: new Date(Date.now()+30000).toISOString(), attempt_id: 'attempt-1', run_id: 'run-1', output_contract: 'summary-value@1', skills: [skill] }, root, port);
 assert.equal(result.skills[0]!.loaded, true); assert.equal(result.skills[0]!.callable, true); assert.equal(result.skills[0]!.used, true); assert.equal(result.skills[0]!.invocation_id, 'tool-1');
});

test('a journal failure explicitly denies Skill permission even if the SDK swallows hook exceptions', async t => {
 const root = await mkdtemp(join(tmpdir(), 'atomic-claude-journal-')); t.after(() => rm(root, { recursive: true, force: true }));
 const skill = { ...registeredSkills[0]!, id: 'statistics', version: '1', must_use: true };
 const port: QueryPort = async function* ({ options }) {
   yield { type: 'system', subtype: 'init', skills: [skill.entry], tools: ['Skill'], plugins: [{ name: 'atomic-registered', path: join(root, 'registered-skills') }] } as unknown as SDKMessage;
   await rm(join(root, 'skill-evidence.jsonl')); await (await import('node:fs/promises')).mkdir(join(root, 'skill-evidence.jsonl'));
   let decision = 'hook-error-fail-open';
   try { const response = await options!.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: skill.entry }, tool_use_id: 'tool-1', session_id: 's', transcript_path: '', cwd: root }, 'tool-1', { signal: new AbortController().signal }); decision = (response as any).hookSpecificOutput.permissionDecision; } catch { /* Emulate SDK catching hook errors. */ }
   assert.equal(decision, 'deny');
   yield { type: 'result', subtype: 'success', is_error: false, permission_denials: [], result: '{"summary":"claimed","value":3}' } as unknown as SDKMessage;
 };
 const result = await runClaude({ prompt: 'Use skill', model: 'test', endpoint: 'https://example.invalid', deadline_at: new Date(Date.now()+30000).toISOString(), attempt_id: 'a', run_id: 'r', skills: [skill] }, root, port);
 assert.equal(result.failure, 'required_capability_failed'); assert.notEqual(result.skills[0]!.used, true);
});

for (const scenario of ['missing-entry', 'no-skill-tool', 'not-used', 'self-report', 'tool-failure', 'runtime-after-use', 'missing-files', 'post-journal-failure'] as const) {
 test(`Claude boundary fails closed for ${scenario} and preserves distinct evidence`, async t => {
   const root = await mkdtemp(join(tmpdir(), 'atomic-claude-negative-')); t.after(() => rm(root, { recursive: true, force: true }));
   const skill = { ...registeredSkills[0]!, id: 'statistics', version: '1', must_use: true };
   const port: QueryPort = async function* ({ options }) {
     yield { type: 'system', subtype: 'init', skills: scenario === 'missing-entry' ? [] : [skill.entry], tools: scenario === 'no-skill-tool' ? [] : ['Skill', 'Bash'], plugins: [{ name: 'atomic-registered', path: join(root, 'registered-skills') }] } as unknown as SDKMessage;
     if (['tool-failure', 'runtime-after-use', 'missing-files', 'post-journal-failure'].includes(scenario)) {
       const input = { tool_name: 'Skill', tool_input: { skill: skill.entry }, tool_use_id: 'tool-1', session_id: 's', transcript_path: '', cwd: root };
       await options!.hooks!.PreToolUse![0]!.hooks[0]!({ ...input, hook_event_name: 'PreToolUse' }, 'tool-1', { signal: new AbortController().signal });
       if (scenario === 'tool-failure') await options!.hooks!.PostToolUseFailure![0]!.hooks[0]!({ ...input, hook_event_name: 'PostToolUseFailure', error: 'SYNTHETIC_SECRET', is_interrupt: false }, 'tool-1', { signal: new AbortController().signal });
       else {
         if (scenario === 'post-journal-failure') { await rm(join(root, 'skill-evidence.jsonl')); await (await import('node:fs/promises')).mkdir(join(root, 'skill-evidence.jsonl')); }
         await options!.hooks!.PostToolUse![0]!.hooks[0]!({ ...input, hook_event_name: 'PostToolUse', tool_response: {} }, 'tool-1', { signal: new AbortController().signal });
       }
     }
     if (scenario === 'runtime-after-use') throw new Error('SYNTHETIC_SECRET');
     yield { type: 'result', subtype: 'success', is_error: false, permission_denials: [], result: scenario === 'self-report' ? '{"skills":[{"used":true}]}' : '{"summary":"claimed","value":3}' } as unknown as SDKMessage;
   };
   const result = await runClaude({ prompt: 'Use skill', model: 'test', endpoint: 'https://example.invalid', deadline_at: new Date(Date.now()+30000).toISOString(), attempt_id: 'a', run_id: 'r', skills: [skill], output_contract: scenario === 'missing-files' ? 'data-statistics@1' : 'summary-value@1' }, root, port);
   assert.equal(result.failure, ['missing-entry', 'no-skill-tool', 'tool-failure', 'post-journal-failure'].includes(scenario) ? 'required_capability_failed' : scenario === 'runtime-after-use' ? 'runtime_failed' : scenario === 'missing-files' ? 'output_invalid' : 'skill_use_unproven');
   assert.equal(result.skills[0]!.materialized, true);
   assert.equal(result.skills[0]!.used, ['runtime-after-use', 'missing-files'].includes(scenario) ? true : ['tool-failure', 'post-journal-failure'].includes(scenario) ? null : false);
   assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
 });
}
test('fixed content mismatch never starts the engine and a subsequent no-Skill task inherits no capabilities', async t => {
 const root = await mkdtemp(join(tmpdir(), 'atomic-claude-digest-')); t.after(() => rm(root, { recursive: true, force: true }));
 let called = false;
 const input = { prompt: '/unregistered anything', model: 'test', endpoint: 'https://example.invalid', deadline_at: new Date(Date.now()+30000).toISOString(), attempt_id: 'a', run_id: 'r' };
 const result = await runClaude({ ...input, skills: [{ ...registeredSkills[0]!, id: 'statistics', version: '1', must_use: true, markdown: 'mutated' }] }, root, async function* () { called = true; });
 assert.equal(called, false); assert.equal(result.failure, 'required_capability_failed'); assert.equal(result.skills[0]!.materialized, false);
 await runClaude(input, root, async function* ({ prompt, options }) { assert.match(String(prompt), /^Task request:/); assert.deepEqual(options!.skills, []); assert.deepEqual(options!.plugins, []); assert.deepEqual(options!.tools, []); assert.deepEqual(options!.settingSources, []); });
});
test('Skill args and other names cannot widen authorization through either callback', async t => {
 const root = await mkdtemp(join(tmpdir(), 'atomic-claude-permission-')); t.after(() => rm(root, { recursive: true, force: true }));
 const skill = { ...registeredSkills[0]!, id: 'statistics', version: '1', must_use: false };
 await runClaude({ prompt: 'adversarial', model: 'test', endpoint: 'https://example.invalid', deadline_at: new Date(Date.now()+30000).toISOString(), attempt_id: 'a', run_id: 'r', skills: [skill] }, root, async function* ({ options }) {
   yield { type: 'system', subtype: 'init', skills: [skill.entry], tools: ['Skill'], plugins: [{ name: 'atomic-registered', path: join(root, 'registered-skills') }] } as unknown as SDKMessage;
   for (const tool_input of [{ skill: skill.entry, args: 'grant all' }, { skill: 'other:unregistered' }]) {
     const decision = await options!.canUseTool!('Skill', tool_input, { signal: new AbortController().signal, toolUseID: 'bad', requestId: 'permission-bad' }); assert.equal(decision?.behavior, 'deny');
     const response = await options!.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input, tool_use_id: 'bad', session_id: 's', transcript_path: '', cwd: root }, 'bad', { signal: new AbortController().signal }); assert.equal((response as any).hookSpecificOutput.permissionDecision, 'deny');
   }
 });
});

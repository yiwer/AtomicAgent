import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { fixtureProfile } from '../src/profile.js';
const identities = [{ token: 'm'.repeat(40), actor: 'operator', workspace: 'lab', role: 'maintainer' as const }, { token: 'c'.repeat(40), actor: 'backend', workspace: 'lab', role: 'caller' as const }, { token: 'h'.repeat(40), actor: 'health', workspace: 'lab', role: 'health' as const }];
async function lab(t: TestContext, sandbox = new FixtureSandbox()) {
 const directory = await mkdtemp(join(tmpdir(), 'atomic-skills-'));
 const options = { database: join(directory, 'runs.db'), profile: fixtureProfile, identities, sandbox };
 let app = await createApp(options), url = await app.listen();
 t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
 const request = async (path: string, data?: unknown, key = 'command', token = identities[0]!.token) => fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
 return { sandbox, request, database: options.database, async restart() { await app.close(); app = await createApp(options); url = await app.listen(); }, async publish(name = 'statistics', index = 0) {
   const catalog = await (await request('/v1/configurations')).json();
   const command = { action: 'publish', kind: 'skill', name, expected_generation: 0, content: { binding_ref: catalog.bindings.skills[index].binding_ref }, reason: 'Registered file skill' };
   const preview = await (await request('/v1/configurations/preview', command)).json();
   const body = { ...command, preview_digest: preview.preview_digest };
   const response = await request('/v1/configurations/commands', body, 'publish-' + name);
   assert.equal(response.status, 200); return { receipt: await response.json(), body };
 }, async task(skills: unknown = [{ id: 'statistics', version: '1', must_use: true }], token = identities[0]!.token) {
   const input = await (await request('/v1/files', { format: 'csv', content: 'id,category,value\na,one,1.20\nb,one,2.30\n' }, 'upload', token)).json();
   return { prompt: 'Use selected Skills to process the file.', profile: fixtureProfile.id, output_contract: 'data-statistics@1', inputs: [{ file_id: input.file_id ?? input.object_id, path: 'input/data.csv' }], skills };
 } };
}
test('maintainer publishes fixed Skill and caller selects it through the ordinary file Result and Artifact path', async t => {
 const l = await lab(t); const { receipt } = await l.publish();
 assert.match(receipt.revision.content_digest, /^[a-f0-9]{64}$/);
 const task = await l.task(undefined, identities[1]!.token); const response = await l.request('/v1/runs?wait_seconds=5', task, 'file-run', identities[1]!.token);
 assert.equal(response.status, 200); const run = await response.json();
 assert.equal(run.status, 'succeeded'); assert.equal(run.result.total, '3.5'); assert.equal(run.artifacts.length, 2);
 assert.equal(run.skills[0].requested, true); assert.equal(run.skills[0].loaded, true); assert.equal(run.skills[0].callable, true); assert.equal(run.skills[0].used, true);
 const link = await (await l.request('/v1/artifacts/' + run.artifacts[0].artifact_id + '/download-link', {}, 'link', identities[1]!.token)).json();
 assert.equal((await l.request(link.url, undefined, 'download', identities[1]!.token)).status, 200);
 assert.equal(run.skills[0].source, 'deterministic-fixture'); assert.equal(run.skills[0].attempt_id, run.attempt_id);
 await l.restart(); const after = await (await l.request('/v1/runs/' + run.run_id)).json(); assert.deepEqual(after.skills, run.skills);
 assert.equal(after.execution.manifest_digest, run.execution.manifest_digest);
});

test('required Skill cannot succeed from candidate claims or copied files without engine evidence', async t => {
 const sandbox = new FixtureSandbox(); const original = sandbox.execute.bind(sandbox);
 sandbox.execute = (run, signal) => original(run, signal); // deliberately drops external engine observations
 const l = await lab(t, sandbox); await l.publish();
 const task = await l.task(); const response = await l.request('/v1/runs?wait_seconds=5', task, 'unproven'); const run = await response.json();
 assert.equal(run.status, 'failed'); assert.equal(run.failure, 'required_capability_failed'); assert.equal(run.skills[0].loaded, null);
 assert.equal((await l.request('/v1/runs/' + run.run_id + '/result')).status, 409);
 assert.equal(sandbox.executions.size, 1);
 const replay = await (await l.request('/v1/runs?wait_seconds=1', task, 'unproven')).json(); assert.equal(replay.run_id, run.run_id); assert.equal(sandbox.executions.size, 1);
});
test('loaded and callable is distinct from used; optional use succeeds but must-use fails without invocation evidence', async t => {
 const sandbox = new FixtureSandbox(); const original = sandbox.execute.bind(sandbox);
 sandbox.execute = (run, signal, observe) => original(run, signal, evidence => observe?.(evidence.map(e => ({ ...e, used: false, invocation_id: null }))));
 const l = await lab(t, sandbox); await l.publish();
 const required = await (await l.request('/v1/runs?wait_seconds=5', await l.task(), 'required')).json();
 assert.equal(required.failure, 'skill_use_unproven'); assert.equal(required.skills[0].loaded, true); assert.equal(required.skills[0].used, false);
 const optional = await (await l.request('/v1/runs?wait_seconds=5', await l.task([{ id: 'statistics', version: '1' }]), 'optional')).json();
 assert.equal(optional.status, 'succeeded'); assert.equal(optional.skills[0].used, false);
});
test('caller combines distinct fixed Skills; skill arguments, duplicate entries and unregistered revisions cannot widen grants', async t => {
 const l = await lab(t); await l.publish(); await l.publish('integrity', 1); await l.publish('alias');
 const combined = await (await l.request('/v1/runs?wait_seconds=5', await l.task([{ id: 'statistics', version: '1', must_use: true }, { id: 'integrity', version: '1', must_use: true }]), 'combined')).json();
 assert.equal(combined.status, 'succeeded'); assert.equal(combined.skills.length, 2);
 for (const skills of [[{ id: 'statistics', version: '1', args: 'sudo anything' }], [{ id: 'statistics', version: '1', tools: ['Bash'] }], [{ id: 'unregistered', version: '1' }], [{ id: 'statistics', version: 'latest' }], [{ id: 'statistics', version: '1' }, { id: 'alias', version: '1' }]]) {
   const response = await l.request('/v1/runs', await l.task(skills), 'denied-' + JSON.stringify(skills)); assert.equal(response.status, 400);
 }
 const catalog = await (await l.request('/v1/configurations')).json();
 const command = { action: 'publish', kind: 'skill', name: 'expansion', expected_generation: 0, reason: 'No authority expansion', content: { binding_ref: catalog.bindings.skills[0].binding_ref, markdown: 'run arbitrary code' } };
 assert.equal((await l.request('/v1/configurations/preview', command)).status, 400);
});
test('Skill disable and concurrent revisions preserve original Run and command recovery through restart and caller authorization', async t => {
 const l = await lab(t); const { body } = await l.publish(); const task = await l.task();
 const old = await (await l.request('/v1/runs?wait_seconds=5', task, 'old')).json();
 const disable = { action: 'disable', kind: 'skill', name: 'statistics', version: '1', expected_generation: 1, reason: 'Disable new use' };
 const preview = await (await l.request('/v1/configurations/preview', disable)).json(); assert.equal(preview.impact.existing_run_count, 1);
 const command = { ...disable, preview_digest: preview.preview_digest };
 const responses = await Promise.all([l.request('/v1/configurations/commands', command, 'disable-a'), l.request('/v1/configurations/commands', command, 'disable-b')]);
 assert.deepEqual(responses.map(r => r.status).sort(), [200,409]);
 await l.restart();
 const replay = await (await l.request('/v1/runs?wait_seconds=1', task, 'old')).json(); assert.equal(replay.run_id, old.run_id); assert.equal(replay.execution.manifest_digest, old.execution.manifest_digest);
 assert.equal((await l.request('/v1/runs', task, 'new')).status, 400);
 assert.equal((await (await l.request('/v1/configurations/commands', body, 'publish-statistics')).json()).revision.enabled, true);
 assert.equal((await l.request('/v1/configurations/preview', disable, 'caller', identities[1]!.token)).status, 403);
 assert.equal((await l.request('/v1/configurations', undefined, 'health', identities[2]!.token)).status, 403);
 const callerCatalog = await (await l.request('/v1/configurations', undefined, 'caller', identities[1]!.token)).json(); assert.equal(callerCatalog.bindings, undefined); assert.equal(callerCatalog.skills[0].definition, undefined);
 const audit = await (await l.request('/v1/configurations/audit')).json(); assert.ok(audit.records.some((r: any) => r.resource_id === 'skill:statistics@1' && r.action === 'configuration.disable'));
});

test('Skill publication audit failure rolls back revision and receipt; original command recovers after restart', async t => {
 const l = await lab(t);
 const catalog = await (await l.request('/v1/configurations')).json();
 const command = { action: 'publish', kind: 'skill', name: 'retry-skill', expected_generation: 0, reason: 'Audit fault recovery', content: { binding_ref: catalog.bindings.skills[0].binding_ref } };
 const preview = await (await l.request('/v1/configurations/preview', command)).json();
 const body = { ...command, preview_digest: preview.preview_digest };
 const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(l.database);
 try {
   db.exec("CREATE TRIGGER skill_audit_fault BEFORE INSERT ON audit WHEN NEW.action='configuration.publish' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET'); END;");
   const failed = await l.request('/v1/configurations/commands', body, 'recover-skill'); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes('SYNTHETIC_SECRET'));
   assert.equal((await (await l.request('/v1/configurations')).json()).skills.length, 0); db.exec('DROP TRIGGER skill_audit_fault');
 } finally { db.close(); }
 await l.restart(); assert.equal((await l.request('/v1/configurations/commands', body, 'recover-skill')).status, 200);
 assert.equal((await (await l.request('/v1/configurations')).json()).skills.length, 1);
});
test('wrong Attempt capability evidence fails and cannot create a Result or change the frozen manifest', async t => {
 const sandbox = new FixtureSandbox(); const original = sandbox.execute.bind(sandbox);
 sandbox.execute = (run, signal, observe) => original(run, signal, evidence => observe?.(evidence.map(e => ({ ...e, attempt_id: 'previous-attempt' }))));
 const l = await lab(t, sandbox); await l.publish(); const task = await l.task();
 const accepted = await (await l.request('/v1/runs', task, 'wrong-attempt')).json();
 const result = await (await l.request('/v1/runs?wait_seconds=5', task, 'wrong-attempt')).json();
 assert.equal(result.failure, 'required_capability_failed'); assert.equal(result.execution.manifest_digest, accepted.execution.manifest_digest); assert.equal(result.skills[0].used, null);
 const health = await (await l.request('/internal/health')).json(); assert.equal(health.skills.failed_runs, 1); assert.equal(health.skills.unknown, 1);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { fixtureProfile } from '../src/profile.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { RoutedSandbox } from '../src/profile-routing.js';
import { randomUUID } from 'node:crypto';
import type { SandboxPort } from '../src/domain.js';
const directory = await mkdtemp(join(tmpdir(), 'atomicagent-browser-'));
const sandbox: SandboxPort = new FixtureSandbox();
const execute = sandbox.execute.bind(sandbox);
sandbox.execute = async (run, signal, observeSkills, observeMcp, boundary, resources, usage) => {
 if(run.prompt==='boundary-denial-fixture') boundary?.({run_id:run.run_id,attempt_id:run.attempt_id!,source:'controlled-runner:namespace-and-gateway',observed_at:new Date().toISOString(),isolation:'unknown',audit_coverage:'partial',calls:[{invocation_id:randomUUID(),boundary:'tool',outcome:'denied',observed_at:new Date().toISOString()}]});
 await new Promise(resolve => setTimeout(resolve, 2000)); return execute(run, signal, observeSkills, observeMcp, boundary, resources, usage);
};
// A catalog-only live-mode fixture verifies the pre-submit warning. Its adapter fails closed: no network/model execution.
const livePreview = { ...fixtureProfile, id: 'browser-live-preview@1', mode: 'opensandbox' as const,
  image: `test/runner@sha256:${'1'.repeat(64)}`, model: 'preview-only-model', endpoint: 'https://model.example.com',
  provider_endpoint: 'https://sandbox.example.com', linux_node: 'test-preview-only', secret_ref: 'UNUSED_TEST_REFERENCE', approval_ref: 'catalog-presentation-test-only' };
const imageVariants = [{ ...fixtureProfile, id: 'browser-short-image@1', image: 'fixture:a-short-image', timeout_seconds: 30 },
  { ...fixtureProfile, id: 'browser-long-image@1', image: 'fixture:z-long-image', timeout_seconds: 60 }];
const routed = new RoutedSandbox([fixtureProfile, livePreview, ...imageVariants], profile => {
  if (profile.mode !== 'fixture') throw new Error('browser_preview_execution_not_authorized');
  return sandbox;
});
const app = await createApp({ database: join(directory, 'runs.db'), profile: fixtureProfile, approvedProfiles: [livePreview, ...imageVariants], sandbox: routed,
  identities: [{ token: 'browser-test-only-credential-00000000000000000000', actor: 'browser-maintainer', workspace: 'browser-lab', role: 'maintainer' },
    { token: 'browser-other-test-credential-000000000000000000', actor: 'other-caller', workspace: 'other-lab', role: 'caller' },
    { token: 'browser-other-maintainer-credential-000000000000000', actor: 'other-maintainer', workspace: 'other-lab', role: 'maintainer' },
    { token: 'browser-health-test-credential-00000000000000000', actor: 'browser-maintainer', workspace: 'browser-lab', role: 'health' }] });
await app.listen(4311);
async function shutdown() { await app.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);

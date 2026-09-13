import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { fixtureProfile } from '../src/profile.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
import { RoutedSandbox } from '../src/profile-routing.js';
const directory = await mkdtemp(join(tmpdir(), 'atomicagent-browser-'));
const sandbox = new FixtureSandbox();
const execute = sandbox.execute.bind(sandbox);
sandbox.execute = async (run, signal) => { await new Promise(resolve => setTimeout(resolve, 2000)); return execute(run, signal); };
// A catalog-only live-mode fixture verifies the pre-submit warning. Its adapter fails closed: no network/model execution.
const livePreview = { ...fixtureProfile, id: 'browser-live-preview@1', mode: 'opensandbox' as const,
  image: `test/runner@sha256:${'1'.repeat(64)}`, model: 'preview-only-model', endpoint: 'https://model.example.com',
  provider_endpoint: 'https://sandbox.example.com', linux_node: 'test-preview-only', secret_ref: 'UNUSED_TEST_REFERENCE', approval_ref: 'catalog-presentation-test-only' };
const routed = new RoutedSandbox([fixtureProfile, livePreview], profile => {
  if (profile.mode !== 'fixture') throw new Error('browser_preview_execution_not_authorized');
  return sandbox;
});
const app = await createApp({ database: join(directory, 'runs.db'), profile: fixtureProfile, approvedProfiles: [livePreview], sandbox: routed,
  identities: [{ token: 'browser-test-only-credential-00000000000000000000', actor: 'browser-maintainer', workspace: 'browser-lab', role: 'maintainer' },
    { token: 'browser-other-test-credential-000000000000000000', actor: 'other-caller', workspace: 'other-lab', role: 'caller' },
    { token: 'browser-other-maintainer-credential-000000000000000', actor: 'other-maintainer', workspace: 'other-lab', role: 'maintainer' },
    { token: 'browser-health-test-credential-00000000000000000', actor: 'browser-maintainer', workspace: 'browser-lab', role: 'health' }] });
await app.listen(4311);
async function shutdown() { await app.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);

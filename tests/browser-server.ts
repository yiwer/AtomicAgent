import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { fixtureProfile } from '../src/profile.js';
import { FixtureSandbox } from '../src/fixture-sandbox.js';
const directory = await mkdtemp(join(tmpdir(), 'atomicagent-browser-'));
const sandbox = new FixtureSandbox();
const execute = sandbox.execute.bind(sandbox);
sandbox.execute = async (run, signal) => { await new Promise(resolve => setTimeout(resolve, 2000)); return execute(run, signal); };
const app = await createApp({ database: join(directory, 'runs.db'), profile: fixtureProfile, sandbox,
  identities: [{ token: 'browser-test-only-credential-00000000000000000000', actor: 'browser-maintainer', workspace: 'browser-lab', role: 'maintainer' },
    { token: 'browser-other-test-credential-000000000000000000', actor: 'other-caller', workspace: 'other-lab', role: 'caller' },
    { token: 'browser-health-test-credential-00000000000000000', actor: 'browser-maintainer', workspace: 'browser-lab', role: 'health' }] });
await app.listen(4311);
async function shutdown() { await app.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);

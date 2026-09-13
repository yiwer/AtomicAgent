import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fixtureProfile } from '../src/profile.js';
await mkdir('.local', { recursive: true });
const token = randomBytes(32).toString('hex');
await writeFile('.local/config.json', JSON.stringify({
  profile: fixtureProfile, database: '.local/runs.db', port: 4310,
  identities: [{ token, actor: 'local-maintainer', workspace: 'atomicagent-lab', role: 'maintainer' }],
}, null, 2), { flag: 'wx', mode: 0o600 });
process.stdout.write('Created .local/config.json with a random local credential. Read it privately for browser login. Fixture only; no model calls.\n');

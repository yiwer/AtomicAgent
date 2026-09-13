// Process-level external-system harness. The ledger counts SandboxPort invocations, never model starts.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { fixtureProfile } from '../src/profile.js';
import type { Run, SandboxPort } from '../src/domain.js';

const directory = process.argv[2]!;
const sandbox: SandboxPort = {
  source: 'deterministic-fixture',
  async prepare(run) { return `controlled-${run.run_id}`; },
  async execute(run: Run) {
    appendFileSync(join(directory, 'starts.jsonl'), JSON.stringify({ run_id: run.run_id, attempt_id: run.attempt_id, source: 'controlled-sandbox-port', pid: process.pid }) + '\n', { flush: true });
    if (process.argv[3] === 'hold') return new Promise(() => {});
    return { summary: 'three apples', value: 3 };
  },
  async cleanup() { return 'absent'; },
};
const app = await createApp({ database: join(directory, 'runs.db'), profile: fixtureProfile, sandbox,
  identities: [{ actor: 'recovery-caller', workspace: 'recovery-lab', role: 'caller', token: 'recovery-test-only-token-0000000000000000' }] });
process.send!({ url: await app.listen(), pid: process.pid });
process.on('message', async message => {
  if (message === 'close') { await app.close(); process.exit(0); }
});

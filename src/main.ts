import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createApp } from './app.js';
import { FixtureSandbox } from './fixture-sandbox.js';
import { OpenSandboxAdapter } from './opensandbox.js';
import { validateProfile } from './profile.js';
import type { Identity, Profile } from './domain.js';

async function main() {
  const configPath = process.env.ATOMIC_CONFIG ?? '.local/config.json';
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    profile: Profile; identities: Identity[]; database: string; port: number;
    opensandbox?: { domain: string; api_key_ref: string };
  };
  validateProfile(config.profile);
  const database = resolve(config.database); await mkdir(dirname(database), { recursive: true });
  // A second process must never recover or dispatch work owned by the first. Stale locks fail closed for operator inspection.
  const lock = await open(`${database}.lock`, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); await lock.sync();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const secret = (name: string) => {
      if (!/^[A-Z][A-Z0-9_]{1,100}$/.test(name) || !process.env[name]) throw new Error('secret_binding_unavailable');
      return process.env[name]!;
    };
    const sandbox = config.profile.mode === 'fixture' ? new FixtureSandbox() : (() => {
      if (!config.opensandbox || process.platform !== 'linux') throw new Error('linux_opensandbox_configuration_required');
      const endpoint = new URL(config.opensandbox.domain);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
          (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)))) throw new Error('secure_provider_endpoint_required');
      secret(config.profile.secret_ref);
      return new OpenSandboxAdapter({ domain: config.opensandbox.domain, apiKey: secret(config.opensandbox.api_key_ref) }, secret);
    })();
    app = await createApp({ database, profile: config.profile, identities: config.identities, sandbox });
    const url = await app.listen(config.port);
    process.stdout.write(`AtomicAgent ${config.profile.mode}: ${url}\n`);
    await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } finally {
    await app?.close(); await lock.close(); await unlink(`${database}.lock`);
  }
}
main().catch(() => { process.stderr.write('AtomicAgent startup or shutdown failed. Check private configuration, bindings and database lock.\n'); process.exitCode = 1; });

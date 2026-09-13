import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createApp } from './app.js';
import { FixtureSandbox } from './fixture-sandbox.js';
import { OpenSandboxAdapter } from './opensandbox.js';
import { validateProfile } from './profile.js';
import type { Identity, Profile } from './domain.js';
import { RoutedSandbox } from './profile-routing.js';
import { contentDigest } from './submission.js';

async function main() {
  const configPath = process.env.ATOMIC_CONFIG ?? '.local/config.json';
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    profile: Profile; identities: Identity[]; database: string; port: number;
    opensandbox?: { domain: string; api_key_ref: string };
    approved_profiles?: Profile[];
    providers?: { ref: string; endpoint: string; api_key_ref: string }[];
    legacy_provider_binding_confirmations?: { ref: string; endpoint: string; api_key_ref: string; approval_ref: string }[];
  };
  validateProfile(config.profile);
  const database = resolve(config.database); await mkdir(dirname(database), { recursive: true });
  // A second process must never recover or dispatch work owned by the first. Stale locks fail closed for operator inspection.
  const lock = await open(`${database}.lock`, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); await lock.sync();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const profiles = [config.profile, ...(config.approved_profiles ?? [])];
    profiles.forEach(validateProfile);
    const providers = [...(config.providers ?? [])];
    if (config.opensandbox) providers.push({ ref: config.profile.provider_ref, endpoint: config.opensandbox.domain, api_key_ref: config.opensandbox.api_key_ref });
    if (new Set(providers.map(p => p.ref)).size !== providers.length) throw new Error('duplicate_provider_binding');
    for (const provider of providers) {
      const endpoint = new URL(provider.endpoint);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
          (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)))) throw new Error('secure_provider_endpoint_required');
    }
    const live = profiles.filter(p => p.mode === 'opensandbox');
    if (live.length && process.platform !== 'linux') throw new Error('linux_opensandbox_configuration_required');
    for (const profile of live) if (!providers.some(p => p.ref === profile.provider_ref && p.endpoint === profile.provider_endpoint)) throw new Error('provider_binding_mismatch');
    // Only names explicitly authorized by this private deployment are read. API data never reaches process.env.
    const allowedNames = new Set([...live.map(p => p.secret_ref), ...providers.map(p => p.api_key_ref)]);
    const secrets = new Map<string, string>();
    for (const name of allowedNames) {
      if (!/^[A-Z][A-Z0-9_]{1,100}$/.test(name) || !process.env[name]) throw new Error('secret_binding_unavailable');
      secrets.set(name, process.env[name]!);
    }
    const fixture = new FixtureSandbox();
    const sandbox = new RoutedSandbox(profiles, profile => {
      if (profile.mode === 'fixture') return fixture;
      const provider = providers.find(p => p.ref === profile.provider_ref && p.endpoint === profile.provider_endpoint);
      if (!provider) throw new Error('provider_binding_unavailable');
      return new OpenSandboxAdapter({ domain: provider.endpoint, apiKey: secrets.get(provider.api_key_ref)! }, reference => {
        if (reference !== profile.secret_ref || !secrets.has(reference)) throw new Error('secret_binding_unavailable');
        return secrets.get(reference)!;
      });
    }, [...profiles.filter(p => p.mode === 'fixture'), ...providers.map(p => ({ mode: 'opensandbox' as const, provider_ref: p.ref, provider_endpoint: p.endpoint }))]);
    app = await createApp({ database, profile: config.profile, approvedProfiles: config.approved_profiles, identities: config.identities, sandbox,
      deploymentBindings: providers.map(p => {
        const confirmation = config.legacy_provider_binding_confirmations?.find(c => c.ref === p.ref && c.endpoint === p.endpoint && c.api_key_ref === p.api_key_ref);
        if (confirmation && (typeof confirmation.approval_ref !== 'string' || !/^[\w:./-]{1,160}$/.test(confirmation.approval_ref))) throw new Error('invalid_legacy_binding_confirmation');
        return { id: `provider:${p.ref}`, document: contentDigest(p), ...(confirmation ? { legacyApproval: `approval-${contentDigest(confirmation)}` } : {}) };
      }) });
    const url = await app.listen(config.port);
    process.stdout.write(`AtomicAgent ${config.profile.mode}: ${url}\n`);
    await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } finally {
    await app?.close(); await lock.close(); await unlink(`${database}.lock`);
  }
}
main().catch(error => {
  const code = error instanceof Error && ['legacy_provider_binding_confirmation_required', 'immutable_deployment_binding_conflict'].includes(error.message) ? ` (${error.message})` : '';
  process.stderr.write(`AtomicAgent startup or shutdown failed${code}. Check private configuration, bindings and database lock.\n`); process.exitCode = 1;
});

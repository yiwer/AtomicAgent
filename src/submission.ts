import { createHash } from 'node:crypto';
import type { Run } from './domain.js';

export function contentDigest(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return createHash('sha256').update(serialized).digest('hex');
}

// Pre-v2 records contain all accepted submission fields in their frozen facts.
// Recover from these facts only; never resolve today's source objects or configuration.
export function submissionDigest(run: Run): string {
  return run.request_digest_version === 2 ? run.request_digest : contentDigest({
    prompt: run.prompt, profile: run.manifest.profile.id, output_contract: run.manifest.output_contract,
    ...(run.manifest.output_contract === 'data-statistics@1'
      ? { inputs: run.manifest.grant.inputs.map(({ file_id, path }) => ({ file_id, path })) } : {}),
  });
}

export function manifestDigest(manifest: Run['manifest']): string {
  return contentDigest({ ...manifest, grant: { ...manifest.grant,
    inputs: manifest.grant.inputs.map(({ loaded: _loaded, ...binding }) => binding) } });
}

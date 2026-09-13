import { ApiError, type Profile } from './domain.js';
export const fixtureProfile: Profile = {
  id: 'json-lab@1', revision: '1', mode: 'fixture', image: 'fixture:no-container',
  node: '24.18.0', sdk: '0.3.270', cli: 'bundled-with-sdk-0.3.270', model: 'fixture:no-model',
  endpoint: 'https://fixture.invalid', secret_ref: 'none', provider_ref: 'none', provider_endpoint: 'https://fixture.invalid', linux_node: 'not-connected',
  runtime: 'docker', timeout_seconds: 60, approval_ref: 'deterministic-test-only',
};
export function validateProfile(profile: Profile): void {
  if (!/^[-a-zA-Z0-9_.]{1,80}@[1-9][0-9]{0,6}$/.test(profile.id) || profile.revision !== profile.id.split('@')[1] || profile.runtime !== 'docker' ||
      !Number.isInteger(profile.timeout_seconds) || profile.timeout_seconds < 1 || profile.timeout_seconds > 3600) {
    throw new ApiError(503, 'invalid_profile');
  }
  if (profile.mode === 'fixture') return;
  if (profile.mode !== 'opensandbox' || !/^.+@sha256:[a-f0-9]{64}$/.test(profile.image) ||
      profile.node !== '24.18.0' || profile.sdk !== '0.3.270' || profile.cli !== 'bundled-with-sdk-0.3.270' ||
      ![profile.model, profile.secret_ref, profile.provider_ref, profile.linux_node, profile.approval_ref].every(v => typeof v === 'string' && v.length > 0 && !v.includes('REPLACE')))
    throw new ApiError(503, 'invalid_profile');
  const url = new URL(profile.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname.endsWith('.invalid'))
    throw new ApiError(503, 'invalid_profile');
  const provider = new URL(profile.provider_endpoint);
  if (provider.username || provider.password || provider.search || provider.hash || provider.hostname.endsWith('.invalid') ||
      (provider.protocol !== 'https:' && !(provider.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(provider.hostname)))) throw new ApiError(503, 'invalid_profile');
}

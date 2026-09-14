import type { ObserveMcp } from './research.js';
import type { ObserveSkills } from './skills.js';
import { TaskError, type LoadedInput, type Profile, type Run, type SandboxPort } from './domain.js';
import { runtimeOf, connectionOf } from './configurations.js';
import { contentDigest } from './submission.js';

// Dispatch and disposal always resolve the frozen Run, never the process's current default revision.
export class RoutedSandbox implements SandboxPort {
  readonly source = 'registered-dispatch';
  constructor(private profiles: Profile[], private adapter: (profile: Profile) => SandboxPort,
    private cleanupProviders: Pick<Profile, 'mode' | 'provider_ref' | 'provider_endpoint'>[] = profiles) {}
  supports(profile: Profile, purpose: 'execute' | 'cleanup' = 'execute') {
    if (purpose === 'cleanup') return this.cleanupProviders.some(p => p.mode === profile.mode && p.provider_ref === profile.provider_ref && p.provider_endpoint === profile.provider_endpoint);
    const runtime = this.profiles.some(p => contentDigest(runtimeOf(p)) === contentDigest(runtimeOf(profile)) &&
      p.image === profile.image && p.timeout_seconds >= profile.timeout_seconds);
    return runtime && this.profiles.some(p =>
      contentDigest(connectionOf(p)) === contentDigest(connectionOf(profile)) && p.model === profile.model);
  }
  sourceFor(run: Run) { return run.manifest.profile.mode === 'fixture' ? 'deterministic-fixture' : 'opensandbox'; }
  private forRun(run: Run, purpose: 'execute' | 'cleanup' = 'execute') {
    if (!this.supports(run.manifest.profile, purpose)) throw new TaskError('authorization_required');
    return this.adapter(structuredClone(run.manifest.profile));
  }
  prepare(run: Run) { return this.forRun(run).prepare(run); }
  async loadInputs(run: Run, inputs: LoadedInput[]) {
    const adapter = this.forRun(run);
    if (!adapter.loadInputs) throw new TaskError('provisioning_failed');
    await adapter.loadInputs(run, inputs);
  }
  execute(run: Run, signal: AbortSignal, observeSkills?: ObserveSkills, observeMcp?: ObserveMcp) { return this.forRun(run).execute(run, signal, observeSkills, observeMcp); }
  cleanup(run: Run) { return this.forRun(run, 'cleanup').cleanup(run); }
  async requestStop(run: Run) { await this.forRun(run, 'cleanup').requestStop?.(run); }
  async forceStop(run: Run) { return await this.forRun(run, 'cleanup').forceStop?.(run) ?? 'unknown' as const; }
}

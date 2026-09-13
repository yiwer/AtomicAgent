import { ApiError, now, type Identity, type Profile, type RevisionRef } from './domain.js';
import { Store } from './store.js';
import { contentDigest } from './submission.js';
import { validateProfile } from './profile.js';

type Kind = 'environment' | 'model';
type Runtime = Pick<Profile, 'mode' | 'node' | 'sdk' | 'cli' | 'provider_ref' | 'provider_endpoint' | 'linux_node' | 'runtime'>;
type Connection = Pick<Profile, 'mode' | 'endpoint' | 'secret_ref' | 'approval_ref'>;
interface EnvironmentBinding { binding_ref: string; runtime: Runtime; images: string[]; image_limits: Record<string, number>; max_timeout_seconds: number }
interface ModelBinding { binding_ref: string; connection: Connection; models: string[] }
interface Content { binding_ref: string; image?: string; timeout_seconds?: number; model?: string }
type Definition = Record<string, string | number>;
interface Revision {
  kind: Kind; name: string; version: string; content: Content; enabled: boolean;
  definition: Definition;
  content_digest: string;
  published_at: string; published_by: string; reason: string; compatibility: { status: 'unverified'; source: string };
}
interface State { generations: Record<string, number>; revisions: Revision[] }
interface Command { action: 'publish' | 'enable' | 'disable'; kind: Kind; name: string; expected_generation: number; content?: Content; version?: string; reason: string }
const identifier = /^[-a-zA-Z0-9_.]{1,80}$/;
const versionPattern = /^[1-9][0-9]{0,6}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_configuration');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new ApiError(400, 'invalid_configuration');
}
export function runtimeOf(p: Profile): Runtime {
  return { mode: p.mode, node: p.node, sdk: p.sdk, cli: p.cli, provider_ref: p.provider_ref,
    provider_endpoint: p.provider_endpoint, linux_node: p.linux_node, runtime: p.runtime };
}
export function connectionOf(p: Profile): Connection {
  return { mode: p.mode, endpoint: p.endpoint, secret_ref: p.secret_ref, approval_ref: p.approval_ref };
}
function describeEnvironment(runtime: Runtime, content: Content): Definition {
  return { ...runtime, binding_ref: content.binding_ref, image: content.image!, timeout_seconds: content.timeout_seconds! };
}
function describeModel(connection: Connection, content: Content): Definition {
  return { mode: connection.mode, endpoint: connection.endpoint, model: content.model!, binding_ref: content.binding_ref,
    credential_identity: `credential-${contentDigest({ reference: connection.secret_ref, endpoint: connection.endpoint })}`,
    approval_identity: `approval-${contentDigest(connection.approval_ref)}` };
}
function revisionContent(kind: Kind, content: Content, definition: Definition) {
  return { content, definition, content_digest: contentDigest({ kind, content, definition }) };
}

// The private deployment catalog grants endpoint/credential/image authority. Public commands can only narrow it.
export class Configurations {
  private environments: EnvironmentBinding[] = [];
  private models: ModelBinding[] = [];
  constructor(private store: Store, private initial: Profile, profiles: Profile[], workspaces: string[]) {
    for (const profile of profiles) {
      validateProfile(profile);
      const runtime = runtimeOf(profile), connection = connectionOf(profile);
      let environment = this.environments.find(b => contentDigest(b.runtime) === contentDigest(runtime));
      if (!environment) { environment = { binding_ref: '', runtime, images: [], image_limits: {}, max_timeout_seconds: 0 }; this.environments.push(environment); }
      if (!environment.images.includes(profile.image)) environment.images.push(profile.image);
      environment.image_limits[profile.image] = Math.max(environment.image_limits[profile.image] ?? 0, profile.timeout_seconds);
      environment.max_timeout_seconds = Math.max(environment.max_timeout_seconds, profile.timeout_seconds);
      let model = this.models.find(b => contentDigest(b.connection) === contentDigest(connection));
      if (!model) { model = { binding_ref: '', connection, models: [] }; this.models.push(model); }
      if (!model.models.includes(profile.model)) model.models.push(profile.model);
    }
    for (const b of this.environments) { b.images.sort(); b.binding_ref = `runtime-${contentDigest(b.runtime)}`; }
    for (const b of this.models) { b.models.sort(); b.binding_ref = `connection-${contentDigest(b.connection)}`; }
    for (const workspace of workspaces) if (!store.configurationState(workspace)) {
      const legacy = [initial, ...store.all().filter(r => r.workspace === workspace && !r.manifest.environment).map(r => r.manifest.profile)];
      const unique = [...new Map(legacy.map(p => [p.id, p])).values()];
      const state: State = { generations: {}, revisions: [] };
      for (const profile of unique.sort((a, b) => Number(a.revision) - Number(b.revision))) {
        const name = profile.id.split('@')[0]!, version = profile.revision;
        const base = { name, version, enabled: true, published_at: now(), published_by: 'platform', reason: 'Legacy fixed profile migration',
          compatibility: { status: 'unverified' as const, source: 'platform:no-approved-compatibility-evidence' } };
        state.generations[`environment:${name}`] = (state.generations[`environment:${name}`] ?? 0) + 1;
        state.generations[`model:${name}`] = (state.generations[`model:${name}`] ?? 0) + 1;
        const environmentContent = { binding_ref: `runtime-${contentDigest(runtimeOf(profile))}`, image: profile.image, timeout_seconds: profile.timeout_seconds };
        const modelContent = { binding_ref: `connection-${contentDigest(connectionOf(profile))}`, model: profile.model };
        state.revisions.push(
          { ...base, kind: 'environment', ...revisionContent('environment', environmentContent, describeEnvironment(runtimeOf(profile), environmentContent)) },
          { ...base, kind: 'model', ...revisionContent('model', modelContent, describeModel(connectionOf(profile), modelContent)) },
        );
      }
      store.transaction(() => { store.saveConfigurationState(workspace, state); store.audit('platform', workspace, 'configuration.migrate', 'fixed-legacy-references'); });
    }
  }
  private state(workspace: string): State { return this.store.configurationState(workspace) as State; }
  private available(revision: Revision) {
    return revision.kind === 'environment'
      ? this.environments.some(b => b.binding_ref === revision.content.binding_ref && b.images.includes(revision.content.image!) && revision.content.timeout_seconds! <= b.image_limits[revision.content.image!]!)
      : this.models.some(b => b.binding_ref === revision.content.binding_ref && b.models.includes(revision.content.model!));
  }
  observation(workspace: string) {
    const revisions = this.state(workspace).revisions;
    return { observed_at: now(), source: 'platform:durable-configuration-revisions', coverage: 'registered-revisions-only',
      enabled: revisions.filter(r => r.enabled).length, unavailable: revisions.filter(r => r.enabled && !this.available(r)).length,
      model_compatibility: 'unverified' };
  }
  list(identity: Identity) {
    const state = this.state(identity.workspace);
    const revisions = state.revisions.map(({ definition, ...r }) => ({ ...r, ...(identity.role === 'maintainer' ? { definition } : {}), available: r.enabled && this.available({ ...r, definition }), generation: state.generations[`${r.kind}:${r.name}`],
      mode: r.kind === 'environment' ? this.environments.find(b => b.binding_ref === r.content.binding_ref)?.runtime.mode ?? 'unknown'
        : this.models.find(b => b.binding_ref === r.content.binding_ref)?.connection.mode ?? 'unknown' }));
    return { environments: revisions.filter(r => r.kind === 'environment'), models: revisions.filter(r => r.kind === 'model'),
      observed_at: now(), source: 'platform:durable-configuration-revisions',
      ...(identity.role === 'maintainer' ? { bindings: {
        environments: this.environments.map(b => ({ binding_ref: b.binding_ref, mode: b.runtime.mode, node: b.runtime.node, sdk: b.runtime.sdk, cli: b.runtime.cli,
          runtime: b.runtime.runtime, provider_ref: b.runtime.provider_ref, provider_endpoint: b.runtime.provider_endpoint, linux_node: b.runtime.linux_node,
          images: b.images, image_limits: b.image_limits, max_timeout_seconds: b.max_timeout_seconds })),
        models: this.models.map(b => ({ binding_ref: b.binding_ref, mode: b.connection.mode, endpoint: b.connection.endpoint, models: b.models,
          compatibility: 'unverified' })),
      } } : {}),
    };
  }
  private command(value: unknown): Command {
    const input = object(value);
    fields(input, ['action', 'kind', 'name', 'expected_generation', 'content', 'version', 'reason', 'preview_digest']);
    if (!['publish', 'enable', 'disable'].includes(String(input.action)) || !['environment', 'model'].includes(String(input.kind)) ||
        typeof input.name !== 'string' || !identifier.test(input.name) || !Number.isSafeInteger(input.expected_generation) || Number(input.expected_generation) < 0 ||
        typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 300 || /[\x00-\x1f]/.test(input.reason)) throw new ApiError(400, 'invalid_configuration');
    const command = { action: input.action, kind: input.kind, name: input.name, expected_generation: input.expected_generation, reason: input.reason } as Command;
    if (command.action === 'publish') {
      if (input.version !== undefined) throw new ApiError(400, 'invalid_configuration');
      const content = object(input.content);
      fields(content, command.kind === 'environment' ? ['binding_ref', 'image', 'timeout_seconds'] : ['binding_ref', 'model']);
      if (typeof content.binding_ref !== 'string') throw new ApiError(400, 'invalid_configuration');
      if (command.kind === 'environment') {
        const binding = this.environments.find(b => b.binding_ref === content.binding_ref);
        const image = content.image ?? (binding?.images.length === 1 ? binding.images[0] : undefined);
        if (!binding || typeof image !== 'string' || !binding.images.includes(image) || !Number.isInteger(content.timeout_seconds) ||
            Number(content.timeout_seconds) < 1 || Number(content.timeout_seconds) > binding.image_limits[image]!) throw new ApiError(400, 'binding_not_allowed');
        command.content = { binding_ref: binding.binding_ref, image, timeout_seconds: Number(content.timeout_seconds) };
      } else {
        const binding = this.models.find(b => b.binding_ref === content.binding_ref);
        if (!binding || typeof content.model !== 'string' || !binding.models.includes(content.model)) throw new ApiError(400, 'binding_not_allowed');
        command.content = { binding_ref: binding.binding_ref, model: content.model };
      }
    } else {
      if (input.content !== undefined || typeof input.version !== 'string' || !versionPattern.test(input.version)) throw new ApiError(400, 'invalid_configuration');
      command.version = input.version;
    }
    return command;
  }
  private inspect(workspace: string, command: Command) {
    const state = this.state(workspace), key = `${command.kind}:${command.name}`;
    const generation = state.generations[key] ?? 0;
    if (generation !== command.expected_generation) throw new ApiError(409, 'configuration_conflict');
    const history = state.revisions.filter(r => r.kind === command.kind && r.name === command.name);
    const previous = command.action === 'publish' ? history.at(-1) : history.find(r => r.version === command.version);
    if (command.action !== 'publish' && !previous) throw new ApiError(404, 'configuration_not_found');
    if (command.action === 'enable' && !this.available(previous!)) throw new ApiError(400, 'binding_not_allowed');
    const definition = command.action !== 'publish' ? previous!.definition : command.kind === 'environment'
      ? describeEnvironment(this.environments.find(b => b.binding_ref === command.content!.binding_ref)!.runtime, command.content!)
      : describeModel(this.models.find(b => b.binding_ref === command.content!.binding_ref)!.connection, command.content!);
    const changes = command.action === 'publish'
      ? Object.entries(definition).filter(([field, after]) => previous?.definition[field] !== after)
        .map(([field, after]) => ({ field, before: previous?.definition[field] ?? null, after }))
      : [{ field: 'enabled', before: previous!.enabled, after: command.action === 'enable' }];
    const runs = this.store.all().filter(r => r.workspace === workspace && (
      r.manifest[command.kind === 'environment' ? 'environment' : 'model']?.profile_id === command.name ||
      (!r.manifest.environment && r.manifest.profile.id.split('@')[0] === command.name)));
    const impact = { new_runs: 'Only new Runs explicitly selecting this revision; no default or existing grant changes.',
      existing_run_count: runs.length, existing_runs: runs.slice(0, 100).map(r => ({ run_id: r.run_id, status: r.status,
        revision: r.manifest[command.kind === 'environment' ? 'environment' : 'model'] ?? { profile_id: r.manifest.profile.id.split('@')[0], version: r.manifest.profile.revision } })),
      truncated: runs.length > 100 };
    return { state, key, previous, version: command.action === 'publish' ? String(Math.max(0, ...history.map(r => Number(r.version))) + 1) : command.version!,
      generation, definition, changes, impact, preview_digest: contentDigest({ workspace, command, generation, changes }) };
  }
  preview(identity: Identity, value: unknown) {
    const command = this.command(value), preview = this.inspect(identity.workspace, command);
    return { command, preview_digest: preview.preview_digest, generation: preview.generation, version: preview.version, changes: preview.changes, impact: preview.impact,
      observed_at: now(), source: 'platform:durable-configuration-and-run-references' };
  }
  execute(identity: Identity, value: unknown, key: string) {
    const input = object(value), digest = contentDigest(input);
    // A recovered command receipt is independent of today's binding catalog and configuration generation.
    const known = this.store.configurationCommand(identity.workspace, identity.actor, key);
    if (known) {
      if (known.digest !== digest) throw new ApiError(409, 'configuration_command_conflict');
      this.store.audit(identity.actor, identity.workspace, 'configuration.replay', 'replayed', null,
        { source: 'platform:durable-configuration-command', operation_id: key, resource_id: null, observed_at: now() });
      return known.receipt;
    }
    const command = this.command(input);
    return this.store.transaction(() => {
      const preview = this.inspect(identity.workspace, command);
      if (input.preview_digest !== preview.preview_digest) throw new ApiError(409, 'configuration_preview_required');
      let revision = preview.previous;
      if (command.action === 'publish') {
        if (preview.state.revisions.length >= 1000) throw new ApiError(409, 'configuration_capacity');
        revision = { kind: command.kind, name: command.name, version: preview.version, ...revisionContent(command.kind, command.content!, preview.definition), enabled: true,
          published_at: now(), published_by: identity.actor, reason: command.reason,
          compatibility: { status: 'unverified', source: 'platform:no-approved-compatibility-evidence' } };
        preview.state.revisions.push(revision);
      } else revision!.enabled = command.action === 'enable';
      preview.state.generations[preview.key] = preview.generation + 1;
      const receipt = { command_id: key, actor: identity.actor, workspace: identity.workspace, action: command.action,
        generation: preview.generation + 1, revision, recorded_at: now() };
      this.store.saveConfigurationState(identity.workspace, preview.state);
      this.store.saveConfigurationCommand(identity.workspace, identity.actor, key, digest, receipt);
      this.store.audit(identity.actor, identity.workspace, `configuration.${command.action}`, 'committed', null,
        { source: 'platform:durable-configuration-command', resource_id: `${command.kind}:${command.name}@${preview.version}`, operation_id: key, observed_at: now() });
      return receipt;
    });
  }
  resolve(workspace: string, input: Record<string, unknown>): { profile: Profile; environment?: RevisionRef; model?: RevisionRef } {
    const legacy = input.profile !== undefined;
    if (legacy && (input.profile !== this.initial.id || input.environment !== undefined || input.model !== undefined)) throw new ApiError(400, 'config_unavailable');
    const reference = (value: unknown): RevisionRef => {
      const ref = object(value); fields(ref, ['profile_id', 'version']);
      if (typeof ref.profile_id !== 'string' || !identifier.test(ref.profile_id) || typeof ref.version !== 'string' || !versionPattern.test(ref.version)) throw new ApiError(400, 'config_unavailable');
      return ref as unknown as RevisionRef;
    };
    const environment = legacy ? { profile_id: this.initial.id.split('@')[0]!, version: this.initial.revision } : reference(input.environment);
    const model = legacy ? { profile_id: this.initial.id.split('@')[0]!, version: this.initial.revision } : reference(input.model);
    const revisions = this.state(workspace).revisions;
    const env = revisions.find(r => r.kind === 'environment' && r.name === environment.profile_id && r.version === environment.version);
    const mod = revisions.find(r => r.kind === 'model' && r.name === model.profile_id && r.version === model.version);
    if (!env?.enabled || !mod?.enabled || !this.available(env) || !this.available(mod)) throw new ApiError(400, 'config_unavailable');
    const runtime = this.environments.find(b => b.binding_ref === env.content.binding_ref)!.runtime;
    const connection = this.models.find(b => b.binding_ref === mod.content.binding_ref)!.connection;
    if (runtime.mode !== connection.mode) throw new ApiError(400, 'config_incompatible');
    if (legacy) return { profile: structuredClone(this.initial) };
    return { environment, model, profile: { ...runtime, ...connection, image: env.content.image!, model: mod.content.model!,
      timeout_seconds: env.content.timeout_seconds!, id: `${environment.profile_id}@${environment.version}+${model.profile_id}@${model.version}`, revision: environment.version } };
  }
}

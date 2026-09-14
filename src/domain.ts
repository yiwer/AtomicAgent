import type { McpBinding, McpEvidence, ResearchResult, researchSchema, ObserveMcp } from './research.js';
import type { SkillBinding, SkillEvidence, ObserveSkills } from './skills.js';
import type { fileSchema } from './file-contract.js';
export type Role = 'caller' | 'maintainer' | 'health';
export interface Identity { token: string; actor: string; workspace: string; role: Role }
export interface Profile {
  id: string; mode: 'fixture' | 'opensandbox'; revision: string; image: string;
  node: string; sdk: string; cli: string; model: string; endpoint: string;
  secret_ref: string; provider_ref: string; provider_endpoint: string; linux_node: string; runtime: 'docker';
  timeout_seconds: number; approval_ref: string;
}
export interface RevisionRef { profile_id: string; version: string }
export const outputSchema = {
  type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: 500 }, value: { type: 'integer' } },
  required: ['summary', 'value'], additionalProperties: false,
} as const;
export type Failure = 'provisioning_failed' | 'runtime_failed' | 'output_invalid' | 'input_required' |
  'authorization_required' | 'execution_lost' | 'deadline_exceeded' | 'artifact_commit_failed' | 'required_capability_failed' | 'skill_use_unproven' | 'input_source_expired' | 'input_copy_failed';
export class TaskError extends Error {
  constructor(public code: Failure) { super(code); }
}
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export interface Run {
  run_id: string; owner: string; workspace: string; request_digest: string; prompt: string;
  request_digest_version?: 2; manifest_digest?: string;
  skills?: SkillEvidence[]; mcp?: McpEvidence[];
  manifest: { skills?: SkillBinding[]; profile: Profile; environment?: RevisionRef; model?: RevisionRef; output_contract: 'summary-value@1' | 'data-statistics@1' | 'research-report@1'; checks?: string[] | 'data-statistics@1'; schema: typeof outputSchema | typeof fileSchema | typeof researchSchema;
    grant: { tools: string[]; mcp: McpBinding[]; inputs: InputBinding[]; external_access: 'model-only' | 'registered-readonly' }; deadline_at: string };
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  cancellation?: { operation_id: string; actor: string; role: Role; requested_at: string; decision: 'accepted' | 'already_terminal'; grace_deadline_at: string | null };
  stop?: { status: 'pending' | 'stopped' | 'unknown' | 'not_started'; observed_at: string | null; source: string | null; forced_at: string | null; checks?: number; retry_at?: string | null };
  phase: 'queued' | 'preparing' | 'executing' | 'terminal'; failure: Failure | null;
  accepted_at: string; terminal_at: string | null; attempt_id: string | null;
  allocation: { operation_id: string; resource_id: string | null; creation_pending?: boolean; input_copy_pending?: boolean } | null;
  cleanup: { status: 'pending' | 'complete' | 'unknown' | 'failed'; observed_at: string | null; source: string | null };
  validation: { status: 'passed' | 'failed'; contract: 'summary-value@1' | 'data-statistics@1' | 'research-report@1'; checks?: string[] } | null;
  result: { summary: string; value: number } | FileResult | ResearchResult | null;
  artifacts?: string[];
}
export interface RunEvent {
  version: 1; event_id: string; run_id: string; sequence: number;
  occurred_at: string; recorded_at: string; type: 'run.progress' | 'run.snapshot';
  source: 'platform:durable-run-state'; attempt_id: string | null;
  status: Run['status']; phase: Run['phase']; failure: Run['failure'];
  validation: 'passed' | 'failed' | null;
  cleanup: { status: Run['cleanup']['status']; observed_at: string | null };
}
export interface SandboxPort {
  readonly source: string;
  supports?(profile: Profile, purpose?: 'execute' | 'cleanup'): boolean;
  sourceFor?(run: Run): string;
  prepare(run: Run): Promise<string>;
  loadInputs?(run: Run, inputs: LoadedInput[]): Promise<void>;
  execute(run: Run, signal: AbortSignal, observeSkills?: ObserveSkills, observeMcp?: ObserveMcp): Promise<unknown>;
  requestStop?(run: Run): Promise<void>;
  forceStop?(run: Run): Promise<'stopped' | 'unknown'>;
  cleanup(run: Run): Promise<'absent' | 'unknown' | 'present'>;
}
export const now = () => new Date().toISOString();

export interface StoredObject {
  object_id: string; kind: 'input' | 'artifact'; owner: string; workspace: string;
  run_id: string | null; path: string | null; format: 'csv' | 'json' | 'markdown';
  size_bytes: number; sha256: string; status: 'staged' | 'available' | 'removed';
  expires_at: string; cleanup_observed_at: string | null;
}
export interface InputBinding {
  binding_id?: string; loaded_at?: string;
  source?: { kind: 'artifact'; artifact_id: string; run_id: string; expires_at: string };
  file_id: string; path: string; sha256: string; size_bytes: number; format: 'csv' | 'json';
  owner: string; workspace: string; expires_at: string; loaded: boolean;
}

export interface FileResult { summary: string; input_count: number; valid_count: number; rejected_count: number; total: string; groups: Record<string, string> }
export interface LoadedInput { binding: InputBinding; bytes: Buffer }
export interface FileCandidate { candidate: unknown; files: { path: string; bytes: Buffer }[]; execution: { tool: 'process-data@1'; observed: true } }

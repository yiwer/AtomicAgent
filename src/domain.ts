export type Role = 'caller' | 'maintainer' | 'health';
export interface Identity { token: string; actor: string; workspace: string; role: Role }
export interface Profile {
  id: string; mode: 'fixture' | 'opensandbox'; revision: string; image: string;
  node: string; sdk: string; cli: string; model: string; endpoint: string;
  secret_ref: string; provider_ref: string; provider_endpoint: string; linux_node: string; runtime: 'docker';
  timeout_seconds: number; approval_ref: string;
}
export const outputSchema = {
  type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: 500 }, value: { type: 'integer' } },
  required: ['summary', 'value'], additionalProperties: false,
} as const;
export type Failure = 'provisioning_failed' | 'runtime_failed' | 'output_invalid' | 'input_required' |
  'authorization_required' | 'execution_lost' | 'deadline_exceeded' | 'artifact_commit_failed';
export class TaskError extends Error {
  constructor(public code: Failure) { super(code); }
}
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export interface Run {
  run_id: string; owner: string; workspace: string; request_digest: string; prompt: string;
  manifest: { profile: Profile; output_contract: 'summary-value@1'; schema: typeof outputSchema;
    grant: { tools: []; mcp: []; inputs: []; external_access: 'model-only' }; deadline_at: string };
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out';
  phase: 'queued' | 'preparing' | 'executing' | 'terminal'; failure: Failure | null;
  accepted_at: string; terminal_at: string | null; attempt_id: string | null;
  allocation: { operation_id: string; resource_id: string | null } | null;
  cleanup: { status: 'pending' | 'complete' | 'unknown' | 'failed'; observed_at: string | null; source: string | null };
  validation: { status: 'passed' | 'failed'; contract: 'summary-value@1' } | null;
  result: { summary: string; value: number } | null;
}
export interface SandboxPort {
  readonly source: string;
  prepare(run: Run): Promise<string>;
  execute(run: Run, signal: AbortSignal): Promise<unknown>;
  cleanup(run: Run): Promise<'absent' | 'unknown' | 'present'>;
}
export const now = () => new Date().toISOString();

import { requestedSkills, verifySkill, type ObserveSkills } from './skills.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectFiles } from './sandbox-files.js';
import { TaskError, type Run, type SandboxPort, type LoadedInput } from './domain.js';
// Explicit external-system double. Never selected by a live profile or by user prompt.
export class FixtureSandbox implements SandboxPort {
  readonly source = 'deterministic-fixture';
  readonly resources = new Set<string>();
  readonly executions = new Set<string>();
  readonly directories = new Map<string, string>();
  constructor(public scenario: 'success' | 'invalid' | 'prepare-failed' | 'cleanup-unknown' | 'input-required' | 'authorization-required' | 'timeout' = 'success') {}
  async prepare(run: Run) {
    const id = `fixture-${run.allocation!.operation_id}`;
    this.resources.add(id);
    if (this.scenario === 'prepare-failed') throw new TaskError('provisioning_failed');
    return id;
  }
  async loadInputs(run: Run, inputs: LoadedInput[]) {
    const root = await mkdtemp(join(tmpdir(), 'atomicagent-execution-')); this.directories.set(run.run_id, root);
    await mkdir(join(root, 'input'));
    for (const input of inputs) await writeFile(join(root, input.binding.path), input.bytes, { flag: 'wx' });
    await writeFile(join(root, 'request.json'), JSON.stringify({ input_path: inputs[0]!.binding.path, format: inputs[0]!.binding.format }));
  }
  async execute(run: Run, signal: AbortSignal, observeSkills?: ObserveSkills): Promise<unknown> {
    if (this.executions.has(run.run_id)) throw new TaskError('execution_lost');
    this.executions.add(run.run_id);
    if (run.manifest.skills?.length) {
      run.manifest.skills.forEach(verifySkill);
      observeSkills?.(requestedSkills(run.manifest.skills).map(e => ({ ...e, materialized: true, loaded: true, callable: true, used: true, invocation_id: `fixture-${e.id}`, attempt_id: run.attempt_id, source: this.source, observed_at: new Date().toISOString() })));
    }
    if (this.scenario === 'timeout') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new TaskError('deadline_exceeded')), { once: true }));
    if (this.scenario === 'input-required') throw new TaskError('input_required');
    if (this.scenario === 'authorization-required') throw new TaskError('authorization_required');
    if (this.scenario === 'invalid') return { summary: 'I succeeded', value: '3', actor: 'admin', secret: 'SYNTHETIC_SECRET' };
    if (run.manifest.output_contract === 'data-statistics@1') {
      const root = this.directories.get(run.run_id)!;
      const script = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './process-data.ts' : './process-data.js', import.meta.url));
      await promisify(execFile)(process.execPath, [...(script.endsWith('.ts') ? ['--import', 'tsx'] : []), script, root], { signal, timeout: 30_000, maxBuffer: 16_384 });
      return collectFiles(root, JSON.parse(await readFile(join(root, 'statistics.json'), 'utf8')));
    }
    return { summary: 'three apples', value: 3 };
  }
  async cleanup(run: Run) {
    if (this.scenario === 'cleanup-unknown') return 'unknown' as const;
    const root = this.directories.get(run.run_id);
    if (root) { await rm(root, { recursive: true, force: true }); this.directories.delete(run.run_id); }
    this.resources.delete(run.allocation?.resource_id ?? `fixture-${run.allocation?.operation_id}`);
    return 'absent' as const;
  }
}

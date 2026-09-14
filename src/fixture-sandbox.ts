import { probeMcp, validateResearch, researchMarkdown, type ObserveMcp } from './research.js';
import { requestedSkills, verifySkill, type ObserveSkills } from './skills.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, type ChildProcess } from 'node:child_process';
import { INPUT_LIMIT } from './file-contract.js';
import { sha256 } from './files.js';
import { readSandboxFile, collectFiles } from './sandbox-files.js';
import { TaskError, type Run, type SandboxPort, type LoadedInput } from './domain.js';
// Explicit external-system double. Never selected by a live profile or by user prompt.
export class FixtureSandbox implements SandboxPort {
  readonly source = 'deterministic-fixture';
  readonly resources = new Set<string>();
  readonly executions = new Set<string>();
  readonly directories = new Map<string, string>();
  private children = new Map<string, { child: ChildProcess; closed: Promise<void> }>();
  private stopped = new Set<string>();
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
    for (const input of inputs) {
      await writeFile(join(root, input.binding.path), input.bytes, { flag: 'wx' });
      const copy = await readSandboxFile(root, input.binding.path, INPUT_LIMIT);
      if (copy.length !== input.binding.size_bytes || sha256(copy) !== input.binding.sha256) throw new TaskError('input_required');
    }
    await writeFile(join(root, 'request.json'), JSON.stringify({ input_path: inputs[0]!.binding.path, format: inputs[0]!.binding.format }));
  }
  async execute(run: Run, signal: AbortSignal, observeSkills?: ObserveSkills, observeMcp?: ObserveMcp): Promise<unknown> {
    signal.throwIfAborted();
    if (this.stopped.has(run.run_id)) throw new TaskError('execution_lost');
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
    if (run.manifest.output_contract === 'research-report@1') {
      const binding = run.manifest.grant.mcp[0]!;
      const { evidence, receipts } = await probeMcp(binding, signal);
      evidence.run_id = run.run_id; evidence.attempt_id = run.attempt_id; observeMcp?.([evidence]);
      if (receipts.length !== binding.sources.length) throw new TaskError('required_capability_failed');
      const candidate = { summary: 'Fixed-material research demonstration', conclusions: [
        { kind: 'fact', statement: 'OpenSandbox describes a general-purpose sandbox platform.', citations: [{ source_id: 'opensandbox', quote: 'general-purpose sandbox platform' }] },
        { kind: 'fact', statement: 'Sandcastle describes a TypeScript library for orchestrating coding agents.', citations: [{ source_id: 'sandcastle', quote: 'A TypeScript library for orchestrating AI coding agents in isolated sandboxes' }] },
        { kind: 'unknown', statement: 'Production reliability is not established by README excerpts.', citations: [] },
      ] };
      const result = validateResearch(candidate, receipts, binding);
      return { candidate, receipts, mcp: [evidence], files: [{ path: 'output/report.md', bytes: Buffer.from(researchMarkdown(result)) }] };
    }
    if (run.manifest.output_contract === 'data-statistics@1') {
      const root = this.directories.get(run.run_id)!;
      const script = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './process-data.ts' : './process-data.js', import.meta.url));
      signal.throwIfAborted();
      if (this.stopped.has(run.run_id)) throw new TaskError('execution_lost');
      await new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, [...(script.endsWith('.ts') ? ['--import', 'tsx'] : []), script, root], { signal, timeout: 30_000, maxBuffer: 16_384 }, error => error ? reject(error) : resolve());
        const closed = new Promise<void>(done => child.once('close', () => { this.children.delete(run.run_id); done(); }));
        this.children.set(run.run_id, { child, closed });
      });
      return collectFiles(root, JSON.parse(await readFile(join(root, 'statistics.json'), 'utf8')));
    }
    return { summary: 'three apples', value: 3 };
  }
  async cleanup(run: Run) {
    if (this.scenario === 'cleanup-unknown') return 'unknown' as const;
    if (this.children.has(run.run_id)) return 'unknown' as const;
    const root = this.directories.get(run.run_id);
    if (root) { await rm(root, { recursive: true, force: true }); this.directories.delete(run.run_id); }
    this.resources.delete(run.allocation?.resource_id ?? `fixture-${run.allocation?.operation_id}`);
    return 'absent' as const;
  }
  async forceStop(run: Run): Promise<'stopped' | 'unknown'> {
    this.stopped.add(run.run_id);
    const owned = this.children.get(run.run_id);
    if (!owned) return 'stopped';
    // Only this child's live Node handle is used; never enumerate or kill processes by a recycled numeric PID.
    if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill('SIGKILL');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([owned.closed.then(() => 'stopped' as const), new Promise<'unknown'>(r => { timer = setTimeout(() => r('unknown'), 5000); })]); }
    finally { clearTimeout(timer); }
  }
}

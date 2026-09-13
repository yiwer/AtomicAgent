import { contentDigest } from './submission.js';
import { ApiError, TaskError, type Run } from './domain.js';

export interface SkillSelection { id: string; version: string; must_use: boolean }
export interface SkillBinding extends SkillSelection { binding_ref: string; entry: string; markdown: string; content_digest: string }
export interface SkillEvidence { id: string; version: string; content_digest: string; requested: true; materialized: boolean; loaded: boolean | null; callable: boolean | null; used: boolean | null; invocation_id: string | null; attempt_id: string | null; source: string; observed_at: string | null; evidence_sources?: { materialized: string | null; loaded: string | null; used: string | null } }
// Maintainers publish only these reviewed, inert instructions. No scripts, settings, hooks, network or extra tool grants.
const samples = [
  { name: 'data-statistics', description: 'Process an uploaded CSV or JSON file with exact decimal statistics.', body: 'Invoke Bash with exactly `node /opt/atomicagent/dist/src/process-data.js` once. Return the statistics from that program as the required JSON result. Completion requires output/valid.csv and output/rejected.json. If processing fails, report the failure.' },
  { name: 'result-integrity', description: 'Report statistics computed from the current task file with explicit rejected rows.', body: 'Use the statistics returned by the registered process-data program. Preserve its exact totals, counts and groups in the final JSON. Completion requires reporting rejected_count without treating rejected rows as valid. Run the program once if it has not run in this task.' },
];
export const registeredSkills = samples.map(s => {
  const markdown = `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`;
  const entry = `atomic-registered:${s.name}`;
  return { binding_ref: `skill-${contentDigest({ entry, markdown })}`, entry, markdown, content_digest: contentDigest({ entry, markdown }) };
});
export function skillSelections(value: unknown): SkillSelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new ApiError(400, 'invalid_skills');
  const result = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['id', 'version', 'must_use'].includes(k)) ||
        typeof item.id !== 'string' || !/^[-a-zA-Z0-9_.]{1,80}$/.test(item.id) || typeof item.version !== 'string' || !/^[1-9][0-9]{0,6}$/.test(item.version) ||
        (item.must_use !== undefined && typeof item.must_use !== 'boolean')) throw new ApiError(400, 'invalid_skills');
    return { id: item.id as string, version: item.version as string, must_use: item.must_use === true };
  });
  if (new Set(result.map(s => s.id)).size !== result.length) throw new ApiError(400, 'invalid_skills');
  return result;
}
export function verifySkill(binding: SkillBinding) {
  if (!/^atomic-registered:[a-z][a-z0-9-]{0,63}$/.test(binding.entry) || binding.content_digest !== contentDigest({ entry: binding.entry, markdown: binding.markdown }) ||
      !binding.markdown.startsWith(`---\nname: ${binding.entry.split(':')[1]}\ndescription: `)) throw new TaskError('required_capability_failed');
}
export function requestedSkills(skills: SkillBinding[]): SkillEvidence[] {
  return skills.map(s => ({ id: s.id, version: s.version, content_digest: s.content_digest, requested: true, materialized: false, loaded: null, callable: null, used: null, invocation_id: null, attempt_id: null, source: 'platform:accepted-manifest', observed_at: null }));
}
export type ObserveSkills = (evidence: SkillEvidence[]) => void;
export function validateSkillEvidence(run: Run, value: unknown): SkillEvidence[] {
  const skills = run.manifest.skills ?? [];
  if (!Array.isArray(value) || value.length !== skills.length) throw new TaskError('required_capability_failed');
  return skills.map(s => {
    const e = value.find(e => e?.id === s.id && e?.version === s.version);
    if (!e || e.content_digest !== s.content_digest || e.requested !== true || e.attempt_id !== run.attempt_id ||
        ![true, false].includes(e.materialized) || ![true, false, null].includes(e.loaded) || ![true, false, null].includes(e.callable) || ![true, false, null].includes(e.used) ||
        (e.loaded === true && !e.materialized) || (e.callable === true && e.loaded !== true) ||
        (e.used === true && (e.callable !== true || typeof e.invocation_id !== 'string' || !/^[\w-]{1,128}$/.test(e.invocation_id))) ||
        typeof e.observed_at !== 'string' || !Number.isFinite(Date.parse(e.observed_at))) throw new TaskError('required_capability_failed');
    return { id: s.id, version: s.version, content_digest: s.content_digest, requested: true, materialized: e.materialized,
      loaded: e.loaded, callable: e.callable, used: e.used, invocation_id: e.used === true ? e.invocation_id : null,
      attempt_id: run.attempt_id, source: run.manifest.profile.mode === 'fixture' ? 'deterministic-fixture' : 'controlled-runner:skill-evidence', observed_at: e.observed_at,
      evidence_sources: run.manifest.profile.mode === 'fixture' ? { materialized: 'deterministic-fixture', loaded: 'deterministic-fixture', used: e.used ? 'deterministic-fixture' : null } : { materialized: e.materialized ? 'runner:verified-entry-file' : null, loaded: e.loaded !== null ? 'claude-sdk:system-init' : null, used: e.used === true ? 'claude-sdk:PostToolUse' : null } };
  });
}

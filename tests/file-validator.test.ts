import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectFiles } from '../src/sandbox-files.js';
import { ARTIFACT_LIMIT, INPUT_LIMIT, parseRows } from '../src/file-contract.js';
import { validateFiles } from '../src/file-validator.js';
import type { LoadedInput } from '../src/domain.js';

test('collection rejects required file symlinks instead of reading outside the task directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atomicagent-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work/output'), { recursive: true });
  await writeFile(join(root, 'outside.csv'), 'sensitive');
  await writeFile(join(root, 'work/process-data.completed'), 'process-data@1');
  // Directory junctions on Windows are the supported unprivileged symlink seam.
  await rm(join(root, 'work/output'), { recursive: true });
  await symlink(root, join(root, 'work/output'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectFiles(join(root, 'work'), {}), /output_invalid/);
});
test('oversized input and sparse output files are rejected before content processing', async t => {
  assert.throws(() => parseRows('x'.repeat(INPUT_LIMIT + 1), 'csv'), /invalid_file/);
  const root = await mkdtemp(join(tmpdir(), 'atomicagent-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'output')); await writeFile(join(root, 'process-data.completed'), 'process-data@1');
  await writeFile(join(root, 'output/valid.csv'), ''); await truncate(join(root, 'output/valid.csv'), ARTIFACT_LIMIT + 1);
  await assert.rejects(collectFiles(root, {}), /output_invalid/);
});
test('content acceptance handles many rows and categories without quadratic rescanning', () => {
  const count = 30_000;
  const content = 'id,category,value\n' + Array.from({ length: count }, (_, i) => `r${i},g${i},0.1\n`).join('');
  const input = { bytes: Buffer.from(content), binding: { format: 'csv' } } as LoadedInput;
  const result = { summary: 'independent repeated-decimal example', input_count: count, valid_count: count, rejected_count: 0,
    total: '3000', groups: Object.fromEntries(Array.from({ length: count }, (_, i) => [`g${i}`, '0.1'])) };
  const accepted = validateFiles({ candidate: result, execution: { tool: 'process-data@1', observed: true },
    files: [{ path: 'output/valid.csv', bytes: Buffer.from(content) }, { path: 'output/rejected.json', bytes: Buffer.from('[]') }] }, input);
  assert.equal(accepted.result.total, '3000');
});

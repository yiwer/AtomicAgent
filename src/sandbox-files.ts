import { readBounded } from './bounded-file.js';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ARTIFACT_LIMIT } from './file-contract.js';
import { TaskError, type FileCandidate } from './domain.js';

export async function readSandboxFile(root: string, relative: string, limit: number): Promise<Buffer> {
  const base = resolve(root); const path = resolve(root, relative);
  if (!path.startsWith(base + sep)) throw new TaskError('output_invalid');
  let current = base;
  for (const component of relative.split('/')) {
    if (!component || component === '.' || component === '..') throw new TaskError('output_invalid');
    current = join(current, component); const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TaskError('output_invalid');
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return await readBounded(file, limit);
  } finally { await file.close(); }
}
export async function collectFiles(root: string, candidate: unknown): Promise<FileCandidate> {
  try {
    const marker = await readSandboxFile(root, 'process-data.completed', 100);
    if (marker.toString() !== 'process-data@1') throw new TaskError('output_invalid');
    const files = []; let remaining = ARTIFACT_LIMIT;
    for (const path of ['output/valid.csv', 'output/rejected.json']) {
      const bytes = await readSandboxFile(root, path, remaining); remaining -= bytes.length; files.push({ path, bytes });
    }
    return { candidate, files, execution: { tool: 'process-data@1', observed: true } };
  } catch { throw new TaskError('output_invalid'); }
}

// Registered process-data@1 program. Only this fixed program is exposed to the file-task Agent.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRows, csvText, safeInputPath } from './file-contract.js';
export async function processData(root: string) {
  const request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8')) as { input_path: string; format: 'csv' | 'json' };
  if (!safeInputPath(request.input_path)) throw new Error('unsafe_input');
  const rows = parseRows(await readFile(join(root, request.input_path), 'utf8'), request.format);
  const valid = [], rejected = []; const sums = new Map<string, bigint>(); let total = 0n;
  for (const row of rows) {
    if (!/^-?\d{1,30}(\.\d{1,18})?$/.test(row.value)) { rejected.push(row); continue; }
    valid.push(row);
    const [whole, fraction = ''] = row.value.replace('-', '').split('.');
    const amount = BigInt(whole! + fraction.padEnd(18, '0')) * (row.value.startsWith('-') ? -1n : 1n);
    total += amount; sums.set(row.category, (sums.get(row.category) ?? 0n) + amount);
  }
  const decimal = (value: bigint) => {
    const digits = (value < 0n ? -value : value).toString().padStart(19, '0');
    const fraction = digits.slice(-18).replace(/0+$/, '');
    return `${value < 0n ? '-' : ''}${digits.slice(0, -18)}${fraction ? '.' + fraction : ''}`;
  };
  const result = { summary: `Processed ${rows.length} rows`, input_count: rows.length, valid_count: valid.length,
    rejected_count: rejected.length, total: decimal(total), groups: Object.fromEntries([...sums].map(([key, value]) => [key, decimal(value)])) };
  await mkdir(join(root, 'output'), { mode: 0o700 });
  await writeFile(join(root, 'output/valid.csv'), csvText(valid), { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'output/rejected.json'), JSON.stringify(rejected), { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'statistics.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'process-data.completed'), 'process-data@1', { flag: 'wx', mode: 0o600 });
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  processData(resolve(process.argv[2] ?? '/workspace')).then(result => process.stdout.write(JSON.stringify(result)))
    .catch(() => { process.stderr.write('file_processing_failed'); process.exitCode = 1; });
}

import { Ajv } from 'ajv';
import { fileSchema, parseRows, ARTIFACT_LIMIT, invalidOutput } from './file-contract.js';
import type { FileCandidate, FileResult, LoadedInput } from './domain.js';
const schema = new Ajv({ strict: true }).compile(fileSchema);
// Independent acceptance arithmetic: align each decimal to the maximum observed precision, with exact integer summation.
export function validateFiles(value: unknown, input: LoadedInput): { result: FileResult; files: FileCandidate['files'] } {
  const envelope = value as FileCandidate | null;
  if (!envelope || envelope.execution?.tool !== 'process-data@1' || envelope.execution?.observed !== true ||
      !schema(envelope.candidate) || !Array.isArray(envelope.files) || envelope.files.length !== 2) invalidOutput();
  const rows = parseRows(input.bytes.toString('utf8'), input.binding.format);
  const accepted = [], rejected = []; const categories = new Map<string, string[]>();
  for (const row of rows) {
    if (!/^-?[0-9]{1,30}(\.[0-9]{1,18})?$/.test(row.value)) { rejected.push(row); continue; }
    accepted.push(row); let values = categories.get(row.category);
    if (!values) { values = []; categories.set(row.category, values); } values.push(row.value);
  }
  const sum = (values: string[]) => {
    const scale = values.reduce((n, v) => Math.max(n, v.split('.')[1]?.length ?? 0), 0);
    let sum = 0n;
    for (const value of values) {
      const parts = value.split('.'); const decimalPlaces = parts[1]?.length ?? 0;
      sum += BigInt(parts.join('')) * 10n ** BigInt(scale - decimalPlaces);
    }
    const abs = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, '0');
    const fraction = scale ? abs.slice(-scale).replace(/0+$/, '') : '';
    return `${sum < 0n ? '-' : ''}${scale ? abs.slice(0, -scale) : abs}${fraction ? '.' + fraction : ''}`;
  };
  const groups = Object.fromEntries([...categories].map(([category, values]) => [category, sum(values)]));
  const candidate = envelope.candidate as FileResult;
  if (candidate.input_count !== rows.length || candidate.valid_count !== accepted.length || candidate.rejected_count !== rejected.length ||
      candidate.total !== sum(accepted.map(r => r.value)) || JSON.stringify(Object.entries(candidate.groups).sort()) !== JSON.stringify(Object.entries(groups).sort())) invalidOutput();
  const csv = envelope.files.find(f => f.path === 'output/valid.csv');
  const json = envelope.files.find(f => f.path === 'output/rejected.json');
  if (!csv || !json || envelope.files.some(f => !Buffer.isBuffer(f.bytes)) || envelope.files.reduce((n, f) => n + f.bytes.length, 0) > ARTIFACT_LIMIT) invalidOutput();
  try {
    if (JSON.stringify(parseRows(csv.bytes.toString('utf8'), 'csv')) !== JSON.stringify(accepted) ||
        JSON.stringify(JSON.parse(json.bytes.toString('utf8'))) !== JSON.stringify(rejected)) invalidOutput();
  } catch { invalidOutput(); }
  return { result: candidate, files: envelope.files };
}

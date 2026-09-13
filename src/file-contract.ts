import { TaskError } from './domain.js';

export const INPUT_LIMIT = 50 * 1024 * 1024;
export const ARTIFACT_LIMIT = 100 * 1024 * 1024;
export type DataRow = { id: string; category: string; value: string };
export const fileSchema = {
  type: 'object', properties: {
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    input_count: { type: 'integer', minimum: 0 }, valid_count: { type: 'integer', minimum: 0 },
    rejected_count: { type: 'integer', minimum: 0 }, total: { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$' },
    groups: { type: 'object', additionalProperties: { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$' } },
  }, required: ['summary', 'input_count', 'valid_count', 'rejected_count', 'total', 'groups'], additionalProperties: false,
} as const;
// RFC 4180 quoting; the registered data contract requires precisely these three columns.
export function parseRows(content: string, format: 'csv' | 'json'): DataRow[] {
  if (Buffer.byteLength(content) > INPUT_LIMIT || content.includes('\u0000')) throw new Error('invalid_file');
  let raw: unknown;
  if (format === 'json') raw = JSON.parse(content, (key: string, value: unknown, context?: { source?: string }) => {
    // Node 24 exposes source text for primitive reviver values; never round a decimal through binary Number.
    if (key === 'value' && typeof value === 'number') {
      if (!context?.source) throw new Error('decimal_source_unavailable');
      return context.source;
    }
    return value;
  });
  else {
    const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
    for (let i = 0; i < content.length; i++) {
      const c = content[i]!;
      if (quoted) {
        if (c === '"' && content[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') { quoted = false; closed = true; } else cell += c;
      } else if (c === ',' || c === '\n' || c === '\r') {
        row.push(cell); cell = ''; closed = false;
        if (c !== ',') { rows.push(row); row = []; if (c === '\r' && content[i + 1] === '\n') i++; }
      } else if (c === '"' && !cell && !closed) quoted = true;
      else { if (closed || c === '"') throw new Error('invalid_csv'); cell += c; }
    }
    if (quoted) throw new Error('invalid_csv');
    if (cell || row.length || closed) { row.push(cell); rows.push(row); }
    if (JSON.stringify(rows.shift()) !== '["id","category","value"]') throw new Error('invalid_columns');
    raw = rows.map(values => { if (values.length !== 3) throw new Error('invalid_columns'); return { id: values[0], category: values[1], value: values[2] }; });
  }
  if (!Array.isArray(raw)) throw new Error('invalid_rows');
  return raw.map(row => {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'category,id,value' ||
        typeof row.id !== 'string' || !row.id || typeof row.category !== 'string' || !row.category ||
        !['string', 'number'].includes(typeof row.value)) throw new Error('invalid_row');
    return { id: row.id, category: row.category, value: String(row.value) };
  });
}
export function csvText(rows: DataRow[]) {
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return 'id,category,value\n' + rows.map(row => [row.id, row.category, row.value].map(quote).join(',') + '\n').join('');
}
export function safeInputPath(path: unknown): path is string {
  return typeof path === 'string' && /^input\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(csv|json)$/.test(path);
}
export function invalidOutput(): never { throw new TaskError('output_invalid'); }

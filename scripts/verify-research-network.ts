// Public, credential-free first-party GETs only. This never calls a model or provider.
import { writeFile, mkdir } from 'node:fs/promises';
import { registeredMcps, probeMcp } from '../src/research.js';
const binding = { ...registeredMcps[1]!, id: 'network-verification', version: '1' };
const result = await probeMcp(binding);
await mkdir('.scratch/v0/evidence/ticket07', { recursive: true });
const report = { layer: 'real-local-MCP-protocol-and-public-network', model: 'not-called', sandbox: 'not-created', binding: { binding_ref: binding.binding_ref, transport: binding.transport, server: binding.server, version: binding.server_version, secret_ref: null }, evidence: result.evidence,
 sources: result.receipts.map(({ text, ...r }) => ({ ...r, snapshot_match: text === binding.sources.find(s => s.id === r.id)?.snapshot })),
 passed: result.evidence.connected === true && result.evidence.callable === true && result.evidence.authorized === true && result.receipts.length === 2 };
await writeFile('.scratch/v0/evidence/ticket07/network.json', JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n'); if (!report.passed) process.exitCode = 1;

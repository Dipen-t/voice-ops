import { beforeAll, afterAll, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { createPool } from '../../../packages/db/src/pool.js';
import { connectTelemetry } from '../src/client.js';

if (!process.env.DATABASE_URL) throw new Error('Restricted runtime DATABASE_URL required');
const pool = createPool(process.env.DATABASE_URL, 10000);
let client: Client;
let incident: { id: string; start_time_us: string; end_time_us: string };
let other: string;
const mode = process.env.MCP_TEST_CONTAINER === '1' ? 'container' : 'host';
beforeAll(async () => {
  const found = await pool.query("SELECT id,start_time_us,end_time_us FROM incidents WHERE import_status='ready' ORDER BY id LIMIT 2");
  if (found.rows.length !== 2) throw new Error('Two actual imported incidents are required');
  incident = found.rows[0]; other = found.rows[1].id;
  client = await connectTelemetry(incident.id, mode);
});
afterAll(async () => { await client?.close(); await pool.end(); });
async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args }, { timeout: 7000 });
}
function data(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  const text = result.content[0];
  if (text?.type !== 'text') throw new Error('Missing structured evidence');
  const parsed = JSON.parse(text.text);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}
it('discovers exactly five read-only tools over real stdio and lists only authorized incident', async () => {
  const found = await client.listTools({}, { timeout: 5000 });
  expect(found.tools.map(t => t.name).sort()).toEqual(['get_incident_summary','get_service_metrics','get_service_traces','list_incidents','search_service_logs']);
  expect(found.tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
  expect(data(await call('list_incidents', {})).incidents).toEqual([expect.objectContaining({ id: incident.id })]);
});
it('actual summary counts and coverage match restricted database observations', async () => {
  const summary = data(await call('get_incident_summary', { incident_id: incident.id }));
  expect(summary.incident).toEqual(expect.objectContaining(incident));
  const coverage = summary.coverage as { kind: string; service: string; record_count: string }[];
  for (const kind of ['metrics','logs','traces']) {
    const table = kind === 'metrics' ? 'metric_samples' : kind === 'logs' ? 'log_entries' : 'trace_spans';
    const actual = await pool.query(`SELECT count(*)::text AS count FROM ${table} WHERE incident_id=$1`, [incident.id]);
    expect(coverage.filter(c => c.kind === kind).reduce((total,c) => total + BigInt(c.record_count), 0n)).toBe(BigInt(actual.rows[0].count));
  }
});
it('all telemetry tools return exact recorded rows, clocks and provenance', async () => {
  const metric = (await pool.query('SELECT * FROM metric_samples WHERE incident_id=$1 ORDER BY source_row,source_field LIMIT 1', [incident.id])).rows[0];
  const result = data(await call('get_service_metrics', { incident_id: incident.id, service: metric.service, start: metric.ts_us, end: metric.ts_us, limit: 1 }));
  expect(result.records).toEqual([expect.objectContaining({ value: metric.value, unit: metric.unit, missing_kind: metric.missing_kind, ts_us: metric.ts_us, source_row: metric.source_row, source_field: metric.source_field })]);
  for (const [tool,table,time] of [['search_service_logs','log_entries','ts_us'], ['get_service_traces','trace_spans','start_time_us']] as const) {
    const row = (await pool.query(`SELECT * FROM ${table} WHERE incident_id=$1 ORDER BY source_row LIMIT 1`, [incident.id])).rows[0];
    const output = data(await call(tool, { incident_id: incident.id, start: row[time], end: row[time], limit: 1 }));
    expect(output.records).toEqual([expect.objectContaining({ source_row: row.source_row, source_ref: row.source_ref, [time]: row[time] })]);
    if (table === 'trace_spans') expect(output.records).toEqual([expect.objectContaining({ trace_id: row.trace_id, span_id: row.span_id, duration_us: row.duration_us, attributes: row.attributes })]);
  }
});
it('pagination advances without duplicates and rejects changed filters and forged cursors', async () => {
  const args = { incident_id: incident.id, limit: 2 };
  const first = data(await call('search_service_logs', args));
  expect(first.truncated).toBe(true);
  const second = data(await call('search_service_logs', { ...args, cursor: first.next_cursor }));
  const a = first.records as { source_row: string }[]; const b = second.records as { source_row: string }[];
  expect(BigInt(b[0]!.source_row)).toBeGreaterThan(BigInt(a.at(-1)!.source_row));
  expect((await call('search_service_logs', { ...args, cursor: first.next_cursor, query: 'different' })).isError).toBe(true);
  expect((await call('search_service_logs', { ...args, cursor: 'forged' })).isError).toBe(true);
});
it('rejects cross-incident access for every scoped tool and arbitrary SQL/shell inputs', async () => {
  for (const name of ['get_incident_summary','get_service_metrics','search_service_logs','get_service_traces']) {
    const args = { incident_id: other, ...(name === 'get_service_metrics' ? { service: 'frontend' } : {}) };
    const response = await call(name, args);
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain(other);
  }
  expect((await call('search_service_logs', { incident_id: incident.id, sql: 'DELETE FROM incidents' })).isError).toBe(true);
  expect((await call('search_service_logs', { incident_id: incident.id, limit: 101 })).isError).toBe(true);
  expect((await call('search_service_logs', { incident_id: incident.id, start: incident.start_time_us, end: (BigInt(incident.start_time_us)+900000001n).toString() })).isError).toBe(true);
  await expect(call('execute_shell', { command: 'whoami' })).rejects.toThrow();
  const empty = data(await call('search_service_logs', { incident_id: incident.id, query: "' OR 1=1; --" }));
  expect(empty.records).toEqual([]);
});
it('a cancelled protocol call leaves the server usable', async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10);
  await expect(client.callTool({ name: 'get_incident_summary', arguments: { incident_id: incident.id } }, { signal: abort.signal, timeout: 7000 })).rejects.toThrow();
  clearTimeout(timer);
  // Allow the cancellation notification and destroyed query connection to settle.
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(data(await call('list_incidents', {})).incidents).toHaveLength(1);
});

import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createPool } from '../../packages/db/src/pool.js';
import { normalizeTrace } from '../lib/normalize.js';
import { openParquet } from '../lib/parquet.js';
import { loadSelection } from '../lib/selection.js';
import { rawDirectory } from '../lib/source.js';

if (!process.env.ADMIN_DATABASE_URL || !process.env.DATABASE_URL) throw new Error('Separate database environments are required');
const adminUrl = process.env.ADMIN_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;

it('three actual recorded cases match source counts and validated checkpoints', async () => {
  const selection = await loadSelection();
  const pool = createPool(adminUrl, 10000);
  try {
    const incidents = await pool.query("SELECT id,import_status FROM incidents WHERE id=ANY($1::uuid[]) ORDER BY id", [selection.cases.map((entry) => entry.publicId)]);
    expect(incidents.rows).toHaveLength(3);
    expect(incidents.rows.every((row) => row.import_status === 'ready')).toBe(true);
    for (const selected of selection.cases) {
      const jobs = await pool.query('SELECT kind,source_rows::text,next_row::text,normalized_rows::text,status FROM import_jobs WHERE incident_id=$1 ORDER BY kind', [selected.publicId]);
      expect(jobs.rows).toHaveLength(3);
      for (const job of jobs.rows) {
        const parquet = await openParquet(resolve(rawDirectory, selected.publicId, `${job.kind}.parquet`));
        expect(Number(job.source_rows)).toBe(parquet.count);
        expect(Number(job.next_row)).toBe(parquet.count);
        expect(job.status).toBe('validated');
        expect(Number(job.normalized_rows)).toBe(parquet.count * (job.kind === 'metrics' ? parquet.schema.length - 2 : 1));
      }
    }
  } finally {
    await pool.end();
  }
});

it('missing metric observations are SQL NULL and source values round-trip', async () => {
  const selection = await loadSelection();
  const selected = selection.cases[0];
  if (!selected) throw new Error('Missing source case');
  const parquet = await openParquet(resolve(rawDirectory, selected.publicId, 'metrics.parquet'));
  const source = (await parquet.read(0, 1))[0];
  if (!source) throw new Error('Missing source sample');
  const pool = createPool(runtimeUrl, 10000);
  try {
    const result = await pool.query('SELECT source_field,value,missing_kind,ts_us::text FROM metric_samples WHERE incident_id=$1 AND source_row=0 ORDER BY source_field', [selected.publicId]);
    expect(result.rows).toHaveLength(Object.keys(source).length - 1);
    let missing = 0;
    for (const metric of result.rows) {
      expect(metric.value).toBe(source[metric.source_field]);
      expect(metric.ts_us).toBe((BigInt(String(source.time)) * 1000000n).toString());
      if (source[metric.source_field] == null) {
        missing++;
        expect(metric.missing_kind).toBe('null');
      }
    }
    expect(missing).toBeGreaterThan(0);
  } finally {
    await pool.end();
  }
});

it('trace identifiers and sub-millisecond timestamps survive the database round trip', async () => {
  const selection = await loadSelection();
  const pool = createPool(runtimeUrl, 10000);
  try {
    for (const selected of selection.cases) {
      const parquet = await openParquet(resolve(rawDirectory, selected.publicId, 'traces.parquet'));
      const sample = (await parquet.read(0, 1))[0];
      if (!sample) throw new Error('Missing source trace');
      const expected = normalizeTrace(sample, 0, selected.publicId);
      const result = await pool.query('SELECT trace_id,span_id,parent_span_id,start_time_us::text,duration_us::text,status_code,attributes FROM trace_spans WHERE incident_id=$1 AND source_row=0', [selected.publicId]);
      const row = result.rows[0];
      for (const key of ['trace_id', 'span_id', 'parent_span_id', 'start_time_us', 'duration_us', 'status_code', 'attributes']) expect(row[key]).toEqual(expected[key]);
      expect(BigInt(row.start_time_us) % 1000n).not.toBe(0n);
    }
  } finally {
    await pool.end();
  }
});

it('runtime-visible metadata contains no answer labels or original source case names', async () => {
  const selection = await loadSelection();
  // A full offline provenance scan has a separate 10s validation budget.
  // API readiness and later scoped telemetry tools keep their own short limits.
  const pool = createPool(runtimeUrl, 10000);
  try {
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('incidents','metric_samples','log_entries','trace_spans')");
    for (const column of columns.rows) expect(['root_cause_service', 'fault', 'fault_description', 'source_case_name', 'inject_time']).not.toContain(column.column_name);
    const incidents = await pool.query('SELECT * FROM incidents');
    const payload = JSON.stringify(incidents.rows);
    for (const selected of selection.cases) expect(payload).not.toContain(selected.source.case);
    const paths = await pool.query(`SELECT source_ref FROM log_entries WHERE source_ref !~ '^logs:[0-9]+$' LIMIT 1`);
    expect(paths.rows).toHaveLength(0);
    const tracePaths = await pool.query(`SELECT source_ref FROM trace_spans WHERE source_ref !~ '^traces:[0-9]+$' LIMIT 1`);
    expect(tracePaths.rows).toHaveLength(0);
  } finally {
    await pool.end();
  }
});

import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Client } from 'pg';
import { z } from 'zod';
import { createPool } from '../packages/db/src/pool.js';
import { integer, normalizeLog, normalizeMetrics, normalizeTrace } from './lib/normalize.js';
import type { Row } from './lib/normalize.js';
import { openParquet } from './lib/parquet.js';
import { loadSelection } from './lib/selection.js';
import { checksum, json, rawDirectory, saveJson } from './lib/source.js';

type Kind = 'metrics' | 'logs' | 'traces';
const descriptions: Record<Kind, { table: string; time: string; nullable: string; fields: string }> = {
  metrics: { table: 'metric_samples', time: 'ts_us', nullable: 'value', fields: 'incident_id uuid, source_row bigint, source_field text, ts_us bigint, service text, metric_name text, value double precision, unit text, missing_kind text' },
  logs: { table: 'log_entries', time: 'ts_us', nullable: 'message', fields: 'incident_id uuid, source_row bigint, ts_us bigint, service text, severity text, message text, source_ref text' },
  traces: { table: 'trace_spans', time: 'start_time_us', nullable: 'status_code', fields: 'incident_id uuid, source_row bigint, trace_id text, span_id text, parent_span_id text, service text, source_service text, start_time_us bigint, duration_us bigint, status_code text, attributes jsonb, source_ref text' },
};

const jobSchema = z.object({
  sha256: z.string(), next_row: z.coerce.number(), normalized_rows: z.coerce.number(),
  null_values: z.coerce.number(), min_time_us: z.string().nullable(), max_time_us: z.string().nullable(), status: z.string(),
});

async function importData() {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.EVALUATOR_DATABASE_URL) throw new Error('Separate administrative and evaluator environments are required');
  const selection = await loadSelection();
  const pool = createPool(process.env.ADMIN_DATABASE_URL, 30000);
  const evaluator = new Client({ connectionString: process.env.EVALUATOR_DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const client = await pool.connect();
  let batches = 0;
  let rowsInsertedThisRun = 0;
  let complete = true;
  const limitArgument = process.argv.find((argument) => argument.startsWith('--stop-after-batches='));
  const stopAfter = limitArgument ? z.coerce.number().int().positive().parse(limitArgument.split('=')[1]) : Infinity;
  const reports: unknown[] = [];
  let activeIncident: string | undefined;
  let activeKind: Kind | undefined;
  try {
    // One importer holds a session lock; batch commits still permit safe resume.
    const lock = await client.query('SELECT pg_try_advisory_lock(74639202) AS acquired');
    if (!lock.rows[0]?.acquired) throw new Error('Another importer is running');
    await evaluator.connect();
    for (const selected of selection.cases) {
      activeIncident = selected.publicId;
      activeKind = undefined;
      await evaluator.query(`INSERT INTO evaluation_cases(public_incident_id, source_case_name, root_cause_service, fault, inject_time_seconds, dataset_revision, source_files)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (public_incident_id) DO UPDATE SET source_files=EXCLUDED.source_files`,
      [selected.publicId, selected.source.case, selected.source.root_cause_service, selected.source.fault, selected.source.inject_time, selection.revision, json(selected.files)]);
      await client.query(`INSERT INTO incidents(id, display_title, system, start_time_us, end_time_us, import_status)
        VALUES ($1,$2,$3,$4,$5,'importing') ON CONFLICT (id) DO NOTHING`,
      [selected.publicId, selected.displayTitle, selected.source.system, (BigInt(selected.source.time_start) * 1000000n).toString(), (BigInt(selected.source.time_end) * 1000000n).toString()]);
      const caseReports: Row[] = [];
      for (const entry of selected.files) {
        activeKind = entry.kind;
        const path = resolve(rawDirectory, selected.publicId, `${entry.kind}.parquet`);
        const sha256 = await checksum(path);
        if (entry.expectedSha256 && entry.expectedSha256 !== sha256) throw new Error('Local source checksum differs from pinned dataset');
        const parquet = await openParquet(path);
        const expectedRows = entry.kind === 'metrics' ? selected.source.n_timesteps : entry.kind === 'logs' ? selected.source.n_logs : selected.source.n_traces;
        if (parquet.count !== expectedRows) throw new Error('Parquet count differs from the source index');
        const width = parquet.schema.length - 2;
        if (entry.kind === 'metrics' && width !== selected.source.n_metrics) throw new Error('Metric width differs from the source index');
        await client.query(`INSERT INTO import_jobs(incident_id,kind,revision,sha256,source_bytes,source_rows)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (incident_id,kind) DO NOTHING`,
        [selected.publicId, entry.kind, selection.revision, sha256, entry.bytes, parquet.count]);
        const result = await client.query('SELECT * FROM import_jobs WHERE incident_id=$1 AND kind=$2', [selected.publicId, entry.kind]);
        const job = jobSchema.parse(result.rows[0]);
        if (job.sha256 !== sha256) throw new Error('Existing checkpoint uses a different source; explicit reimport is required');
        let count = job.normalized_rows;
        let nulls = job.null_values;
        let minimum = job.min_time_us ? BigInt(job.min_time_us) : null;
        let maximum = job.max_time_us ? BigInt(job.max_time_us) : null;
        const description = descriptions[entry.kind];
        const batchSize = entry.kind === 'metrics' ? 32 : 2048;
        console.log(`${selected.displayTitle}: ${entry.kind}, resuming at source row ${job.next_row}/${parquet.count}`);
        for (let start = job.next_row; start < parquet.count; start += batchSize) {
          const end = Math.min(start + batchSize, parquet.count);
          const sourceRows = await parquet.read(start, end);
          if (sourceRows.length !== end - start) throw new Error('Parquet reader returned an incomplete range');
          const normalized = sourceRows.flatMap((row, offset) => entry.kind === 'metrics'
            ? normalizeMetrics(row, start + offset, selected.publicId)
            : [entry.kind === 'logs' ? normalizeLog(row, start + offset, selected.publicId) : normalizeTrace(row, start + offset, selected.publicId)]);
          for (const row of normalized) {
            const time = integer(row[description.time], description.time);
            if (minimum === null || time < minimum) minimum = time;
            if (maximum === null || time > maximum) maximum = time;
            if (row[description.nullable] === null) nulls++;
          }
          count += normalized.length;
          const payload = json(normalized);
          if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new Error('Import batch exceeded 8 MiB');
          await client.query('BEGIN');
          try {
            // Table/type strings are fixed constants; all data is parameterized.
            const inserted = await client.query(`INSERT INTO ${description.table} SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(${description.fields})`, [payload]);
            if (inserted.rowCount !== normalized.length) throw new Error('Inserted batch row count differs');
            await client.query(`UPDATE import_jobs SET next_row=$3,normalized_rows=$4,null_values=$5,min_time_us=$6,max_time_us=$7,status='importing',updated_at=now()
              WHERE incident_id=$1 AND kind=$2`, [selected.publicId, entry.kind, end, count, nulls, minimum?.toString(), maximum?.toString()]);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
          batches++;
          rowsInsertedThisRun += normalized.length;
          if (batches >= stopAfter) {
            console.log(`Checkpoint saved after ${batches} batches; rerun data:import to resume.`);
            complete = false;
            return;
          }
          if (start === job.next_row || end === parquet.count || end % (batchSize * 50) === 0) console.log(`${selected.displayTitle}: ${entry.kind}, committed ${end}/${parquet.count} source rows`);
        }
        const normalizedExpected = entry.kind === 'metrics' ? parquet.count * width : parquet.count;
        const verification = await client.query(`SELECT count(*)::text AS rows, count(*) FILTER (WHERE ${description.nullable} IS NULL)::text AS nulls,
          min(${description.time})::text AS minimum, max(${description.time})::text AS maximum,
          count(DISTINCT source_row)::text AS source_rows FROM ${description.table} WHERE incident_id=$1`, [selected.publicId]);
        const observed = z.object({ rows: z.coerce.number(), nulls: z.coerce.number(), minimum: z.string(), maximum: z.string(), source_rows: z.coerce.number() }).parse(verification.rows[0]);
        if (observed.rows !== normalizedExpected || observed.rows !== count || observed.source_rows !== parquet.count || observed.nulls !== nulls || observed.minimum !== minimum?.toString() || observed.maximum !== maximum?.toString()) {
          throw new Error('Post-import counts, nulls or clocks disagree with source');
        }
        if (entry.kind === 'metrics' && (minimum !== BigInt(selected.source.time_start) * 1000000n || maximum !== BigInt(selected.source.time_end) * 1000000n)) throw new Error('Metrics source window differs from the index');
        // Compare actual first and last source rows after database round trip.
        for (const sourceIndex of [0, parquet.count - 1]) {
          const source = (await parquet.read(sourceIndex, sourceIndex + 1))[0];
          if (!source) throw new Error('Missing sample row');
          if (entry.kind === 'traces') {
            const expected = normalizeTrace(source, sourceIndex, selected.publicId);
            const sample = await client.query('SELECT trace_id,span_id,parent_span_id,start_time_us::text,duration_us::text,status_code,attributes FROM trace_spans WHERE incident_id=$1 AND source_row=$2', [selected.publicId, sourceIndex]);
            for (const key of ['trace_id', 'span_id', 'parent_span_id', 'start_time_us', 'duration_us', 'status_code', 'attributes']) {
              if (!isDeepStrictEqual(sample.rows[0]?.[key], expected[key])) throw new Error('Trace sample round-trip differs from source');
            }
          }
        }
        await client.query("UPDATE import_jobs SET status='validated',updated_at=now() WHERE incident_id=$1 AND kind=$2", [selected.publicId, entry.kind]);
        caseReports.push({ kind: entry.kind, sourceRows: parquet.count, normalizedRows: observed.rows, nullValues: observed.nulls, minTimeUs: observed.minimum, maxTimeUs: observed.maximum, bytes: entry.bytes });
        console.log(`${selected.displayTitle}: ${entry.kind} validated (${observed.rows} stored rows)`);
      }
      const ranges = caseReports.map((report) => [BigInt(String(report.minTimeUs)), BigInt(String(report.maxTimeUs))]);
      const start = ranges.reduce((minimum, [time]) => time !== undefined && time < minimum ? time : minimum, BigInt(selected.source.time_start) * 1000000n);
      const end = ranges.reduce((maximum, [, time]) => time !== undefined && time > maximum ? time : maximum, BigInt(selected.source.time_end) * 1000000n);
      await client.query("UPDATE incidents SET import_status='ready', start_time_us=$2,end_time_us=$3 WHERE id=$1", [selected.publicId, start.toString(), end.toString()]);
      reports.push({ incidentId: selected.publicId, title: selected.displayTitle, telemetry: caseReports });
    }
    await saveJson(resolve('eval/reports/data-validation.json'), { capturedAt: new Date().toISOString(), revision: selection.revision, totalSourceBytes: selection.totalBytes,
      batchesCommittedThisRun: batches, rowsInsertedThisRun, maximumResidentSetKiB: process.resourceUsage().maxRSS, cases: reports });
    console.log('Three incidents imported and validated. Sanitized report: eval/reports/data-validation.json');
  } catch (error) {
    if (activeIncident) {
      await client.query("UPDATE incidents SET import_status='failed' WHERE id=$1", [activeIncident]);
      if (activeKind) await client.query("UPDATE import_jobs SET status='failed',updated_at=now() WHERE incident_id=$1 AND kind=$2", [activeIncident, activeKind]);
    }
    throw error;
  } finally {
    if (!complete) console.log('Import intentionally paused at a committed checkpoint.');
    await evaluator.end();
    await client.query('SELECT pg_advisory_unlock(74639202)');
    client.release();
    await pool.end();
  }
}

importData().catch((error: unknown) => {
  // Do not echo PostgreSQL errors, source paths or telemetry messages.
  const safeMessages = ['Local source checksum differs from pinned dataset', 'Parquet count differs from the source index', 'Metric width differs from the source index', 'Post-import counts, nulls or clocks disagree with source', 'Metrics source window differs from the index', 'Trace source clocks disagree', 'Trace sample round-trip differs from source', 'Another importer is running'];
  console.error(error instanceof Error && safeMessages.includes(error.message) ? error.message : 'Data import failed. Check private source files, database setup and the last committed checkpoint.');
  process.exitCode = 1;
});

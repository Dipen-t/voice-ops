import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { Cursors } from './cursor.js';
import { ToolFailure, windowBounds, type Slice } from './contracts.js';

type Incident = { id: string; display_title: string; system: string; start_time_us: string; end_time_us: string };
export class Telemetry {
  private busy = false;
  private readonly cursors = new Cursors();
  constructor(private readonly pool: Pool, private readonly incidentId: string) {}
  async call(kind: 'list' | 'summary' | 'metrics' | 'logs' | 'traces', input: Partial<Slice>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (input.incident_id !== undefined && input.incident_id !== this.incidentId) throw new ToolFailure('INCIDENT_NOT_AUTHORIZED');
    if (this.busy) throw new ToolFailure('SERVER_BUSY');
    this.busy = true;
    let client: PoolClient | undefined;
    let destroyed = false;
    const cancel = () => { if (client && !destroyed) { destroyed = true; client.release(true); } };
    try {
      signal.throwIfAborted();
      client = await this.pool.connect();
      client.on('error', () => { /* Query errors are returned without connection details. */ });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); throw new ToolFailure('CANCELLED'); }
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '3000ms'");
      const query = async <T extends QueryResultRow>(sql: string, args: unknown[] = []) => {
        signal.throwIfAborted();
        return (await client!.query<T>(sql, args)).rows;
      };
      const [identity] = await query<{ current_user: string }>('SELECT current_user');
      if (identity?.current_user !== 'voiceops_runtime') throw new ToolFailure('RUNTIME_ROLE_REQUIRED');
      const [incident] = await query<Incident>('SELECT id, display_title, system, start_time_us, end_time_us FROM incidents WHERE id=$1 AND import_status=\'ready\'', [this.incidentId]);
      if (!incident) throw new ToolFailure('INCIDENT_UNAVAILABLE');
      let result: Record<string, unknown>;
      if (kind === 'list') result = { incidents: [incident] };
      else if (kind === 'summary') {
        const coverage = await query(`SELECT 'metrics' AS kind, service, count(*)::text AS record_count, min(ts_us)::text AS start_time_us, max(ts_us)::text AS end_time_us, count(*) FILTER (WHERE missing_kind IS NOT NULL)::text AS missing_values FROM metric_samples WHERE incident_id=$1 GROUP BY service
          UNION ALL SELECT 'logs', service, count(*)::text, min(ts_us)::text, max(ts_us)::text, count(*) FILTER (WHERE message IS NULL)::text FROM log_entries WHERE incident_id=$1 GROUP BY service
          UNION ALL SELECT 'traces', service, count(*)::text, min(start_time_us)::text, max(start_time_us)::text, count(*) FILTER (WHERE status_code IS NULL)::text FROM trace_spans WHERE incident_id=$1 GROUP BY service ORDER BY kind,service LIMIT 101`, [this.incidentId]);
        result = { incident, coverage: coverage.slice(0, 100), truncated: coverage.length > 100, timestamp_unit: 'epoch_microseconds', unknown_metric_units: true, missing_trace_status_is_not_success: true };
      } else {
        const args = input as Slice;
        const bounds = windowBounds(args, incident.start_time_us, incident.end_time_us);
        const binding = createHash('sha256').update(JSON.stringify([kind, this.incidentId, args.service, bounds, args.metric_names, args.query, args.trace_id])).digest('hex');
        const cursor = this.cursors.decode(args.cursor, binding);
        const values: unknown[] = [this.incidentId, bounds.start, bounds.end];
        const time = kind === 'traces' ? 'start_time_us' : 'ts_us';
        const clauses = ['incident_id=$1', `${time} BETWEEN $2::bigint AND $3::bigint`];
        const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
        if (args.service) add('service=?', args.service);
        if (kind === 'metrics' && args.metric_names) add('metric_name=ANY(?::text[])', args.metric_names);
        // strpos is literal substring search: user text cannot become SQL or LIKE wildcards.
        if (kind === 'logs' && args.query) add('strpos(message,?)>0', args.query);
        if (kind === 'traces' && args.trace_id) add('trace_id=?', args.trace_id);
        if (kind === 'metrics') {
          values.push(cursor.row, cursor.field);
          clauses.push(`(source_row,source_field)>($${values.length - 1}::bigint,$${values.length}::text)`);
        } else add('source_row>?::bigint', cursor.row);
        values.push(args.limit + 1);
        const table = kind === 'metrics' ? 'metric_samples' : kind === 'logs' ? 'log_entries' : 'trace_spans';
        const columns = kind === 'metrics' ? "source_row,source_field,ts_us,service,metric_name,value,unit,missing_kind,'metrics:'||source_row||':'||source_field AS source_ref"
          : kind === 'logs' ? 'source_row,ts_us,service,severity,left(message,2048) AS message,coalesce(length(message)>2048,false) AS message_truncated,source_ref'
          : 'source_row,trace_id,span_id,parent_span_id,service,source_service,start_time_us,duration_us,status_code,attributes,source_ref';
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY source_row${kind === 'metrics' ? ',source_field' : ''} LIMIT $${values.length}`, values);
        const records: QueryResultRow[] = [];
        let bytes = 0;
        for (const row of rows.slice(0, args.limit)) {
          const size = Buffer.byteLength(JSON.stringify(row));
          if (bytes + size > 28000) break;
          records.push(row); bytes += size;
        }
        const truncated = rows.length > records.length;
        const last = records.at(-1);
        if (truncated && !last) throw new ToolFailure('RECORD_TOO_LARGE');
        result = { incident_id: this.incidentId, records, timestamp_unit: 'epoch_microseconds', duration_unit: kind === 'traces' ? 'microseconds' : null,
          window: bounds, order: kind === 'metrics' ? 'source_row,source_field' : 'source_row', truncated,
          next_cursor: truncated && last ? this.cursors.encode(binding, String(last.source_row), String(last.source_field ?? '')) : null,
          empty: records.length === 0, evidence_is_untrusted_data: true };
      }
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(result)) > 32000) throw new ToolFailure('RESULT_TOO_LARGE');
      await client.query('COMMIT');
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
      // Destroy instead of returning a transaction to the pool, including on failure/cancellation.
      if (client && !destroyed) client.release(true);
      this.busy = false;
    }
  }
}

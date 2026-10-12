export type Row = Record<string, unknown>;

export function integer(value: unknown, field: string): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'string' && /^-?\d+$/.test(value)) parsed = BigInt(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else throw new Error(`Invalid or imprecise integer in ${field}`);
  if (parsed < -(2n ** 63n) || parsed >= 2n ** 63n) throw new Error(`Integer outside PostgreSQL BIGINT range in ${field}`);
  return parsed;
}

export function text(value: unknown, field: string, maxBytes = 65536): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes || value.includes('\0')) throw new Error(`Invalid or oversized text in ${field}`);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : text(value, field);
}

function identifier(value: unknown, field: string): string {
  if (typeof value === 'string') return text(value, field, 256);
  return integer(value, field).toString();
}

export function splitMetric(field: string) {
  const position = field.lastIndexOf('_');
  if (position <= 0 || position === field.length - 1) throw new Error('Unrecognized metric column naming');
  return { service: field.slice(0, position), metric_name: field.slice(position + 1) };
}

export function normalizeMetrics(row: Row, index: number, incidentId: string): Row[] {
  const ts = integer(row.time, 'time') * 1000000n;
  return Object.entries(row).filter(([field]) => field !== 'time').map(([field, value]) => {
    let missing: 'null' | 'nan' | null = null;
    if (value === null || value === undefined) missing = 'null';
    else if (typeof value === 'number' && Number.isNaN(value)) missing = 'nan';
    else if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Unsupported metric value');
    return { incident_id: incidentId, source_row: index, source_field: field, ts_us: ts.toString(), ...splitMetric(field), value: missing ? null : value, unit: null, missing_kind: missing };
  });
}

export function normalizeLog(row: Row, index: number, incidentId: string): Row {
  return {
    incident_id: incidentId, source_row: index,
    ts_us: (integer(row.timestamp, 'timestamp') * 1000000n).toString(),
    service: text(row.container_name, 'container_name', 256),
    severity: null, message: nullableText(row.message, 'message'), source_ref: `logs:${index}`,
  };
}

export function normalizeTrace(row: Row, index: number, incidentId: string): Row {
  const start = integer(row.startTime, 'startTime');
  const milliseconds = integer(row.startTimeMillis, 'startTimeMillis');
  if (start / 1000n !== milliseconds) throw new Error('Trace source clocks disagree');
  const sourceService = text(row.serviceName, 'serviceName', 256);
  const attributes = {
    time_display: nullableText(row.time, 'time'),
    method_name: nullableText(row.methodName, 'methodName'),
    operation_name: nullableText(row.operationName, 'operationName'),
    start_time_millis: milliseconds.toString(),
  };
  if (Buffer.byteLength(JSON.stringify(attributes)) > 16384) throw new Error('Trace attributes exceed their storage budget');
  const duration = integer(row.duration, 'duration');
  if (duration < 0n) throw new Error('Negative trace duration');
  return {
    incident_id: incidentId, source_row: index,
    trace_id: identifier(row.traceID, 'traceID'), span_id: identifier(row.spanID, 'spanID'),
    parent_span_id: row.parentSpanID == null ? null : identifier(row.parentSpanID, 'parentSpanID'),
    // The trace source calls the frontend "frontendservice"; metrics/logs use "frontend".
    service: sourceService === 'frontendservice' ? 'frontend' : sourceService,
    source_service: sourceService, start_time_us: start.toString(), duration_us: duration.toString(),
    status_code: row.statusCode == null ? null : integer(row.statusCode, 'statusCode').toString(),
    attributes, source_ref: `traces:${index}`,
  };
}

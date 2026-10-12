import { describe, expect, it } from 'vitest';
import { integer, normalizeLog, normalizeMetrics, normalizeTrace, splitMetric } from '../lib/normalize.js';

// Explicitly synthetic edge fixtures; actual source files are tested separately.
describe('source normalization', () => {
  it('preserves missing metrics separately from zeros', () => {
    const rows = normalizeMetrics({ time: 1700000000n, cartservice_cpu: null, cartservice_mem: 0, cartservice_error: NaN }, 2, 'fixture');
    expect(rows.map((row) => [row.value, row.missing_kind])).toEqual([[null, 'null'], [0, null], [null, 'nan']]);
    expect(rows[0]?.ts_us).toBe('1700000000000000');
  });
  it('splits the metric suffix while preserving underscores in service names', () => {
    expect(splitMetric('service_with_underscore_latency-90')).toEqual({ service: 'service_with_underscore', metric_name: 'latency-90' });
  });
  it('rejects unsafe numeric integers rather than silently rounding them', () => {
    expect(() => integer(Number.MAX_SAFE_INTEGER + 1, 'id')).toThrow('imprecise integer');
    expect(integer('1844674407370955161', 'id').toString()).toBe('1844674407370955161');
    expect(() => integer('18446744073709551615', 'id')).toThrow('BIGINT range');
  });
  const trace = { time: '12:00', traceID: '18446744073709551615', spanID: 'abcdef', parentSpanID: null, serviceName: 'frontendservice', methodName: null, operationName: 'request', startTime: 10000000000000001n, startTimeMillis: 10000000000000n, duration: 17n, statusCode: null };
  it('keeps trace IDs and microsecond timestamps exact', () => {
    const normalized = normalizeTrace(trace, 0, 'fixture');
    expect(normalized.trace_id).toBe(trace.traceID);
    expect(normalized.start_time_us).toBe('10000000000000001');
    expect(normalized.duration_us).toBe('17');
    expect(normalized.service).toBe('frontend');
    expect(normalized.source_service).toBe('frontendservice');
    expect(normalized.status_code).toBeNull();
  });
  it('rejects inconsistent clocks and negative durations', () => {
    expect(() => normalizeTrace({ ...trace, startTimeMillis: 1n }, 0, 'fixture')).toThrow('clocks disagree');
    expect(() => normalizeTrace({ ...trace, duration: -1n }, 0, 'fixture')).toThrow('Negative');
  });
  it('preserves log text and seconds without adding filename hints', () => {
    const result = normalizeLog({ timestamp: 1700000000n, container_name: 'frontend', message: 'observed message' }, 9, 'fixture');
    expect(result.ts_us).toBe('1700000000000000');
    expect(result.source_ref).toBe('logs:9');
    expect(result.message).toBe('observed message');
  });
  it('rejects oversized text instead of silently dropping source evidence', () => {
    expect(() => normalizeLog({ timestamp: 1n, container_name: 'frontend', message: 'x'.repeat(65537) }, 0, 'fixture')).toThrow('oversized');
  });
});

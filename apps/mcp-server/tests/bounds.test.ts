import { expect, it } from 'vitest';
import { metrics, logs, windowBounds } from '../src/contracts.js';
import { Cursors } from '../src/cursor.js';

it('synthetic inputs reject unsafe clocks, unknown fields and oversized queries', () => {
  const incident_id = '00000000-0000-4000-8000-000000000001';
  expect(metrics.safeParse({ incident_id, service: 'frontend', start: '9223372036854775808' }).success).toBe(false);
  expect(logs.safeParse({ incident_id, sql: 'SELECT 1' }).success).toBe(false);
  expect(logs.safeParse({ incident_id, limit: 101 }).success).toBe(false);
  expect(logs.safeParse({ incident_id, query: 'x'.repeat(129) }).success).toBe(false);
});
it('synthetic windows keep exact microseconds and enforce coverage and duration', () => {
  expect(windowBounds({ start: '1708474641000001', end: '1708474641000002' }, '1708474641000000', '1708475570000000')).toEqual({ start: '1708474641000001', end: '1708474641000002' });
  expect(() => windowBounds({}, '0', '1')).not.toThrow();
  expect(() => windowBounds({ start: '0', end: '900000001' }, '0', '1000000000')).toThrow('INVALID_WINDOW');
  expect(() => windowBounds({ start: '2', end: '1' }, '0', '10')).toThrow('INVALID_WINDOW');
});
it('synthetic pagination tokens reject tampering, changed filters and other sessions', () => {
  const cursors = new Cursors();
  const token = cursors.encode('filter-one', '42', 'field');
  expect(cursors.decode(token, 'filter-one')).toEqual({ row: '42', field: 'field' });
  expect(() => cursors.decode(`${token}x`, 'filter-one')).toThrow('INVALID_CURSOR');
  expect(() => cursors.decode(token, 'filter-two')).toThrow('INVALID_CURSOR');
  expect(() => new Cursors().decode(token, 'filter-one')).toThrow('INVALID_CURSOR');
});

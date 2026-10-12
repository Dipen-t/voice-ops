import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { Telemetry } from '../src/telemetry.js';

it('synthetic stalled database query is destroyed on cancellation and busy state recovers', async () => {
  const released = vi.fn();
  let rejectQuery: (reason: Error) => void = () => {};
  const query = vi.fn(() => new Promise((_resolve, reject) => { rejectQuery = reject; }));
  const client = { query, on: vi.fn(), release: (destroy: boolean) => { released(destroy); rejectQuery(new Error('connection destroyed')); } } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const telemetry = new Telemetry(pool, '00000000-0000-4000-8000-000000000001');
  const abort = new AbortController();
  const first = telemetry.call('list', {}, abort.signal);
  await vi.waitFor(() => expect(query).toHaveBeenCalled());
  await expect(telemetry.call('list', {}, abort.signal)).rejects.toThrow('SERVER_BUSY');
  abort.abort();
  await expect(first).rejects.toThrow('connection destroyed');
  expect(released).toHaveBeenCalledExactlyOnceWith(true);
  await expect(telemetry.call('list', {}, AbortSignal.abort())).rejects.not.toThrow('SERVER_BUSY');
});
it('synthetic out-of-scope requests never acquire a database connection', async () => {
  const connect = vi.fn();
  const telemetry = new Telemetry({ connect } as unknown as Pool, '00000000-0000-4000-8000-000000000001');
  await expect(telemetry.call('summary', { incident_id: '00000000-0000-4000-8000-000000000002' }, new AbortController().signal)).rejects.toThrow('INCIDENT_NOT_AUTHORIZED');
  expect(connect).not.toHaveBeenCalled();
});

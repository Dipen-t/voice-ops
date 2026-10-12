import { Pool } from 'pg';

export function createPool(connectionString: string, timeoutMs = 1500): Pool {
  return new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: timeoutMs,
    idleTimeoutMillis: 10000,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: 'voiceops-foundation',
  });
}

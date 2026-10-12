import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../../../packages/db/src/pool.js';

const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it('readiness reaches real PostgreSQL and Redis', async () => {
  const app = buildApp(config);
  apps.push(app);
  const response = await app.inject('/health/ready');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ready', dependencies: { postgres: 'up', redis: 'up' } });
});

it.each(['DATABASE_URL', 'REDIS_URL'] as const)('readiness fails for unreachable %s', async (key) => {
  const url = new URL(config[key]);
  url.port = '1';
  const app = buildApp({ ...config, [key]: url.toString(), HEALTH_TIMEOUT_MS: 300 });
  apps.push(app);
  const response = await app.inject('/health/ready');
  expect(response.statusCode).toBe(503);
  expect(response.json().dependencies[key === 'DATABASE_URL' ? 'postgres' : 'redis']).toBe('down');
});

it('migration enabled pgvector and recorded its version', async () => {
  const pool = createPool(process.env.ADMIN_DATABASE_URL ?? config.DATABASE_URL);
  try {
    const result = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].extversion).toBe('0.8.1');
    const migrations = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(migrations.rows).toEqual([{ name: '001_foundation.sql' }, { name: '002_telemetry.sql' }, { name: '003_knowledge.sql' }]);
  } finally {
    await pool.end();
  }
});

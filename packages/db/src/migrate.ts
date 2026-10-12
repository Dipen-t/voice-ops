import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';

async function migrate() {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Administrative database URL is required');
  const pool = createPool(connectionString, 10000);
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(74639201)');
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
      for (const name of names) {
        const existing = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [name]);
        if (existing.rowCount) continue;
        await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
        console.log(`Applied ${name}`);
      }
      await client.query('COMMIT');
      console.log('Database migrations complete');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

migrate().catch(() => {
  console.error('Migration failed; check database connectivity and extension permissions.');
  process.exitCode = 1;
});

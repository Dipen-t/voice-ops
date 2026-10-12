import { expect, it } from 'vitest';
import { createPool } from '../src/pool.js';

if (!process.env.DATABASE_URL || !process.env.EVALUATOR_DATABASE_URL) throw new Error('Run db:setup before integration tests');
const runtimeUrl = process.env.DATABASE_URL;
const evaluatorUrl = process.env.EVALUATOR_DATABASE_URL;

it('runtime role reads telemetry but cannot write it or read import bookkeeping', async () => {
  const pool = createPool(runtimeUrl);
  try {
    const identity = await pool.query('SELECT current_user');
    expect(identity.rows[0].current_user).toBe('voiceops_runtime');
    await expect(pool.query('SELECT id,display_title FROM incidents LIMIT 1')).resolves.toBeDefined();
    await expect(pool.query('SELECT * FROM import_jobs LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM schema_migrations LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    // Turn off the default read-only setting to test actual privilege enforcement.
    const client = await pool.connect();
    try {
      await client.query('SET default_transaction_read_only = off');
      await expect(client.query('DELETE FROM incidents WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('CREATE TEMP TABLE denied_fixture (id int)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});

it('runtime credentials cannot connect to the evaluator database', async () => {
  const url = new URL(runtimeUrl);
  url.pathname = new URL(evaluatorUrl).pathname;
  const pool = createPool(url.toString());
  try {
    await expect(pool.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
  } finally {
    await pool.end();
  }
});

it('runtime has no privileged role membership or server-file access', async () => {
  const pool = createPool(runtimeUrl);
  try {
    const result = await pool.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
      pg_has_role(current_user,'pg_read_server_files','MEMBER') AS server_files
      FROM pg_roles WHERE rolname=current_user`);
    expect(result.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, server_files: false });
    await expect(pool.query("SELECT pg_read_file('/etc/passwd')")).rejects.toMatchObject({ code: '42501' });
  } finally {
    await pool.end();
  }
});

it('evaluator uses a distinct database and login', async () => {
  const pool = createPool(evaluatorUrl);
  try {
    const result = await pool.query('SELECT current_user,current_database()');
    expect(result.rows[0]).toEqual({ current_user: 'voiceops_evaluator', current_database: 'voiceops_evaluation' });
    await expect(pool.query('SELECT public_incident_id FROM evaluation_cases LIMIT 1')).resolves.toBeDefined();
  } finally {
    await pool.end();
  }
});

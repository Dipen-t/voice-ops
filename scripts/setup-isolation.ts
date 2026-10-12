import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { Client } from 'pg';

const runtimeRole = 'voiceops_runtime';
const evaluatorRole = 'voiceops_evaluator';
const evaluatorDatabase = 'voiceops_evaluation';
const ingestRole = 'voiceops_ingest';
const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const quoteLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'";

async function setup() {
  let environment: Record<string, string | undefined>;
  try {
    environment = parseEnv(await readFile('.env.admin', 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    environment = parseEnv(await readFile('.env', 'utf8'));
  }
  const adminUrl = environment.ADMIN_DATABASE_URL ?? environment.DATABASE_URL;
  if (!adminUrl) throw new Error('An administrative database URL is required for local isolation setup');
  const admin = new URL(adminUrl);
  if (admin.username === runtimeRole || admin.username === evaluatorRole) throw new Error('Administrative credentials are required');
  const database = decodeURIComponent(admin.pathname.slice(1));
  const runtimePassword = environment.RUNTIME_DATABASE_URL ? decodeURIComponent(new URL(environment.RUNTIME_DATABASE_URL).password) : randomBytes(24).toString('hex');
  const evaluatorPassword = environment.EVALUATOR_DATABASE_URL ? decodeURIComponent(new URL(environment.EVALUATOR_DATABASE_URL).password) : randomBytes(24).toString('hex');
  const ingestPassword = environment.INGEST_DATABASE_URL ? decodeURIComponent(new URL(environment.INGEST_DATABASE_URL).password) : randomBytes(24).toString('hex');
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  await client.connect();
  try {
    for (const [role, password] of [[runtimeRole, runtimePassword], [evaluatorRole, evaluatorPassword], [ingestRole, ingestPassword]]) {
      if (!role || !password) throw new Error('Missing role configuration');
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (!exists.rowCount) await client.query(`CREATE ROLE ${quoteIdentifier(role)}`);
      await client.query(`ALTER ROLE ${quoteIdentifier(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
    }
    const existingDatabase = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [evaluatorDatabase]);
    if (!existingDatabase.rowCount) await client.query(`CREATE DATABASE ${quoteIdentifier(evaluatorDatabase)} OWNER ${quoteIdentifier(evaluatorRole)}`);
    await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(evaluatorDatabase)} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(evaluatorDatabase)} FROM ${quoteIdentifier(runtimeRole)}`);
    await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(evaluatorDatabase)} FROM ${quoteIdentifier(ingestRole)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(evaluatorDatabase)} TO ${quoteIdentifier(evaluatorRole)}`);
    await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(runtimeRole)}`);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(runtimeRole)}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quoteIdentifier(runtimeRole)}`);
    await client.query(`GRANT SELECT ON incidents, metric_samples, log_entries, trace_spans TO ${quoteIdentifier(runtimeRole)}`);
    const knowledge = await client.query("SELECT to_regclass('public.knowledge_chunks') AS present");
    if (knowledge.rows[0]?.present) {
      await client.query(`GRANT SELECT ON knowledge_documents, knowledge_chunks TO ${quoteIdentifier(runtimeRole)}`);
      await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(ingestRole)}`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(ingestRole)}`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quoteIdentifier(ingestRole)}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON knowledge_documents,knowledge_chunks,knowledge_ingestion_jobs TO ${quoteIdentifier(ingestRole)}`);
      await client.query(`ALTER ROLE ${quoteIdentifier(ingestRole)} SET statement_timeout = '10000ms'`);
    }
    await client.query(`ALTER ROLE ${quoteIdentifier(runtimeRole)} SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE ${quoteIdentifier(runtimeRole)} SET statement_timeout = '3000ms'`);
    await client.query(`ALTER ROLE ${quoteIdentifier(runtimeRole)} SET idle_in_transaction_session_timeout = '10000ms'`);
  } finally {
    await client.end();
  }
  const runtime = new URL(admin);
  runtime.username = runtimeRole;
  runtime.password = runtimePassword;
  const evaluator = new URL(admin);
  evaluator.username = evaluatorRole;
  evaluator.password = evaluatorPassword;
  evaluator.pathname = `/${evaluatorDatabase}`;
  const containerRuntime = new URL(runtime);
  const ingest = new URL(admin); ingest.username = ingestRole; ingest.password = ingestPassword;
  containerRuntime.hostname = 'postgres';
  containerRuntime.port = '5432';
  const adminVariables = {
    POSTGRES_USER: environment.POSTGRES_USER ?? decodeURIComponent(admin.username),
    POSTGRES_PASSWORD: environment.POSTGRES_PASSWORD ?? decodeURIComponent(admin.password),
    POSTGRES_DB: environment.POSTGRES_DB ?? database,
    POSTGRES_PORT: environment.POSTGRES_PORT ?? admin.port,
    REDIS_PORT: environment.REDIS_PORT ?? '16379',
    ADMIN_DATABASE_URL: admin.toString(),
    EVALUATOR_DATABASE_URL: evaluator.toString(),
    RUNTIME_DATABASE_URL: runtime.toString(),
    RUNTIME_CONTAINER_DATABASE_URL: containerRuntime.toString(),
    INGEST_DATABASE_URL: ingest.toString(),
  };
  const serialize = (variables: Record<string, string>) => Object.entries(variables).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  // Private bootstrap/CLI environment and runtime environment are separate.
  await writeFile('.env.admin', serialize(adminVariables), { mode: 0o600 });
  await writeFile('.env', serialize({ DATABASE_URL: runtime.toString(), REDIS_URL: environment.REDIS_URL ?? 'redis://127.0.0.1:16379', HOST: '127.0.0.1', PORT: environment.PORT ?? '3001', HEALTH_TIMEOUT_MS: '1500', LOG_LEVEL: 'info' }), { mode: 0o600 });
  await writeFile('.env.ingest', serialize({ INGEST_DATABASE_URL: ingest.toString(), REDIS_URL: environment.REDIS_URL ?? 'redis://127.0.0.1:16379' }), { mode: 0o600 });
  const evaluationClient = new Client({ connectionString: evaluator.toString(), connectionTimeoutMillis: 5000 });
  await evaluationClient.connect();
  try {
    await evaluationClient.query(`CREATE TABLE IF NOT EXISTS evaluation_cases (
      public_incident_id uuid PRIMARY KEY, source_case_name text NOT NULL,
      root_cause_service text NOT NULL, fault text NOT NULL,
      inject_time_seconds bigint NOT NULL, dataset_revision text NOT NULL,
      source_files jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await evaluationClient.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await evaluationClient.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC');
  } finally {
    await evaluationClient.end();
  }
  console.log('Runtime SELECT-only role and separate evaluator database configured. Secrets saved to ignored environment files.');
}

setup().catch(() => {
  console.error('Isolation setup failed; verify local administrative access and apply telemetry migrations first. No credentials are printed.');
  process.exitCode = 1;
});

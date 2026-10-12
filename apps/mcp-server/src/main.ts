import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createPool } from '../../../packages/db/src/pool.js';
import { Telemetry } from './telemetry.js';
import { createServer } from './server.js';

try {
  // The trusted local launcher chooses the incident; tool arguments cannot expand access.
  const incident = z.uuid().parse(process.env.VOICEOPS_INCIDENT_ID);
  const database = z.url().parse(process.env.DATABASE_URL);
  const url = new URL(database);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== 'voiceops_runtime') throw new Error();
  const pool = createPool(database, 3000);
  pool.on('error', () => { /* Never log credentials or raw database errors. */ });
  const telemetry = new Telemetry(pool, incident);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16384 });
  const handle = serveStdio(() => createServer(telemetry), { transport, onerror: () => console.error('MCP protocol error') });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await handle.close();
    await pool.end();
  }
  process.stdin.on('end', () => { void close(); });
  process.on('SIGINT', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
} catch {
  console.error('MCP startup failed: a selected incident and restricted runtime database are required');
  process.exitCode = 1;
}

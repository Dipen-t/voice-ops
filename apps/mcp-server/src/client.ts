import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';

export async function connectTelemetry(incidentId: string, mode: 'container' | 'host' = 'container', signal?:AbortSignal) {
  z.uuid().parse(incidentId);
  const client = new Client({ name: 'voiceops-local-client', version: '0.1.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  // Explicit environment: never inherit admin/evaluator credentials or provider secrets.
  const environment: Record<string, string> = { VOICEOPS_INCIDENT_ID: incidentId };
  if (mode === 'host') {
    if (!process.env.DATABASE_URL) throw new Error('Runtime database configuration is required');
    environment.DATABASE_URL = process.env.DATABASE_URL;
  }
  const transport = new StdioClientTransport(mode === 'container' ? {
    command: 'docker', args: ['compose', '--env-file', '.env.admin', '--profile', 'tools', 'run', '--rm', '--no-deps', '-T', 'mcp'], env: environment, stderr: 'pipe',
  } : {
    command: process.execPath, args: ['dist/apps/mcp-server/src/main.js'], env: environment, stderr: 'pipe',
  });
  // Consume bounded, sanitized server diagnostics without printing telemetry or secrets.
  transport.stderr?.on('data', () => { /* Discard diagnostics rather than accumulating them. */ });
  try {
    await client.connect(transport, { timeout: 15000,...(signal?{signal}:{}) });
    return client;
  } catch {
    await transport.close();
    throw new Error('MCP connection failed; check the build, Docker and selected incident');
  }
}

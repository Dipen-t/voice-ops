import { connectTelemetry } from '../apps/mcp-server/src/client.js';

const selected = process.env.VOICEOPS_INCIDENT_ID;
if (!selected) throw new Error('Set VOICEOPS_INCIDENT_ID to a public incident UUID first');
const client = await connectTelemetry(selected);
try {
  console.log(JSON.stringify(await client.listTools({}, { timeout: 5000 }), null, 2));
  console.log(JSON.stringify(await client.callTool({ name: 'get_incident_summary', arguments: { incident_id: selected } }, { timeout: 7000 }), null, 2));
} finally { await client.close(); }

import { loadConfig } from '../apps/api/src/config/env.js';
import { createInvestigatorRuntime } from '../apps/api/src/investigator-runtime.js';
import { investigate } from '../packages/investigator/src/run.js';
import { mkdir,writeFile } from 'node:fs/promises';

// Real provider, MCP and RAG smoke test. No synthetic model or expected diagnosis.
const config=loadConfig({...process.env,MODEL_REQUESTS_ENABLED:'true'});
if(!config.GROQ_API_KEY)throw new Error('MODEL_NOT_CONFIGURED');
const runtime=await createInvestigatorRuntime(config);
const phases:Record<string,unknown>[]=[];
try {
  const incidents=await runtime.pool.query("SELECT id FROM incidents WHERE import_status='ready' ORDER BY created_at,id LIMIT 1");
  const id=String(incidents.rows[0]?.id);
  const answer=await investigate({...runtime,model:runtime.model!},id,
    'When should I use an OpenTelemetry span event rather than an attribute? Also retrieve two unfiltered logs, without service or query filters, and report one exact observed excerpt. Do not infer a root cause.',
    [],AbortSignal.timeout(120000),event=>{
      phases.push({type:event.type,elapsed_ms:event.elapsed_ms,...(event.type==='model_completed'?{usage:event.data.usage}:{}),...(event.type==='tool_completed'?{tool:event.data.tool,evidence_id:event.data.id}:{}),...(event.type==='retrieval_completed'?{status:event.data.status,citation_count:(event.data.citations as unknown[]).length}: {})});
      console.log(JSON.stringify(phases.at(-1)));
    });
  await mkdir('eval/reports',{recursive:true});
  await writeFile('eval/reports/investigator-smoke.json',JSON.stringify({date:new Date().toISOString(),provider:'groq',model:config.GROQ_MODEL,incident_id:id,synthetic:false,scope:'One live recorded-incident smoke test; no diagnosis accuracy claim',phases,answer},null,2)+'\n');
  console.log('Validated live answer saved; no credentials printed.');
} finally {await runtime.close();}

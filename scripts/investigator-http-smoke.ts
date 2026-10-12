import { mkdir,writeFile } from 'node:fs/promises';
const bearer=process.env.API_BEARER_TOKEN;
if(!bearer)throw new Error('Local API bearer token is required');
const origin='http://127.0.0.1:3002';
const documentRegression=process.argv.includes('--document-regression');
async function request(path:string,body?:unknown,capability?:string) {
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${bearer}`,...(body===undefined?{}:{'content-type':'application/json'}),...(capability?{'x-session-token':capability}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(125000)});
  if(!response.ok)throw new Error(`HTTP_SMOKE_FAILED_${response.status}`);
  return response;
}
const page=await fetch(origin);if(!page.ok||!(await page.text()).includes('VoiceOps'))throw new Error('WORKBENCH_UNAVAILABLE');
const list=await(await request('/incidents')).json() as {incidents:{id:string}[]};
const incidentId=documentRegression?'88ec4733-902a-409d-8a87-5f1d744ac20e':list.incidents[0]!.id;
if(!list.incidents.some(incident=>incident.id===incidentId))throw new Error('INCIDENT_UNAVAILABLE');
const session=await(await request('/sessions',{incident_id:incidentId})).json() as {id:string;session_token:string};
const question=documentRegression?'Retrieve two unfiltered logs, without service or query filters. Show the exact observed excerpts and explain what remains unknown. Do not infer a root cause.':'When should I use an OpenTelemetry span event rather than an attribute? Also retrieve two unfiltered logs, without service or query filters, and report one exact observed excerpt. Do not infer a root cause.';
const response=await request(`/sessions/${session.id}/messages`,{text:question},session.session_token);
let text='';const decoder=new TextDecoder();
for await(const chunk of response.body!){text+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(text)>160000)throw new Error('HTTP_SMOKE_BUFFER_LIMIT');}
const events=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)) as {type:string;elapsed_ms:number;data:Record<string,unknown>});
const failed=events.find(event=>event.type==='turn_failed'||event.type==='turn_cancelled');if(failed){console.log(JSON.stringify({error:failed.data.error,phases:events.map(event=>event.type)}));throw new Error(String(failed.data.error));}
const answer=events.find(event=>event.type==='answer');if(!answer)throw new Error('NO_VALIDATED_ANSWER');
if(!(answer.data.answer as {observed_evidence:unknown[]}).observed_evidence.length)throw new Error('NO_OBSERVED_EVIDENCE_IN_SMOKE_ANSWER');
const retrieved=(events.find(event=>event.type==='retrieval_completed')?.data.citations??[]) as {id:string}[];
const documentIds=(answer.data.answer as {documentation_ids:string[]}).documentation_ids;
if(documentIds.some(id=>!retrieved.some(citation=>citation.id===id)))throw new Error('UNSUPPORTED_DOCUMENT_IN_SMOKE_ANSWER');
const phases=events.map(event=>({type:event.type,elapsed_ms:event.elapsed_ms,...(event.type==='model_completed'?{usage:event.data.usage}:{}),...(event.type==='tool_completed'?{tool:event.data.tool,arguments:event.data.arguments,evidence_id:event.data.id}:{}),...(event.type==='retrieval_completed'?{status:event.data.status}: {})}));
await mkdir('eval/reports',{recursive:true});
await writeFile(documentRegression?'eval/reports/investigator-document-regression.json':'eval/reports/investigator-http-smoke.json',JSON.stringify({date:new Date().toISOString(),synthetic:false,scope:'One live Groq + isolated container API + real stdio MCP + local RAG turn; no accuracy or latency percentile claim',incident_id:incidentId,retrieved_document_count:retrieved.length,phases,answer:answer.data.answer,citations:answer.data.citations},null,2)+'\n');
console.log(JSON.stringify({workbench_served:true,live_answer_validated:true,retrieved_documents:retrieved.length,document_ids:documentIds,events:events.length,total_duration_ms:answer.elapsed_ms,tools:phases.filter(phase=>phase.tool).map(phase=>phase.tool)}));

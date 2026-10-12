import { beforeAll,afterAll,expect,it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createInvestigatorRuntime } from '../src/investigator-runtime.js';
import type { LLMProvider } from '../../../packages/investigator/src/model.js';

// Explicitly synthetic model responses; database, MCP protocol, embeddings and RAG are real.
const token='synthetic-api-token-for-integration-tests-only';
const config=loadConfig({...process.env,INVESTIGATOR_ENABLED:'true',API_BEARER_TOKEN:token,LOG_LEVEL:'silent'});
let app:ReturnType<typeof buildApp>;let incidentId:string;let session:{id:string;session_token:string};
beforeAll(async()=>{
  const runtime=await createInvestigatorRuntime(config);
  incidentId=String((await runtime.pool.query("SELECT id FROM incidents WHERE import_status='ready' ORDER BY created_at,id LIMIT 1")).rows[0].id);
  const model:LLMProvider={name:'synthetic-test-only',complete:async(messages,_tools,final)=>{
    if(!final)return {message:{role:'assistant',content:null,tool_calls:[{id:'synthetic-call',type:'function',function:{name:'search_service_logs',arguments:JSON.stringify({incident_id:incidentId,limit:2})}}]},usage:null};
    const data=JSON.parse(messages.find(message=>message.role==='tool')!.content!);
    return {message:{role:'assistant',content:JSON.stringify({observed_evidence:[{evidence_id:data.evidence_id,observation:'A recorded sample was retrieved; this is a synthetic test answer.',quote:incidentId}],likely_explanations:[],confidence:'low',uncertainty:['Synthetic model response; no causal conclusion.'],suggested_checks:[],documentation_ids:['D99'],clarification:null})},usage:null};
  }};
  app=buildApp(config,{postgres:async()=>{},redis:async()=>{},close:async()=>{}},{...runtime,model});await app.ready();
});
afterAll(async()=>{await app?.close();});
it('API authentication and origin checks reject access before listing incidents',async()=>{
  expect((await app.inject({url:'/incidents'})).statusCode).toBe(401);
  expect((await app.inject({url:'/incidents',headers:{authorization:`Bearer ${token}`,origin:'https://untrusted.example'}})).statusCode).toBe(403);
  const response=await app.inject({url:'/incidents',headers:{authorization:`Bearer ${token}`}});expect(response.statusCode).toBe(200);expect(response.json().incidents).toHaveLength(3);
});
it('session rejects client-selected alternate incident fields and invalid capabilities',async()=>{
  const response=await app.inject({method:'POST',url:'/sessions',headers:{authorization:`Bearer ${token}`},payload:{incident_id:incidentId}});expect(response.statusCode).toBe(201);session=response.json();
  expect((await app.inject({url:`/sessions/${session.id}/events`,headers:{authorization:`Bearer ${token}`,'x-session-token':'wrong'}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:`/sessions/${session.id}/messages`,headers:{authorization:`Bearer ${token}`,'x-session-token':session.session_token},payload:{text:'Inspect logs',incident_id:'0952ccc9-0fe3-40f0-9ef2-23a6f8bc437c'}})).statusCode).toBe(400);
});
it('SSE exposes actual MCP and RAG events and validated synthetic-model evidence',async()=>{
  const response=await app.inject({method:'POST',url:`/sessions/${session.id}/messages`,headers:{authorization:`Bearer ${token}`,'x-session-token':session.session_token},payload:{text:'How do OpenTelemetry span events differ from attributes?'}});
  expect(response.statusCode).toBe(200);
  const events=response.body.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  expect(events.some(event=>event.type==='retrieval_completed'&&event.data.citations.length>0)).toBe(true);
  expect(events.some(event=>event.type==='tool_completed'&&event.data.tool==='search_service_logs')).toBe(true);
  const answer=events.find(event=>event.type==='answer');expect(answer).toBeDefined();expect(answer.data.evidence.find((e:{id:string})=>e.id==='E2').data.records.length).toBeGreaterThan(0);
  expect(answer.data.answer.documentation_ids).toEqual([]);expect(answer.data.citations).toEqual([]);expect(events.some(event=>event.type==='output_validation'&&event.data.document_references_withheld===1)).toBe(true);
  expect(events.every(event=>event.elapsed_ms>=0)).toBe(true);
  const persisted=await app.inject({url:`/sessions/${session.id}/events`,headers:{authorization:`Bearer ${token}`,'x-session-token':session.session_token}});expect(persisted.json().events.length).toBe(events.length);
},60000);

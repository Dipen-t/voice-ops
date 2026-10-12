import { expect,it } from 'vitest';
import { validateAnswer,type Evidence } from '../src/contracts.js';
import { redact } from '../src/redact.js';
import { GroqProvider } from '../src/model.js';

// Synthetic fixtures exercise validation only, not diagnosis quality.
const evidence:Evidence[]=[{id:'E1',tool:'search_service_logs',arguments:{},data:{records:[{message:'synthetic failure'}]}}];
const answer={observed_evidence:[{evidence_id:'E1',observation:'Synthetic log contains failure',quote:'synthetic failure'}],likely_explanations:[],confidence:'low',uncertainty:['Synthetic fixture'],suggested_checks:[],documentation_ids:[],clarification:null};
it('accepts exact observed evidence but rejects fabricated references and quotes',()=>{
  expect(validateAnswer(JSON.stringify(answer),evidence,[]).confidence).toBe('low');
  expect(()=>validateAnswer(JSON.stringify({...answer,observed_evidence:[{...answer.observed_evidence[0],quote:'fabricated'}]}),evidence,[])).toThrow('UNSUPPORTED_EVIDENCE_REFERENCE');
  expect(()=>validateAnswer(JSON.stringify({...answer,documentation_ids:['D99']}),evidence,[])).toThrow('UNSUPPORTED_DOCUMENT_REFERENCE');
  expect(()=>validateAnswer(JSON.stringify({...answer,observed_evidence:[{...answer.observed_evidence[0],observation:'Failure within 30 minutes'}]}),evidence,[])).toThrow('UNSUPPORTED_NUMERIC_OBSERVATION');
});
it('rejects unsupported explanations and malformed output',()=>{
  expect(()=>validateAnswer(JSON.stringify({...answer,observed_evidence:[],likely_explanations:[{hypothesis:'Synthetic cause',evidence_ids:['E1']}]}),evidence,[])).toThrow('UNSUPPORTED_EXPLANATION');
  expect(()=>validateAnswer('not JSON',evidence,[])).toThrow('INVALID_MODEL_ANSWER');
});
it('matches original recorded strings containing quotes and newlines',()=>{
  const quoted='synthetic "failure"\nrecord';
  expect(validateAnswer(JSON.stringify({...answer,observed_evidence:[{evidence_id:'E1',observation:'Synthetic quoted log',quote:quoted}]}),[{...evidence[0]!,data:{message:quoted}}],[]).observed_evidence[0]?.quote).toBe(quoted);
});
it('redacts nested credentials, connection strings, supplied secrets and emails',()=>{
  const clean=JSON.stringify(redact({password:'synthetic',message:'Bearer synthetic-token email@example.com postgresql://user:pass@host/db unique-test-secret'},['unique-test-secret']));
  for(const secret of ['synthetic-token','email@example.com','user:pass','unique-test-secret'])expect(clean).not.toContain(secret);
});
it('Groq rate-limit failure does not retry or expose provider error bodies',async()=>{
  let calls=0;
  const model=new GroqProvider('synthetic-key','openai/gpt-oss-20b',async()=>{calls++;return new Response('synthetic-private-error',{status:429});});
  await expect(model.complete([],[],false,new AbortController().signal)).rejects.toThrow('MODEL_RATE_LIMITED');expect(calls).toBe(1);
});
it('final structured output omits tools; ordinary requests use explicit local tools',async()=>{
  const bodies:Record<string,unknown>[]=[];
  const model=new GroqProvider('synthetic-key','openai/gpt-oss-20b',async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(answer)}}]});});
  await model.complete([],[],false,new AbortController().signal);await model.complete([],[],true,new AbortController().signal);
  expect(bodies[0]?.tools).toEqual([]);expect(bodies[1]?.tools).toBeUndefined();expect(bodies[1]?.response_format).toBeDefined();
});
it('final schema constrains IDs and exact quote choices without ambiguous anyOf branches',async()=>{
  let body:Record<string,unknown>={};
  const model=new GroqProvider('synthetic-key','openai/gpt-oss-20b',async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(answer)}}]});});
  await model.complete([{role:'user',content:JSON.stringify({untrusted_initial_evidence:evidence})},{role:'tool',content:JSON.stringify({evidence_id:'E2',records:[{message:'second synthetic quote'}]})}],[],true,new AbortController().signal);
  const schema=(body.response_format as {json_schema:{schema:{properties:{observed_evidence:{items:{anyOf?:unknown;properties:{quote:{enum:string[]};evidence_id:{enum:string[]}}}}}}}}).json_schema.schema;
  expect(schema.properties.observed_evidence.items.anyOf).toBeUndefined();expect(schema.properties.observed_evidence.items.properties.evidence_id.enum).toEqual(['E1','E2']);expect(schema.properties.observed_evidence.items.properties.quote.enum).toContain('second synthetic quote');
  expect((body.messages as {role:string}[]).some(message=>message.role==='tool')).toBe(false);
});
it('final documentation schema uses only current-turn sources and requires no citations for empty retrieval',async()=>{
  const bodies:Record<string,unknown>[]=[];
  const model=new GroqProvider('synthetic-key','openai/gpt-oss-20b',async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(answer)}}]});});
  await model.complete([{role:'user',content:JSON.stringify({untrusted_runbook_candidates:[{id:'D99'}]})},{role:'user',content:JSON.stringify({untrusted_initial_evidence:evidence,untrusted_runbook_candidates:[{id:'D1'}]})}],[],true,new AbortController().signal);
  await model.complete([{role:'user',content:JSON.stringify({untrusted_initial_evidence:evidence,untrusted_runbook_candidates:[]})}],[],true,new AbortController().signal);
  const documentation=(body:Record<string,unknown>)=>(body.response_format as {json_schema:{schema:{properties:{documentation_ids:{items:{enum?:string[]};maxItems:number}}}}}).json_schema.schema.properties.documentation_ids;
  expect(documentation(bodies[0]!).items.enum).toEqual(['D1']);expect(documentation(bodies[1]!).maxItems).toBe(0);
  expect(JSON.parse((bodies[1]!.messages as {content:string}[])[1]!.content).available_document_ids).toEqual([]);
});

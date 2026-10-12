import { beforeAll,afterAll,expect,it,vi } from 'vitest';
import { DocumentModel } from '../src/document-model.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { demoDocumentId } from '../../../packages/rag/src/demo-insurance.js';
import { createPool } from '../../../packages/db/src/pool.js';
import { retrieve } from '../../../packages/rag/src/search.js';
import { LocalEmbeddings,modelIdentity } from '../../../packages/rag/src/embedding.js';
// Real local database/vector retrieval, fictional FAQ and synthetic API token. No hosted calls.
const token='synthetic-document-api-token-for-tests-only';
let app:ReturnType<typeof buildApp>;
beforeAll(async()=>{app=buildApp(loadConfig({...process.env,ASSISTANT_MODE:'documents',INVESTIGATOR_ENABLED:'true',API_BEARER_TOKEN:token,GROQ_API_KEY:'',MODEL_REQUESTS_ENABLED:'false',VOICE_REQUESTS_ENABLED:'false',LOG_LEVEL:'silent'}),{postgres:async()=>{},redis:async()=>{},close:async()=>{}});await app.ready();});
afterAll(async()=>{await app.close();});
it('lists only the sample document after authentication and rejects alternate corpus scope',async()=>{
  expect((await app.inject('/documents')).statusCode).toBe(401);
  const list=await app.inject({url:'/documents',headers:{authorization:`Bearer ${token}`}});expect(list.json().documents).toHaveLength(1);expect(list.json().documents[0].id).toBe(demoDocumentId);
  expect((await app.inject({method:'POST',url:'/sessions',headers:{authorization:`Bearer ${token}`},payload:{document_id:'0952ccc9-0fe3-40f0-9ef2-23a6f8bc437c'}})).statusCode).toBe(400);
});
it('greets in Roman Hinglish from Hindi input with the model disabled and keeps capabilities enforced',async()=>{
  const session=(await app.inject({method:'POST',url:'/sessions',headers:{authorization:`Bearer ${token}`},payload:{document_id:demoDocumentId}})).json();
  const headers={authorization:`Bearer ${token}`,'x-session-token':session.session_token};
  expect((await app.inject({method:'POST',url:`/sessions/${session.id}/messages`,headers:{...headers,'x-session-token':'wrong'},payload:{text:'नमस्ते'}})).statusCode).toBe(403);
  const response=await app.inject({method:'POST',url:`/sessions/${session.id}/messages`,headers,payload:{text:'नमस्ते'}});
  expect(response.statusCode).toBe(200);const event=JSON.parse(response.body.split('\n').find(line=>line.startsWith('data: '))!.slice(6));expect(event.data.kind).toBe('greeting');expect(event.data.reply).toContain('Namaste');expect(event.data.citations).toEqual([]);
  for(const text of ['अच्छा ठीक है, ठीक है, समझ गया।','ठीक है','समझ गया']){
    const ack=await app.inject({method:'POST',url:`/sessions/${session.id}/messages`,headers,payload:{text}});
    expect(ack.statusCode).toBe(200);expect(ack.body).not.toContain('search_started');expect(ack.body).toContain(text==='ठीक है'?'Ji, theek hai.':'Badhiya');
  }
});
it('retrieves the waiting-period section while excluding every technical runbook',async()=>{
  const pool=createPool(process.env.DATABASE_URL!,3000);const embeddings=new LocalEmbeddings(await modelIdentity());
  try{const result=await retrieve(pool,embeddings,{query:'What is the waiting period for illness and accident claims?',limit:2,document_id:demoDocumentId});expect(result.hits.length).toBeGreaterThan(0);expect(result.hits.every(hit=>(hit.citation as {document_id:string}).document_id===demoDocumentId)).toBe(true);expect(result.hits.some(hit=>String(hit.text).includes('30 days'))).toBe(true);}finally{await embeddings.close();await pool.end();}
});
it('retrieves the expanded comparison topic with exact fictional source provenance',async()=>{
  const pool=createPool(process.env.DATABASE_URL!,3000);const embeddings=new LocalEmbeddings(await modelIdentity());
  try{
    const result=await retrieve(pool,embeddings,{query:'What is the difference between a deductible and co-payment?',limit:4,document_id:demoDocumentId});
    expect(result.hits.some(hit=>String(hit.text).includes('different mechanisms'))).toBe(true);
    expect(result.hits.every(hit=>(hit.citation as {document_id:string;revision:string}).document_id===demoDocumentId&&(hit.citation as {revision:string}).revision==='demo-v2')).toBe(true);
    const example=await retrieve(pool,embeddings,{query:'deductible co-payment example',limit:4,document_id:demoDocumentId});
    expect(example.hits.some(hit=>String(hit.text).includes('Rs.5000')&&String(hit.text).includes('Rs.9600'))).toBe(true);
  }finally{await embeddings.close();await pool.end();}
});
it('skips hosted translation for explicit topics and bounds the total model-call budget',async()=>{
  const query=vi.spyOn(DocumentModel.prototype,'query').mockResolvedValue('premium payment');
  const answer=vi.spyOn(DocumentModel.prototype,'answer').mockResolvedValue({reply:'Synthetic test reply.',covered:false,citations:[]});
  const isolated=buildApp(loadConfig({...process.env,ASSISTANT_MODE:'documents',INVESTIGATOR_ENABLED:'true',API_BEARER_TOKEN:token,GROQ_API_KEY:'synthetic-test-key',MODEL_REQUESTS_ENABLED:'true',VOICE_REQUESTS_ENABLED:'false',LOG_LEVEL:'silent'}),{postgres:async()=>{},redis:async()=>{},close:async()=>{}});
  try{
    await isolated.ready();const session=(await isolated.inject({method:'POST',url:'/sessions',headers:{authorization:`Bearer ${token}`},payload:{document_id:demoDocumentId}})).json();
    const headers={authorization:`Bearer ${token}`,'x-session-token':session.session_token};
    const ask=(text:string)=>isolated.inject({method:'POST',url:`/sessions/${session.id}/messages`,headers,payload:{text}});
    expect((await ask('Iska example do')).statusCode).toBe(200);expect(query).toHaveBeenCalledTimes(1);
    for(const text of ['ठीक है','अच्छा ठीक है, ठीक है, समझ गया।','समझ गया'])expect((await ask(text)).statusCode).toBe(200);
    expect((await ask('Premium kya hota hai?')).statusCode).toBe(200);
    // The spy retains the history array; the completed substantive turn has been appended.
    expect(answer.mock.calls[1]![1]).toEqual(['Iska example do','Synthetic test reply.','Premium kya hota hai?','Synthetic test reply.']);
    expect((await ask('Premium aur sum insured mein difference?')).statusCode).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);expect(answer).toHaveBeenCalledTimes(3);
    const limited=await ask('Premium explain karo');expect(limited.statusCode).toBe(429);expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await ask('Namaste')).statusCode).toBe(200);expect(answer).toHaveBeenCalledTimes(3);
    expect((await ask('ठीक है')).statusCode).toBe(200);expect(query).toHaveBeenCalledTimes(1);expect(answer).toHaveBeenCalledTimes(3);
  }finally{await isolated.close();vi.restoreAllMocks();}
});

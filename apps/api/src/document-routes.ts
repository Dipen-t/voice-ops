import { randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config/env.js';
import { createPool } from '../../../packages/db/src/pool.js';
import { LocalEmbeddings,modelIdentity } from '../../../packages/rag/src/embedding.js';
import { retrieve } from '../../../packages/rag/src/search.js';
import { demoDocumentId } from '../../../packages/rag/src/demo-insurance.js';
import { redact } from '../../../packages/investigator/src/redact.js';
import { DocumentModel,smallTalk,unknownReply,insuranceSearchQuery,type DocumentReply,type DocumentSource } from './document-model.js';
import { createVoiceGateway,sarvamSocket,type VoiceSession } from './voice.js';
type Session=VoiceSession&{token:string;history:string[];turns:number};
const same=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function documentRoutes(app:FastifyInstance,config:Config){
  if(!config.API_BEARER_TOKEN||new URL(config.DATABASE_URL).username!=='voiceops_runtime')throw new Error('Restricted document runtime required');
  const pool=createPool(config.DATABASE_URL,3000);pool.on('error',()=>{});
  const embeddings=new LocalEmbeddings(await modelIdentity());const model=new DocumentModel(config);
  const secrets=[config.GROQ_API_KEY,config.SARVAM_API_KEY,config.API_BEARER_TOKEN,config.DATABASE_URL,decodeURIComponent(new URL(config.DATABASE_URL).password)];
  const voiceEnabled=Boolean(config.VOICE_REQUESTS_ENABLED&&config.SARVAM_API_KEY);
  const voice=createVoiceGateway(app.server,voiceEnabled,kind=>sarvamSocket(config.SARVAM_API_KEY,kind,true),secrets,true);
  const sessions=new Map<string,Session>();let active=false;const requests:{at:number;cost:number}[]=[];
  const cleanup=setInterval(()=>{for(const[id,s]of sessions)if(s.expiresAt<Date.now()){s.active?.abort();sessions.delete(id);}},60000);cleanup.unref();
  app.addHook('preHandler',async(req,reply)=>{
    if(!same(String(req.headers.authorization??''),`Bearer ${config.API_BEARER_TOKEN}`))return reply.code(401).send({error:'AUTH_REQUIRED'});
    if(req.headers.origin){let host='';try{host=new URL(req.headers.origin).host;}catch{/* Fail closed. */}if(host!==req.headers.host)return reply.code(403).send({error:'ORIGIN_NOT_ALLOWED'});}
    reply.header('cache-control','no-store');
  });
  function scoped(req:FastifyRequest){const id=z.uuid().safeParse((req.params as {id?:string}).id);const s=id.success?sessions.get(id.data):undefined;if(!s||s.expiresAt<Date.now()||!same(String(req.headers['x-session-token']??''),s.token))throw new Error('SESSION_NOT_AUTHORIZED');return s;}
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof Error&&error.message==='SESSION_NOT_AUTHORIZED'?403:400).send({error:'DOCUMENT_REQUEST_FAILED'}));
  app.get('/documents',async()=>({documents:(await pool.query('SELECT id,title,license FROM knowledge_documents WHERE id=$1',[demoDocumentId])).rows,fictional:true}));
  app.get('/investigator/status',async()=>({provider:'groq',model:config.GROQ_MODEL,model_configured:Boolean(config.GROQ_API_KEY),requests_enabled:config.MODEL_REQUESTS_ENABLED,voice_available:voiceEnabled,mode:'documents'}));
  app.post('/sessions',async(req,reply)=>{
    if(!z.object({document_id:z.literal(demoDocumentId)}).strict().safeParse(req.body).success)return reply.code(400).send({error:'INVALID_DOCUMENT'});
    if(sessions.size>=20)return reply.code(429).send({error:'SESSION_LIMIT'});
    if(!(await pool.query('SELECT id FROM knowledge_documents WHERE id=$1',[demoDocumentId])).rowCount)return reply.code(503).send({error:'DOCUMENT_NOT_INDEXED'});
    const s:Session={id:randomUUID(),token:randomBytes(24).toString('hex'),expiresAt:Date.now()+1800000,history:[],turns:0,active:undefined};sessions.set(s.id,s);return {id:s.id,session_token:s.token};
  });
  app.post('/sessions/:id/voice-ticket',async req=>voice.issue(scoped(req)));
  app.post('/sessions/:id/cancel',async req=>{scoped(req).active?.abort();return {cancelled:true};});
  app.post('/sessions/:id/messages',async(req,reply)=>{
    const s=scoped(req);const input=z.object({text:z.string().trim().min(2).max(500)}).strict().safeParse(req.body);
    if(!input.success)return reply.code(400).send({error:'INVALID_MESSAGE'});
    const question=String(redact(input.data.text,secrets));const greeting=smallTalk(question);
    const localQuery=insuranceSearchQuery(question);const cost=localQuery?1:2;
    if(active)return reply.code(409).send({error:'ASSISTANT_BUSY'});
    if(s.turns>=20)return reply.code(429).send({error:'SESSION_TURN_LIMIT'});
    while(requests.length&&requests[0]!.at<Date.now()-60000)requests.shift();
    if(!greeting&&requests.reduce((total,r)=>total+r.cost,0)+cost>4){
      let available=4-requests.reduce((total,r)=>total+r.cost,0);let retryAt=Date.now()+60000;
      for(const r of requests){available+=r.cost;if(available>=cost){retryAt=r.at+60000;break;}}
      return reply.header('retry-after',Math.max(1,Math.ceil((retryAt-Date.now())/1000))).code(429).send({error:'LOCAL_MODEL_COOLDOWN'});
    }
    if(!greeting&&(!config.MODEL_REQUESTS_ENABLED||!config.GROQ_API_KEY))return reply.code(503).send({error:'MODEL_NOT_CONFIGURED'});
    const abort=new AbortController();s.active=abort;active=true;s.turns++;delete s.speech;
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(90000)]);const started=performance.now();let sequence=0;
    if(!greeting)requests.push({at:Date.now(),cost});
    reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-next-turn-at':'0'});
    const disconnect=()=>abort.abort();reply.raw.on('close',disconnect);
    const emit=(type:string,data:unknown)=>{if(reply.raw.writableLength>65536){abort.abort();return;}if(!reply.raw.destroyed)reply.raw.write(`event: ${type}\ndata: ${JSON.stringify({sequence:++sequence,type,elapsed_ms:Math.round(performance.now()-started),data})}\n\n`);};
    try{
      let result:DocumentReply=greeting??unknownReply;let sources:DocumentSource[]=[];
      if(!greeting){
        emit('search_started',{});const query=localQuery??await model.query(question,s.history,signal);
        emit('query_resolved',{path:localQuery?'local':'model'});
        const hits=await retrieve(pool,embeddings,{query,limit:4,document_id:demoDocumentId},signal);
        sources=hits.hits.map((hit,i)=>({id:`D${i+1}`,text:String(hit.text).slice(0,1200),citation:hit.citation as Record<string,unknown>}));
        emit('retrieval_completed',{count:sources.length});
        if(sources.length){emit('model_started',{});result=await model.answer(question,s.history,sources,signal);emit('model_completed',{});}
      }
      signal.throwIfAborted();result=redact(result,secrets) as DocumentReply;s.speech=result.reply;
      if(!greeting){s.history.push(question.slice(0,500),result.reply);s.history=s.history.slice(-6);}
      emit('answer',{reply:result.reply,kind:greeting?'greeting':result.covered?'document':'unknown',citations:result.citations.map(c=>({...c,source:sources.find(src=>src.id===c.id)!.citation}))});
    }catch{emit(signal.aborted?'turn_cancelled':'turn_failed',{error:signal.aborted?'TURN_CANCELLED':'DOCUMENT_ANSWER_UNAVAILABLE'});}
    finally{reply.raw.off('close',disconnect);s.active=undefined;active=false;if(!reply.raw.destroyed)reply.raw.end();}
  });
  app.addHook('preClose',async()=>{voice.close();for(const s of sessions.values())s.active?.abort();});
  app.addHook('onClose',async()=>{clearInterval(cleanup);await embeddings.close();await pool.end();});
}

import { randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config/env.js';
import { investigate } from '../../../packages/investigator/src/run.js';
import { InvestigationFailure,type Event,type Answer } from '../../../packages/investigator/src/contracts.js';
import type { Message } from '../../../packages/investigator/src/model.js';
import { redact } from '../../../packages/investigator/src/redact.js';
import { createInvestigatorRuntime,type InvestigatorRuntime } from './investigator-runtime.js';
import { createVoiceGateway,sarvamSocket } from './voice.js';

type Session={id:string;incidentId:string;token:string;expiresAt:number;events:Event[];history:Message[];turns:number;active:AbortController|undefined;answer?:Answer};
const same=(actual:string,expected:string)=>Buffer.byteLength(actual)===Buffer.byteLength(expected)&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
const sessionId=z.uuid();
const questionSchema=z.object({text:z.string().trim().min(3).max(1000)}).strict();
export async function investigatorRoutes(app:FastifyInstance,config:Config,provided?:InvestigatorRuntime) {
  const bearer=config.API_BEARER_TOKEN;
  if(!bearer)throw new Error('Investigator API bearer token is required');
  const runtime=provided??await createInvestigatorRuntime(config);
  const sessions=new Map<string,Session>();let activeTurn=false;let nextTurnAt=0;
  const voiceEnabled=Boolean(config.VOICE_REQUESTS_ENABLED&&config.SARVAM_API_KEY);
  const voice=createVoiceGateway(app.server,voiceEnabled,kind=>sarvamSocket(config.SARVAM_API_KEY,kind),runtime.secrets);
  const cleanup=setInterval(()=>{for(const [id,session]of sessions)if(session.expiresAt<Date.now()){session.active?.abort();sessions.delete(id);}},60000);cleanup.unref();
  app.addHook('preHandler',async(request,reply)=>{
    if(!same(String(request.headers.authorization??''),`Bearer ${bearer}`))return reply.code(401).send({error:'AUTH_REQUIRED'});
    const origin=request.headers.origin;
    if(origin) {let host='';try{host=new URL(origin).host;}catch{ /* Invalid origins fail the host comparison. */ }if(host!==request.headers.host)return reply.code(403).send({error:'ORIGIN_NOT_ALLOWED'});}
    reply.header('cache-control','no-store');
  });
  function scoped(request:FastifyRequest):Session {
    const params=request.params as {id?:unknown};
    const id=sessionId.safeParse(params.id);
    const session=id.success?sessions.get(id.data):undefined;
    if(!session||session.expiresAt<Date.now()||!same(String(request.headers['x-session-token']??''),session.token))throw new InvestigationFailure('SESSION_NOT_AUTHORIZED');
    return session;
  }
  app.setErrorHandler((error,_request,reply)=>{
    const code=error instanceof InvestigationFailure?error.code:'REQUEST_FAILED';
    reply.code(code==='SESSION_NOT_AUTHORIZED'?403:400).send({error:code});
  });
  app.get('/investigator/status',async()=>({provider:'groq',model:config.GROQ_MODEL,model_configured:Boolean(config.GROQ_API_KEY),requests_enabled:config.MODEL_REQUESTS_ENABLED,voice_available:voiceEnabled}));
  app.post('/sessions/:id/voice-ticket',async request=>voice.issue(scoped(request)));
  app.get('/incidents',async()=>({incidents:(await runtime.pool.query("SELECT id,display_title,system,start_time_us,end_time_us FROM incidents WHERE import_status='ready' ORDER BY created_at,id LIMIT 20")).rows}));
  app.post('/sessions',async(request,reply)=>{
    const parsed=z.object({incident_id:z.uuid()}).strict().safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'INVALID_SESSION_INPUT'});
    for(const [id,session]of sessions)if(session.expiresAt<Date.now()){session.active?.abort();sessions.delete(id);}
    if(sessions.size>=20)return reply.code(429).send({error:'SESSION_LIMIT'});
    const exists=await runtime.pool.query("SELECT id FROM incidents WHERE id=$1 AND import_status='ready'",[parsed.data.incident_id]);
    if(!exists.rowCount)return reply.code(404).send({error:'INCIDENT_UNAVAILABLE'});
    const session:Session={id:randomUUID(),incidentId:parsed.data.incident_id,token:randomBytes(24).toString('hex'),expiresAt:Date.now()+1800000,events:[],history:[],turns:0,active:undefined};
    sessions.set(session.id,session);
    return reply.code(201).send({id:session.id,incident_id:session.incidentId,session_token:session.token,expires_at:new Date(session.expiresAt).toISOString()});
  });
  app.get('/sessions/:id/events',async request=>({events:scoped(request).events}));
  app.post('/sessions/:id/cancel',async request=>{const session=scoped(request);session.active?.abort();return {cancelled:Boolean(session.active)};});
  app.post('/sessions/:id/messages',async(request,reply)=>{
    const session=scoped(request);const parsed=questionSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'INVALID_MESSAGE'});
    if(!runtime.model)return reply.code(503).send({error:config.GROQ_API_KEY?'MODEL_REQUESTS_DISABLED':'MODEL_NOT_CONFIGURED'});
    if(activeTurn)return reply.code(409).send({error:'INVESTIGATOR_BUSY'});
    if(Date.now()<nextTurnAt)return reply.header('retry-after',Math.ceil((nextTurnAt-Date.now())/1000)).code(429).send({error:'LOCAL_MODEL_COOLDOWN'});
    if(session.turns>=10)return reply.code(429).send({error:'SESSION_TURN_LIMIT'});
    const started=performance.now();const abort=new AbortController();session.active=abort;activeTurn=true;session.turns++;nextTurnAt=Date.now()+60000;
    delete session.answer;
    reply.header('x-next-turn-at',String(nextTurnAt));
    voice.progress(session.id);
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(120000)]);
    reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no','x-content-type-options':'nosniff','x-next-turn-at':String(nextTurnAt)});
    const disconnect=()=>abort.abort();reply.raw.on('close',disconnect);
    const write=(event:Event)=>{
      const persisted={...event,sequence:(session.events.at(-1)?.sequence??0)+1};
      session.events.push(persisted);session.events=session.events.slice(-100);
      if(!reply.raw.destroyed&&!reply.raw.writableEnded){if(reply.raw.writableLength>131072){abort.abort();return;}reply.raw.write(`event: ${persisted.type}\ndata: ${JSON.stringify(persisted)}\n\n`);}
    };
    try {
      const answer=await investigate({...runtime,model:runtime.model},session.incidentId,parsed.data.text,session.history,signal,write);
      if(!signal.aborted)session.answer=answer;
      // Store bounded validated answers for follow-ups; raw telemetry is re-fetched per turn.
      session.history.push({role:'user',content:String(redact(parsed.data.text,runtime.secrets))},{role:'assistant',content:JSON.stringify(answer).slice(0,3000)});
      session.history=session.history.slice(-4);
    } catch(error) {
      write({sequence:0,type:signal.aborted?'turn_cancelled':'turn_failed',at:new Date().toISOString(),elapsed_ms:Math.round(performance.now()-started),data:{error:signal.aborted?'TURN_CANCELLED':error instanceof InvestigationFailure?error.code:'INVESTIGATION_FAILED'}});
    } finally {
      reply.raw.off('close',disconnect);session.active=undefined;activeTurn=false;if(!reply.raw.destroyed)reply.raw.end();
    }
  });
  app.addHook('preClose',async()=>{voice.close();for(const session of sessions.values())session.active?.abort();});
  app.addHook('onClose',async()=>{clearInterval(cleanup);await runtime.close();});
}

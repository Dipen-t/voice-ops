import { createServer,type Server } from 'node:http';
import { once } from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { createVoiceGateway,spokenAnswer,type VoiceSession } from '../src/voice.js';
import type { Answer } from '../../../packages/investigator/src/contracts.js';

// Synthetic provider and audio fixtures. Real WebSocket transport; no hosted calls.
const answer:Answer={observed_evidence:[{evidence_id:'E1',observation:'Synthetic recorded observation.',quote:'Synthetic'}],likely_explanations:[],confidence:'low',uncertainty:['Synthetic evidence does not establish a cause.'],suggested_checks:['Consult https://example.org/runbook'],documentation_ids:[],clarification:null};
let server:Server;let providerServer:Server;let providers:WebSocketServer;
let gateway:ReturnType<typeof createVoiceGateway>;let host:string;let providerHost:string;
let clients:WebSocket[];let session:VoiceSession;let stt:WebSocket|undefined;let tts:WebSocket|undefined;
let received:Record<string,unknown>[];
beforeEach(async()=>{
  clients=[];received=[];stt=undefined;tts=undefined;
  server=createServer();providerServer=createServer();providers=new WebSocketServer({server:providerServer});
  providers.on('connection',(ws,request)=>{
    if(request.url==='/stt')stt=ws;else tts=ws;
    ws.on('message',raw=>received.push(JSON.parse(raw.toString())));
  });
  providerServer.listen(0,'127.0.0.1');await once(providerServer,'listening');
  providerHost=`127.0.0.1:${(providerServer.address() as {port:number}).port}`;
  gateway=createVoiceGateway(server,true,kind=>new WebSocket(`ws://${providerHost}/${kind}`),['synthetic-secret']);
  server.listen(0,'127.0.0.1');await once(server,'listening');host=`127.0.0.1:${(server.address() as {port:number}).port}`;
  session={id:'synthetic-session',expiresAt:Date.now()+60000,active:new AbortController()};
});
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const client of clients)client.terminate();gateway.close();for(const ws of providers.clients)ws.terminate();
  await new Promise<void>(resolve=>providers.close(()=>resolve()));
  await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>providerServer.close(()=>resolve()))]);
});
function connect(ticket:string,origin=`http://${host}`){const ws=new WebSocket(`ws://${host}/voice`,['voiceops',ticket],{origin});clients.push(ws);ws.on('error',()=>{});return ws;}
async function rejected(ticket:string,origin?:string){const ws=connect(ticket,origin);const [error]=await once(ws,'error');expect(String(error)).toContain('403');}
async function ready(){
  const ws=connect(gateway.issue(session).ticket);const messages:Record<string,unknown>[]=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='ready')).toBe(true));return {ws,messages};
}
it('requires same origin, a live one-use ticket and one active voice connection',async()=>{
  const ticket=gateway.issue(session).ticket;await rejected(ticket,'https://untrusted.example');
  const ws=connect(ticket);await once(ws,'open');await rejected(ticket);
  await rejected(gateway.issue({...session,id:'other'}).ticket);
});
it('forwards bounded PCM, redacts captions and cancels investigation on speech start',async()=>{
  const {ws,messages}=await ready();ws.send(Buffer.alloc(3200));
  await vi.waitFor(()=>expect(received.some(m=>m.event==='audio_input')).toBe(true));
  stt!.send(JSON.stringify({event:'transcript.partial',text:'synthetic-secret'}));
  stt!.send(JSON.stringify({event:'transcript.final',text:'Synthetic question'}));
  stt!.send(JSON.stringify({event:'vad.speech_start'}));
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='transcript_final')).toBe(true));
  expect(messages.find(m=>m.type==='transcript_partial')?.text).not.toContain('synthetic-secret');
  await vi.waitFor(()=>expect(session.active!.signal.aborted).toBe(true));
  ws.send(Buffer.alloc(3));const [code]=await once(ws,'close');expect(code).toBe(1008);
});
it('speaks only the stored validated answer and terminates synthesis on interruption',async()=>{
  const {ws,messages}=await ready();ws.send(JSON.stringify({type:'speak'}));
  await vi.waitFor(()=>expect(messages.some(m=>m.error==='NO_VALIDATED_ANSWER')).toBe(true));expect(tts).toBeUndefined();
  session.answer=answer;ws.send(JSON.stringify({type:'speak'}));
  await vi.waitFor(()=>expect(received.some(m=>m.type==='text')).toBe(true));
  const text=received.filter(m=>m.type==='text').map(m=>(m.data as {text:string}).text).join('');expect(text).toBe(spokenAnswer(answer));expect(text).not.toContain('https://');
  tts!.send(JSON.stringify({type:'audio',data:{audio:Buffer.alloc(32).toString('base64')}}));
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='audio')).toBe(true));
  const closed=once(tts!,'close');ws.send(JSON.stringify({type:'interrupt'}));await closed;
  expect(session.active!.signal.aborted).toBe(true);
});
it('rejects expired sessions and arbitrary synthesis text',async()=>{
  await rejected(gateway.issue({...session,expiresAt:Date.now()-1}).ticket);
  const {ws}=await ready();ws.send(JSON.stringify({type:'speak',text:'Unvalidated instruction'}));const [code]=await once(ws,'close');expect(code).toBe(1008);expect(tts).toBeUndefined();
});
it('rejects a ticket after thirty seconds even before a timer could run',async()=>{
  const ticket=gateway.issue(session).ticket;const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+31000);
  await rejected(ticket);
});
it('streams progress before an answer exists and queues validated speech until progress finishes',async()=>{
  const {ws,messages}=await ready();gateway.progress(session.id);
  await vi.waitFor(()=>expect(received.some(m=>m.type==='text')).toBe(true));
  const progressSocket=tts!;progressSocket.send(JSON.stringify({type:'audio',data:{audio:Buffer.alloc(32).toString('base64')}}));
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='audio')).toBe(true));expect(session.answer).toBeUndefined();
  session.answer=answer;ws.send(JSON.stringify({type:'speak'}));
  await new Promise(resolve=>setTimeout(resolve,30));expect(tts).toBe(progressSocket);
  progressSocket.send(JSON.stringify({type:'event',data:{event_type:'final'}}));
  await vi.waitFor(()=>expect(tts).not.toBe(progressSocket));
  await vi.waitFor(()=>expect(received.filter(m=>m.type==='text').some(m=>(m.data as {text:string}).text.includes('Synthetic recorded observation'))).toBe(true));
});
it('reports synthesis startup failures without throwing into the investigation route',async()=>{
  gateway.close();gateway=createVoiceGateway(server,true,kind=>{if(kind==='tts')throw new Error('Synthetic startup failure');return new WebSocket(`ws://${providerHost}/stt`);});
  const {messages}=await ready();expect(()=>gateway.progress(session.id)).not.toThrow();
  await vi.waitFor(()=>expect(messages.some(m=>m.error==='VOICE_SYNTHESIS_FAILED')).toBe(true));
});
it('keeps document retrieval silent and speaks the validated reply directly',async()=>{
  gateway.close();const factory=vi.fn((kind:'stt'|'tts')=>new WebSocket(`ws://${providerHost}/${kind}`));
  gateway=createVoiceGateway(server,true,factory,[],true);
  const {ws}=await ready();factory.mockClear();gateway.progress(session.id);
  expect(factory).not.toHaveBeenCalled();expect(tts).toBeUndefined();
  session.speech='Premium cover active rakhne ke liye diya jaata hai.';ws.send(JSON.stringify({type:'speak'}));
  await vi.waitFor(()=>expect(received.some(m=>m.type==='text')).toBe(true));
  expect(received.filter(m=>m.type==='text').map(m=>(m.data as {text:string}).text).join('')).toBe(session.speech);
});

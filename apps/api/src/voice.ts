import { randomBytes } from 'node:crypto';
import type { Server,IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket,{WebSocketServer} from 'ws';
import { z } from 'zod';
import type { Answer } from '../../../packages/investigator/src/contracts.js';
import { redact } from '../../../packages/investigator/src/redact.js';

export type VoiceSession={id:string;expiresAt:number;active:AbortController|undefined;answer?:Answer;speech?:string};
export function spokenAnswer(answer:Answer):string {
  return [`Confidence is ${answer.confidence}.`,...answer.observed_evidence.slice(0,2).map(o=>o.observation),
    ...answer.likely_explanations.slice(0,1).map(h=>`A tentative explanation: ${h.hypothesis}`),
    `Uncertainty: ${answer.uncertainty[0]??'The evidence does not establish a cause.'}`,
    ...answer.suggested_checks.slice(0,1).map(s=>`Suggested check: ${s}`)].join(' ').replace(/https?:\/\/\S+/g,'the linked documentation').slice(0,1200);
}
const control=z.discriminatedUnion('type',[
  z.object({type:z.literal('interrupt')}).strict(),z.object({type:z.literal('speak')}).strict(),
]);
// Provider endpoints are fixed. Credentials never cross the browser transport.
export function sarvamSocket(key:string,kind:'stt'|'tts',conversational=false):WebSocket {
  const path=kind==='stt'?`speech-to-text-realtime/ws?language_code=auto&model=saaras%3Av4&stream_type=fast&sample_rate=16000&encoding=linear16&endpointing=vad${conversational?'&silence_duration_ms=300&min_speech_duration_ms=250':''}`:'text-to-speech/ws?model=bulbul%3Av4-flash&send_completion_event=true';
  return new WebSocket(`wss://api.sarvam.ai/${path}`,{headers:{'Api-Subscription-Key':key},handshakeTimeout:10000,maxPayload:1048576});
}
export type SocketFactory=(kind:'stt'|'tts')=>WebSocket;
export function createVoiceGateway(server:Server,enabled:boolean,factory:SocketFactory,secrets:string[]=[],hindi=false) {
  const tickets=new Map<string,{session:VoiceSession;expiresAt:number}>();
  const wss=new WebSocketServer({noServer:true,maxPayload:6400,handleProtocols:protocols=>protocols.has('voiceops')?'voiceops':false});
  let current:WebSocket|undefined;let connections=0;let totalBytes=0;let totalCharacters=0;
  const speakers=new Map<string,(text:string)=>void>();
  const upgrade=(request:IncomingMessage,socket:Duplex,head:Buffer)=>{
    const reject=(status:number)=>{socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);};
    if(request.url!=='/voice')return reject(404);
    let origin='';try{origin=new URL(String(request.headers.origin)).host;}catch{ /* Fail closed. */ }
    if(!origin||origin!==request.headers.host)return reject(403);
    const protocols=String(request.headers['sec-websocket-protocol']??'').split(',').map(s=>s.trim());
    const ticket=protocols.length===2&&protocols[0]==='voiceops'?protocols[1]??'':'';
    const entry=tickets.get(ticket);tickets.delete(ticket);const session=entry?.session;
    if(!enabled||!session||!entry||entry.expiresAt<Date.now()||session.expiresAt<Date.now()||current||connections>=6||totalBytes>=19200000)return reject(403);
    wss.handleUpgrade(request,socket,head,client=>{
      current=client;connections++;
      let stt:WebSocket|undefined;let tts:WebSocket|undefined;let generation=0;let outputBytes=0;let connectionBytes=0;
      const connectedAt=performance.now();let speechEndedAt:number|undefined;
      const send=(value:unknown)=>{if(client.readyState===WebSocket.OPEN){if(client.bufferedAmount>262144){client.close(1008,'Slow consumer');return;}client.send(JSON.stringify(value));}};
      let queuedSpeech:string|undefined;
      const interrupt=()=>{generation++;queuedSpeech=undefined;tts?.terminate();tts=undefined;clearTimeout(speechTimer);session.active?.abort();send({type:'interrupted',generation});};
      const timer=setTimeout(()=>client.close(1000,'Voice time limit'),Math.min(180000,session.expiresAt-Date.now()));timer.unref();
      let speechTimer:ReturnType<typeof setTimeout>|undefined;
      const fail=()=>{send({type:'error',error:'VOICE_PROVIDER_FAILED'});client.close(1011,'Provider failed');};
      try{stt=factory('stt');}catch{fail();}
      stt?.on('open',()=>send({type:'ready'}));
      stt?.on('error',fail);
      stt?.on('close',()=>{if(client.readyState===WebSocket.OPEN)fail();});
      stt?.on('message',raw=>{
        try{
          const event=z.object({event:z.string(),text:z.string().max(4000).optional()}).passthrough().parse(JSON.parse(raw.toString()));
          if(event.event==='vad.speech_start'){interrupt();send({type:'speech_start'});}
          if(event.event==='vad.speech_end')speechEndedAt=performance.now();
          if(event.event==='transcript.partial'||event.event==='transcript.final')send({type:event.event==='transcript.final'?'transcript_final':'transcript_partial',text:String(redact((event.text??'').slice(0,1000),secrets))});
          if(event.event==='error')fail();
        }catch{fail();}
      });
      const synthesize=(text:string)=>{
          if(tts){queuedSpeech=text;return;}
          totalCharacters+=text.length;
          if(totalCharacters>8000){send({type:'error',error:'VOICE_CHARACTER_LIMIT'});return;}
          const epoch=++generation;outputBytes=0;let provider:WebSocket;
          try{provider=factory('tts');}catch{send({type:'error',error:'VOICE_SYNTHESIS_FAILED'});return;}
          tts=provider;let firstAudio=true;
          const finish=()=>{if(tts!==provider)return;tts=undefined;clearTimeout(speechTimer);const next=queuedSpeech;queuedSpeech=undefined;if(next)synthesize(next);};
          speechTimer=setTimeout(()=>{queuedSpeech=undefined;provider.terminate();send({type:'error',error:'VOICE_TIMEOUT'});},30000);
          provider.on('open',()=>{
            provider.send(JSON.stringify({type:'config',data:{speaker:hindi?'aparna_hi_customer':'simran_en_customer',language_code:hindi?'hi-IN':'en-IN',pace:1,speech_sample_rate:16000,output_audio_codec:'linear16',min_buffer_size:50,max_chunk_length:200}}));
            for(const sentence of text.match(/[^.!?]+[.!?]*\s*/g)??[text])provider.send(JSON.stringify({type:'text',data:{text:sentence}}));
            provider.send(JSON.stringify({type:'flush'}));
          });
          provider.on('error',()=>{queuedSpeech=undefined;send({type:'error',error:'VOICE_SYNTHESIS_FAILED'});});
          provider.on('close',finish);
          provider.on('message',data=>{
            if(epoch!==generation)return;
            try{
              const event=z.object({type:z.string(),data:z.object({audio:z.string().max(1400000).optional(),event_type:z.string().optional(),content_type:z.string().optional()}).passthrough().optional()}).passthrough().parse(JSON.parse(data.toString()));
              if(event.type==='audio'&&event.data?.audio){
                if(firstAudio){firstAudio=false;if(speechEndedAt!==undefined)send({type:'latency',speech_end_to_first_audio_ms:Math.round(performance.now()-speechEndedAt)});}
                outputBytes+=Buffer.byteLength(event.data.audio,'base64');
                if(outputBytes>1920000){queuedSpeech=undefined;provider.terminate();send({type:'error',error:'VOICE_AUDIO_LIMIT'});return;}
                send({type:'audio',generation:epoch,audio:event.data.audio,sample_rate:16000});
              }else if(event.type==='event'&&event.data?.event_type==='final'){send({type:'audio_end',generation:epoch});provider.close();finish();}
              else if(event.type==='error'){queuedSpeech=undefined;provider.terminate();send({type:'error',error:'VOICE_SYNTHESIS_FAILED'});}
            }catch{queuedSpeech=undefined;provider.terminate();send({type:'error',error:'VOICE_PROTOCOL_ERROR'});}
          });
      };
      speakers.set(session.id,synthesize);
      client.on('message',(raw,isBinary)=>{
        if(session.expiresAt<Date.now()){client.close(1008,'Session expired');return;}
        if(isBinary){
          const bytes=Buffer.from(raw as Buffer);
          totalBytes+=bytes.length;
          connectionBytes+=bytes.length;
          if(!bytes.length||bytes.length%2||bytes.length>6400||totalBytes>19200000||connectionBytes>(performance.now()-connectedAt)*32+64000||stt?.readyState!==WebSocket.OPEN||stt.bufferedAmount>65536){client.close(1008,'Audio limit');return;}
          stt.send(JSON.stringify({event:'audio_input',audio:bytes.toString('base64')}));return;
        }
        try{
          const message=control.parse(JSON.parse(raw.toString()));
          if(message.type==='interrupt'){interrupt();return;}
          if(!session.answer&&!session.speech){send({type:'error',error:'NO_VALIDATED_ANSWER'});return;}
          synthesize(session.speech??spokenAnswer(session.answer!));
        }catch{client.close(1008,'Invalid control');}
      });
      client.on('error',()=>client.terminate());
      client.on('close',()=>{speakers.delete(session.id);queuedSpeech=undefined;clearTimeout(timer);clearTimeout(speechTimer);stt?.terminate();tts?.terminate();session.active?.abort();if(current===client)current=undefined;});
    });
  };
  server.on('upgrade',upgrade);
  return {
    progress(id:string){if(!hindi)speakers.get(id)?.('I am checking the recorded evidence for your question.');},
    issue(session:VoiceSession){if(!enabled)throw new Error('VOICE_NOT_CONFIGURED');for(const [ticket,entry]of tickets)if(entry.session.id===session.id||entry.expiresAt<Date.now())tickets.delete(ticket);if(tickets.size>=20)throw new Error('VOICE_TICKET_LIMIT');const ticket=randomBytes(24).toString('hex');tickets.set(ticket,{session,expiresAt:Date.now()+30000});return {ticket,expires_in_seconds:30};},
    close(){server.off('upgrade',upgrade);for(const client of wss.clients)client.terminate();tickets.clear();wss.close();},
  };
}

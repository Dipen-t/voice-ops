import { sarvamSocket } from '../apps/api/src/voice.js';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { z } from 'zod';

// Explicit live provider test using synthetic speech, not a microphone recording or incident data.
const key=process.env.SARVAM_API_KEY;if(!key)throw new Error('SARVAM_NOT_CONFIGURED');
const gatewayMode=process.argv.includes('--gateway');
const documentsMode=process.argv.includes('--documents');
const detailed=process.argv.includes('--detailed');
const acknowledgement=process.argv.includes('--acknowledgement');
const completeAnswer=process.argv.includes('--complete-answer');
const tuned=process.argv.includes('--tuned');
const pauseTest=process.argv.includes('--pause-test');
if(pauseTest&&(!gatewayMode||!documentsMode||!completeAnswer||acknowledgement||detailed))throw new Error('PAUSE_TEST_REQUIRES_SIMPLE_COMPLETE_DOCUMENT_GATEWAY');
if(detailed&&(!gatewayMode||!documentsMode||!completeAnswer))throw new Error('DETAILED_TEST_REQUIRES_COMPLETE_DOCUMENT_GATEWAY');
if(acknowledgement&&(!gatewayMode||!documentsMode||!completeAnswer||detailed))throw new Error('ACK_TEST_REQUIRES_COMPLETE_DOCUMENT_GATEWAY');
const headers={authorization:`Bearer ${process.env.API_BEARER_TOKEN??''}`,'content-type':'application/json'};
async function api(path:string,body?:unknown,capability?:string){const response=await fetch(`http://127.0.0.1:3002${path}`,{method:body===undefined?'GET':'POST',headers:{...headers,...(capability?{'x-session-token':capability}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!response.ok)throw new Error('GATEWAY_REQUEST_FAILED');return response.json();}
let session:{id:string;session_token:string}|undefined;let ticket:string|undefined;
const llmModel=gatewayMode?z.object({model:z.string().max(100)}).parse(await api('/investigator/status')).model:undefined;
if(gatewayMode){let body:unknown;if(documentsMode){const docs=z.object({documents:z.array(z.object({id:z.uuid()})).min(1)}).parse(await api('/documents'));body={document_id:docs.documents[0]!.id};}else{const incidents=z.object({incidents:z.array(z.object({id:z.uuid()})).min(1)}).parse(await api('/incidents'));body={incident_id:incidents.incidents[0]!.id};}session=z.object({id:z.uuid(),session_token:z.string()}).parse(await api('/sessions',body));ticket=z.object({ticket:z.string()}).parse(await api(`/sessions/${session.id}/voice-ticket`,{},session.session_token)).ticket;}
const chunks:Buffer[]=[];const started=performance.now();let firstAudio:number|undefined;
await new Promise<void>((resolve,reject)=>{
  const ws=sarvamSocket(key,'tts');const timer=setTimeout(()=>{ws.terminate();reject(new Error('TTS_TIMEOUT'));},30000);
  ws.on('open',()=>{
    ws.send(JSON.stringify({type:'config',data:{speaker:documentsMode?'aparna_hi_customer':'simran_en_customer',language_code:documentsMode?'hi-IN':'en-IN',speech_sample_rate:16000,output_audio_codec:'linear16',min_buffer_size:50,max_chunk_length:200}}));
    ws.send(JSON.stringify({type:'text',data:{text:acknowledgement?'अच्छा ठीक है, ठीक है, समझ गया।':detailed?'डिडक्टिबल और को पेमेंट में क्या फर्क है? एक उदाहरण के साथ विस्तार से समझाओ।':documentsMode?'सैंपल पॉलिसी में वेटिंग पीरियड कितना है?':'What should we check to investigate slow requests?'}}));ws.send(JSON.stringify({type:'flush'}));
  });
  ws.on('error',()=>{clearTimeout(timer);reject(new Error('TTS_CONNECTION_FAILED'));});
  ws.on('message',raw=>{
    const event=JSON.parse(raw.toString());
    if(event.type==='audio'){firstAudio??=performance.now()-started;chunks.push(Buffer.from(event.data.audio,'base64'));if(chunks.reduce((n,c)=>n+c.length,0)>1000000){ws.terminate();reject(new Error('AUDIO_LIMIT'));}}
    if(event.type==='error'){clearTimeout(timer);ws.terminate();reject(new Error('TTS_PROVIDER_REJECTED'));}
    if(event.type==='event'&&event.data.event_type==='final'){clearTimeout(timer);ws.close();resolve();}
  });
});
const pcm=Buffer.concat(chunks);if(!pcm.length||pcm.length%2||pcm.subarray(0,4).toString()==='RIFF')throw new Error('UNEXPECTED_AUDIO_ENCODING');
const transcripts:string[]=[];let partials=0;let toolCalls=0;let answerValidated=false;let gatewayAudioBytes=0;let gatewayLatency:number|undefined;let progressAudioBytes=0;let progressLatency:number|undefined;
let documentAnswer:unknown;
let completeAudioReceived=false;
let requestToAnswer:number|undefined,inputEndAt:number|undefined,firstAnswerAudioAt:number|undefined,requestStartedAt:number|undefined;
let turnEvents:{type:string;elapsed_ms:number;path?:string}[]=[];
await new Promise<void>((resolve,reject)=>{
  const ws=gatewayMode?new WebSocket('ws://127.0.0.1:3002/voice',['voiceops',ticket!],{origin:'http://127.0.0.1:3002'}):sarvamSocket(key,'stt');const timer=setTimeout(()=>{ws.terminate();reject(new Error('STT_TIMEOUT'));},gatewayMode?90000:30000);
  let sent=false;let asked=false;
  const sendPCM=()=>{if(sent)return;sent=true;void (async()=>{
    await delay(200);
    const send=(chunk:Buffer)=>ws.send(gatewayMode?chunk:JSON.stringify({event:'audio_input',audio:chunk.toString('base64')}));
    const pauseOffset=Math.floor(pcm.length/6400)*3200;
    for(let offset=0;offset<pcm.length&&ws.readyState===1;offset+=3200){
      if(pauseTest&&offset===pauseOffset){for(let i=0;i<2;i++){send(Buffer.alloc(3200));await delay(100);}}
      send(pcm.subarray(offset,offset+3200));if(offset+3200>=pcm.length)inputEndAt=performance.now();await delay(100);
    }
    for(let i=0;i<12&&ws.readyState===1;i++){send(Buffer.alloc(3200));await delay(100);}
  })();};
  ws.on('error',()=>{clearTimeout(timer);reject(new Error('STT_CONNECTION_FAILED'));});
  ws.on('open',()=>{if(!gatewayMode)sendPCM();});
  ws.on('message',raw=>{
    const event=JSON.parse(raw.toString());
    if(event.type==='ready')sendPCM();
    if(event.type==='transcript_partial')partials++;
    if(event.type==='latency'){gatewayLatency=event.speech_end_to_first_audio_ms;if(!answerValidated)progressLatency=gatewayLatency;}
    if(event.type==='audio'&&!answerValidated)progressAudioBytes+=Buffer.byteLength(event.audio,'base64');
    if(event.type==='audio'&&answerValidated){firstAnswerAudioAt??=performance.now();gatewayAudioBytes+=Buffer.byteLength(event.audio,'base64');if(!completeAnswer){clearTimeout(timer);ws.close();resolve();}}
    if(event.type==='audio_end'&&answerValidated&&completeAnswer){completeAudioReceived=true;clearTimeout(timer);ws.close();resolve();}
    if(event.type==='transcript_final'&&!asked){
      if(pauseTest&&inputEndAt===undefined){clearTimeout(timer);ws.terminate();reject(new Error('PAUSE_SPLIT_UTTERANCE'));return;}
      asked=true;transcripts.push(String(event.text).slice(0,1000));
      void (async()=>{
        requestStartedAt=performance.now();
        const response=await fetch(`http://127.0.0.1:3002/sessions/${session!.id}/messages`,{method:'POST',headers:{...headers,'x-session-token':session!.session_token},body:JSON.stringify({text:event.text})});
        if(!response.ok)throw new Error('INVESTIGATION_REJECTED');
        const stream=await response.text();if(stream.length>200000)throw new Error('STREAM_LIMIT');
        const events=stream.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
        requestToAnswer=Math.round(performance.now()-requestStartedAt);
        turnEvents=events.map(e=>({type:String(e.type),elapsed_ms:Number(e.elapsed_ms),...(e.type==='query_resolved'?{path:String(e.data.path)}:{})}));
        toolCalls=events.filter(e=>e.type==='tool_completed').length;answerValidated=events.some(e=>e.type==='answer');
        if(documentsMode){
          documentAnswer=events.find(e=>e.type==='answer')?.data;
          if(acknowledgement){z.object({kind:z.literal('greeting'),reply:z.string().max(100),citations:z.array(z.unknown()).length(0)}).parse(documentAnswer);if(events.some(e=>e.type==='search_started'||e.type==='model_started'))throw new Error('ACK_STARTED_RETRIEVAL');}
          if(detailed){
            const value=z.object({kind:z.literal('document'),reply:z.string().min(200).max(1000),citations:z.array(z.unknown()).min(1)}).parse(documentAnswer);
            if(/[\u0900-\u097f]/u.test(value.reply)||/dekh.*bata|checking|searching|reading documents/iu.test(value.reply))throw new Error('UNEXPECTED_REPLY_STYLE');
          }
        }
        if(!answerValidated)throw new Error('NO_VALIDATED_ANSWER');ws.send(JSON.stringify({type:'speak'}));
      })().catch(()=>{clearTimeout(timer);ws.terminate();reject(new Error('GATEWAY_INVESTIGATION_FAILED'));});
    }
    if(event.event==='transcript.partial')partials++;
    if(event.event==='transcript.final'){transcripts.push(String(event.text).slice(0,1000));clearTimeout(timer);ws.close();resolve();}
    if(event.event==='error'){clearTimeout(timer);ws.terminate();reject(new Error('STT_PROVIDER_REJECTED'));}
    if(event.type==='error'){clearTimeout(timer);ws.terminate();reject(new Error('VOICE_GATEWAY_REJECTED'));}
  });
});
const report={kind:gatewayMode?'live-sarvam-groq-gateway-synthetic-speech':'live-sarvam-synthetic-speech-loopback',microphone_tested:false,free_signup_credits_only:true,tts_model:'bulbul:v4-flash',stt_model:'saaras:v4',pcm_bytes:pcm.length,audio_seconds:pcm.length/32000,tts_first_audio_ms:Math.round(firstAudio??0),partial_events:partials,transcripts,...(gatewayMode?{tool_calls:toolCalls,answer_validated:answerValidated,gateway_audio_bytes:gatewayAudioBytes,progress_audio_bytes:progressAudioBytes,speech_end_to_progress_audio_at_server_ms:progressLatency,speech_end_to_first_audio_at_server_ms:gatewayLatency}:{})};
if(completeAnswer&&(!completeAudioReceived||!gatewayAudioBytes))throw new Error('INCOMPLETE_ANSWER_AUDIO');
const finalReport=documentsMode?{...report,kind:acknowledgement?'live-hinglish-acknowledgement-synthetic-voice':detailed?'live-hinglish-insurance-detailed-synthetic-voice':'live-hindi-document-assistant-synthetic-voice',llm_model:llmModel,request_to_answer_ms:requestToAnswer,last_input_pcm_to_first_audio_at_client_ms:inputEndAt!==undefined&&firstAnswerAudioAt!==undefined?Math.round(firstAnswerAudioAt-inputEndAt):undefined,request_to_first_audio_at_client_ms:requestStartedAt!==undefined&&firstAnswerAudioAt!==undefined?Math.round(firstAnswerAudioAt-requestStartedAt):undefined,answer_audio_seconds:gatewayAudioBytes/32000,turn_events:turnEvents,complete_answer_audio_received:completeAudioReceived,document_answer:documentAnswer,speaker:'aparna_hi_customer',language:'hi-IN'}:report;
const reportPath=acknowledgement?'eval/reports/hinglish-acknowledgement-voice-smoke.json':detailed?'eval/reports/hinglish-insurance-detailed-voice-smoke.json':documentsMode?'eval/reports/hindi-document-voice-smoke.json':gatewayMode?'eval/reports/voice-gateway-smoke.json':'eval/reports/voice-provider-smoke.json';
const measuredReport={...finalReport,measured_at:new Date().toISOString(),...(tuned?{configured_silence_duration_ms:300}:{}),...(pauseTest?{synthetic_internal_pause_ms:200,pause_split_detected:false}:{})};
await writeFile(reportPath.replace('.json',`${tuned?'-tuned':''}${pauseTest?'-pause':''}.json`),JSON.stringify(measuredReport,null,2)+'\n');console.log(JSON.stringify(measuredReport));

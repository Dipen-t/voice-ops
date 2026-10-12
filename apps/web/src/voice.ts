import {StreamingPlayback} from './playback';
type Callbacks={status:(value:string)=>void;caption:(value:string)=>void;final:(value:string)=>void;interrupt:()=>void;error:(value:string)=>void;latency:(value:number)=>void};
export class VoiceConnection {
  private socket:WebSocket|undefined;private context:AudioContext|undefined;private stream:MediaStream|undefined;
  private playback:StreamingPlayback|undefined;private generation=0;private microphone:AudioWorkletNode|undefined;
  private closed=false;
  private muted=false;
  constructor(private callbacks:Callbacks){}
  async start(getTicket:()=>Promise<string>){
    this.callbacks.status('Requesting microphone…');
    try{
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(this.closed){this.stream.getTracks().forEach(t=>t.stop());return;}
      this.context=new AudioContext({sampleRate:16000});await this.context.resume();
      this.playback=new StreamingPlayback(this.context,playing=>this.callbacks.status(playing?'Speaking':'Listening'));
      if(this.context.sampleRate!==16000)throw new Error('This browser does not support the required 16 kHz microphone rate.');
      await this.context.audioWorklet.addModule('/microphone.js');
      if(this.closed)return;
      const ticket=await getTicket();if(this.closed)return;
      const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/voice`,['voiceops',ticket]);this.socket=socket;
      socket.onmessage=event=>{
        try{
          const message=JSON.parse(String(event.data));
          if(message.type==='ready'){
            if(!this.context||!this.stream)return;
            const microphone=new AudioWorkletNode(this.context,'microphone');this.microphone=microphone;
            microphone.port.onmessage=event=>{if(socket.readyState===WebSocket.OPEN){if(socket.bufferedAmount>64000){this.callbacks.error('Audio connection is too slow.');this.stop();return;}socket.send(this.muted?new ArrayBuffer(event.data.byteLength):event.data);}};
            this.context.createMediaStreamSource(this.stream).connect(microphone);microphone.connect(this.context.destination);
            this.callbacks.status('Listening');
          }
          if(message.type==='transcript_partial')this.callbacks.caption(String(message.text));
          if(message.type==='transcript_final'){this.callbacks.caption(String(message.text));this.callbacks.final(String(message.text));}
          if(message.type==='speech_start'){this.stopPlayback();this.callbacks.interrupt();this.callbacks.status('Listening');}
          if(message.type==='interrupted'){this.generation=Math.max(this.generation,Number(message.generation));this.stopPlayback();}
          if(message.type==='audio')this.play(message.audio,Number(message.generation));
          if(message.type==='error')this.callbacks.error(String(message.error));
          if(message.type==='latency')this.callbacks.latency(Number(message.speech_end_to_first_audio_ms));
        }catch{this.callbacks.error('Invalid voice response');this.stop();}
      };
      socket.onerror=()=>this.callbacks.error('Voice connection failed. Check the server configuration.');
      socket.onclose=()=>{this.stop();this.callbacks.status('Voice stopped');};
    }catch(error){this.stop();throw error;}
  }
  private play(encoded:string,generation:number){
    const context=this.context;if(!context||generation<this.generation||this.closed)return;
    if(generation>this.generation)this.generation=generation;
    const bytes=Uint8Array.from(atob(encoded),s=>s.charCodeAt(0));
    if(bytes.length%2||bytes.length>1048576)throw new Error('Invalid PCM audio');
    this.playback?.push(bytes);
  }
  speak(){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type:'speak'}));}
  setMuted(value:boolean){this.muted=value;this.stream?.getAudioTracks().forEach(track=>{track.enabled=!value;});}
  interrupt(){this.generation++;this.stopPlayback();if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type:'interrupt'}));}
  private stopPlayback(){this.playback?.stop();}
  stop(){this.closed=true;this.stopPlayback();this.microphone?.disconnect();this.stream?.getTracks().forEach(t=>t.stop());this.socket?.close();void this.context?.close().catch(()=>{});}
}

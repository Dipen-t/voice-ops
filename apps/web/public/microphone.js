// Mono PCM16, 16 kHz. The AudioContext requests this rate; refuse mismatched rates.
/* global AudioWorkletProcessor, sampleRate, registerProcessor */
class Microphone extends AudioWorkletProcessor {
  constructor(){super();this.samples=[];}
  process(inputs){
    const channel=inputs[0]?.[0];
    if(channel&&sampleRate===16000){
      for(const value of channel)this.samples.push(Math.round(Math.max(-1,Math.min(1,value))*32767));
      while(this.samples.length>=1600){
        const pcm=new Int16Array(this.samples.splice(0,1600));
        this.port.postMessage(pcm.buffer,[pcm.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('microphone',Microphone);

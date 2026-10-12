/** Bound raw PCM memory while scheduling only one second ahead of playback. */
export class StreamingPlayback {
  private queue:{bytes:Uint8Array;offset:number}[]=[];
  private allocated=0;private next=0;private nodes=new Set<AudioBufferSourceNode>();
  private timer:ReturnType<typeof setInterval>|undefined;
  constructor(private context:AudioContext,private state:(playing:boolean)=>void){}
  push(bytes:Uint8Array){
    if(!bytes.length||bytes.length%2||bytes.length>1048576)throw new Error('Invalid PCM audio');
    if(this.allocated+bytes.length>4194304)throw new Error('Audio memory limit reached');
    this.queue.push({bytes,offset:0});this.allocated+=bytes.length;this.pump();
    if(!this.timer)this.timer=setInterval(()=>this.pump(),50);
  }
  private pump(){
    while(this.queue.length&&Math.max(this.next,this.context.currentTime)-this.context.currentTime<1){
      const item=this.queue[0]!;const length=Math.min(8000,item.bytes.length-item.offset);
      const pcm=new DataView(item.bytes.buffer,item.bytes.byteOffset+item.offset,length);
      const buffer=this.context.createBuffer(1,length/2,16000);const channel=buffer.getChannelData(0);
      for(let i=0;i<channel.length;i++)channel[i]=pcm.getInt16(i*2,true)/32768;
      item.offset+=length;if(item.offset===item.bytes.length){this.queue.shift();this.allocated-=item.bytes.length;}
      const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);this.nodes.add(source);
      this.next=Math.max(this.context.currentTime+0.03,this.next);source.start(this.next);this.next+=buffer.duration;
      source.onended=()=>{this.nodes.delete(source);source.disconnect();this.pump();};this.state(true);
    }
    if(!this.queue.length&&!this.nodes.size){if(this.timer)clearInterval(this.timer);this.timer=undefined;this.next=0;this.state(false);}
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;this.queue=[];this.allocated=0;for(const node of this.nodes){node.onended=null;node.stop();node.disconnect();}this.nodes.clear();this.next=0;}
}

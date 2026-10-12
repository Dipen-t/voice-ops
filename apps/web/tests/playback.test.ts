import { afterEach,expect,it,vi } from 'vitest';
import { StreamingPlayback } from '../src/playback';
// Synthetic AudioContext and PCM. Tests scheduling/cancellation, not audible browser output.
function fixture(){
  let time=0;const scheduled:{at:number;duration:number;ended:()=>void;stop:ReturnType<typeof vi.fn>}[]=[];
  const context={get currentTime(){return time;},destination:{},createBuffer:(_channels:number,length:number,rate:number)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),createBufferSource:()=>{
    const node={buffer:{duration:0},onended:null as null|(()=>void),connect:()=>{},disconnect:()=>{},stop:vi.fn(),start:(at:number)=>{scheduled.push({at,duration:node.buffer.duration,ended:()=>node.onended?.(),stop:node.stop});}};return node;
  }};
  const state=vi.fn();const player=new StreamingPlayback(context as unknown as AudioContext,state);
  return {player,scheduled,state,advance:(seconds:number)=>{time+=seconds;for(const s of scheduled.splice(0))if(s.at+s.duration<=time)s.ended();else scheduled.push(s);vi.advanceTimersByTime(seconds*1000);}};
}
afterEach(()=>vi.useRealTimers());
it('plays an accelerated forty-second PCM response with only a short scheduling horizon',()=>{
  vi.useFakeTimers();const f=fixture();f.player.push(new Uint8Array(640000));f.player.push(new Uint8Array(640000));
  expect(Math.max(...f.scheduled.map(s=>s.at+s.duration))).toBeLessThan(1.3);
  for(let i=0;i<45;i++)f.advance(1);
  expect(f.scheduled).toHaveLength(0);expect(f.state).toHaveBeenLastCalledWith(false);expect(vi.getTimerCount()).toBe(0);
});
it('interrupts scheduled and buffered audio and permits the next reply',()=>{
  vi.useFakeTimers();const f=fixture();f.player.push(new Uint8Array(640000));const old=[...f.scheduled];f.player.stop();expect(old.every(s=>s.stop.mock.calls.length===1)).toBe(true);expect(vi.getTimerCount()).toBe(0);f.player.push(new Uint8Array(3200));expect(vi.getTimerCount()).toBe(1);f.player.stop();
});
it('bounds PCM memory while rejecting malformed audio',()=>{
  vi.useFakeTimers();const f=fixture();expect(()=>f.player.push(new Uint8Array(3))).toThrow('Invalid PCM');for(let i=0;i<4;i++)f.player.push(new Uint8Array(1048576));expect(()=>f.player.push(new Uint8Array(1048576))).toThrow('Audio memory limit');f.player.stop();
});

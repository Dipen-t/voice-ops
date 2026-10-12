import React,{useState,useRef,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import {VoiceConnection} from './voice';
import {HindiApp} from './HindiApp';

type Incident={id:string;display_title:string;system:string;start_time_us:string;end_time_us:string};
type Event={sequence:number;type:string;at:string;elapsed_ms:number;data:Record<string,unknown>};
type Answer={observed_evidence:{evidence_id:string;observation:string;quote:string}[];likely_explanations:{hypothesis:string;evidence_ids:string[]}[];confidence:string;uncertainty:string[];suggested_checks:string[];documentation_ids:string[];clarification:string|null};
type Source={id:string;text:string;citation:{url:string;title:string;heading:string;attribution:string}};
type Session={id:string;session_token:string};
const base=import.meta.env.DEV?'/api':'';
function App() {
  const [token,setToken]=useState(''),[connected,setConnected]=useState(false),[incidents,setIncidents]=useState<Incident[]>([]),[selected,setSelected]=useState('');
  const [session,setSession]=useState<Session|null>(null),[question,setQuestion]=useState(''),[events,setEvents]=useState<Event[]>([]),[answer,setAnswer]=useState<Answer|null>(null),[sources,setSources]=useState<Source[]>([]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[model,setModel]=useState('');
  const abort=useRef<AbortController|null>(null);
  const voice=useRef<VoiceConnection|null>(null);
  const [voiceReady,setVoiceReady]=useState(false),[voiceStatus,setVoiceStatus]=useState('Voice stopped'),[caption,setCaption]=useState('');
  const [voiceLatency,setVoiceLatency]=useState<number|null>(null);
  const [micMuted,setMicMuted]=useState(false);
  const [showDetails,setShowDetails]=useState(false);
  const nextTurnAt=useRef(0),queuedQuestion=useRef<string|null>(null),queueTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const actions=useRef<{run:(text:string)=>void;interrupt:()=>void}>({run:()=>{},interrupt:()=>{}});
  useEffect(()=>()=>{voice.current?.stop();abort.current?.abort();if(queueTimer.current)clearTimeout(queueTimer.current);},[]);
  async function api(path:string,body?:unknown,capability?:string) {
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'}),...(capability?{'x-session-token':capability}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();if(!response.ok)throw new Error(value.error??'REQUEST_FAILED');return value;
  }
  async function connect(event:React.FormEvent) {
    event.preventDefault();setError('');setBusy(true);
    try {const list=await api('/incidents');const status=await api('/investigator/status');setIncidents(list.incidents);setReady(status.model_configured&&status.requests_enabled);setVoiceReady(status.voice_available);setModel(status.model);setConnected(true);}
    catch(e){setError(e instanceof Error?e.message:'Connection failed');}finally{setBusy(false);}
  }
  async function choose(id:string) {
    stopVoice();
    setCaption('');setVoiceLatency(null);
    setSelected(id);setEvents([]);setAnswer(null);setSources([]);setSession(null);setError('');
    if(!id)return;setBusy(true);
    try {setSession(await api('/sessions',{incident_id:id}));}catch(e){setError(e instanceof Error?e.message:'Session failed');}finally{setBusy(false);}
  }
  function accept(event:Event) {
    setEvents(old=>[...old,event].slice(-100));
    if(event.type==='answer'){setAnswer(event.data.answer as Answer);setSources(event.data.citations as Source[]);}
    if(event.type==='turn_failed'||event.type==='turn_cancelled')setError(String(event.data.error));
  }
  async function send(event:React.FormEvent) {
    event.preventDefault();voice.current?.interrupt();await runQuestion(question);
  }
  async function runQuestion(text:string) {
    setQuestion(text);if(!session||text.trim().length<3)return;
    if(voice.current&&(abort.current||Date.now()<nextTurnAt.current)){queuedQuestion.current=text;scheduleQuestion();return;}
    if(abort.current)return;
    queuedQuestion.current=null;if(queueTimer.current){clearTimeout(queueTimer.current);queueTimer.current=null;}
    setBusy(true);setError('');setAnswer(null);setSources([]);
    const controller=new AbortController();abort.current=controller;
    try {
      const response=await fetch(`${base}/sessions/${session.id}/messages`,{method:'POST',headers:{authorization:`Bearer ${token}`,'x-session-token':session.session_token,'content-type':'application/json'},body:JSON.stringify({text}),signal:controller.signal});
      if(!response.ok){const problem=await response.json();if(problem.error==='LOCAL_MODEL_COOLDOWN'&&voice.current){nextTurnAt.current=Date.now()+Math.min(60,Number(response.headers.get('retry-after'))||60)*1000;queuedQuestion.current=text;scheduleQuestion();return;}throw new Error(problem.error??'Investigation failed');}
      nextTurnAt.current=Number(response.headers.get('x-next-turn-at'))||Date.now()+60000;
      if(!response.body)throw new Error('No event stream');
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      let validated=false;
      while(true){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});if(pending.length>200000)throw new Error('Stream limit exceeded');let end:number;while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);const line=frame.split('\n').find(l=>l.startsWith('data: '));if(line){const event=JSON.parse(line.slice(6));accept(event);if(event.type==='answer')validated=true;}}}
      if(validated&&!controller.signal.aborted)voice.current?.speak();
    } catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Investigation failed');}
    finally{abort.current=null;setBusy(false);if(queuedQuestion.current)scheduleQuestion();}
  }
  async function cancel(){actions.current.interrupt();if(session)await api(`/sessions/${session.id}/cancel`,{},session.session_token).catch(()=>{});setError('Investigation cancelled');}
  function scheduleQuestion(){
    if(queueTimer.current)clearTimeout(queueTimer.current);
    if(!voice.current||!queuedQuestion.current)return;
    const wait=Math.max(0,nextTurnAt.current-Date.now());
    setVoiceStatus(wait>0?'Your follow-up is queued · waiting for model capacity':'Preparing your follow-up');
    queueTimer.current=setTimeout(()=>{queueTimer.current=null;if(!voice.current)return;if(abort.current){scheduleQuestion();return;}const text=queuedQuestion.current;queuedQuestion.current=null;if(text)actions.current.run(text);},Math.max(wait,250));
  }
  actions.current={run:text=>{void runQuestion(text);},interrupt:()=>{queuedQuestion.current=null;if(queueTimer.current)clearTimeout(queueTimer.current);abort.current?.abort();}};
  function stopVoice(){queuedQuestion.current=null;if(queueTimer.current)clearTimeout(queueTimer.current);abort.current?.abort();voice.current?.stop();voice.current=null;setVoiceStatus('Voice stopped');setMicMuted(false);}
  async function startVoice(){
    if(!session||voice.current)return;setError('');
    setVoiceStatus('Connecting voice…');setVoiceLatency(null);setMicMuted(false);
    const connection=new VoiceConnection({status:value=>{if(voice.current!==connection)return;if(value==='Listening'&&queuedQuestion.current){scheduleQuestion();return;}setVoiceStatus(value);if(value==='Voice stopped'){voice.current=null;queuedQuestion.current=null;if(queueTimer.current)clearTimeout(queueTimer.current);}},caption:setCaption,final:text=>actions.current.run(text),interrupt:()=>actions.current.interrupt(),error:setError,latency:setVoiceLatency});voice.current=connection;
    try{await connection.start(async()=>{const {ticket}=await api(`/sessions/${session.id}/voice-ticket`,{},session.session_token);return ticket;});}
    catch(e){stopVoice();setError(e instanceof Error?e.message:'Microphone failed');}
  }
  const evidence=events.filter(e=>e.type==='tool_completed');
  const incident=incidents.find(i=>i.id===selected);
  return <div className="shell"><header><div className="brand"><span className="mark">V</span><div>VoiceOps<small>INCIDENT WORKBENCH</small></div></div><span className="replay">RECORDED INCIDENTS · READ ONLY</span></header>
    <main><div className="intro"><div><p className="eyebrow">YOUR INCIDENT COMPANION</p><h1>Let’s talk it through.</h1><p className="muted">Choose an incident, then tell me what you’re noticing.</p></div><button className="secondary" onClick={()=>setShowDetails(!showDetails)} aria-expanded={showDetails}>{showDetails?'Hide evidence':'View evidence'}</button></div>
    {!connected?<section className="login"><h2>Connect to your local workbench</h2><p>Enter the API bearer token from your local .env.model file. It stays in this tab’s memory.</p><form onSubmit={connect}><label htmlFor="token">Local access token</label><input id="token" type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} required/><button disabled={busy||!token}>Connect</button></form></section>:<>
    <section className="selector"><label htmlFor="incident">What are we investigating?</label><select id="incident" disabled={busy} value={selected} onChange={e=>{void choose(e.target.value);}}><option value="">Choose a recorded incident</option>{incidents.map(i=><option key={i.id} value={i.id}>{i.display_title} · {i.system}</option>)}</select>{showDetails&&incident&&<p className="id">{incident.id}<span>Epoch µs: {incident.start_time_us} — {incident.end_time_us}</span></p>}</section>
    {!ready&&<div className="notice">Groq is not ready for requests. Configure the local key and enable requests in .env.model, then restart the application. Evidence tools and runbooks are already available.</div>}
    <div className={showDetails?'grid':'voice-layout'}><section className="conversation"><div className="section-head"><h2>A conversation, with context.</h2><span>{showDetails?model:'VOICEOPS'}</span></div>
      <section className="voice-controls" data-state={micMuted?'muted':busy&&voiceStatus==='Listening'?'thinking':voiceStatus.toLowerCase()}>
        <div className="voice-orb" aria-hidden="true"><span>V</span></div>
        <p className="voice-state" role="status">{micMuted?'Microphone muted':busy&&voiceStatus==='Listening'?'Thinking through the evidence…':voiceStatus==='Voice stopped'?'Ready when you are':voiceStatus}{!voiceReady?' · Voice unavailable':''}</p>
        <p className="voice-prompt">{voiceStatus==='Voice stopped'?'Begin once. Ask questions and follow-ups naturally.':'I’ll keep listening. You can speak over me to interrupt.'}</p>
        <p aria-live="polite" className="caption">{caption||'“What should we check about slow requests?”'}</p>
        <div className="call-controls">{voiceStatus==='Voice stopped'?<button type="button" disabled={!session||!ready||!voiceReady} onClick={()=>{void startVoice();}}>Begin conversation</button>:<><button type="button" className="secondary" aria-pressed={micMuted} onClick={()=>{voice.current?.setMuted(!micMuted);setMicMuted(!micMuted);}}>{micMuted?'Unmute':'Mute microphone'}</button><button type="button" className="end-call" onClick={stopVoice}>End conversation</button><button type="button" className="secondary" onClick={()=>{voice.current?.interrupt();actions.current.interrupt();setVoiceStatus('Listening');}}>Interrupt</button></>}</div>
        <small>Microphone audio goes to Sarvam while connected and unmuted. English spoken replies.</small>
        {showDetails&&voiceLatency!==null&&<p>Speech end → first audio at server: {voiceLatency} ms</p>}
      </section>
      <div hidden={!showDetails}>
      {answer?<article className="answer"><h3>Observed evidence</h3>{answer.observed_evidence.map((o,i)=><p key={i}><b className="ref">{o.evidence_id}</b> {o.observation}<small className="quote">“{o.quote}”</small></p>)}<h3>Likely explanation</h3>{answer.likely_explanations.length?answer.likely_explanations.map((h,i)=><p key={i}>{h.hypothesis} <small>{h.evidence_ids.join(', ')}</small></p>):<p>No supported explanation yet.</p>}<h3>Confidence / uncertainty · {answer.confidence}</h3><ul>{answer.uncertainty.map((u,i)=><li key={i}>{u}</li>)}</ul><h3>Suggested checks</h3><ul>{answer.suggested_checks.map((s,i)=><li key={i}>{s}</li>)}</ul>{answer.clarification&&<p className="notice">{answer.clarification}</p>}</article>:<div className="empty"><span className="cross">＋</span><h3>{busy&&session?'Collecting evidence…':'Start with a symptom.'}</h3><p>Ask about a service, a time window or an unusual signal.<br/>Answers will show observations, uncertainty and suggested checks.</p></div>}
      </div><details className="text-fallback"><summary>Prefer to type?</summary><form className="composer" onSubmit={send}><label htmlFor="question">Your question</label><textarea id="question" value={question} onChange={e=>setQuestion(e.target.value)} maxLength={1000} placeholder="Ask about this incident…" disabled={busy}/><div><small>Suggested checks require a human.</small>{busy&&abort.current?<button type="button" className="secondary" onClick={()=>{void cancel();}}>Cancel</button>:<button disabled={!session||!ready||busy||question.trim().length<3}>Ask <span>↗</span></button>}</div></form></details>
    </section><aside hidden={!showDetails}><section className="timeline"><div className="section-head"><h2>Investigation timeline</h2><span>{events.length} events</span></div>{events.length?<ol>{events.map(e=><li key={e.sequence}><span className={e.type.endsWith('failed')?'dot failed':'dot'}></span><div><strong>{e.type.replaceAll('_',' ')}</strong><small>{String(e.data.name??e.data.provider??'')}{typeof e.data.duration_ms==='number'?` · ${e.data.duration_ms} ms`:` · +${e.elapsed_ms} ms`}</small></div></li>)}</ol>:<p className="muted">Actual tool and retrieval events will appear here when a turn starts.</p>}</section>
    <section className="sources"><h2>Documentation sources</h2>{sources.length?sources.map(source=><a key={source.id} href={source.citation.url} target="_blank" rel="noreferrer"><b>{source.id} · {source.citation.title}</b><span>{source.citation.heading}</span><small>{source.citation.attribution} · CC BY 4.0 ↗</small></a>):<p className="muted">Citations appear when the answer references retrieved runbooks.</p>}</section></aside></div>
    <section className="evidence" hidden={!showDetails}><div className="section-head"><h2>Evidence record</h2><span>{evidence.length} completed calls</span></div>{evidence.length?evidence.map(e=><details key={e.sequence}><summary>{String(e.data.id)} · {String(e.data.tool)}</summary><pre>{JSON.stringify(e.data,null,2)}</pre></details>):<p className="muted">No diagnostic evidence has been collected for this session.</p>}</section></>}
    {error&&<p role="alert" className="error">{error.replaceAll('_',' ')}</p>}
    </main><footer>Recorded replay · Evidence is not causal proof · Speech uses validated answers</footer></div>;
}
const root=createRoot(document.getElementById('root')!);
void fetch(base+'/app-config').then(r=>{if(!r.ok)throw new Error('APP_UNAVAILABLE');return r.json();}).then(config=>root.render(config.mode==='documents'?<HindiApp/>:<App/>)).catch(()=>root.render(<p role="alert">Application unavailable. Refresh after the local service starts.</p>));

import { readFile,writeFile } from 'node:fs/promises';
import { DocumentModel } from '../apps/api/src/document-model.js';
import { loadConfig } from '../apps/api/src/config/env.js';
import { chunkMarkdown } from '../packages/rag/src/chunk.js';
import { demoDocumentId } from '../packages/rag/src/demo-insurance.js';

// Explicit, six-call hosted comparison using fictional sample material.
// Supplied passages isolate model time; this is not an end-to-end RAG/voice benchmark.
if(process.env.MODEL_REQUESTS_ENABLED!=='true'||!process.env.GROQ_API_KEY)throw new Error('MODEL_NOT_ENABLED');
const base=loadConfig({...process.env,DATABASE_URL:'postgres://localhost/unused',REDIS_URL:'redis://localhost'});
const chunks=chunkMarkdown(await readFile('apps/web/public/sample-insurance-faq.md','utf8'),demoDocumentId,'Fictional sample FAQ',[
  'waiting-period','deductible','co-payment','deductible-versus-co-payment','worked-cost-sharing-example','premium',
]);
const cases=[
  {name:'waiting-period',question:'Sample policy mein waiting period kitna hai?',anchors:['waiting-period']},
  {name:'cost-sharing',question:'Deductible aur co-payment mein kya farak hai? Example ke saath detail mein samjhao.',anchors:['deductible','co-payment','deductible-versus-co-payment','worked-cost-sharing-example']},
  {name:'unknown-premium',question:'Is policy ka exact monthly premium kitne rupees hai?',anchors:['premium']},
];
const results=[];
for(const entry of cases){
  const sources=chunks.filter(c=>entry.anchors.includes(c.anchor)).map((c,i)=>({id:`D${i+1}`,text:c.content.slice(0,1200),citation:{heading:c.heading}}));
  if(!sources.length)throw new Error('COMPARISON_SOURCE_MISSING');
  for(const name of ['openai/gpt-oss-120b','openai/gpt-oss-20b']){
    const started=performance.now();
    try{
      const reply=await new DocumentModel({...base,GROQ_MODEL:name}).answer(entry.question,[],sources,AbortSignal.timeout(30000));
      const elapsed_ms=Math.round(performance.now()-started);
      const style_ok=!/[\u0900-\u097f]/u.test(reply.reply)&&!/dekh.*bata|checking|searching|reading documents/iu.test(reply.reply);
      const expectation_ok=entry.name==='unknown-premium'?!reply.covered:reply.covered;
      results.push({model:name,case:entry.name,elapsed_ms,validated:true,style_ok,expectation_ok,reply});
      console.log(JSON.stringify({model:name,case:entry.name,elapsed_ms,validated:true,style_ok,expectation_ok}));
    }catch(error){
      const known=['MODEL_RATE_LIMITED','DOCUMENT_MODEL_FAILED','INVALID_DOCUMENT_CITATION','UNSUPPORTED_DOCUMENT_NUMBER','UNGROUNDED_DOCUMENT_REPLY','MODEL_RESPONSE_LIMIT'];
      const code=error instanceof Error&&known.includes(error.message)?error.message:'COMPARISON_VALIDATION_FAILED';
      results.push({model:name,case:entry.name,elapsed_ms:Math.round(performance.now()-started),validated:false,error:code});
      console.log(JSON.stringify({model:name,case:entry.name,validated:false,error:code}));
    }
  }
}
await writeFile('eval/reports/document-model-speed-comparison.json',JSON.stringify({measured_at:new Date().toISOString(),synthetic:true,scope:'Six model-only requests over selected fictional FAQ passages; no retrieval, STT, TTS or microphone timing. One sample per model/question. Structural validation is not semantic accuracy proof.',free_plan_only:true,automatic_retries:0,results},null,2)+'\n');

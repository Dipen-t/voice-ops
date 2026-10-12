import { beforeAll,afterAll,expect,it } from 'vitest';
import { createPool } from '../../db/src/pool.js';
import { LocalEmbeddings,modelIdentity } from '../src/embedding.js';
import { retrieve } from '../src/search.js';
import { loadDocument } from '../src/corpus.js';
import { ingestDocument } from '../src/ingest.js';

if(!process.env.DATABASE_URL||!process.env.INGEST_DATABASE_URL)throw new Error('Separate runtime/knowledge writer credentials required');
const pool=createPool(process.env.DATABASE_URL,3000),writer=createPool(process.env.INGEST_DATABASE_URL,10000);
let embeddings:LocalEmbeddings;
beforeAll(async()=>{embeddings=new LocalEmbeddings(await modelIdentity());});
afterAll(async()=>{await embeddings?.close();await pool.end();await writer.end();});
it('actual local model returns finite normalized 384-dimensional embeddings',async()=>{
  const vectors=await embeddings.embed(['A Kubernetes Pod remains Pending.','An OpenTelemetry span records an operation.']);
  expect(vectors).toHaveLength(2);expect(vectors.every(v=>v.length===384&&v.every(Number.isFinite))).toBe(true);
  expect(vectors[0]).not.toEqual(vectors[1]);
});
it('real indexing is idempotent and all stored chunks match approved source sections',async()=>{
  const before=await pool.query('SELECT id,content_sha256 FROM knowledge_chunks ORDER BY id');
  expect(before.rows.length).toBeGreaterThan(0);
  for(let index=0;index<4;index++) {
    const document=await loadDocument(index);
    const result=await ingestDocument(index,writer,embeddings,AbortSignal.timeout(10000));expect(result.changed).toBe(false);
    const found=await pool.query('SELECT id,content,heading,anchor,source_start_line,source_end_line FROM knowledge_chunks WHERE document_id=$1 ORDER BY ordinal',[document.id]);
    expect(found.rows).toEqual(document.chunks.map(({id,content,heading,anchor,source_start_line,source_end_line})=>({id,content,heading,anchor,source_start_line,source_end_line})));
  }
  expect((await pool.query('SELECT id,content_sha256 FROM knowledge_chunks ORDER BY id')).rows).toEqual(before.rows);
});
it('vector and hybrid search retrieve relevant actual sections with valid citations and bounded context',async()=>{
  for(const mode of ['vector','hybrid']) {
    const result=await retrieve(pool,embeddings,{query:'When should I use a span event instead of a span attribute?',mode,limit:5});
    expect(result.status).toBe('retrieval_candidates');expect(result.context_bytes).toBeLessThanOrEqual(12000);
    const hits=result.hits as {text:string;citation:{chunk_id:string;url:string}}[];
    expect(hits.some(h=>h.citation.url.endsWith('#when-to-use-span-events-versus-span-attributes'))).toBe(true);
    for(const hit of hits)expect((await pool.query('SELECT content FROM knowledge_chunks WHERE id=$1',[hit.citation.chunk_id])).rows[0]?.content).toBe(hit.text);
  }
});
it('unsupported queries abstain; model version mismatch and cancellation fail closed',async()=>{
  const result=await retrieve(pool,embeddings,{query:'How do I bake a chocolate cake?'});expect(result.status).toBe('insufficient_knowledge_coverage');
  const wrong=new LocalEmbeddings('wrong-model');
  try {await expect(retrieve(pool,wrong,{query:'Kubernetes CPU resource usage'})).rejects.toThrow('KNOWLEDGE_MODEL_MISMATCH_OR_EMPTY');}finally{await wrong.close();}
  await expect(retrieve(pool,embeddings,{query:'Pod scheduling'},AbortSignal.abort())).rejects.toThrow();
});
it('runtime cannot write knowledge or see ingestion bookkeeping; knowledge writer cannot read incident/evaluator data',async()=>{
  await expect(pool.query('SELECT * FROM knowledge_ingestion_jobs LIMIT 1')).rejects.toThrow();
  const runtime=await pool.connect();
  try {await runtime.query('SET default_transaction_read_only=off');await expect(runtime.query('DELETE FROM knowledge_chunks WHERE false')).rejects.toThrow();}finally{runtime.release(true);}
  await expect(writer.query('SELECT * FROM incidents LIMIT 1')).rejects.toThrow();
  const evalUrl=new URL(process.env.INGEST_DATABASE_URL!);evalUrl.pathname='/voiceops_evaluation';
  const blocked=createPool(evalUrl.toString(),1000);try{await expect(blocked.query('SELECT 1')).rejects.toThrow();}finally{await blocked.end();}
});

import { Worker } from 'bullmq';
import { createPool } from '../../../packages/db/src/pool.js';
import { LocalEmbeddings,modelIdentity } from '../../../packages/rag/src/embedding.js';
import { ingestDocument } from '../../../packages/rag/src/ingest.js';
import { ingestInsuranceDemo } from '../../../packages/rag/src/demo-insurance.js';

async function main() {
const database = process.env.INGEST_DATABASE_URL;
const redis = process.env.REDIS_URL;
if(!database || !redis || new URL(database).username !== 'voiceops_ingest')throw new Error('Restricted ingestion environment required');
const redisUrl=new URL(redis);
const connection={host:redisUrl.hostname,port:Number(redisUrl.port||6379),maxRetriesPerRequest:null,connectTimeout:3000,retryStrategy:(attempt:number)=>attempt<=3?Math.min(200*attempt,1000):null};
const pool=createPool(database,10000);pool.on('error',()=>{});
const embeddings=new LocalEmbeddings(await modelIdentity());
const abort=new AbortController();
const worker=new Worker(process.argv.includes('--documents')?'voiceops-document-ingestion':'voiceops-runbook-ingestion',async job=>{
  if(job.name==='sample-insurance-faq'&&Object.keys(job.data).length===0)return ingestInsuranceDemo(pool,embeddings,AbortSignal.any([abort.signal,AbortSignal.timeout(180000)]));
  if(job.name!=='official-runbook' || !Number.isInteger(job.data.index) || Object.keys(job.data).length!==1)throw new Error('JOB_NOT_ALLOWED');
  try { return await ingestDocument(job.data.index,pool,embeddings,AbortSignal.any([abort.signal,AbortSignal.timeout(180000)])); }
  catch { throw new Error('INGESTION_FAILED'); }
},{connection,concurrency:1,maxStalledCount:1});
worker.on('error',()=>{console.error('Ingestion queue connection error');process.exitCode=1;void close();});
worker.on('completed',(_job,result)=>console.log(JSON.stringify(result)));
worker.on('failed',()=>console.error('Runbook ingestion attempt failed'));
let closing=false;
async function close(){if(closing)return;closing=true;abort.abort();await embeddings.close();await worker.close();await pool.end();}
process.on('SIGINT',()=>{void close();});process.on('SIGTERM',()=>{void close();});
console.log('Runbook ingestion worker ready');
}
main().catch(()=>{console.error('Runbook worker startup failed; verify restricted ingestion configuration and local model');process.exitCode=1;});

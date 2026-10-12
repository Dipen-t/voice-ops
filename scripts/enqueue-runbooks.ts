import { Queue,QueueEvents } from 'bullmq';
async function main() {
const url=new URL(process.env.REDIS_URL??'redis://127.0.0.1:16379');
const connection={host:url.hostname,port:Number(url.port||6379),connectTimeout:3000,maxRetriesPerRequest:1,retryStrategy:(attempt:number)=>attempt<=3?Math.min(200*attempt,1000):null};
const queue=new Queue('voiceops-runbook-ingestion',{connection});
const events=new QueueEvents('voiceops-runbook-ingestion',{connection:{...connection,maxRetriesPerRequest:null}});
try {
  await events.waitUntilReady();await queue.setGlobalConcurrency(1);
  const jobs=[];
  for(let index=0;index<4;index++) jobs.push(await queue.add('official-runbook',{index},{attempts:3,backoff:{type:'exponential',delay:1000},removeOnComplete:20,removeOnFail:20}));
  console.log('Four official runbook jobs queued');
  for(const job of jobs)console.log(JSON.stringify(await job.waitUntilFinished(events,240000)));
} finally {await events.close();await queue.close();}
}
main().catch(()=>{console.error('Runbook queue operation failed; verify local Redis and the ingestion worker');process.exitCode=1;});

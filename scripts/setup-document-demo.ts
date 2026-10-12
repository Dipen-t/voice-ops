import { spawn } from 'node:child_process';
import { Queue,QueueEvents } from 'bullmq';
const url=new URL(process.env.REDIS_URL??'redis://127.0.0.1:16379');
const connection={host:url.hostname,port:Number(url.port||6379),maxRetriesPerRequest:null};
const worker=spawn(process.execPath,['dist/apps/worker/src/main.js','--documents'],{env:process.env,stdio:'ignore',windowsHide:true});
const queue=new Queue('voiceops-document-ingestion',{connection});const events=new QueueEvents('voiceops-document-ingestion',{connection});
try{await events.waitUntilReady();const job=await queue.add('sample-insurance-faq',{},{attempts:1,removeOnComplete:10,removeOnFail:10});console.log(JSON.stringify(await job.waitUntilFinished(events,180000)));}
finally{worker.kill();await events.close();await queue.close();}

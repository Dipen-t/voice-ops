import { createPool } from '../packages/db/src/pool.js';
import { LocalEmbeddings,modelIdentity } from '../packages/rag/src/embedding.js';
import { retrieve } from '../packages/rag/src/search.js';

async function main() {
  const query=process.argv.slice(2).join(' ');
  if(!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).username!=='voiceops_runtime')throw new Error();
  const pool=createPool(process.env.DATABASE_URL,3000);pool.on('error',()=>{});
  const embeddings=new LocalEmbeddings(await modelIdentity());
  try {console.log(JSON.stringify(await retrieve(pool,embeddings,{query,mode:process.env.RAG_MODE??'hybrid'},AbortSignal.timeout(60000)),null,2));}
  finally {await embeddings.close();await pool.end();}
}
main().catch(()=>{console.error('Runbook search failed; verify runtime configuration, local model and indexed corpus');process.exitCode=1;});

import type { Config } from './config/env.js';
import { createPool } from '../../../packages/db/src/pool.js';
import { connectTelemetry } from '../../mcp-server/src/client.js';
import { LocalEmbeddings,modelIdentity } from '../../../packages/rag/src/embedding.js';
import { retrieve } from '../../../packages/rag/src/search.js';
import { GroqProvider } from '../../../packages/investigator/src/model.js';
import type { InvestigatorDependencies } from '../../../packages/investigator/src/run.js';
import type { Pool } from 'pg';

export type InvestigatorRuntime=Omit<InvestigatorDependencies,'model'> & {pool:Pool;model:InvestigatorDependencies['model']|undefined;close:()=>Promise<void>};
export async function createInvestigatorRuntime(config:Config):Promise<InvestigatorRuntime> {
  if(new URL(config.DATABASE_URL).username!=='voiceops_runtime')throw new Error('Investigator requires restricted runtime credentials');
  const embeddings=new LocalEmbeddings(await modelIdentity());
  const pool=createPool(config.DATABASE_URL,3000);pool.on('error',()=>{});
  return {pool,connect:(id,signal)=>connectTelemetry(id,'host',signal),retrieve:(query,signal)=>retrieve(pool,embeddings,{query,limit:3},signal),
    model:config.MODEL_REQUESTS_ENABLED&&config.GROQ_API_KEY?new GroqProvider(config.GROQ_API_KEY,config.GROQ_MODEL):undefined,
    secrets:[config.GROQ_API_KEY,config.SARVAM_API_KEY,config.API_BEARER_TOKEN??'',config.DATABASE_URL,decodeURIComponent(new URL(config.DATABASE_URL).password)],
    close:async()=>{await embeddings.close();await pool.end();}};
}

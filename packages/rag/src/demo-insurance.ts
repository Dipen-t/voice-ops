import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { EmbeddingProvider } from './embedding.js';
import { chunkMarkdown,hash } from './chunk.js';
export const demoDocumentId='dce3a82e-635b-4f19-89b3-a68b5db3e2a7';
export async function ingestInsuranceDemo(pool:Pool,embeddings:EmbeddingProvider,signal:AbortSignal){
  const markdown=await readFile('apps/web/public/sample-insurance-faq.md','utf8');
  const headings=['premium','waiting-period','claim-documents','cashless-and-reimbursement','policy-cancellation','exclusions-and-coverage','sum-insured','deductible','co-payment','deductible-versus-co-payment','individual-and-family-floater','claim-process','cashless-request-not-approved','renewal-and-lapse','pre-existing-conditions','policy-schedule','nominee','room-rent-and-sub-limits','claim-status-and-review','choosing-what-to-ask'];
  headings.push('worked-cost-sharing-example');
  const chunks=chunkMarkdown(markdown,demoDocumentId,'Fictional sample insurance FAQ',headings);
  const vectors:number[][]=[];
  for(let i=0;i<chunks.length;i+=8){
    signal.throwIfAborted();
    vectors.push(...await embeddings.embed(chunks.slice(i,i+8).map(c=>`${c.heading}. ${c.content}`),signal));
  }
  signal.throwIfAborted();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`INSERT INTO knowledge_documents(id,title,source_url,revision,source_sha256,license,attribution,modifications,model_key,splitter_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET revision=$4,source_sha256=$5,modifications=$8,model_key=$9,splitter_version=$10,indexed_at=now()`,[demoDocumentId,'Sample Insurance FAQ · Fictional demo','/sample-insurance-faq.md','demo-v2',hash(markdown),'CC0-1.0','Authored for local software testing; no real insurer or policy.','Expanded fictional demo sections chunked; English embeddings. Hindi/Hinglish questions translated for search.',embeddings.key,'sections-v1-100words-overlap20']);
    await client.query('DELETE FROM knowledge_chunks WHERE document_id=$1',[demoDocumentId]);
    for(const [i,c]of chunks.entries())await client.query(`INSERT INTO knowledge_chunks(id,document_id,ordinal,heading,anchor,content,content_sha256,source_start_line,source_end_line,model_key,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)`,[c.id,demoDocumentId,c.ordinal,c.heading,c.anchor,c.content,c.content_sha256,c.source_start_line,c.source_end_line,embeddings.key,JSON.stringify(vectors[i])]);
    await client.query('COMMIT');return {document_id:demoDocumentId,chunks:chunks.length,fictional:true};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

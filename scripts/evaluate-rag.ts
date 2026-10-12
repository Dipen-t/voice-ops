import { readFile,writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { createPool } from '../packages/db/src/pool.js';
import { LocalEmbeddings,modelIdentity } from '../packages/rag/src/embedding.js';
import { retrieve } from '../packages/rag/src/search.js';
import { loadDocument } from '../packages/rag/src/corpus.js';

const questionsSchema=z.array(z.object({id:z.string(),query:z.string(),source:z.number().int().min(0).max(3).optional(),anchors:z.array(z.string()).optional(),unsupported:z.boolean().optional()})).min(20).max(30);
async function main() {
  if(!process.env.DATABASE_URL)throw new Error('Runtime database required');
  const pool=createPool(process.env.DATABASE_URL,3000);pool.on('error',()=>{});
  const embeddings=new LocalEmbeddings(await modelIdentity());
  try {
    const questions=questionsSchema.parse(JSON.parse(await readFile('eval/rag-questions.json','utf8')));
    const documents=[];for(let i=0;i<4;i++)documents.push(await loadDocument(i));
    const reports=[];
    // Record the vector-only baseline first, then assess fusion using the same development questions.
    for(const mode of ['vector','hybrid'] as const) {
      const cases=[];let recalled=0,positives=0,abstained=0,negatives=0,correct=0,citations=0;
      for(const question of questions) {
        const start=performance.now();
        const result=await retrieve(pool,embeddings,{query:question.query,mode,limit:5},AbortSignal.timeout(60000));
        const hits=result.hits as {text:string;citation:{chunk_id:string;document_id:string;url:string;heading:string;revision:string}}[];
        let found=false;
        for(const hit of hits) {
          const document=documents.find(d=>d.id===hit.citation.document_id);
          const chunk=document?.chunks.find(c=>c.id===hit.citation.chunk_id);
          const valid=!!document&&!!chunk&&chunk.content===hit.text&&chunk.heading===hit.citation.heading&&document.source.repositoryRevision===hit.citation.revision&&hit.citation.url===document.source.url+(chunk.anchor?`#${chunk.anchor}`:'');
          citations++;if(valid)correct++;
          if(question.source!==undefined && document?.id===documents[question.source]!.id && question.anchors?.includes(chunk?.anchor??'missing'))found=true;
        }
        if(question.unsupported){negatives++;if(result.status==='insufficient_knowledge_coverage')abstained++;}
        else {positives++;if(found)recalled++;}
        cases.push({id:question.id,recalled:question.unsupported?null:found,status:result.status,returned_citations:hits.map(h=>h.citation.url),duration_ms:Math.round(performance.now()-start)});
      }
      reports.push({mode,recall_at_5:recalled/positives,positive_questions:positives,recalled,unsupported_questions:negatives,unsupported_abstentions:abstained,citation_correctness:citations?correct/citations:null,citations_checked:citations,cases});
    }
    const report={capturedAt:new Date().toISOString(),corpus_documents:documents.length,chunks:documents.reduce((sum,d)=>sum+d.chunks.length,0),model_key:embeddings.key,similarity_threshold:0.4,question_set:`${questions.length} hand-curated development questions; 20 supported and the remainder unsupported; not a held-out diagnosis benchmark`,citation_check:'Exact excerpt, heading, document ID, pinned revision and section URL against checksum-verified source chunks; live page anchors checked separately',reports};
    await writeFile('eval/reports/rag-retrieval.json',JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(reports.map(report=>({mode:report.mode,recall_at_5:report.recall_at_5,positive_questions:report.positive_questions,recalled:report.recalled,unsupported_questions:report.unsupported_questions,unsupported_abstentions:report.unsupported_abstentions,citation_correctness:report.citation_correctness,citations_checked:report.citations_checked})),null,2));
  } finally {await embeddings.close();await pool.end();}
}
main().catch(()=>{console.error('RAG evaluation failed; verify indexed corpus and local model');process.exitCode=1;});

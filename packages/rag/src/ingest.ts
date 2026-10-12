import type { Pool } from 'pg';
import { loadDocument } from './corpus.js';
import { splitterVersion } from './chunk.js';
import type { EmbeddingProvider } from './embedding.js';

export async function ingestDocument(index:number,pool:Pool,embeddings:EmbeddingProvider,signal:AbortSignal) {
  const document = await loadDocument(index);
  const start = performance.now();
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))',[document.id]);
    const identity = await client.query('SELECT current_user');
    if(identity.rows[0].current_user !== 'voiceops_ingest')throw new Error('INGEST_ROLE_REQUIRED');
    await client.query(`INSERT INTO knowledge_ingestion_jobs(document_id,revision,status,attempts) VALUES($1,$2,'running',1)
      ON CONFLICT(document_id) DO UPDATE SET revision=$2,status='running',attempts=knowledge_ingestion_jobs.attempts+1,failure_code=NULL,updated_at=now()`,[document.id,document.source.repositoryRevision]);
    const existing = await client.query('SELECT source_sha256,model_key,splitter_version FROM knowledge_documents WHERE id=$1',[document.id]);
    const old = existing.rows[0];
    let changed = true;
    if(old?.source_sha256===document.source.sha256 && old.model_key===embeddings.key && old.splitter_version===splitterVersion)changed=false;
    if(changed) {
      const vectors:number[][]=[];
      for(let i=0;i<document.chunks.length;i+=8) {
        signal.throwIfAborted();
        vectors.push(...await embeddings.embed(document.chunks.slice(i,i+8).map(c=>`${document.source.title}. ${c.heading}. ${c.content}`),signal));
      }
      signal.throwIfAborted();
      await client.query('BEGIN'); transaction=true;
      await client.query(`INSERT INTO knowledge_documents(id,title,source_url,revision,source_sha256,license,attribution,modifications,model_key,splitter_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET title=$2,source_url=$3,revision=$4,source_sha256=$5,license=$6,attribution=$7,modifications=$8,model_key=$9,splitter_version=$10,indexed_at=now()`,
        [document.id,document.source.title,document.source.url,document.source.repositoryRevision,document.source.sha256,document.source.license,document.source.attribution,'Selected sections; code examples/front matter/diagrams omitted, Markdown formatting removed; 100-word chunks with 20-word overlap.',embeddings.key,splitterVersion]);
      await client.query('DELETE FROM knowledge_chunks WHERE document_id=$1',[document.id]);
      for(const [i,chunk] of document.chunks.entries()) {
        await client.query(`INSERT INTO knowledge_chunks(id,document_id,ordinal,heading,anchor,content,content_sha256,source_start_line,source_end_line,model_key,embedding)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)`,[chunk.id,document.id,chunk.ordinal,chunk.heading,chunk.anchor,chunk.content,chunk.content_sha256,chunk.source_start_line,chunk.source_end_line,embeddings.key,JSON.stringify(vectors[i])]);
      }
      await client.query('COMMIT'); transaction=false;
    }
    const duration=Math.round(performance.now()-start);
    await client.query("UPDATE knowledge_ingestion_jobs SET status='ready',chunk_count=$2,duration_ms=$3,updated_at=now() WHERE document_id=$1",[document.id,document.chunks.length,duration]);
    return {document_id:document.id,chunks:document.chunks.length,changed,duration_ms:duration};
  } catch {
    if(transaction)await client.query('ROLLBACK');
    await client.query("UPDATE knowledge_ingestion_jobs SET status='failed',failure_code='INGESTION_FAILED',updated_at=now() WHERE document_id=$1",[document.id]).catch(()=>{});
    throw new Error('INGESTION_FAILED');
  } finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))',[document.id]).catch(()=>{});client.release(); }
}

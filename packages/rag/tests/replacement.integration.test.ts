import { expect,it } from 'vitest';
import { createPool } from '../../db/src/pool.js';
import { LocalEmbeddings,modelIdentity } from '../src/embedding.js';
import { ingestDocument } from '../src/ingest.js';
import { loadDocument } from '../src/corpus.js';
import { splitterVersion } from '../src/chunk.js';

if(!process.env.INGEST_DATABASE_URL)throw new Error('Knowledge writer environment required');
it('reindexing replaces stale chunks atomically using actual source text and embeddings',async()=>{
  const pool=createPool(process.env.INGEST_DATABASE_URL!,10000);
  const embeddings=new LocalEmbeddings(await modelIdentity());
  const document=await loadDocument(3);
  const staleId='synthetic-stale-chunk-test';
  try {
    // Synthetic version marker and stale ID; duplicate content/vector come from a real approved chunk.
    await pool.query('UPDATE knowledge_documents SET splitter_version=$2 WHERE id=$1',[document.id,'synthetic-old-splitter']);
    await pool.query(`INSERT INTO knowledge_chunks(id,document_id,ordinal,heading,anchor,content,content_sha256,source_start_line,source_end_line,model_key,embedding)
      SELECT $2,document_id,999,heading,anchor,content,content_sha256,source_start_line,source_end_line,model_key,embedding FROM knowledge_chunks WHERE document_id=$1 ORDER BY ordinal LIMIT 1`,[document.id,staleId]);
    const result=await ingestDocument(3,pool,embeddings,AbortSignal.timeout(30000));
    expect(result.changed).toBe(true);
    expect((await pool.query('SELECT id FROM knowledge_chunks WHERE document_id=$1 ORDER BY ordinal',[document.id])).rows.map(r=>r.id)).toEqual(document.chunks.map(c=>c.id));
    expect((await pool.query('SELECT splitter_version FROM knowledge_documents WHERE id=$1',[document.id])).rows[0].splitter_version).toBe(splitterVersion);
  } finally {
    await pool.query('DELETE FROM knowledge_chunks WHERE id=$1',[staleId]);
    await pool.query('UPDATE knowledge_documents SET splitter_version=$2 WHERE id=$1',[document.id,splitterVersion]);
    await embeddings.close();await pool.end();
  }
});

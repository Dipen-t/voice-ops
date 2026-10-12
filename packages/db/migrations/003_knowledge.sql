CREATE TABLE knowledge_documents (
  id text PRIMARY KEY, title text NOT NULL, source_url text NOT NULL,
  revision text NOT NULL, source_sha256 text NOT NULL, license text NOT NULL,
  attribution text NOT NULL, modifications text NOT NULL, model_key text NOT NULL,
  splitter_version text NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_chunks (
  id text PRIMARY KEY, document_id text NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL, heading text NOT NULL, anchor text NOT NULL,
  content text NOT NULL CHECK (octet_length(content)<=8192), content_sha256 text NOT NULL,
  source_start_line integer NOT NULL, source_end_line integer NOT NULL,
  model_key text NOT NULL, embedding vector(384) NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english',heading || ' ' || content)) STORED,
  UNIQUE(document_id,ordinal)
);
CREATE INDEX knowledge_chunks_lexical ON knowledge_chunks USING gin(search_vector);
-- Exact vector scans are appropriate for this small corpus; no approximate index required.
CREATE TABLE knowledge_ingestion_jobs (
  document_id text PRIMARY KEY, revision text NOT NULL, status text NOT NULL CHECK(status IN ('running','ready','failed')),
  attempts integer NOT NULL DEFAULT 0, chunk_count integer, failure_code text,
  duration_ms integer, updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON knowledge_documents,knowledge_chunks,knowledge_ingestion_jobs FROM PUBLIC;

# Phase 4: local runbook RAG

Four audited official documentation sources are indexed in PostgreSQL as **55 section-aware chunks**: nine Pod debugging chunks, 12 resource metrics chunks, 15 Service debugging chunks and 19 OpenTelemetry tracing chunks. Sources remain pinned to the audited revisions in `data/runbook-sources.json`; every ingestion checks source SHA-256 and size. Only fixed approved sources/sections are accepted, never incident answer labels or source case names.

## Setup and use

Existing local indexing is complete. To search now:

```powershell
npm run rag:search -- "How is Kubernetes memory working set measured?"
```

For a fresh installation, run the foundation setup and `npm run data:audit-sources` to create the verified Markdown snapshots. Then:

```powershell
npm run db:migrate
npm run db:setup
npm run rag:model
npm run build
```

In one terminal run `npm run rag:worker`. In another run `npm run rag:ingest`. The producer queues four jobs and waits for results. Leave the worker running for further jobs, or stop it with Ctrl+C when finished. Ingestion was completed and the worker stopped after verification on this workstation; start it again before queueing new jobs. Redis and PostgreSQL remain running.

`npm run rag:evaluate` writes the vector-only baseline first, followed by the hybrid comparison, to `eval/reports/rag-retrieval.json`. `npm run rag:verify-citations` verifies section fragments on live official pages and writes `eval/reports/rag-anchors.json`. Set `$env:RAG_MODE='vector'` to use the baseline in the search CLI; the default is hybrid. The reusable retrieval function is `packages/rag/src/search.ts`; it is separate from MCP telemetry tools. No retrieval HTTP route, model investigator, chat UI or voice integration exists yet.

## Embeddings and indexing

Ollama was not installed, so the provider interface defaults to local CPU inference through `@huggingface/transformers` 4.3.1. The model is `Xenova/all-MiniLM-L6-v2`, pinned to revision `751bff37182d3f1213fa05d7196b954e230abad9`, quantized q8, mean pooling, normalized 384-dimensional vectors. Five source files total **23,685,172 bytes**. Downloads check pinned repository metadata, SHA-256 for LFS weights and Git blob hashes for configuration/tokenizer files. Model files are ignored; the manifest is reviewable in `data/embedding-model.json`. Documents and queries use the same identity including model revision, precision, pooling, normalization, dimension, library and token limit. Empty/mixed/mismatched index models fail closed.

Model files are checked against the manifest before use. Inference disables remote model loading. An isolated worker thread limits inference to two CPU threads, batches of eight, 4096 input characters and 256 tokenizer tokens per text; oversized tokenized inputs fail instead of silently truncating. Output vectors must have 384 finite values and unit norm. Each inference call has a 60-second ceiling and cancellation terminates its worker thread. This includes cold model loading and is a guardrail, not a latency claim. Optional ONNX CUDA installation is unnecessary; set `ONNXRUNTIME_NODE_INSTALL=skip` for CPU-only Linux dependency installation. The bundled CPU binaries worked here without approving package install scripts.

The splitter follows Markdown sections, retains nested headings and explicit source anchors, and uses 100-word chunks with 20-word overlap. It records source line ranges, content checksums and deterministic chunk IDs. Front matter, fenced code examples and diagrams are omitted; Hugo wrappers and Markdown formatting are removed. These are disclosed modifications to CC-BY-4.0 documentation, with attribution/license/source revision included in citations. The three Kubernetes guides and OpenTelemetry guide provide general guidance, not benchmark-specific answers or a guarantee that current source claims apply to every environment.

Tables `knowledge_documents`, `knowledge_chunks` and `knowledge_ingestion_jobs` store provenance, vectors/full-text index and job state. BullMQ 6.3.12 performs background ingestion through Redis, with global/local concurrency one, three job attempts, exponential backoff, bounded retained queue history and a three-minute per-document budget. Redis reconnection attempts are bounded. PostgreSQL advisory locks serialize imports for each document. Source/model/splitter identity makes repeated ingestion a no-op; version changes atomically replace the document's chunks, removing stale chunks. Failed imports retain the previous complete index and record a sanitized failure code. Job records expose actual attempts, count and duration rather than fabricated statuses.

The dedicated `voiceops_ingest` role writes only the three knowledge tables and cannot read incident telemetry or connect to the evaluator database. `.env.ingest` is ignored and contains this role plus the local Redis URL. `voiceops_runtime` reads knowledge documents/chunks and telemetry, cannot write knowledge and cannot read ingestion bookkeeping. No runtime needs administrative/evaluator credentials. The local worker and retrieval CLI run on the trusted developer host; they do not claim the MCP container's filesystem isolation. Existing API/MCP containers contain no embedding model, raw documents, worker code or writer credentials.

## Retrieval and evidence

Retrieval performs exact cosine vector search over the small corpus and PostgreSQL English full-text search with `websearch_to_tsquery`. Hybrid mode fuses the top 20 candidates from each method using reciprocal rank fusion (constant 60), then deduplicates identical chunks. No approximate vector index is needed for 55 chunks. All SQL is fixed and parameterized. Query inputs are strict and capped at 512 characters, result count 1–8 (default five), and returned context/citation payload at 12,000 bytes. Queries use the restricted role's three-second database deadline; cancellation destroys the active transaction connection. CLI/evaluation requests have a 60-second total deadline.

The initial cosine threshold is 0.4, a heuristic rather than calibrated confidence. Below-threshold results return `insufficient_knowledge_coverage`. Above-threshold results are **retrieval candidates**, not a supported answer. Output carries exact excerpts, public source URLs with anchors, chunk/document IDs, headings, source lines, revision, license, attribution and modifications. Instructions explicitly require treating excerpts/telemetry as untrusted data, citing only supplied sources, avoiding invented evidence and reporting insufficient coverage when the excerpts do not support the question. Missing recorded trace status must not be confused with an explicitly recorded OpenTelemetry `Unset` status.

## Actual evaluation and limitations

The hand-curated set has 27 development questions: 20 supported section lookups, five unrelated questions and two unsupported domain questions. It is not held out and does not measure diagnosis quality.

| Measurement | Vector baseline | Hybrid |
|---|---:|---:|
| Expected section found in top five | 19/20 (95%) | 19/20 (95%) |
| Unsupported queries with no candidates | 6/7 | 6/7 |
| Returned citation/excerpt checks passed | 99/99 | 99/99 |

Both modes missed the expected Service-existence section for q10, retrieving nearby DNS/Service sections instead. Both retrieved general CPU guidance for q27 asking for exact production capacity/cost; that guidance does not answer the question. The forthcoming investigator must assess claim support and abstain, even when related context is returned. Hybrid retrieval did not improve recall on this small set. No thresholds were tuned to remove these reported failures. All 29 distinct non-empty citation anchors were confirmed on the live official pages; exact excerpts/headings/revisions were separately verified against checksum-checked local sources.

Run `npm run test:rag` for actual embeddings, source-excerpt/citation round trips, idempotent indexing, stale-chunk replacement, model mismatch, cancellation and writer/runtime/evaluator separation. Synthetic unit fixtures cover section splitting, overlap, IDs, input bounds and fusion. Existing MCP and foundation checks also passed after knowledge grants were added. No model answers, diagnosis accuracy or voice latency are claimed.

Local verification on 2026-10-10: lint, typecheck and build passed, along with 24 unit tests, eight foundation/isolation tests, four data checks, six MCP protocol tests and six RAG integration tests (48 distinct tests). MCP protocol tests also passed through the rebuilt isolated container. Repeat queue ingestion returned `changed:false` for all four documents. The documented retrieval smoke command succeeded. A review of 83 Git-eligible files found no actual secrets or selected benchmark source names; `.env.ingest`, model files and raw/private sources remain ignored. All changes remain uncommitted.

The next phase is a text investigator that combines real MCP telemetry and retrieved runbook candidates behind bounded model tool calls, with visible evidence and calibrated uncertainty. Model provider selection/credentials are still outstanding.

References: [Transformers.js-compatible model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9), [BullMQ workers](https://docs.bullmq.io/guide/workers).

# VoiceOps — Development Specification

**Status:** Implementation-ready specification (not a claim that features already exist)  
**Primary stack:** Node.js LTS, TypeScript, Fastify, React/Vite, PostgreSQL + pgvector, Redis, BullMQ, official Model Context Protocol (MCP) TypeScript SDK  
**Project type:** Voice-first, evidence-grounded AI incident investigation demo  
**Audience:** Engineer implementing the project (including Codex), reviewers, and hiring evaluators  
**Version:** 1.0 — 2026-10-10

---

## 0. One-paragraph product definition

VoiceOps is a voice-first application in which a developer selects a **recorded microservice incident**, describes symptoms aloud, and asks an AI assistant to investigate. The assistant uses **MCP diagnostic tools** to inspect incident telemetry (logs, metrics, traces), **RAG** to retrieve relevant technical runbooks, and an **LLM** to combine evidence into a cautious diagnosis. The interface speaks the answer aloud, shows the exact tool calls and retrieved citations, supports interruptions, and measures latency. **The MVP operates on replayed benchmark data, NOT a live production cluster.**

### Product promises

1. An investigator can converse using **voice**, with text input as a debugging/accessibility fallback.
2. The assistant may inspect an incident **only through controlled tools**, not through direct access to benchmark answer keys.
3. The assistant can cite **relevant sources** and identify **specific observed telemetry** supporting its conclusions.
4. The system distinguishes **observations**, **hypotheses**, **recommended next steps**, and **unknowns**.
5. A reviewer can observe actual performance measurements, not invented or hardcoded latencies.
6. The stack and source code are understandable enough to be defended line-by-line in a technical interview.

### Out of scope for MVP

- Real customer production infrastructure or unattended operations.
- Kubernetes administration, multi-GPU inference or genuine large-cluster operations.
- Model training, LoRA fine-tuning, custom foundation-model development.
- Automatic restarts, database writes, production remediation, shell command execution, or arbitrary URL fetching by the model.
- Claims of guaranteed sub-300 ms end-to-end voice response.
- Telephony/PSTN integration, commercial billing, multi-tenant SaaS administration.
- LangChain or LangGraph.

---

## 1. Core engineering rules (mandatory for Codex)

These rules have priority over convenience:

- **TypeScript/Node.js for all application code**, including dataset import, RAG pipeline, MCP services and AI orchestration. Python is not a runtime dependency or planned importer. If the chosen Parquet library is inadequate, document the blocker and request approval before adding another language.
- **Use existing voice-agent code** only after inspecting its interface and tests. Do not replace functioning components or claim they have been inspected if the code is unavailable.
- Use **official MCP TypeScript SDK**, direct model-provider SDK or an OpenAI-compatible client, and **custom RAG implementation**. MCP is a protocol for tools/resources; it is not a substitute for embedding, search and retrieval.
- Keep the **MCP telemetry server read-only** and its tool results tightly scoped to one selected incident.
- Never give the model RCAEval ground-truth fields, case names that encode the answer, hidden answer files, or a database query that can derive the answer directly.
- **No invented telemetry or performance claims.** Test fixtures may be synthetic but must be marked as such; actual incident demos must derive from downloaded benchmark data.
- Separate the **incident dataset** (telemetry for tools) from the **RAG corpus** (runbooks for retrieval). Do not vectorize the hidden diagnosis label or pre-load it into prompts.
- All expensive or long-running tasks (documents, embeddings and re-indexing) must be background jobs; voice request handling must remain responsive.
- Apply timeouts, cancellation, data-size budgets and per-session tool-call limits everywhere.
- Secrets must never appear in Git, logs, browser bundles or example responses.
- Prefer small vertical slices and tests before abstractions. No "production-ready" claim without demonstrated behavior.
- Before introducing a new package, database table, queue, API route or architectural layer, state **why** existing components do not suffice.
- Do not refactor unrelated files or change project scope without approval.
- Document actual commands executed, test results, known failures and measurement conditions.

---

## 2. Data: verified primary source and critical pitfalls

### RCAEval benchmark

- Dataset: https://huggingface.co/datasets/phamquiluan/RCAEval
- Repository/docs: https://github.com/phamquiluan/RCAEval
- License displayed by dataset: MIT. Preserve source attribution and confirm licensing for other knowledge sources independently.
- **735** recorded incident cases across RE1, RE2, RE3 and three microservice systems.
- MVP dataset: **RE2-OB (Online Boutique)**, which provides metrics, logs and traces. Start with **three carefully selected cases**; do **not** download the entire ~3.4 GB collection.
- Dataset root contains `cases.parquet` index. The verified index includes fields such as `case`, `dataset`, `suite`, `system`, `root_cause_service`, `fault`, `inject_time`, `has_logs`, `has_traces`, `n_logs`, `n_traces`.
- Per-case directories contain `metrics.parquet`, usually `logs.parquet`, `traces.parquet` where available, and `inject_time.txt`.
- Metrics are in a **wide time-series table** with `time` plus `{service}_{metric}` columns; logs contain fields including `timestamp`, `container_name`, `message`; traces contain fields including `time`, `traceID`, `spanID`, `serviceName`, `duration`, `statusCode`, `parentSpanID` (inspect actual schemas before import).
- Null metric samples are **missing observations**, not necessarily zeros. Do not fill missing values with zeros by default.

**Very important leakage warning:** The original per-case directory name (for example `re2tt_ts-order-service_cpu_1`) encodes the root-cause service and fault. Never show that string to the agent or include it in MCP tool outputs. `root_cause_service`, `fault`, `fault_description`, `root_cause.txt` and answer key data are evaluation-only.

#### Public-facing incident identity

- Assign an **opaque random public incident ID** (e.g. UUID) not derived from the directory name.
- Give the agent only selected non-answer-bearing case metadata such as observed time window, generic service inventory and the incident's recorded telemetry.
- `inject_time` can be useful for offline analysis; don't automatically expose the exact injected fault timestamp as a diagnostic hint unless an evaluation protocol explicitly allows it. Prefer generic incident onset window supplied by UI.
- Keep real source path ↔ public incident ID mappings inside the importer/private evaluator only.
- Separate evaluator credentials, environment and/or storage tables from agent runtime; no shared unrestricted SQL role.
- Logs/traces may themselves reveal an incident naturally—that is legitimate investigation evidence. The prohibition concerns **answer-key and filename leakage**.

#### Download/import workflow

1. Download only `cases.parquet` first from the Hugging Face dataset repository.
2. Inspect its **actual** columns and filter to `dataset == "RE2-OB"`, `has_logs == true`, `has_traces == true`, selecting three reasonable case sizes and **different fault categories**.
3. Log anticipated file sizes before downloads; get explicit confirmation for unexpectedly large cases.
4. Download exact paths using a Node-capable HTTP/Hugging Face workflow, respecting repository file listings and redirects; no imagined URLs.
5. Verify Parquet decoding in Node (consider `hyparquet` or another maintained JS reader after a small spike). Preserve 64-bit IDs as strings/BigInt as appropriate and preserve timestamp units.
6. Import data with streaming/batches rather than loading giant traces fully into RAM.
7. Perform post-import row count, null-handling and time-range validation against source.
8. Write a **private evaluation manifest** keyed by opaque incident ID; never ship it to the web client or agent service.
9. Make imports idempotent and resumable. Record checksum, import status and source provenance.
10. Do not commit bulk telemetry to Git. Provide a repeatable import script and `data/README.md`.

### RAG knowledge source

Use **real technical troubleshooting documentation and runbooks** that relate to selected incidents. Start with material on Kubernetes debugging, microservice performance, network faults, CPU/memory pressure and tracing:

- Kubernetes debugging: https://kubernetes.io/docs/tasks/debug/
- Kubernetes resource metrics: https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/
- OpenTelemetry documentation: https://opentelemetry.io/docs/
- Redis troubleshooting only for incidents actually involving Redis: https://redis.io/docs/latest/
- PostgreSQL documentation only where relevant: https://www.postgresql.org/docs/current/

**Copyright/quality:** Link to source documents; check licensing before scraping and redistributing. Maintain a manifest of exact source URLs, capture times, approved import scope, attribution and checksums. Use only small, relevant, legally reusable excerpts or permissioned material. Not every selected RCAEval case has a directly matching runbook: document gaps honestly.

**RAG corpus must NOT include:** evaluation answers, case-name strings encoding faults, the hidden RCAEval `cases.parquet` labels, generated 'correct diagnosis' templates, or incident summaries that reveal the answer in advance.

---

## 3. Architecture and request flows

```text
                               ┌──────────────────────────┐
                               │ React Web / Voice Client │
                               │ mic, captions, timeline  │
                               └─────────────┬────────────┘
                                             │ WebSocket / HTTP
                               ┌─────────────▼────────────┐
                               │  Fastify API Gateway     │
                               │  auth, sessions, VAD,    │
                               │  cancellation, metrics   │
                               └─────────────┬────────────┘
                                             │
                               ┌─────────────▼────────────┐
                               │ TypeScript Orchestrator  │
                               │  LLM streaming + state  │
                               └───┬─────────┬────────┬───┘
                                   │         │        │
                         RAG search│         │ MCP    │ STT/TTS providers
                                   ▼         ▼        ▼
                            pgvector    MCP Server   Audio Services
                               ▲         (read-only)  (streaming)
                               │             │
                         RAG ingestion   Telemetry Store
                               ▲             ▲
                      Approved runbooks     RCAEval import
                               │             │
                          BullMQ/Redis   Private evaluator
                                         (hidden labels only)
```

### Knowledge ingestion (asynchronous)

Approved URL/local source → fetch/parse → clean → section-aware chunk → tokenize/check limits → embed → persist with version/checksum/source metadata in pgvector. Report ingestion progress in UI. Re-ingest updated documents and remove or supersede stale chunks. Fail clearly for unsupported formats.

### Incident investigation (text, first)

User selects opaque incident ID and asks question → server checks session/incident authorization → orchestration starts → LLM requests scoped MCP metrics/logs/traces → orchestrator invokes RAG retrieval for troubleshooting knowledge → summarize bounded evidence without losing provenance → streamed response includes observations, likely causes, uncertainty, suggested next checks, citations → UI timeline records timings/tool outcomes. The LLM does not obtain raw unrestricted DB access.

### Voice (after text flow works)

Browser microphone → streamed audio → VAD/endpointing + streaming STT → stable transcript → investigator → streaming LLM output → chunked TTS → playback. Barge-in means **when the user begins speaking while assistant audio plays**, stop playback, abort in-flight TTS/LLM/tool calls if safe, and continue a new user turn. Endpointing means **detecting when the user has stopped speaking**; these are separate mechanisms.

### Latency definitions

- Primary voice KPI: **end-of-user-speech to first audible response** (not full answer).
- Also capture microphone-to-transcript partial/final, VAD endpoint delay, MCP query duration, embedding/search duration, LLM time-to-first-token, TTS time-to-first-audio, full-turn duration, cancellations and errors.
- Store p50, p95, sample size, configuration, provider/model, warm/cold state and hardware/network conditions.
- The requested **<300 ms** is an aggressive *target to investigate*, not an acceptance promise. Never fabricate measurements or conflate text first token with audible audio.

---

## 4. Required monorepo structure

```text
voiceops/
├── DEVELOPMENT.md                 # This specification (copy/rename if desired)
├── README.md                      # Setup, honest demo scope, attribution
├── AGENTS.md                      # Codex scope and change rules (derived from §1)
├── .gitignore
├── .env.example                   # Placeholders only
├── package.json                   # npm workspaces; pinned scripts
├── package-lock.json
├── tsconfig.base.json
├── docker-compose.yml             # pgvector + redis + local API if useful
├── .github/workflows/ci.yml       # lint/typecheck/unit/integration
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── app.ts               # Fastify build function
│   │   │   ├── server.ts            # Process entrypoint
│   │   │   ├── config/env.ts        # Zod config validation
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   ├── incidents.ts
│   │   │   │   ├── knowledge.ts
│   │   │   │   ├── sessions.ts
│   │   │   │   └── voice.ts
│   │   │   ├── orchestration/
│   │   │   │   ├── investigator.ts
│   │   │   │   ├── tool-policy.ts
│   │   │   │   ├── prompt.ts
│   │   │   │   └── stream.ts
│   │   │   ├── voice/
│   │   │   │   ├── gateway.ts
│   │   │   │   ├── session.ts
│   │   │   │   ├── vad.ts
│   │   │   │   ├── stt-adapter.ts
│   │   │   │   ├── tts-adapter.ts
│   │   │   │   └── cancellation.ts
│   │   │   ├── observability/
│   │   │   │   ├── metrics.ts
│   │   │   │   └── tracing.ts
│   │   │   └── auth/
│   │   └── tests/
│   ├── web/
│   │   ├── src/
│   │   │   ├── pages/IncidentWorkbench.tsx
│   │   │   ├── components/
│   │   │   │   ├── IncidentPicker.tsx
│   │   │   │   ├── VoiceControl.tsx
│   │   │   │   ├── InvestigationTimeline.tsx
│   │   │   │   ├── EvidencePanel.tsx
│   │   │   │   ├── SourcesPanel.tsx
│   │   │   │   └── LatencyPanel.tsx
│   │   │   ├── hooks/
│   │   │   └── lib/
│   │   └── tests/
│   ├── mcp-server/
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── tools/
│   │   │   │   ├── list-incidents.ts
│   │   │   │   ├── get-service-metrics.ts
│   │   │   │   ├── search-service-logs.ts
│   │   │   │   └── get-service-traces.ts
│   │   │   └── security/tool-scope.ts
│   │   └── tests/
│   └── worker/
│       └── src/
│           ├── ingest-document.ts
│           └── reindex.ts
├── packages/
│   ├── shared/
│   │   └── src/                   # Typed DTOs / Zod schemas
│   ├── db/
│   │   ├── migrations/
│   │   ├── src/pool.ts
│   │   └── src/repositories/
│   ├── telemetry/
│   │   └── src/                   # Import-neutral telemetry queries
│   ├── rag/
│   │   └── src/
│   │       ├── parser.ts
│   │       ├── chunker.ts
│   │       ├── embeddings.ts
│   │       ├── store.ts
│   │       ├── lexical-search.ts
│   │       ├── hybrid-search.ts
│   │       └── citation.ts
│   └── ai-providers/
│       └── src/                   # LLM/STT/TTS interfaces/adapters
├── scripts/
│   ├── inspect-rcaeval.ts
│   ├── select-cases.ts
│   ├── download-cases.ts
│   ├── import-incidents.ts
│   ├── import-runbooks.ts
│   ├── evaluate-rca.ts            # PRIVATE answer-key access
│   └── benchmark-latency.ts
├── data/
│   ├── README.md
│   ├── raw/                     # gitignored, downloaded data
│   └── private-evaluation/      # gitignored, never served
├── eval/
│   ├── questions.json            # No answers in agent prompt
│   └── reports/                 # sanitized report outputs
└── docs/
    ├── architecture.md
    ├── data-provenance.md
    ├── threat-model.md
    ├── evaluation.md
    ├── latency.md
    └── deployment.md
```

The file tree is the intended target, not a requirement to create empty placeholder files on day one. Add each module only when its phase begins.

---

## 5. Database design (minimum viable entities)

### Telemetry and incident tables

- `incidents`: `id` (opaque UUID), `display_title` (neutral, never revealing answer), `system`, `start_time`, `end_time`, `import_status`, `created_at`.
- `metric_samples`: `incident_id`, `ts`, `service`, `metric_name`, `value` nullable, `unit` optional. Index incident/service/ts/name. Preserve source field mapping and missingness.
- `log_entries`: `id`, `incident_id`, `ts`, `service`, `severity` nullable, `message`, `source_ref`. Index incident/service/ts; enforce capped queries.
- `trace_spans`: `incident_id`, `trace_id` (text), `span_id` (text), `parent_span_id` nullable, `service`, `start_time`, `duration`, `status_code` nullable, `attributes` JSONB with size limits. Index incident/time/service/trace.
- `import_jobs`: `id`, source checksum/path (private), row counts, status, error summary.
- `agent_sessions`: `id`, `incident_id`, session owner, state, timestamps; transcripts/evidence with configurable retention.
- `investigation_events`: session ID, event type, tool identifier, duration, sanitized arguments, source refs, outcome; no secret/audio payload logging by default.

### RAG tables

- `knowledge_documents`: `id`, `title`, `source_url`, `license_note`, `source_hash`, `version`, `status`, indexed timestamps.
- `knowledge_chunks`: `id`, `document_id`, `ordinal`, `heading_path`, `content`, `token_count`, `embedding vector(N)`, `tsvector` lexical index, `source_locator`, `content_hash`. `N` equals the chosen embedding model output dimension; fix it in configuration/migration. Add vector and lexical indexes as appropriate for corpus size.
- `knowledge_ingestion_jobs`: document ID, status, attempts, failure summary, time metrics.

### Private evaluator only

Store `public_incident_id → source_case_name`, `root_cause_service`, `fault` and any diagnosis labels in a **separate private evaluator database/schema or unserved encrypted mapping** with distinct DB credentials. No API or MCP connection can SELECT these fields. A local CLI evaluator is ideal for MVP.

---

## 6. APIs and MCP contracts

### Fastify APIs

- `GET /health/live` — process reachable.
- `GET /health/ready` — actual DB/Redis checks, bounded timeout.
- `GET /incidents` — only neutral public metadata.
- `GET /incidents/:publicId` — incident metadata, service list and timeline, no hidden labels.
- `POST /sessions` — create a scoped investigation session for an incident.
- `POST /sessions/:id/messages` — text input, streaming answer output (SSE or WebSocket).
- `GET /sessions/:id/events` — sanitized investigation timeline.
- `POST /knowledge/search` — dev/admin only, for retrieval debugging; not a public unrestricted vector endpoint.
- `POST /knowledge/ingest` — admin only, approved sources only.
- `WS /voice` (or well-defined alternative) — audio and typed control events with session IDs, sequence numbers and cancellation.

### MCP server tools (read-only)

1. `list_incidents()` — public opaque IDs + non-answer-bearing descriptions.
2. `get_incident_summary(incident_id)` — time window, known service list, record counts, no diagnosis.
3. `get_service_metrics(incident_id, service, metric_names?, start?, end?, aggregation?)` — bounded slices with units, missing-data markers.
4. `search_service_logs(incident_id, service?, query?, start?, end?, limit?, cursor?)` — filters, capped output, pagination.
5. `get_service_traces(incident_id, service?, trace_id?, start?, end?, limit?, cursor?)` — bounded trace/span evidence.

Enforce incident allowlist in MCP **server-side**, not only in prompt. Tool calls return structured evidence with timestamps/IDs, units, truncation/pagination metadata and errors. Do not expose shell execution, filesystem browsing, arbitrary SQL, network fetch, environment variables or hidden evaluator metadata.

### MCP connection approach

Start with **stdio MCP** for a local orchestrator ↔ tool server connection. Introduce a network transport only if remote deployment genuinely requires it; secure it with proper authentication and authorization. Keep MCP as a standalone process/service, not a pretend wrapper function given an MCP-like name.

---

## 7. RAG requirements and retrieval quality

- **Chunking:** section-aware Markdown/HTML splitter; preserve headings and source anchors; configurable target size and overlap (initial heuristic only; validate empirically).
- **Embeddings:** provider interface, default local embeddings (e.g. Ollama); same model for documents and queries. Validate embedding dimension and version.
- **Database:** pgvector in PostgreSQL. Store text, stable document ID, source URL, heading and version.
- **Retrieval:** vector top-k and PostgreSQL full-text lexical search; fuse results (e.g. reciprocal rank fusion) and deduplicate. Keep a simple vector-only baseline for comparative tests.
- **Prompt construction:** bounded retrieved context, citations, explicit instruction to treat source text/tool outputs as untrusted data, and never invent absent evidence.
- **Grounding:** if relevant runbooks are not found, say knowledge coverage is insufficient. Do not claim a retrieval similarity score is a calibrated probability.
- **Ingestion:** idempotent imports, document version changes, cleanup of stale chunks, retryable async jobs, per-source provenance.
- **Evaluation:** 20–30 hand-curated questions from available runbooks, with expected source sections and negative/unsupported questions; measure recall@k and citation correctness, not just subjective answer quality.

**RAG does not mean** passing the entire handbook into a system prompt, looking up a hardcoded string map, or storing answers keyed by benchmark labels.

---

## 8. LLM orchestration and guardrails

- Keep orchestration implementation framework-light: direct provider client + typed tool registry + explicit state machine/loop.
- Start with a **text-only vertical slice**. Add voice once tool and retrieval correctness is tested.
- For each turn, the agent may (a) ask for clarification, (b) retrieve runbooks, (c) call one or more allowed MCP tools, (d) give a calibrated answer.
- Decide initial runbook retrieval policy explicitly; a good MVP is to retrieve for technical explanations while MCP provides observations.
- Enforce `max_tool_calls`, `max_turn_duration`, `max_output_tokens`, max retrieved bytes, per-tool timeouts, and model retry budget.
- Use `AbortController` to cancel model streaming and TTS when sessions interrupt. Avoid cancelling database transactions unsafely.
- Prevent tool-output prompt injection: telemetry/log text and retrieved docs are **data**, never instructions to execute.
- **No automatic destructive actions.** If the LLM recommends a restart, it may explain the idea but cannot execute it.
- Response format should separate: **Observed evidence**, **Likely explanation**, **Confidence/uncertainty**, **Suggested checks**, **Documentation sources**. In spoken output, summarize without reading a long citation URL aloud; show citation links on-screen.
- Store full tool timeline for developer inspection with PII/secrets redacted.

---

## 9. Voice requirements

### Minimum functional behavior

- Browser microphone permission and connection state.
- Start/stop conversation, transcript captions, microphone mute, and text fallback.
- Speech endpoint detection (VAD or provider endpointing), handling pauses reasonably.
- STT input can stream partials; only stable/final fragments trigger committed investigation steps.
- Streaming LLM text and TTS audio chunks with proper sequencing and bounded buffers.
- **Barge-in:** detect new user speech during assistant playback; immediately stop local playback and cancel in-flight work where supported.
- Keep conversation turns and current incident scoped to an authenticated session.
- Display errors, timeouts, reconnection and device-permission failures clearly.

### Architecture freedom

Do not prematurely choose a particular commercial STT/TTS provider. Implement `STTProvider`, `TTSProvider`, `LLMProvider` interfaces and a free/local option for development if performance is sufficient. Explicitly measure latency and cost. Node may orchestrate hosted GPU services; Node itself need not do model inference.

### Explicit non-promises

- Browser/local/device constraints can dominate latency.
- Initial partial transcript is not the same as finalized recognized speech.
- Fast LLM tokens do not guarantee fast audible output.
- Do not advertise consistent sub-300 ms voice latency until end-to-end tests show it at a stated percentile and environment.

---

## 10. Web UI requirements

One highly usable **Incident Workbench** screen is enough for MVP:

1. Incident selector (opaque IDs; neutral symptoms; no answer-bearing names).
2. Central voice control with microphone status and live waveform/caption area.
3. Text chat fallback for debugging.
4. Investigation timeline showing **real** MCP calls and RAG retrieval events, outcomes and duration.
5. Evidence panel with service, metric, time, log excerpt and trace IDs.
6. Source panel linking to runbooks actually used in answer.
7. Latency panel showing measured phase timings; include missing/unknown states instead of fabricated zeros.
8. Small badge/text stating **“Recorded incident replay — not connected to production.”**

No fake telemetry, fake statuses, invented performance metrics or decorative action buttons that do nothing. UI should be accessible by keyboard; surface live captions.

---

## 11. Security, privacy and data integrity

- All sample incident data is benchmark-derived or explicitly labeled synthetic test fixtures.
- Use public incident IDs; never leak filenames or root-cause labels into browser, MCP, logs, prompts or trace metadata visible to the assistant.
- Server validates all JSON inputs with Zod and enforces query limits and per-session scope.
- No arbitrary code execution, shell, OS diagnostics or tool-based writes in MVP.
- Restricted ingestion: source allowlist/local approved files, block SSRF/private IPs/localhost redirects and overly large files; do not let the public ask to fetch arbitrary URLs.
- Do not provide unrestricted MCP to internet users. Authenticate network-exposed transports, and bound session access.
- Rate limit agent requests, expensive embeddings, and tool calls; add concurrency caps to avoid free-tier abuse.
- Keep API keys server-side, redact stack traces and sensitive fields, and set a sensible transcript retention policy.
- Protect against prompt injection from logs and documents.
- Ensure evaluation labels are physically inaccessible to the runtime service, not merely hidden by a prompt.
- Include attribution and verify source documents' terms before redistribution.

---

## 12. Testing plan and acceptance criteria

### Automated tests

- **Unit:** chunking, timestamp precision, metric normalization, missing values, embedding dimension validation, query filtering, tool argument validation, citation formatting, timeout logic.
- **Integration:** real PostgreSQL + Redis, import a small actual Parquet case, make MCP calls, retrieve a runbook section, reject out-of-scope incident IDs.
- **Security:** prompt injection in a log message is not executed; tool cannot access evaluator DB; original dataset filename never appears in agent-facing payload; ingestion SSRF and oversized payload blocked.
- **E2E text:** selected recorded incident → agent invokes real MCP + RAG → produces evidence-referencing response → UI displays events.
- **E2E voice:** microphone → transcript → investigation → speech; interrupt during TTS and ensure playback stops; reconnect behavior.
- **Evaluation:** diagnosis accuracy over held-out cases, correct-service top-1/top-3 where appropriate, retrieval recall@k, citation support, unsupported-answer rate; publish denominators.
- **Performance:** use k6/Artillery for API endpoints and scripted voice turn replay; record p50/p95 and configuration. Load test **two or more API processes** connected to shared Postgres/Redis locally, without calling it production clustering.

### Acceptance gates by phase

| Phase | Deliverable | Definition of done |
|---|---|---|
| 0 | Source audit | Inspect actual Parquet files, source licenses, existing voice repo and tooling; document blockers. |
| 1 | Project foundation | `npm install`, lint/typecheck/tests work; Fastify ready checks really reach Postgres/Redis. |
| 2 | Dataset import | Three real RE2-OB cases imported; row counts/time ranges verified; all answer keys inaccessible to API. |
| 3 | MCP diagnosis | Real stdio MCP server; scoped tools retrieve actual metrics/logs/traces with input bounds. |
| 4 | RAG | Approved docs embedded in pgvector; semantic + lexical search; citations and known-question evaluation. |
| 5 | Text investigation | One incident investigated end-to-end; LLM uses MCP + RAG; tool events are visible and bounded. |
| 6 | Voice | Functional streaming voice, captions, barge-in and cancellation; measured audio latency. |
| 7 | Evidence/testing | Automated tests, held-out cases, accurate metrics and disclosed limitations. |
| 8 | Deployment | Publicly inspectable demo with no answer-key leaks or exposed secrets; runnable GitHub README. |

Every phase ends with an actual Git commit, a short change summary, commands run and remaining limitations.

---

## 13. Execution plan and dependency ordering

### Phase 0: audit first

- Inspect user's existing voice-agent repo/source and note which components are already reusable. If repo is not available, ask for its URL/path; do not assume the contents.
- Inspect RCAEval `cases.parquet` and at least one candidate `metrics.parquet`, `logs.parquet`, `traces.parquet` with Node tooling; verify library behavior and source sizes.
- Verify relevant docs sources/license. Choose 3 cases and explain why.
- **Stop if Node Parquet support cannot correctly preserve data; do not silently switch languages.**

### Phase 1: foundation

- npm workspaces + strict TypeScript, Fastify app factory, env validation, Docker Compose with pinned pgvector Postgres and Redis versions, migrations, health checks, Vitest, lint and GitHub Actions CI.
- Do not create LLM/voice logic yet.

### Phase 2: data importer

- Download three cases incrementally and normalize wide metrics + logs + spans.
- Confirm exact row counts, clocks, nulls, service name derivation and pagination.
- Implement public ID mapping and private evaluator isolation **before** exposing any case API.

### Phase 3: MCP

- Implement stdio MCP server and tool test client. Require incident-scoped session identity and enforce it server-side.
- Produce tool fixtures using real imported data, never diagnosis constants.

### Phase 4: RAG

- Approve corpus, ingest selected docs, chunk/embed/index; implement retrieval and citation checks.
- Establish vector-only retrieval baseline before adding hybrid fusion.

### Phase 5: investigator

- Integrate model API, MCP client and RAG search behind one orchestrator.
- Keep prompt small, evidence-rich and source-attributed.
- Ship working text investigation and timeline.

### Phase 6: voice

- Integrate **existing** agent streaming code or agreed providers. Implement interrupt cancellation, captions, metrics.
- Run repeated actual voice tests in browser.

### Phase 7: scaling and evaluation

- Collect accuracy and latency measurements, compare retrieval modes, run multiple API instances and validate session continuity.
- A local multi-instance simulation is a **scalability test**, not evidence of having managed a large cluster.

### Phase 8: shareable demo

- Deploy a limited, rate-controlled demo; include demo scenario guide, architecture diagram, one short recording, known limitations and reproducible commands.
- Include a link to original dataset and acknowledge recorded/simulated incident investigation.

---

## 14. What must NOT be built (scope guard)

| Do not build | Why |
|---|---|
| Hotel/customer-service chatbot, LeadFlow integration | Different product; distracts from incident investigator. |
| Generic PDF Q&A as the main app | Does not demonstrate telemetry investigation. |
| LangChain/LangGraph dependency | Not needed for this implementation; keep direct code understandable. |
| Pretend MCP calls | MCP must run through an actual protocol server/client. |
| LLM access to SQL, shell, filesystem or unrestricted HTTP | Major security risk and unnecessary for demo. |
| Automatic operational remediation | Wrong safety model for an interview demo. |
| Training or LoRA fine-tuning module | Not relevant to MVP and not required to demonstrate RAG. |
| Kubernetes, service mesh, Kafka or complex microservices by default | Premature operational overhead; simulated scaling is sufficient. |
| Hundreds of downloaded incidents immediately | Slow, expensive, complicates debugging. |
| Ingesting root-cause labels into RAG or prompts | Invalidates evaluation. |
| Hardcoded diagnosis for an incident | Misrepresents AI investigation quality. |
| Fake UI metric values or hardcoded under-300-ms claims | Misrepresents actual engineering. |
| Real production credentials or customer data | Out of scope and unsafe. |
| Telephony numbers and payment billing | Not part of current goal. |
| Unbounded raw log/trace dumps into prompts | Cost, latency and prompt-injection risk. |
| Overengineering abstractions before a vertical slice | Slows delivery and obscures reasoning. |

---

## 15. Standard scripts / developer ergonomics

Implement working npm root scripts with these names (commands may delegate to workspaces):

```bash
npm run dev              # API + web + necessary local dev processes
npm run dev:api
npm run dev:web
npm run dev:mcp
npm run dev:worker
npm run db:migrate
npm run data:inspect      # inspect dataset source metadata/schemas
npm run data:download     # download explicitly selected cases
npm run data:import
npm run knowledge:ingest
npm run test
npm run test:integration
npm run typecheck
npm run lint
npm run eval:rca        # private local evaluator only
npm run benchmark
```

Do not publish scripts that do not exist. If a script is not implemented at the current phase, remove or clearly label it as planned.

Suggested development tools: `tsx`, `vitest`, ESLint, `pg` or a well-supported typed query layer, `zod`, `@modelcontextprotocol/sdk`, `bullmq`, `ioredis`, a maintained JS Parquet reader, Playwright if needed for E2E. Choose providers only after small benchmarks.

---

## 16. README and demo disclosure requirements

The public README must include:

- Clear pitch and **recorded incident replay** disclaimer.
- Architecture diagram distinguishing **MCP data**, **RAG documents**, **LLM**, **voice**.
- Feature matrix: **implemented / planned / not implemented**, continually maintained.
- Source links, licenses, dataset selection method and leakage precautions.
- Exact local commands, `.env.example`, how to obtain/copy only approved test data.
- Five-minute demo script: select incident, start voice, ask diagnosis, inspect evidence, interrupt response, show references and timings.
- Screenshots or short screen recording of **actual app behavior**, not AI-generated claims of implementation.
- Actual benchmark tables with dates, test hardware/provider and denominators.
- Known limitations and evaluation methods.
- Safety/security rules, repo structure and tests.

When emailing Rahul, say **"I recently extended my voice agent into a VoiceOps prototype using real recorded incident telemetry, MCP and RAG"** only after the work genuinely exists. State that LoRA and production GPU clustering are studied topics, not implemented experience. Do not claim a <300 ms voice pipeline or big-cluster operation without measured evidence.

---

## 17. Operating procedure for Codex

For each task:

1. Read `DEVELOPMENT.md` (this document), `AGENTS.md` and the existing relevant code.
2. Identify the current phase; do not work ahead unless asked.
3. Produce a brief plan specifying intended files, dependencies and acceptance tests.
4. Implement the smallest vertical slice that satisfies the phase.
5. Run typecheck/lint/unit/integration tests that are applicable.
6. Inspect the Git diff for unintended edits, hardcoded secrets, answer leakage and scope changes.
7. Report: files changed, behavior added, actual commands/results, failures, decisions and next action.
8. Ask before: changing architecture, introducing Python, selecting a paid provider, downloading >500 MB at once, altering live infrastructure, destructive operations, or accessing credentials.
9. Never claim commands/tests/benchmarks were executed unless they actually were.
10. Commit only with user's instruction or agreed workflow; never force push.

### First Codex task (copy into Codex)

> Read `DEVELOPMENT.md` completely. Execute **Phase 0 only**: inspect the existing repository, determine where my existing voice-agent code is located (ask me for its path if unavailable), inspect RCAEval's real index and one RE2-OB Parquet case using Node/TypeScript, identify an appropriately licensed small RAG runbook corpus, and report exact findings, dataset download sizes, schema examples, risks and the proposed Phase 1 implementation plan. Do not build unrelated features, use Python, fetch gigabytes, expose hidden ground-truth labels, or claim any tests passed without running them. Stop after Phase 0 and wait for approval.

---

## 18. Final delivery standard

An acceptable MVP is **not** "it talks." It is:

- A real, inspectable **voice interaction** and text fallback.
- Three real RCAEval replay incidents with no answer-key leakage.
- Real read-only MCP protocol tools querying those incidents.
- A functioning RAG pipeline over relevant, licensed runbooks using embeddings and pgvector.
- A model response that cites knowledge and observed telemetry and acknowledges uncertainty.
- Working interruption handling.
- Measured latency and a small evaluation report.
- Reproducible setup and honest, reviewed GitHub code.

**Build for demonstrable correctness first; optimize latency and scaling second.**

# VoiceOps — Hinglish document assistant and incident investigation prototype

Current demo: a friendly Hinglish voice assistant over a clearly labeled fictional insurance FAQ, using PostgreSQL/pgvector RAG and Sarvam streaming speech.

The selected mode is `ASSISTANT_MODE=documents`. Twenty-one fictional FAQ topics are indexed separately from technical runbooks; greetings are immediate, policy answers retrieve source passages and cite exact quotes, and missing information is acknowledged. See [setup and limits](docs/hindi-assistant-status.md). The recorded-incident prototype remains available through `ASSISTANT_MODE=investigator`. Browser microphone/playback acceptance testing remains pending.

| Capability | Status |
|---|---|
| npm workspaces, strict TypeScript, ESLint, Vitest, CI configuration | Implemented |
| Fastify liveness and bounded PostgreSQL/Redis readiness checks | Implemented |
| Local PostgreSQL/pgvector and Redis, versioned migrations | Implemented |
| Three real RE2-OB incidents; resumable, checksum-verified Node import | Implemented |
| Read-only runtime role, separate evaluator DB and isolated API container | Implemented and tested |
| License/provenance audit for four official runbooks | Implemented; indexed with attribution |
| Five read-only stdio MCP telemetry tools with incident scope, bounds and pagination | Implemented and tested through an isolated container |
| Background runbook ingestion, local CPU embeddings, vector and hybrid retrieval | Implemented; 55 chunks from four official sources, development evaluation recorded |
| Text investigator and React/Vite workbench | Implemented; current-turn citations enforced, live Groq validation and real API/MCP/RAG tests |
| Conversational voice, streamed progress/audio, captions and interruptions | Implemented; voice-first interface, browser acceptance pending |
| Hinglish document assistant and natural greetings | Implemented; Roman Hinglish interface; silent retrieval, adaptive explanations, twenty-one fictional topics, including a sourced worked example, three exchanges of context, Groq 120B in the local demo, cited answers, no-model greetings and acknowledgments |
| Audio burst buffering | Fixed; bounded raw PCM queue and short scheduling horizon, interruption regression tested |
| Liquid voice interface | Neutral light canvas, focused voice card, subtle fluid ring, real voice states, Roman Hinglish controls, responsive layout and reduced-motion support |
| Uploading arbitrary policy/PDF files | Not implemented; current demo uses the selected sample FAQ |
| Response-time instrumentation | Measured in three synthetic voice turns; [results and limits](docs/response-time-check.md) |
| Faster document voice turn detection | 300 ms silence threshold; tuned synthetic acknowledgment 1.22 s, cold policy question 2.67 s; inserted 200 ms pause retained the full question. Full 300 ms response not achieved |
| Accuracy evaluation and audible browser latency | Not implemented |
| Production infrastructure or automatic remediation | Out of scope |

## Local setup

Requires Node 22.13+ or 24 LTS, npm, and Docker Desktop with its Linux engine running. The dependency lockfile pins resolved versions. Services bind to loopback only; this is a local development setup.

1. Run `npm ci` (or `npm install` when first creating the lockfile). Local embeddings use bundled CPU binaries; on Linux set `ONNXRUNTIME_NODE_INSTALL=skip` before installing to avoid optional CUDA downloads. CI sets this automatically.
2. Copy `.env.admin.example` to `.env.admin`. Replace the PostgreSQL password placeholder in both `POSTGRES_PASSWORD` and `ADMIN_DATABASE_URL` with the same random, URL-safe local password. Existing local installations already have ignored environment files; preserve their passwords and volumes.
3. Run `npm run infra:up`.
4. Run `npm run db:migrate` (safe to repeat).
5. Run `npm run db:setup`. This creates a SELECT-only runtime role and a separate evaluator login/database, then generates `.env` with runtime credentials. `.env.admin` is for bootstrap/import CLI commands only.
6. To obtain the selected benchmark data, run the sequence in `data/README.md`. Existing local data is already imported.
7. Run `npm run dev`.

API: http://127.0.0.1:3001/health/live and http://127.0.0.1:3001/health/ready. Readiness returns 503 when either dependency is unreachable. `npm run dev` builds and starts the health API container in the background. It receives only runtime credentials and contains no raw data, evaluator files, admin environment, import scripts or migration executable. Docker must be running.

## Text investigation

Run `npm run investigator:setup` to create the ignored `.env.model` without displaying credentials. Set `GROQ_API_KEY` locally using a Groq free-plan account, then set `MODEL_REQUESTS_ENABLED=true`. Preserve the generated `API_BEARER_TOKEN`. Run `npm run investigator:start` and open http://127.0.0.1:3002. Enter the local API token, select a recorded incident, and ask a bounded question such as “Inspect a small sample of logs. What is observed, and what remains unknown?”

The container holds the provider key server-side and uses only the restricted runtime database login. The MCP child receives only that runtime connection and its selected incident UUID. Local embedding weights are mounted read-only; raw telemetry files, evaluator mappings and admin credentials are absent. Only redacted public benchmark observations and public runbook excerpts are sent to Groq.

The workbench displays actual SSE tool/retrieval/model events, evidence, measured durations and cited sources. The final answer is buffered and checked before display and speech; model token streaming is not implemented. One active turn and a one-minute process-wide cooldown limit free-plan use; Groq may impose additional limits. See [the text implementation](docs/text-investigator-status.md) and [voice setup and test limits](docs/voice-status.md). `npm run test:investigator` uses real MCP/RAG with explicitly synthetic model fixtures and makes no hosted calls. `npm run investigator:smoke` is an explicit live hosted test.

## MCP tools

See [the MCP setup and contracts](docs/mcp-status.md). Build the isolated tool image with `npm run mcp:build`, then select one public UUID in PowerShell and run the real protocol smoke client:

```powershell
$env:VOICEOPS_INCIDENT_ID = '7866929a-f7c0-489c-9971-c20405e60e81'
npm run mcp:smoke
```

`npm run mcp:serve` starts the stdio server for a compatible local client; its stdout is reserved for MCP. The trusted launcher chooses the incident. The investigator verifies API bearer authentication and a separate session capability before launching a scoped MCP child; MCP itself has no network listener.

Use `npm run infra:stop` to stop local services while preserving their volumes. Do not remove volumes unless you intend to delete their data. `npm run dev:api` is an optional host-based code-debugging command using restricted DB credentials; the host developer has filesystem access, so use the container for the demonstrated isolation boundary. Do not run both on port 3001.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
npm run test:data
npm run test:mcp
npm run test:rag
npm run test:investigator
```

## Runbook retrieval

The corpus and local model are already indexed on this workstation. Try:

```powershell
npm run rag:search -- "When should I record a span event rather than a span attribute?"
```

For a fresh setup, follow [the RAG guide](docs/rag-status.md): verify source snapshots, download the 24 MB embedding model, build, start the background worker in one terminal and queue ingestion in another. The worker uses `.env.ingest`, containing a knowledge-only database writer. The search CLI uses `.env`, with read-only credentials. No paid provider or model API key is required.

Vector-only and hybrid search each reached 19/20 expected sections in the top five on 27 development questions, with valid citations for all returned excerpts. Six of seven unsupported questions returned insufficient coverage; one question about exact production capacity/cost retrieved general CPU guidance. Retrieval candidates are not diagnoses or proof that a complete answer exists. The next investigator must check whether excerpts support its claims and abstain when they do not. See [the actual evaluation](eval/reports/rag-retrieval.json).

Integration tests require running services, applied migrations and `db:setup`. They check connectivity, failures, pgvector and runtime/evaluator permissions. `test:data` additionally requires the actual selected Parquet files and imported incidents; it checks source counts, missing values, identifiers, precision and label-free metadata. Unit fixtures are explicitly synthetic. CI runs unit and service/isolation tests without downloading telemetry; its GitHub execution has not yet been observed. Local data results are in `docs/data-provenance.md` and `eval/reports/data-validation.json`.

The TypeScript build compiles application source into `dist/`. The local image contains required compiled API code and production dependencies. Administrative migrations/imports use tsx outside that container. This is a local development image, not a public deployment.

## Intended architecture

```text
React voice/text client → Fastify → bounded TypeScript investigator
                                     ├─ MCP → recorded telemetry (read-only)
                                     ├─ RAG → licensed runbooks in pgvector
                                     └─ LLM/STT/TTS providers
Background worker → approved document ingestion via BullMQ/Redis
Private evaluator → isolated answer keys (never accessible to the investigator)
```

## Sources and remaining work

Full requirements: [development.md](development.md). Dataset: [RCAEval](https://huggingface.co/datasets/phamquiluan/RCAEval), [upstream repository](https://github.com/phamquiluan/RCAEval). Revision `afeacb11bcc94dadfd1c8f483ee4377b2b8b614e`; MIT attribution is preserved in `data/licenses/RCAEval-MIT.txt`. Three cases provide **280,647 metric observations, 379,735 logs and 855,295 spans**, from 23,533,610 bytes of compressed telemetry. These are recorded observations, not generated fixtures.

Indexed runbooks cover Kubernetes Pod/Service debugging and resource metrics, plus OpenTelemetry trace concepts. `data/runbook-sources.json` records official URLs, pinned source revisions, checksums, capture times, CC-BY-4.0 attribution and limited import scope. Raw snapshots are ignored; 55 approved chunks are embedded and indexed.

The workspace was empty except for the specification. Existing voice code is unavailable, and the user authorized a new agent. Source audit and three-case import are complete. Public IDs are random UUIDs with neutral titles; answer-bearing paths, labels and injection times live only in private selection/evaluation storage. Runtime credentials cannot connect to that evaluator database, access import bookkeeping or modify telemetry.

Known data limits: telemetry types have different clocks/coverage; metric units remain unknown unless independently verified, and NULL observations are preserved. A live model smoke test is not a diagnosis accuracy evaluation. Synthetic voice timing measurements are documented in [the response-time report](docs/response-time-check.md); audible browser latency and production scaling have not been demonstrated. Sarvam speech integration, captions and automated interruption tests are implemented. Next: browser microphone/playback acceptance, real-user interruption checks and answer accuracy evaluation.

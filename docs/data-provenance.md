# Data audit/import — 2026-10-10, Asia/Calcutta

## Verified sources

[RCAEval](https://huggingface.co/datasets/phamquiluan/RCAEval) was inspected through its repository API and actual Parquet files using Node/TypeScript. Revision `afeacb11bcc94dadfd1c8f483ee4377b2b8b614e`; index size 29,500 bytes, 735 rows and 22 columns. Ninety RE2-OB entries have both logs and traces.

Three cases covering CPU, memory and network-delay categories, with distinct affected services, were selected by private label metadata and small verified file totals. Labels determine category diversity only; they are never investigation evidence. Nine exact telemetry files total 23,533,610 bytes. The verified repository listing supplied their paths, sizes and LFS SHA-256 hashes. Files were downloaded sequentially and verified. Ground-truth and injection-time text files were not downloaded.

All actual files use Zstandard. `hyparquet` 1.31.3 initially rejected this compression; `hyparquet-compressors` 1.1.2 enabled decoding. Both are dev/import tooling excluded from the runtime image. No Python was introduced.

## Actual schemas

| Source | Fields | Preservation |
|---|---|---|
| Metrics | INT64 `time`; 74, 71 and 76 DOUBLE measurements | Source seconds → integer epoch microseconds; service/metric/source field preserved; NULL retained |
| Logs | INT64 `timestamp`; string `container_name`, `message` | Source seconds, service, message and row number preserved; severity unknown |
| Traces | Strings `time`, `traceID`, `spanID`, `serviceName`, `methodName`, `operationName`, `parentSpanID`; INT64 `startTimeMillis`, `startTime`, `duration`, `statusCode` | Text IDs, exact integer clocks/durations and nullable status/parent/method preserved |

Trace `time` is a display string such as `23:11`; it is not an epoch. An actual startTime is `1705705884062003`, with startTimeMillis `1705705884062`; the extra microseconds survive database round trip. Jaeger's [JSON model](https://pkg.go.dev/github.com/uber/jaeger@v1.17.0/model/json) defines microsecond start/duration values. Every imported span was checked for agreement between these clocks. BigInt and PostgreSQL BIGINT avoid JS Date's millisecond truncation. The observed trace alias `frontendservice` → `frontend` retains `source_service`.

Coverage differs among sources. Incident 1 has 930 metric time steps and a shorter trace window; the others have 1,441 metric steps. No missing coverage was generated. Metric units are not in the inspected schema and remain NULL pending independent verification. Log severity is likewise unknown.

## Validated counts

| Neutral incident | Metric observations | Missing metrics | Logs | Spans | Missing span status |
|---|---:|---:|---:|---:|---:|
| Recorded incident 1 | 68,820 | 1,974 | 110,067 | 199,960 | 9,381 |
| Recorded incident 2 | 102,311 | 6 | 155,910 | 276,103 | 12,868 |
| Recorded incident 3 | 109,516 | 10 | 113,758 | 379,232 | 17,924 |
| Total | 280,647 | 1,990 | 379,735 | 855,295 | 40,173 |

`eval/reports/data-validation.json` contains safe IDs, counts and windows. All nine files matched index/file row counts, normalized widths, NULL counts and exact min/max times. First/last spans matched IDs, parents, clocks, duration, status and attributes. Separate actual-data tests passed for source counts, missing metrics, ID/sub-millisecond precision and absence of answer labels/paths from runtime metadata.

## Isolation and resume behavior

Only observation data exists in `incidents`, `metric_samples`, `log_entries` and `trace_spans`. No root-cause, fault, source-case-name or injection-time columns exist there. Original mappings/provenance remain in ignored private manifests and `voiceops_evaluation`, using the separate `voiceops_evaluator` login. The evaluator database denies runtime CONNECT. `import_jobs` is administrative and runtime cannot SELECT it.

`voiceops_runtime` has SELECT on the four telemetry tables, no superuser/role/database/schema-create/server-file privileges and no TEMP privilege. Tests disabled its default read-only setting and still confirmed writes are denied by actual grants. `.env.admin` supplies administrative/evaluator CLI credentials; `.env` supplies runtime only. Both are ignored.

The default API is a UID-1000, read-only Docker container with no raw/private files, administrative environment, import scripts or migration executable. Inspection while running confirmed those absences and the correct runtime login. Health readiness returned HTTP 200. Host `dev:api` is trusted developer execution and lacks this container filesystem boundary; use the default container for demonstrated isolation.

Imports use 32 metric rows or 2,048 log/span rows per bounded reader range, with database payloads capped at 8 MiB. Data and progress commit in the same transaction; a session lock prevents simultaneous importers. The real import was interrupted and resumed, then intentionally stopped after two committed batches and resumed again. A complete subsequent import verified all files and recorded **zero batches/zero new rows**, demonstrating idempotency. Source row numbers preserve duplicate observations. This is verified for the selected cases, not arbitrary-size scalability.

The report's maximum RSS describes its latest verification run, which inserted zero rows; it does not measure the original cold import. No voice latency or diagnosis accuracy measurements exist.

## Licenses and runbook candidates

The [dataset card](https://huggingface.co/datasets/phamquiluan/RCAEval) and [upstream licensing statement](https://github.com/phamquiluan/RCAEval#licensing) confirm MIT. The original notice is saved in `data/licenses/RCAEval-MIT.txt`; its exact source revision/hash is in `data/runbook-sources.json`.

Four official Markdown candidates were audited: Kubernetes Debug Running Pods, Resource Metrics Pipeline, Debug Services, and OpenTelemetry Traces. Total source size is 74,697 bytes. Both documentation repositories publish CC-BY-4.0 licenses. The manifest records pinned source revisions, Git blob/SHA-256 hashes, capture times, attribution, license URLs/checksums and proposed small-section import scope. Third-party material is excluded. Raw snapshots are ignored and unserved. No chunking, embeddings, retrieval or RAG evaluation has been implemented; general guidance is not a case-specific answer key.

## Commands/results and resolved failures

- Reader/codec npm installs completed with zero reported vulnerabilities.
- `data:inspect`, `data:select`, `data:download`: actual index and all selected files decoded/verified, within stated budgets.
- Migration applied `002_telemetry.sql`; `db:setup` created separated roles/database/environments.
- `data:import`: three complete validated incidents, interrupted/resumed checkpoint check and zero-insert rerun.
- `npm run dev`: build and isolated image startup passed; all three Compose services healthy.
- `npm test`: 16/16 passed; `test:integration`: 8/8 passed; `test:data`: 4/4 passed.
- `data:audit-sources`: original dataset notice and four official licensed Markdown sources audited.
- Final lint/typecheck passed. Runtime container inspection and HTTP readiness checks passed.
- Migration and isolation setup reruns completed successfully; all 8 service/isolation and 4 actual-data tests passed again afterward.
- Repeated selection retained the same three UUIDs; repeated downloads verified existing files, including strengthened Git-blob integrity for the index.
- A scan of all 48 Git-eligible files found no generated secrets or selected answer-bearing case names. Raw/private files and both real environment files remained ignored. API/PostgreSQL/Redis were left running healthy.

Resolved failures: Zstandard required a codec; strict typing required optional Node environment-parser values. npm/PowerShell did not forward the pause flag on its first attempt, so Node was called directly. A full offline provenance scan exceeded the 1.5-second readiness-style pool budget; validation now has a separate 10-second bound, with the application's deadline unchanged. Kubernetes HTML exceeded the 512 KiB audit budget; pinned official Markdown passed within it. CI is configured but not yet observed on GitHub. No commit or push was performed.

Next: real stdio MCP tools with incident allowlists, bounded queries and explicit evidence/time/unit handling. RAG ingestion, investigator, web and voice remain later phases.

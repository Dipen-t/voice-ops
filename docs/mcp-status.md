# Phase 3: read-only MCP telemetry

The official `@modelcontextprotocol/server` and `@modelcontextprotocol/client` packages are pinned to 2.3.1. The local client negotiates protocol 2026-07-28 through an actual stdio child process; tools are registered with strict Zod input schemas. These packages implement the tool interface only. RAG, model reasoning, browser UI and voice are subsequent phases.

## Start and verify

Keep the existing PostgreSQL container running (`npm run infra:up`). Then:

```powershell
npm run mcp:build
$env:VOICEOPS_INCIDENT_ID = '7866929a-f7c0-489c-9971-c20405e60e81'
npm run mcp:smoke
```

The smoke client lists tool definitions and retrieves the selected incident's observed summary. It closes the process/container afterward. `connectTelemetry(id)` is the reusable TypeScript client entry point; it defaults to the isolated container. `npm run mcp:serve` is the raw stdio endpoint for another trusted local client, which must supply the selected UUID. No diagnosis is produced.

The public UUIDs are also recorded in `eval/reports/data-validation.json`. They contain no benchmark answer labels. A separate server process is created for each selected incident; the process environment is immutable from tool calls. `list_incidents` returns only that incident, and all other tools reject any other ID before acquiring a database connection. There is no default incident or unrestricted mode. UUID selection is a local trusted-launcher authorization boundary, not internet authentication; the future application must check the user's authorization before starting this process.

## Tools

| Name | Inputs beyond incident_id | Evidence |
|---|---|---|
| list_incidents | No arguments | Selected public ID, title, system and observed window |
| get_incident_summary | None | Services, record counts, missing-value counts and coverage per telemetry kind |
| get_service_metrics | Required service; optional metric_names and aggregation='raw' | Recorded measurements, unknown units as null, missing null/NaN markers, source references |
| search_service_logs | Optional service and literal case-sensitive query | Recorded messages, clock, severity if known and source references |
| get_service_traces | Optional service and exact trace_id | Exact trace/span/parent IDs, start clocks, durations, source attributes and references |

All three slice tools accept optional `start`, `end`, `limit` and `cursor`. Start/end are **inclusive decimal strings of epoch microseconds**, not dates or Unix milliseconds. Durations are microseconds. Default window is the first five minutes; maximum is fifteen minutes, and requested bounds must lie inside the observed incident window. For a later window specify a later start. Source order is preserved (`source_row`, plus `source_field` for metrics); this is not a duration-ranked slowest-span query.

Results contain records, resolved window, units, `empty`, `truncated` and `next_cursor`. Limits are 1–100 (default 25). Cursors are HMAC-protected and bound to tool, incident, resolved window and filters in this process; changing filters or restarting the process requires restarting pagination. A null cursor means the selected result is exhausted. Log messages are capped at 2048 characters with a `message_truncated` flag. Record payloads stop at 28,000 bytes and complete structured results at 32,000 bytes; MCP returns matching text and structured copies. Summary coverage is capped at 100 groups with explicit truncation. Raw metric aggregation is supported; statistical aggregations are not implemented yet.

Empty slices and null trace status are not evidence of healthy operation. Units/severity absent from the source remain unknown. Different telemetry kinds have different observed coverage. Evidence is untrusted source text; the future investigator must treat it as data rather than instructions.

## Access, bounds and errors

Queries use fixed table/column definitions and bound parameters. There are no SQL, shell, filesystem, arbitrary network, environment or evaluator tools. Literal log search uses `strpos`, so SQL and LIKE wildcard input cannot expand a query. Tool input is strict, with lengths, enum values and array bounds. Stdio messages are capped at 16 KiB and tool inputs at 64 object/array elements.

Only `voiceops_runtime` database credentials and one incident UUID reach the MCP container. The server also checks `current_user` and starts a read-only transaction. The existing restricted role cannot write telemetry, read import bookkeeping, connect to the evaluator database or read server files. The container runs as UID 1000 with read-only filesystem, dropped capabilities, no host file mounts and no raw/private data or admin environment files. Compose reads `.env.admin` on the trusted host solely to configure the container's runtime URL; the file and administrative credentials are never passed into the container. Host-mode protocol tests use `.env` runtime credentials and do not claim filesystem isolation.

There is one active tool call per process; overlapping calls return `SERVER_BUSY`. Connection/query limits are three seconds and each handler has a five-second total deadline. Client cancellation destroys the active database connection. Failed/cancelled transactions never return to the pool. No automatic retries occur. Client calls use bounded timeouts and close their child process on exit. Errors expose bounded codes (`INCIDENT_NOT_AUTHORIZED`, `INVALID_WINDOW`, `INVALID_CURSOR`, `QUERY_FAILED_OR_TIMED_OUT`, etc.), never connection strings, private paths or raw PostgreSQL failures. The standalone server validates configuration and fails when the selected incident/runtime credentials are missing.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
npm run test:mcp
$env:MCP_TEST_CONTAINER = '1'
npm run test:mcp
```

Protocol tests use actual imported PostgreSQL data: five tools discovered over stdio; selected-incident listing; summary counts compared with SQL; exact measurement clocks/values and span IDs/durations; log pagination; cursor tampering and filter changes; rejection of other incidents and SQL/shell-style arguments; cancellation followed by a successful call. Synthetic unit fixtures cover int64/time-window bounds, signed cursor isolation, cancellation of a stalled connection and overlapping calls. Container inspection checks that private paths and admin/evaluator environment variables are absent.

Local verification on 2026-10-10: lint, typecheck and build passed; 21 unit tests, eight foundation/isolation integration tests, four data tests and six MCP protocol tests passed (39 distinct tests). The six MCP tests passed in both host and container modes, and the documented container smoke command succeeded. Container inspection returned UID 1000, zero private paths and zero admin/evaluator environment variables. One sandboxed unit-test run could not load two suites because Windows mapped their temporary files incorrectly; rerunning outside the sandbox passed all 21 tests. No application change was needed for that environment failure.

The next phase is custom runbook RAG over the already audited official documentation sources. No model provider key is required for these telemetry tools, and no voice or diagnosis latency has been measured.

Official SDK reference: https://github.com/modelcontextprotocol/typescript-sdk

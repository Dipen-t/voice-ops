# Setup verification — 2026-10-10 (Asia/Calcutta)

This is the historical Phase 1 snapshot. Current imports, credential separation and container startup are documented in `data-provenance.md` and the root README.

The user requested project setup from development.md and confirmed that existing voice-agent source is unavailable: create a new voice agent. The starting workspace contained only development.md; there was no Git repository or application source.

## Foundation delivered

Root npm workspaces with an API app and database package; strict TypeScript; Fastify app factory; Zod configuration validation; loopback-only server; process liveness and bounded, real-service readiness; connection cleanup; pgvector migration with transactional version tracking and advisory locking; pinned Compose services; dependency lockfile; ESLint/Vitest; CI definition; ignored generated local .env; development and data-scope documentation.

Dependencies were introduced because no existing components were present. Fastify serves the required API, Zod validates environment values without echoing secrets, pg reaches PostgreSQL, ioredis verifies Redis, and TypeScript/tsx/ESLint/Vitest provide development and verification. No orchestration, voice, model-provider or ingestion packages were added ahead of their phases. The only database table is migration bookkeeping; incident schemas await actual Parquet inspection. The only API routes are health routes.

Docker images are pinned by tag and verified repository digest. Direct npm dependency versions and transitive resolutions are pinned. Git was initialized on main; no files were staged, committed or pushed.

## Environment and actual commands

Windows, PowerShell, Node v22.19.0, npm 11.19.1, Docker Engine 28.0.4, Compose v2.34.0. Final test execution used local services on 127.0.0.1:15432 and 127.0.0.1:16379. These are setup checks, not incident accuracy or voice latency benchmarks.

| Command/check | Observed result |
|---|---|
| `node --version`, `npm --version`, Docker version checks | Installed tools confirmed |
| `npm install` | Dependencies installed, package-lock.json generated |
| `npm audit --json` after the initial install | Three advisories in the initial Vitest dependency tree |
| `npm install --save-dev --save-exact vitest@5.0.3 eslint@10.12.0 @eslint/js@latest typescript-eslint@8.71.1` | Updated compatible tool versions; zero reported vulnerabilities |
| Pin manifests from the installed lockfile; `npm install --package-lock-only --ignore-scripts --offline` | Lockfile synchronized; zero reported vulnerabilities |
| `docker compose up -d --wait` | PostgreSQL and Redis started healthy |
| `npm run db:migrate` twice | First applied 001_foundation.sql; second completed without reapplying |
| `npm run lint` | Passed, zero warnings |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` (final run) | 9/9 unit tests passed |
| `npm run test:integration` | 4/4 tests passed against real PostgreSQL/Redis |
| `npm run dev` | API listening on 127.0.0.1:3001 |
| HTTP GET /health/live | 200, status ok |
| HTTP GET /health/ready | 200, postgres up and redis up |
| `docker compose ps` | Both services healthy, ports bound to loopback |
| `git check-ignore .env node_modules dist` | All three ignored |

Integration checks include real successful connectivity, refused PostgreSQL and Redis connections returning 503, pgvector 0.8.1, and a single applied migration record. Unit fixtures are synthetic dependency doubles, not incident telemetry.

## Failures encountered and resolved

Restricted execution initially denied Docker engine access and npm DNS access; normal-access retries succeeded. Restricted migration attempts failed and an integration suite reported filesystem EPERM; normal-access execution applied migrations and ran the real integration tests successfully.

The first unit run had one timeout during cold Fastify request-injection startup (about 21 seconds). Vitest's test/hook deadline is now 30 seconds; the application's readiness timeout remains independently bounded at 1.5 seconds. Final unit and integration runs each finished in under two seconds on the warm host; this is not a product latency claim. Windows npm test quoting was corrected to use double quotes.

npm emitted an install-script review notice for esbuild. No manual blanket script approval was applied; tsx, Vitest and the TypeScript build subsequently ran successfully. CI is configured but has not run on GitHub. A compiled deployment package is not yet prepared; migration/startup commands currently operate on TypeScript source via tsx.

## Remaining work

The dataset/source portion of Phase 0 is outstanding: inspect actual RCAEval index and candidate RE2-OB metrics/logs/traces with Node, preserve ID/timestamp precision, record source sizes/checksums, choose three cases, and audit small relevant runbook excerpts and licenses. No benchmark files or runbooks have been downloaded or redistributed.

Before importing data or exposing incident APIs, establish restricted runtime database permissions and isolated private evaluator storage/credentials. The foundation currently uses a local development administrator and contains no evaluator labels. Do not interpret gitignore as runtime isolation.

MCP, BullMQ workers, custom RAG, model integration, React/Vite workbench and the new streaming voice agent remain planned. No paid provider has been selected. No microphone, investigation, accuracy, audio latency or production deployment behavior has been implemented or measured.

The local API and database services were left running after verification. Stop the API with Ctrl+C in its terminal and stop database services using `npm run infra:stop`; the latter preserves volumes.

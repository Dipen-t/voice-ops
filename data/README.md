# Benchmark data

Source: [RCAEval](https://huggingface.co/datasets/phamquiluan/RCAEval), revision `afeacb11bcc94dadfd1c8f483ee4377b2b8b614e`. MIT attribution is preserved in `licenses/RCAEval-MIT.txt`.

Three actual RE2-OB cases are imported locally. Compressed telemetry totals **23,533,610 bytes** (23.53 MB); the index is 29,500 bytes. No entire suite was downloaded.

| Neutral incident | Metric source rows | Normalized metrics | Logs | Spans | Telemetry bytes |
|---|---:|---:|---:|---:|---:|
| Recorded incident 1 | 930 | 68,820 | 110,067 | 199,960 | 5,745,551 |
| Recorded incident 2 | 1,441 | 102,311 | 155,910 | 276,103 | 7,748,436 |
| Recorded incident 3 | 1,441 | 109,516 | 113,758 | 379,232 | 10,039,623 |

The private selection covers three categories and distinct services, favoring small complete source files with all telemetry types. Public random UUIDs persist across reruns. Original directory names and labels are omitted from this document and runtime metadata.

## Reproduce

First install dependencies, start services, apply migrations and run `npm run db:setup` as described in the root README. Then:

```sh
npm run data:inspect
npm run data:select
npm run data:download
npm run data:import
npm run test:data
npm run data:audit-sources
```

Inspection downloads only verified repository metadata and the index. Selection saves a private manifest. Downloads use exact pinned paths from the real listing, verify sizes and SHA-256/Git blob hashes, and store telemetry under public UUID directories. The initial selection budget is 100 MiB and the per-file cap is 100 MiB; downloads are sequential. A changed revision requires explicit reselection, not silent replacement.

The importer reads bounded source ranges (32 metric rows or 2,048 log/span rows), then commits parameterized database batches capped at 8 MiB. These files each contain one row group; non-overlapping pages are skipped rather than transposing a giant trace table into rows. Data and the next-row checkpoint commit atomically. A session advisory lock prevents concurrent importers. Completed reruns verify counts and insert zero rows.

To intentionally stop at a committed checkpoint on Windows, call Node directly:

```sh
node --env-file=.env.admin --import tsx scripts/import-incidents.ts --stop-after-batches=2
```

`raw/` contains ignored source files/audit snapshots. `private-evaluation/` contains ignored label/path mappings. The separate evaluator database denies runtime CONNECT; administrative import bookkeeping is not granted to runtime. The default API container receives no admin/evaluator credentials and has no raw/private file mounts or copies. Gitignore alone is not the isolation boundary.

## Interpretation and validation

Metrics/log clocks are INT64 Unix seconds, converted exactly to epoch microseconds. Jaeger trace `startTime`/`duration` are microseconds; `startTimeMillis` is preserved and checked. Trace `time` is only a display string. IDs remain text and clock arithmetic uses BigInt. The observed trace alias `frontendservice` maps to `frontend`, with the source name preserved.

NULL metric observations are preserved, not replaced by zero; NaN has a distinct missing marker if encountered. Metric units and log severity are not in the observed schemas and remain unknown. Telemetry types have unequal coverage, especially incident 1; missing evidence is not synthesized. Duplicate source observations remain separate via source row numbers.

Actual validation checks file/index counts, metric widths, NULLs, min/max times and first/last trace ID/clock/attribute round trips. See `../eval/reports/data-validation.json` and `../docs/data-provenance.md`. Checksums and answer-bearing source paths are private; the report contains public IDs and observed counts/times.

`runbook-sources.json` records the original audit of four official CC-BY-4.0 Markdown candidates, totaling 74,697 bytes, with pinned revisions, licenses, checksums, attribution and scoped reuse. Selected sections from those checksum-verified snapshots are now indexed as 55 knowledge chunks. See `../docs/rag-status.md` for setup, bounds and evaluation. The audit's capture-time status remains historical; current ingestion status is in the knowledge database. `embedding-model.json` records the pinned local model and five verified files (23,685,172 bytes); weights in `models/` are ignored. Never include evaluation labels or answer-bearing case names in the RAG corpus.

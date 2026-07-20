# Lineage and evaluation foundation

This foundation records durable, immutable evidence. It does not download models,
execute benchmarks, or replace the existing registry and job systems.

`web/src/lib/lineage-evaluations.ts` owns a private SQLite ledger in the
portable state root. It records content-addressed dataset manifests, immutable
lineage entities and relations, immutable evaluation suite/case definitions,
and evaluation runs. A completed run binds its suite to exact artifact/runtime
IDs, chat-template hash, host fingerprint hash, software/environment revisions,
decoding options, seed and repeat. It preserves each raw case output, structured
scorer result, numeric metrics, and structured error when applicable.

The repository rejects changed content under the same ID, partial case evidence,
duplicate cases/results, and incomplete exact-runtime evidence. Suite and case
IDs are SHA-256 identities over canonical definition data; reruns use a distinct
run ID and retain their declared seed/repeat. The comparison primitive reports
per-case outcomes and never folds quality and latency into an unlabeled score.

Read-only inspection endpoints are `/api/v1/evaluations/suites`,
`/api/v1/evaluations/runs/:id`, and `/api/v1/lineage/:id`. Mutating benchmark,
import, and promotion endpoints remain deferred until their job, authorization,
and approval adapters are integrated.

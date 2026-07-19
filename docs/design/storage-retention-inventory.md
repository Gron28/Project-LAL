# Storage and retention inventory

Status: baseline inventory for Foundation Milestone 2. It describes current
behavior; an unbounded row is a deliberate implementation gap, not an implied
retention promise.

| Root or owner | Contents | Current retention | Reference protection | Required next step |
| --- | --- | --- | --- | --- |
| `web/.data/runs/` | Run metadata, NDJSON event logs, client capabilities | Run ledgers: 30 days and 256 MiB; live work never evicted | Live runs are excluded; metadata, log, and capability files are removed as one unit | Add observability/export accounting and migrate the root outside the checkout in the portability slice |
| `web/.data/conversations/` | Chat/code conversations | Unbounded | None | Define export, deletion, size quota, and references from runs/media before enabling eviction |
| `web/.data/hive.db` | HIVE workflows, events, profiles, dataset/checkpoint metadata | Unbounded | Database records are authoritative metadata | Add migration, compaction, backup, and reference-aware retention through the registry/job work |
| `web/.data/hive/artifacts/` | Content-addressed HIVE artifacts | Unbounded | Current provenance/checkpoint records can reference hashes, but no garbage collector exists | Build reference graph and delete only unreferenced, expired bytes |
| `web/.data/hive/{datasets,quarantine}/` | Dataset manifests and candidate examples | Unbounded | Dataset manifests protect referenced `_deliberation` runs | Make dataset/checkpoint references authoritative before collection |
| `<workspace>/_deliberation/` | Deliberate-research outputs | 20 unprotected runs and 512 MiB; eviction runs after a completed deliberation | Any path mentioned by a dataset manifest is retained | Move generated research state into the configured data root and add disk accounting |
| `web/.data/webshots/` | Browser/evaluation screenshots | Unbounded | None | Convert to media artifacts with origin, retention class, and authorization |
| `web/.data/{cli-token,cli-devices.json}` | Pairing token and device metadata | No automatic deletion | Secret file mode is restricted; device metadata is not content-addressed | Add device lifecycle/revocation retention in Slice 1 |
| `/models/` | GGUFs, adapters, manifests | Manual deletion only | Specialist manifests and promoted model lineage are not yet protected by a common registry | Import into the capability registry, then enforce reference-aware deletion |
| `/data/` | Local training datasets and generated manifests | Manual deletion only | HIVE provenance hashes selected datasets, but ordinary data files have no global index | Migrate data manifests/ownership before any cleanup policy |
| `/out/` | Training output, logs, intermediate checkpoints | Manual deletion only | No durable relationship to final models or runs | Make training a durable job with checkpoint/output verification and retention classes |
| External Ollama and Hugging Face caches | Runtime/catalog cache outside the checkout | Managed by their tools, not LAL | No LAL reference tracking | Add adapters that report bytes and protect pinned imported artifacts before pruning |
| `llama/`, `.venv/`, `.venv-rocm/`, `web/.next/`, and app `node_modules/` | Build products and dependency environments | Rebuildable/manual deletion | None required; these are not user artifacts | Relocate/rebuild through the platform and dependency-bundle work |

## Existing safety rules

- No policy deletes a live run.
- A run ledger’s metadata and event log are one retention unit.
- A dataset manifest protects a referenced deliberation run even when it would
  otherwise exceed the count or byte budget.
- The current code never automatically removes models, datasets, training
  outputs, HIVE artifacts, conversations, screenshots, or external caches.

## What this inventory blocks

Do not add broad “clean storage” controls until model, evaluation, media,
dataset, and job references share the capability registry. Otherwise a cleanup
can silently destroy bytes required to reproduce a promoted model or report.
Until then, each unbounded row must remain visibly reported as unbounded rather
than displayed as protected or automatically managed.

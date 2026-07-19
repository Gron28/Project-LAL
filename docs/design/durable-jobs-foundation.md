# Durable jobs foundation

Slice 4 begins with `web/src/lib/jobs.ts`: a SQLite ledger under the platform
state directory, outside the checkout. It records declared resources, progress,
checkpoints, artifact references, structured errors, and an append-only event
trail; it never records model bytes or credentials.

`start()` admits a queued job only when its exclusive GPU, CPU slots, and disk
reservation are available. `succeed()` requires output artifact digests, so a
job cannot report completion before its output is verified. Cancellation is
durable; checkpointable workers observe it and settle it before releasing leases.
On restart, `recover()` releases stale leases and requeues recoverable jobs or
settles nonrecoverable jobs as `interrupted`.

The versioned endpoints are intentionally read-only while workload adapters are
migrated: `GET /api/v1/jobs` and `GET /api/v1/jobs/:id`.

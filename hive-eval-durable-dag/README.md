# Durable DAG evaluation fixture

Implement `DurableDagRunner` in `src/durable-dag.js` using only Node's standard library.

Requirements:

1. Validate node IDs, missing dependencies, duplicate IDs, and cycles before any task runs.
2. Schedule each node only after all dependencies have succeeded. Preserve deterministic declaration order among simultaneously-ready nodes.
3. Support bounded per-node retries (`retries`, default `0`) without exceeding the global `maxAttempts` budget.
4. Persist an append-only NDJSON journal. Every record needs a monotonic `seq`, timestamp, run ID, node ID, attempt, and event type.
5. Recover from the journal without rerunning succeeded nodes. A truncated final NDJSON line must be ignored, while corruption in the middle must fail loudly.
6. Pass one idempotency key per `(runId,nodeId,attempt)` into the task function.
7. Support `AbortSignal`. Do not start new nodes after cancellation; record cancellation durably.
8. Enforce a wall-time budget and a global attempt budget. Fail explicitly rather than claiming completion.
9. Return a structured summary containing status, completed node IDs, attempts by node, errors, and journal sequence.
10. Journal writes must be durable enough for a local process: append, `fsync`, then acknowledge the transition.

Run `npm test` and `npm run lint`. Do not weaken or delete tests.

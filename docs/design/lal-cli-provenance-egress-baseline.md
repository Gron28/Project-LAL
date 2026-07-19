# LAL CLI provenance and egress baseline

This is the initial, source-backed Gate B baseline for the supported LAL CLI.
Its machine-readable records are:

- [`apps/cli/provenance/initial-ledger.json`](../../apps/cli/provenance/initial-ledger.json)
- [`apps/cli/provenance/outbound-inventory.json`](../../apps/cli/provenance/outbound-inventory.json)

Run `node apps/cli/scripts/check-audit-inventories.mjs` from the repository root
to ensure each record still has the source evidence it cites.

## Scope and limits

The records cover cohesive subtrees and the currently supported LAL startup,
attach/native-run mirror, and distribution-wrapper paths. They are deliberately
not a claim that every inherited CLI path has been audited. In particular,
they do not replace the Gate B deny-by-default network harness, a complete
per-file ledger, or release artifact inspection.

The available local history first introduces `apps/cli/` in
`871cf32fe637a591ae204b386b15c33fb9bd027c`. `NOTICE-LAL.md` identifies Qwen
Code as the immediate Apache-2.0 upstream, but this checkout does not record
the exact Qwen base commit, its file blob hashes, or the Gemini base commit.
Those fields are therefore explicitly `null`/unresolved in the ledger. They
must be recovered from preserved fork/archive evidence before release; guessing
from version strings or copyright headers would not establish provenance.

## Current source conclusions

The supported LAL paths have three intended remote directions, each to the
configured LAL host: gateway requests from attach/native-run mirror, wrapper
heartbeats, and the explicit `lal update` installer fetch. The exact host is
configuration-derived; the gateway client defaults to `http://localhost:8770`.
The inventory does not assume that a configured host is local or trusted merely
because it is configured.

Two inherited upstream routes are present in source but are not approved LAL
destinations:

- Alibaba RUM has a fixed hostname. Its logger is gated by usage statistics;
  the current CLI settings-to-config default is `false`, but settings can still
  enable it.
- The `update-notifier` path has no fixed registry host in this source. It is
  gated by both `LAL_MANAGED !== '1'` and auto-update being enabled. The package
  `lal` entry wrapper sets `LAL_MANAGED=1` before loading the CLI.

These are source reachability conditions, not runtime proof. The required next
Gate B step is a deny-by-default harness that records DNS, connect, fetch, and
child-process attempts for startup, native turn, attach, tool execution, update,
sandbox start, and shutdown. Until that evidence exists, no destination should
be described as fully contained.

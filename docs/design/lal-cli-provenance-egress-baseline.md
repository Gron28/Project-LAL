# LAL CLI provenance and egress baseline

This is the initial, source-backed Gate B baseline for the supported LAL CLI.
Its machine-readable records are:

- [`apps/cli/provenance/initial-ledger.json`](../../apps/cli/provenance/initial-ledger.json)
- [`apps/cli/provenance/outbound-inventory.json`](../../apps/cli/provenance/outbound-inventory.json)

Run `node apps/cli/scripts/check-audit-inventories.mjs` from the repository root
to ensure each record still has the source evidence it cites.

Run `npm --prefix apps/cli run check:egress-acceptance` for the deterministic
startup boundary check. It makes no network calls: it verifies that the package
`lal` entry forcibly applies its managed-runtime marker, default startup keeps
RUM and inherited update checks disabled, and the two forbidden routes still
match the outbound inventory. It is a bounded startup acceptance check, not a
substitute for lifecycle-wide socket/DNS/process interception.

Run `npm --prefix apps/cli run check:egress-runtime-interception` for a second,
process-level startup check. It starts the supported `lal` entrypoint's safe
version path under a test-only Node preload that blocks and records standard
DNS, socket, HTTP(S), `fetch`, and child-process primitives before they reach
the host. The check fails if that path attempts any audited primitive, and
self-tests that the preload records each surface. It intentionally does not
claim coverage for native addons, external processes, or full interactive/model
turns; those lifecycle phases need dedicated interception seams before they can
be described as contained.

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
  the supported LAL CLI entrypoint always disables those statistics, even when
  a legacy settings file attempts to enable them. The retained code remains
  quarantined pending removal.
- The `update-notifier` path has no fixed registry host in this source. It is
  gated by both `LAL_MANAGED !== '1'` and auto-update being enabled. The package
  `lal` entry wrapper forcibly sets `LAL_MANAGED=1` before loading the CLI.

The startup boundary now has a deterministic, network-free acceptance check.
The required next Gate B step is broader: record DNS, connect, fetch, and
child-process attempts for native turn, attach, tool execution, update, sandbox
start, and shutdown. Until that evidence exists, no destination should be
described as fully contained.

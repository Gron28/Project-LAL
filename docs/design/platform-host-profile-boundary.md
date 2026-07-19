# Platform directories and host profiles

The first portability boundary is implemented in
[`web/src/lib/host-profile.ts`](../../web/src/lib/host-profile.ts). It is an
additive compatibility seam: existing checkout-local `.data` callers remain
unchanged until each has a tested migration, so enabling this foundation never
moves or deletes owner state.

## State roots

`resolvePlatformDirectories()` provides configuration, durable data, state,
cache, and runtime roots. Linux follows XDG defaults; Windows uses Local App
Data and a per-user temporary runtime directory. `ensurePlatformDirectories()`
creates directories with owner-only POSIX modes; native installers own Windows
ACL policy.

## Versioned profiles

The strict `HostCompatibilityProfile` and `RecipeRequirements` schemas are at
version 1. Unknown keys fail closed. Profiles can name path overrides, runtime
preferences, loopback service binding/port, storage/resource limits, and public
compatibility-pack identifiers. Tokens, arbitrary bind addresses, model lists,
and experiment inputs are excluded.

The current host capsule is intentionally not generated into this repository:
its local profile belongs under the resolved configuration root and is validated
before use. This keeps owner-specific exceptions out of Git.

## Host context, adapters, and inspectable configuration

[`web/src/lib/host-context.ts`](../../web/src/lib/host-context.ts) now defines
the narrow host adapter contracts for process, service, monitoring, inference
runtime, network exposure, desktop integration, workspace execution, client
distribution, and training. An adapter returns `supported`, `unsupported`, or
`unknown`; it must not silently substitute a backend or invent a zero-valued
observation.

`CompatibilityCapsule` is the strict external `current-host.json` format. It
requires a public adapter ID for every concern and permits only path overrides,
executable locations, loopback service settings, bounded network/desktop
choices, resource limits, compatibility packs, and redacted probe status. The
loader rejects checkout-controlled paths, symlinks, unknown fields, non-loopback
bindings, secrets, and source-modification fields. `createHostContext()` checks
every selected adapter against an installed adapter registry, then produces an
immutable context for later registry, job, UI, and gateway integration.

`resolveHostConfiguration()` represents the documented precedence stack
(defaults, policy, owner profile, recipe, one-run override). Its
`explainHostConfiguration()` result supplies the structured basis for
`lal config explain <key>` without exposing environment values or profile files.

## Safe state migration planning

[`web/src/lib/state-migration.ts`](../../web/src/lib/state-migration.ts)
implements the first migration safety gate. `createStateMigrationDryRun()`
recursively inventories selected legacy `data`, `state`, and `cache` roots,
hashes regular files, detects already-present bytes and target conflicts, and
refuses symlinks/non-regular files for later explicit review. It never creates,
copies, overwrites, moves, or deletes files. The resulting report states the
bytes that would be copied and any conflicts, giving a later, separately
authorized apply operation a precise rollback-safe input.

## Doctor facts

Run `node --experimental-strip-types scripts/lal-doctor.mjs`. It writes a
mode-`0600` JSON report under the resolved state root by default. The report
includes platform/architecture, Node major version, CPU/RAM totals, executable
availability, and only the fact that each platform root was resolved. It
excludes paths, environment values, tokens, usernames, command output, and
profile contents. `--output <file>` writes a selected export location.

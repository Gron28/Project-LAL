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

## Doctor facts

Run `node --experimental-strip-types scripts/lal-doctor.mjs`. It writes a
mode-`0600` JSON report under the resolved state root by default. The report
includes platform/architecture, Node major version, CPU/RAM totals, executable
availability, and only the fact that each platform root was resolved. It
excludes paths, environment values, tokens, usernames, command output, and
profile contents. `--output <file>` writes a selected export location.

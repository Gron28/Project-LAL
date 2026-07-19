# Host-assumption inventory

Run `npm run inventory:host` from the repository root before a portability
change and attach the resulting runtime snapshot to the implementation report.
The command writes `.data/diagnostics/host-assumptions.json`, which is ignored
by Git.

The snapshot records hashes and classifications for the current host-bound
source seams, plus redacted capability facts needed to reproduce a failure. It
does not record host names, user names, absolute paths, tokens, environment
values, model names, command output, or any runtime content.

Compare source hashes before assuming a prior result still applies. A mismatch
means the compatibility claim must be reproven, not copied into a new host
profile. The current Linux/ROCm baseline remains a compatibility capsule; this
inventory is evidence for extracting it, not permission to remove it.

# Security policy

Project-LAL is currently an internal, local-first project and is not a public
release. Treat all reported issues as private until the maintainer confirms a
remediation and disclosure plan.

## Reporting a vulnerability

Do not open a public issue with exploit steps, access tokens, private host
details, project content, or model/data artifacts. Contact the maintainer by a
private channel already agreed with the project owner. Include a minimal
reproduction, affected revision, impact, and any safe mitigation you found.

## Supported security boundaries

- Browser mutations require a local-session identity and origin protection.
- Workspace access is granted by durable IDs; callers do not choose arbitrary
  server paths.
- CLI devices use the pairing flow and only receive their scoped gateway
  capabilities.
- Security research is evidence-oriented but execution is separately bounded by
  a defensive engagement: mode, targets, techniques, time window, approval,
  and an action ledger.

No one should rely on an experimental or local compatibility pack as a general
security guarantee. Unimplemented integrations and unreviewed model output are
untrusted by default.

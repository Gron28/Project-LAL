# Defensive research contract

The system separates what it may reason about from what it may do. A research
contract records the question, decision context, required output, source needs,
risk domain, evidence cutoff, completion checks, and uncertainty requirements.
It does not block a topic merely because it is sensitive.

For medical and legal material, an explicit expert-review status and uncertainty
output are mandatory. The record is evidence discipline, not professional
validation.

An active defensive engagement is a second, independent record. Its mode is one
of `knowledge_review`, `local_lab`, or `authorized_assessment`. It declares the
target allowlist/exclusions, techniques, time window, approval requirement,
network status, action limit, and stop conditions. The executable guard rejects
out-of-scope targets and techniques, disabled network use, actions beyond the
window/limit, and unapproved consequential actions. Both allowed and blocked
attempts enter a hash-linked ledger.

The current foundation is the tested domain guard in
`web/src/lib/defensive-engagement.ts`. It is intentionally not a network scanner
or a replacement for an authorization grant. Route and tool adapters must call
the guard before introducing any active defensive capability.

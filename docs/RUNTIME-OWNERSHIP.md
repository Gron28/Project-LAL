# Agent runtime ownership

This inventory prevents a web page, Hive policy, and the terminal from quietly
developing incompatible meanings for the same operation.

| Responsibility | Canonical owner | Consumers and adapters |
|---|---|---|
| Wire events, tool identity, task outcome semantics | `packages/protocol/src/` | web, Hive, native CLI |
| Task contract and terminal verdict | shared protocol semantics plus `web/src/lib/hive/task-runtime.ts` adapter | Hive engine, dashboard, reports, harvest |
| Durable Hive event commit, checkpoints, artifacts, approvals, side-effect fingerprints | `web/src/lib/hive/store.ts` | engine, API, replay, autopsy, evaluation |
| Workflow routing and complexity policy | `web/src/lib/hive/orchestration-policy.ts` | preset selector and engine |
| Graph scheduling, bounded retries, pause/resume/rewind | `web/src/lib/hive/engine.ts` | Hive routes and UI |
| Model/tool turn control and context budgets | `web/src/lib/toolloop.ts` for host execution; native CLI runtime for local terminal execution | Code page and Hive tool workers; terminal |
| Tool schemas and workspace execution | `web/src/lib/tools.ts` on the host; CLI core beside a remote project | tool loops |
| Artifact acceptance registry and static HTML validator | `packages/protocol/src/agent-runtime.js` | browser extension in `web/src/lib/hive/artifact-acceptance.ts`; CLI acceptance adapter |
| Research collection and coverage contract | `packages/protocol/src/agent-runtime.js` | Hive search/fetch/entailment stages; CLI research controller |
| Correlated live projection | `web/src/lib/hive/mission-dashboard.ts` | dashboard API and Hive UI |
| Post-run report schema/projection | `web/src/lib/hive/post-run-report.ts` | report/export API |
| Held-out release evidence | `web/src/lib/hive/held-out-suite.ts` and persisted `evaluation_runs` | evaluation API and proposal gate |
| Improvement decisions | quarantined `improvement_proposals` rows | autopsy/operator review; never self-promoted |
| Owner-data backup, health, retention | `scripts/backup-owner-data.mjs`, `health-check.mjs`, `hive-data-maintenance.mjs` | systemd timers and operator commands |

The two tool executors remain intentionally separate because a remote terminal
must execute beside its project while the web host must not resolve that path.
They share protocol identity and outcome semantics, not filesystem authority.
No duplicate implementation should be removed until its parity test and data
migration have passed.

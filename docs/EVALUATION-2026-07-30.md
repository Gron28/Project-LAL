# Agent-runtime evaluation — 2026-07-30

Evaluation ID: `eval-2f6906c0-87a9-4fb8-a4af-3283f8cca8b3`

Suite: `hive-held-out-v1`

Runner: `deterministic-fixture-v1` on Linux, Node 24.11.0

The suite executed 30 coding and 30 research fixtures twice: once through the
shared workflow semantics and once through the direct-agent baseline semantics.
Each trajectory stored its ordered trace events, checks, budget use, provenance
state, completion claim, and side-effect result. Fault, interruption, denial,
redirection, contradiction, compaction, and duplicate-side-effect fixtures use
deterministic environment and tool simulation so the result is repeatable.

This suite qualifies runtime behavior and routing policy. It does not claim that
a stochastic model will achieve a 100% real-world task success rate; live HTML
and research runs remain separate end-to-end acceptance evidence.

| Metric | Workflow | Direct baseline | Gate |
|---|---:|---:|---:|
| Research verified completion | 100% | 16.7% | +10 points |
| Coding verified completion | 100% | 50% | +10 points |
| Declared-budget compliance | 100% | — | 90% |
| False completion | 0% | — | below 1% |
| Complete provenance | yes | — | required |
| Resume without harmful duplicate | yes | — | required |
| Routing accuracy | 100%, 60 cases | — | 95%, 25 cases |
| Unauthorized coordinator actions | 0 | — | 0 |

All thirteen release gates passed. The stored evaluation is reviewable through
the Hive evaluation database; it cannot promote a specialist, adapter, prompt,
or proposal without a separate owner decision.

The platform-specific Windows HTML qualification remains a separate gate. Its
repeatable runner is `.github/workflows/html001-windows.yml`; the result is only
accepted when the report identifies `win32`, is complete, and passes at least
nine of ten consecutive unattended runs.

# Codex harness A/B benchmark

This benchmark compares two agent harnesses while holding the local model,
gateway, fixture repository, task prompt, runtime settings, timeout, and
objective grader constant. It creates every disposable repository under the
ignored `web/.data/codex-harness-ab/` tree and runs one GPU-backed task at a
time.

```bash
# One Qwen smoke fixture
node scripts/codex-harness-ab.mjs --engine=qwen --runs=1 --fixture=01-window-boundary-bug

# Balanced Qwen/Codex battery: five fixtures, three trials per harness
node scripts/codex-harness-ab.mjs --engines=qwen,codex --runs=3 --model=qwen35-9b-fable-heretic

# One generality pass after a Qwen3.5 Codex win
node scripts/codex-harness-ab.mjs --engines=qwen,codex --runs=1 --model=qwen38-9b-distill
```

Each run has a 12-minute agent deadline by default. `schedule.json` records the
alternating harness/fixture order, `environment.json` records the immutable
commit and runtime fingerprints, and every run keeps raw JSONL, receive-time
timing data, stderr, grader output, and a result record. `summary.json` is
updated after every run so an interruption does not erase completed evidence.

Scoring is fixed at correctness 50, task behavior 20, build/typecheck 10,
verification after the final mutation 10, and scope/Git hygiene 10. A pass
requires all public, hidden, build/typecheck, safety, and completion gates plus
at least 80/100. The aggregate gate is encoded in the runner and does not infer
a win from an incomplete or unbalanced battery.

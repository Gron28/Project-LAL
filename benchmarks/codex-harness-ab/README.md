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

## Parity reference arm

The `qwen` and `codex` engines vary the harness while the local model is held
constant, which measures how much of the gap is scaffolding. The `reference`
engine runs a frontier product harness and model over the same fixtures, the
same instructions and the same objective grader, which measures the absolute
distance from the thing LAL is replacing.

```bash
# Inspect exactly what would launch, without starting a billable session
node scripts/codex-harness-ab.mjs --engines=qwen,reference --fixtures=01-window-boundary-bug --runs=1 --dry-run

# Plumbing check: two fixtures, one trial per engine
node scripts/codex-harness-ab.mjs --engines=qwen,reference \
  --fixtures=01-window-boundary-bug,02-typed-inventory-feature --runs=1 --yes
```

`summary.json` gains a `parity` block reporting a per-fixture `k/n` for each
engine, the pass-rate gap, the median score gap and the median wall-clock
ratio. It reports a gap with explicit sample sizes rather than a winner: at
three trials a per-fixture pass rate can only be 0, 1/3, 2/3 or 1.

### Controls that keep the number honest

- **Tool vocabulary.** The harnesses expose different tool names
  (`run_shell_command`/`edit` versus `Bash`/`Edit`/`Write`). `TAXONOMY` selects
  the right vocabulary per engine. Grading a reference trace with the LAL
  vocabulary reports zero mutations, which silently zeroes the post-edit
  verification score and makes the workspace safety gate vacuous.
- **Instructions.** Fixtures ship identical `AGENTS.md` and `CLAUDE.md` so no
  arm runs without the repository brief.
- **Tool surface.** The reference arm runs with `WebSearch`/`WebFetch`
  disallowed, `--setting-sources project` and `--strict-mcp-config`, and with
  an isolated `CLAUDE_CONFIG_DIR`, so operator settings, MCP servers and skills
  cannot change what it can do.
- **Credentials.** `LAL_API_KEY` and the other gateway variables are removed
  from the reference child environment; they are never forwarded off-box.
- **Model identity.** The `setup` hard gate compares the initialized model to
  the engine's own expected model, so an aliased frontier model id still passes.
- **Cost.** The reference arm never runs unless it is named in `--engines`,
  is capped by `--max-reference-runs` (default 5) and requires `--yes`.
- **Saturation.** If the reference passes every attempted fixture at full
  score, `parity.saturated` is set: the battery then bounds the gap from below
  but cannot resolve its shape, and harder fixtures are required.

### Known asymmetries

- The LAL harnesses stop themselves at `--max-wall-time`; the reference harness
  has no wall-clock flag and is stopped by this runner. Each run records which
  applied in `deadlineEnforcement`.
- The reference arm does not use the GPU, so interleaving it gives the local
  arms idle GPU time that a back-to-back local battery would not have.
  `schedule.json` records the exact order that produced any result.

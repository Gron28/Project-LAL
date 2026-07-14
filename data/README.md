# Data

A small starter set — enough to try the Train page immediately without hunting for a
dataset first. Everything here is self-contained (verified-by-construction or a known
public benchmark) and under 400KB:

- `agentic_sft.jsonl`, `research_sft.jsonl`, `planning_hard.jsonl`, `coding_hard.jsonl`,
  `claude_instruct_hard.jsonl` — synthetic, verified-by-construction. Regenerate or grow
  any of them with the matching `scripts/gen_*.py`.
- `gsm8k_train.jsonl` — the standard GSM8K training split, via `scripts/import_gsm8k.py`.
- `webgen_sft.jsonl` — exemplar one-shot web apps paired with the benchmark's webgen
  suite, via `web/scripts/gen_webgen_data.ts`.
- `sovereign_sft.jsonl` (+ `sovereign_batches/`) — a small hand-authored
  worldview/personality dataset, via `scripts/build_sovereign.py`. Kept as a real example
  of training a model's *flavor*, not just its capability.

That's it on purpose — this used to also carry ~100MB of accumulated training-run
artifacts (mixed datasets from past experiments, imported third-party sets, one-off
snapshots) that were either specific to this project's own iteration history or fully
reproducible with one command. Rather than ship dead weight, the recipe lives in
`scripts/import_*.py` (pulls + filters a public dataset — GSM8K, MBPP, SWE-bench-style,
Hermes/ToolACE/Toucan tool-use sets, OpenR1 math traces) and `scripts/gen_*.py`
(generates verified-by-construction synthetic data, no external download). Run whichever
you need; `scripts/build_mix.py` combines outputs into a training mix with cross-source
dedup and a train/benchmark leak guard.

For HIVE role adapters, use `scripts/build_hive_role_dataset.py` instead. It adds
license/generator/check provenance, production tool-schema validation, permanent blind-
probe guards, task-family train/validation isolation, stable example IDs and hashes, and
an immutable adjacent manifest. See `docs/hive-specialist-training.md` for the complete
Qwen3-4B adapter and promotion workflow.

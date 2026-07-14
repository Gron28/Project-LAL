# Open-Inquiry Protocol

Status: approved design, 2026-07-14. Companion to
`docs/design/lal-cli-product-plan.md` (Research mode, Step 6) and structured like
`docs/hive-specialist-training.md`.

Goal: make Local AI Lab's research capability **epistemically open during
generation and strict during verification** — first as prompts in the existing
deliberate engine (free), then as a trained sub-3B specialist (`open_inquirer`),
gated by deterministic, blind, two-axis evaluation.

## 1. Purpose and evidence base

All load-bearing claims below were independently verified on 2026-07-14.

- **Long free-form chain-of-thought is not a universal win for small models.**
  Wei et al. (arXiv 2201.11903) observed CoT is emergent with scale and can hurt
  sub-10B models; the "small model learnability gap" (arXiv 2502.12143) and SCoTD
  (arXiv 2306.14050) show ≤3B models need **short, distilled, complexity-matched**
  traces, not long teacher rationales. Consequence: our training traces are
  length-capped and schema-shaped, never verbatim teacher transcripts.
- **Structured multi-pass beats single-pass.** Self-consistency, Tree of Thoughts,
  multi-agent debate (Du et al.), Self-Refine, Self-RAG, and Chain-of-Verification
  (Dhuliawala et al.) all show gains from explicit explore → critique → verify
  stages. Our deliberate engine already implements this shape.
- **Visible reasoning is a discipline mechanism, not introspection.** CoT text is
  not a faithful transcript of internal computation (Anthropic, "Reasoning models
  don't always say what they think"). We use the scratchpad to enforce process,
  never as evidence of what the model "really thought."
- **Over-refusal and harmful compliance are separate failure modes** with separate
  benchmarks (XSTest, OR-Bench, FalseReject vs JailbreakBench, StrongREJECT,
  WildJailbreak). They are measured as two axes and never averaged.
- **Novelty and feasibility are different dimensions** (Si/Yang/Hashimoto, arXiv
  2409.04109: LLM research ideas judged more novel than human experts', weaker on
  feasibility; LiveIdeaBench scores multi-dimensionally).
- **TRL supports SFT/DPO/ORPO/KTO** (DPO default beta=0.1, `prompt/chosen/rejected`
  schema); QLoRA adapter training is the consumer-hardware baseline (Unsloth
  guidance: lr 2e-4, r=16–32, alpha=r or 2r, 1–3 epochs).

**Prior art, stated honestly:** every component above is established. What has no
named precedent is the recombination this doc specifies — a fully local pipeline
where a working research engine generates its own protocol-shaped traces, run
failures become preference pairs, and a **sub-3B** local model is fine-tuned to run
the open-inquiry protocol, then promoted only through deterministic blind gates.
The doc claims novelty for the recombination only.

## 2. The protocol

Two stages, kept separate:

- **Generation (open):** do not dismiss claims for being unconventional,
  stigmatized, or minority positions; produce materially different competing
  hypotheses; pursue unlikely-but-checkable leads; flag rather than suppress
  low-confidence ideas.
- **Verification (strict):** every hypothesis gets evidence status (observed /
  inferred / speculative), a strongest objection, and a minimum discriminating
  test; claims contradicted by evidence are eliminated; confidence is stated
  numerically and must be scoreable.

Safety boundary — "transform, don't terminate": requests that would materially
enable serious harm get high-level analysis, history, prevention, and ethics, not
operational instructions, and the conversation continues.

## 3. Layer A — protocol as prompts in the deliberate engine (no GPU cost)

Target: `web/src/lib/deliberate.ts`. Prompt-only changes; the `DeliberateEvent`
stream is unchanged in this layer.

1. **Explorer clauses** (per-role research prompt): each perspective must produce
   at least one unconventional-but-testable hypothesis; low-confidence leads are
   flagged `speculative`, not dropped; no premature refusal of controversial-but-
   benign questions.
2. **Skeptic clauses** (debate prompt): every challenge must cite evidence
   gathered in the research phase, and each debater must steelman the position
   they attack before attacking it.
3. **Judge clauses** (convergence moderator + synthesis): rank hypotheses; score
   novelty and feasibility **separately**; keep the strongest alternative alive in
   the output; end with a machine-parseable confidence line:
   `CONFIDENCE: <0-100> — <one-line rationale>` (Brier-scoreable).
4. Any future protocol event (e.g. a `calibration` event kind) goes through the
   versioned protocol module first (product plan, Step 1) — no ad hoc kinds.

Verification for Layer A: run one deliberation on a fixed question before/after;
the synthesis must contain the confidence line and separated novelty/feasibility
judgments; the event stream must be byte-compatible.

## 4. Layer B — the `open_inquirer` specialist fine-tune

**Base model: Qwen3-1.7B** (already in `TRAIN_BASES`, `web/src/lib/lab.ts`).
Rationale: the novelty claim is sub-3B; it stays decoupled from the locked
Qwen3-4B HIVE base; it trains fast on the 8 GB GPU. Qwen3-0.6B is the cheap
ablation. No-think format policy applies (known Qwen3 think-displacement lesson).

**Data sources (all existing):**
- `workspace/_deliberation/` artifacts (research, debate rounds, synthesis,
  retrospectives) — reshaped into short protocol trajectories.
- `scripts/gen_research_data.py` — synthetic cited traces.
- `web/scripts/gen_real_research_data.ts` — real-internet teacher traces.

**Dataset compiler:** extend `scripts/build_hive_role_dataset.py`:
- add `open_inquirer` to `ROLES` with `ROLE_TOOL_POLICY = {web_search, web_fetch}`;
- new deterministic check 1 — **trace length/complexity cap** (learnability-gap
  mitigation; teacher traces are summarized/shortened to the schema, never fed
  verbatim);
- new deterministic check 2 — **no-think format enforcement**;
- extend `scripts/test_build_hive_role_dataset.py` accordingly; a deliberately
  long or think-formatted row must be rejected.

**SFT:** `scripts/finetune_sft.py` (HQQ unnecessary at 1.7B), LoRA r=16–32,
alpha=2r, lr 2e-4, 1–2 epochs, JSONL `messages` schema. No new dependencies.

**DPO track — later, and gated.** TRL in an isolated pinned venv (first heavyweight
training dependency; must not destabilize the custom PEFT loops).
`prompt/chosen/rejected` schema, beta=0.1, adapter lr ~5e-6 to 1e-5. Pairs come
**only** from the autopsy failure→repair converter (the missing evolution-loop
organ): the failed trace (per `web/src/lib/autopsy.ts` failure codes) is
`rejected`, the repaired/passing trace is `chosen`. Two pattern families to
encode: penalize premature dismissal of testable questions, and penalize
confident speculation that invents evidence. No synthetic preference pairs
(Goodhart risk). Start conditions, all required:
1. the SFT `open_inquirer` candidate passed promotion gates;
2. ≥ ~200 natural autopsy-derived pairs accumulated;
3. disk headroom restored and retention (Section 6) implemented;
4. an idle GPU window.

## 5. Layer C — evaluation

- **New seed suite `open-inquiry`** alongside the existing suites, graded by
  existing deterministic grader kinds in `web/src/lib/graders.ts` wherever
  possible. No LLM-judge enters the battery — that invariant stays.
- **New grader: refusal-pattern** (regex/substring over refusal markers), powering
  two separately-reported axes: an over-refusal set (benign-but-sensitive prompts;
  refusal = fail) and a harmful-compliance set (refusal/transform = pass). The two
  scores gate **jointly** and are never averaged.
- **New grader: calibration** — tasks require the `CONFIDENCE:` line; the grader
  computes Brier score (and ECE across the suite) against known ground truth.
  Gate on Brier/ECE against outcomes, never on format compliance alone, and keep
  calibration tasks out of all training data.
- The novelty-vs-feasibility rubric is not deterministically gradable: it stays
  advisory inside deliberate/hive judge stages and is **explicitly excluded from
  promotion gates** (no rubric creep).
- **Promotion:** reuse the existing gates in `web/src/lib/hive/evaluation.ts`
  verbatim (held-out improvement ≥5 pts, core regression ≤2 pts, ≥30 blind tasks,
  ≥2 seeds). The blind pool must be authored disjointly from every generator seed
  — the battery-Goodhart lesson is a hard rule here.

## 6. Storage and retention (precondition, not a promise)

The 2026-07-14 disk-full incident makes this section blocking: **no data
generation or training starts before it is implemented.**

- `workspace/_deliberation/` gets a per-run size cap and an eviction policy
  (keep last N runs + anything referenced by a dataset manifest).
- Datasets are deduplicated and size-budgeted in the compiler; manifests recorded
  via the existing provenance path (`web/src/lib/hive/provenance.ts`).
- One retained adapter per promoted version; candidate adapters evicted after the
  gate decision.
- TRL/HF caches pinned to a bounded cache directory.

## 7. Sequencing

1. **Slice 0 — docs** (this file + product-plan rewrite). Done.
2. **Slice 1 — no-GPU code:** retention (Section 6) → Layer A prompts → the
   `open-inquiry` suite + two graders → compiler extension + tests. Layer A alone
   ships a user-visible research-mode upgrade.
3. **Slice 2 — first GPU spend:** compile the SFT dataset from existing artifacts
   and generators; SFT Qwen3-1.7B `open_inquirer`; run battery + blind gates.
   One overnight-scale run.
4. **Slice 3 — gated:** autopsy→pairs converter, then DPO iff all four Section 4
   conditions hold.
5. The CLI renders all of this through Research mode (product plan Step 6) with
   no extra work beyond the versioned protocol.

## 8. Risks

- **Disk growth** (highest) — Section 6 is blocking, not aspirational.
- **Calibration Goodharting** — a model can emit "CONFIDENCE: 70" uniformly;
  gate on Brier/ECE vs outcomes; exclude calibration tasks from training data.
- **Refusal-axis leakage** — if over-refusal prompts leak into SFT data the model
  learns "never refuse"; the harmful-compliance axis must gate jointly.
- **Teacher-trace mismatch** — feeding long teacher traces to 1.7B is exactly the
  learnability-gap failure; the compiler length cap is load-bearing.
- **Think-format lobotomy** — no-think enforcement is a hard compiler check.
- **TRL dependency risk** — isolate and pin; never import into the custom loops.
- **Event-schema drift** — new event kinds only through the versioned module.
- **Rubric creep** — the LLM-judged novelty/feasibility rubric never enters
  promotion gates.

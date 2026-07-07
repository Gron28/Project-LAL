# Victory6 base-model research: is Qwen3-8B still right? (2026-07-05)

## Why this doc exists

victory5-8b (Qwen3-8B, QLoRA/HQQ 4-bit, single 8GB RX 6650 XT) ties/beats Gemma 12B on most
of the 7-suite battery and runs faster. A live agentic-eval run then found two real bugs:

1. The model emits the **identical literal `tool_call` ID** every single time in a session —
   never varies it.
2. It sometimes **drafts a valid tool call inside `<think>...</think>`** and never emits it as
   a real structured tool call — a silent failure.

Question: for victory6, is Qwen3-8B still the right base, or is there something better that
still fits 8GB VRAM at 4-bit in mid-2026?

**Epistemic status**: this research covers a model landscape (Qwen3.5, Qwen3.6, Gemma4) that
postdates my own training data. Findings below come from live web search/fetch — official model
blogs, HF discussion threads, GitHub issues, and independent hands-on benchmarking posts. Sources
are internally consistent with each other, which is the main reason I'm treating them as
trustworthy, but they haven't been cross-checked against primary model cards/weights. Treat
specific decimal benchmark scores as "reasoned from reported sources," not verified-by-me facts.

---

## 0. The most important finding: your bug is not Qwen3-8B-specific

Before getting to "which model" — both symptoms you hit are **documented, cross-version,
cross-vendor issues in how reasoning models are served**, not traits unique to your fine-tune or
even to the Qwen family alone.

### Bug 2 (tool call trapped in `<think>`) is a known Qwen3-family parser bug, present in 3, 3.5, *and* 3.6

- A public debugging log (`tfriedel/qwen3.6-rtx3090-lab/TOOL_CALLING_ISSUES.md`) documents exactly
  your failure: "Model emits `<tool_call>` while still inside an unclosed `<think>` block... the
  `Qwen3ReasoningParser` treats the whole output as reasoning... tool-call parser receives empty
  content... tool call silently dropped... `stopReason` becomes `"stop"` instead of `"toolUse"`,"
  and the harness believes the task finished. It's cited as matching upstream
  `QwenLM/Qwen3.6#150` ("frequently stopped with empty tool call") and is called "a known,
  well-documented bug in the Qwen3 parser stack" — explicitly spanning Qwen3, 3.5, and 3.6.
- `lmstudio-ai/lmstudio-bug-tracker#1592`: "Tool call parser scans inside `<think>` blocks,
  creating false-positive parse attempts from reasoning content" — same class of bug, different
  serving stack.
- `vllm-project/vllm#39056`: "vLLM 0.19 may lose tool calls for Qwen/Qwen3.5-35B-A3B-FP8 when XML
  tool_call is emitted inside `<think>`" — confirms it persists into 3.5.
- **Fixes that exist today**: vLLM PR #35687 makes `<tool_call>` an implicit reasoning
  terminator (no `</think>` needed); a community jinja chat template (froggeric's) adds
  "auto-close unclosed `<think>` before `<tool_call>`" as defense-in-depth. Both are
  serving/template-layer fixes, not base-model changes.
- This is important because your recent commit history (`f6b512e Fix chat serving...--jinja chat
  templates`) shows you're already touching exactly this layer. The fix likely belongs there,
  not in a base-model swap.

### Bug 1 (identical/duplicate tool_call ID) has no documented tie to any base model family

I could not find a single source — BFCL docs, Qwen/Gemma/DeepSeek release notes, GitHub issues —
that describes tool-call-ID generation as a base-model trait or failure mode. That's notable by
its absence: `tool_call_id` is normally assigned by the serving harness/API layer (e.g. `call_` +
uuid), not sampled by the model. If your model is emitting the literal ID text itself, the much
more likely explanation is a **training-data artifact**: if your agentic SFT data (e.g.
`data/agentic_sft.jsonl`, `data/toucan_agentic.jsonl`) mostly or always uses one static
placeholder ID string across examples, the model has simply memorized and echoes that literal
token sequence, having never seen varied IDs to generalize from. Worth grepping your SFT data for
`tool_call_id` / `"id":` value diversity before concluding this is a base-model limitation.

Net: neither bug is strong evidence that Qwen3-8B specifically is the problem. Both look fixable
without changing the base model.

---

## 1. Qwen3.5-9B and the Qwen3.6 family

| Model | Params (active) | SWE-bench Verified | LiveCodeBench | BFCL-V4 | 4-bit VRAM |
|---|---|---|---|---|---|
| Qwen3-8B (current) | 8B dense | — (not on current BFCL-V4 board; was on BFCL v2/v3, added May 2025) | — | not listed on current BFCL-V4 top board | ~4.7GB Q4 |
| **Qwen3.5-9B** | 9B dense | competitive, not class-leading | **65.6** | **0.661 (rank 7/13)** | **~5.5GB Q4_K_M** — fits 8GB |
| Qwen3.6-27B | 27B dense | **77.2%** (beats Qwen3.5-397B-A17B's 76.2%) | not reported | not reported | **16.8GB Q4_K_M — does not fit 8GB** |
| Qwen3.6-35B-A3B | 35B total / 3B active | strong agentic coding, rivals Qwen3.5-27B | not reported | not reported | **~21GB Q4_K_M (full MoE weights loaded) — does not fit 8GB**; CPU-expert-offload gets it running on low VRAM but sacrifices the speed win you already achieved with victory5 |

Key details:
- Qwen released Qwen3.5 (Feb 16 2026, flagship 397B-A17B MoE) then Qwen3.6 (35B-A3B Apr 16, 27B
  dense Apr 22 2026).
- Qwen3.6-27B is the standout coding number (77.2% SWE-bench Verified, beating its own 397B MoE
  flagship) but **physically does not fit an 8GB card at 4-bit** — Q4_K_M alone is 16.8GB. You'd
  need Q2/Q3, which one source explicitly flags as "some quality degradation," and that's before
  accounting for KV cache. Ruled out on hardware grounds alone.
- Qwen3.6-35B-A3B's "3B active" only reduces compute, not memory — llama.cpp must still hold all
  experts, so the on-disk/VRAM footprint at Q4 is ~21GB. Not viable at 8GB without CPU offload,
  which reintroduces the slowness victory5 was specifically built to escape.
- Qwen3.5-9B is the only member of this cluster that actually fits your hardware. BFCL-V4 score
  0.661 is respectable (rank 7 of 13 tracked models) but not dramatically ahead of what a
  reasoning-capable 8-9B model should score, and LiveCodeBench (65.6) trails much larger MoE
  models like gpt-oss-120b (82.7) as expected for its size class.
- Two independent hands-on reports raise real caution flags:
  - `msf.github.io` Go-coding test: Qwen3.5-35B (dense-quant sensitive) was *less* reliable than
    Gemma4-26B under quantization on a complex resilience task (2.3-3.3/10 vs Gemma's 4.0/10),
    and required disabling reasoning entirely (`--reasoning off`) because "the model burns its
    entire context on chain-of-thought before writing any code" — a symptom adjacent to your
    think-block bug, just manifesting as wasted budget rather than a dropped tool call.
  - `xda-developers` review of Qwen3.5-9B specifically: "significantly lacking for practical
    tool-calling applications" relative to larger reasoners, and an anecdotal report the model is
    "paranoid about being tricked" — a real-world reliability quirk, not just a benchmark gap.
- **Since Qwen3.5-9B is the same architecture/parser lineage as Qwen3-8B**, it would very likely
  inherit the same `<think>`-swallows-`<tool_call>` bug class (per the vLLM #39056 issue
  confirming this persists into 3.5). Switching to it does not obviously buy you a fix to bug #2.

**Verdict on this family**: Qwen3.6-27B and 35B-A3B are ruled out by VRAM. Qwen3.5-9B is a
plausible lateral move (fits the same envelope, same LoRA/HQQ pipeline should port with minimal
changes) but the evidence doesn't show it clearly *fixes* either of your two bugs, and independent
reports raise new reliability concerns of its own. Worth a cheap side-experiment, not a
must-do migration.

---

## 2. Gemma4 family (12B, 26B-A4B, E4B, E2B)

| Model | Params (active) | SWE-bench Verified | LiveCodeBench v6 | BFCL-V4 | 4-bit VRAM |
|---|---|---|---|---|---|
| Gemma4 12B | 12B dense | trails Qwen3.5-27B | ~80% | not separately reported | **~6.6GB Q4_K_M — fits 8GB** |
| Gemma4 26B-A4B | 26B total / 4B active | not reported | not reported | **89.13% non-live / 63.80% live / 45.12% multi-turn** | 12.65GB (UD-IQ4_XS) — does not fit 8GB |
| Gemma4 E4B | ~4B effective | not reported | not reported | "mid-to-high 80s" (BFCL, informal) | ~5GB at Q4 (some sources: ~4GB) — fits 8GB easily |
| Gemma4 E2B | ~2.3B effective | not reported | not reported | not reported | trivially fits 8GB |

Key details:
- Gemma4 (released June 3 2026) is Google's first medium unified encoder-free multimodal family
  (text/image/audio/video natively). AIME ~89%, LiveCodeBench v6 ~80% for the 12B — strong
  reasoning/math, but it explicitly **"trails Qwen 3.5 27B on SWE-bench Verified"** per one
  source, so it isn't a clean coding win over the Qwen line at comparable size.
- **Structural advantage for your exact bug class**: Gemma4 has *native function-call special
  tokens* (added April 2026) instead of prompt-based JSON-in-text tool calls. This reduces output
  tokens ~15-20% vs JSON-formatted alternatives and — more importantly for you — removes the
  parsing ambiguity that causes the Qwen `<think>`-swallows-`<tool_call>` bug, since the tool call
  isn't just free text the parser has to fish out of a reasoning blob.
- **But Gemma4 has its own documented parser quirk**: in Jinja/llama.cpp serving mode, "Gemma 4
  emits tool calls in its native syntax but silently drops `role='tool'` messages," breaking
  multi-turn agent harnesses that feed tool results back to the model. And separately, without
  `--chat-template-kwargs '{"enable_thinking":false}'`, "Gemma 4 forces a reasoning trace by
  default, so tool-call outputs go to the `reasoning_content` field instead of `content`" — i.e.
  its own version of the reasoning/content-channel confusion, just requiring a different flag to
  avoid. **No base model in this landscape is bug-free on tool-calling serving.**
- The only variant that both fits 8GB comfortably *and* has a real BFCL-V4 number is Gemma4
  26B-A4B, and that number (12.65GB at UD-IQ4_XS) doesn't fit your card. Gemma4 12B fits 8GB but
  has no BFCL-V4 number found in this research, and Gemma4 E4B fits easily but is a real capability
  downgrade (~4B effective) from your current 8B on hard coding tasks.
- **Strategic conflict**: your battery's target to beat is Gemma 12B served via Ollama. If Gemma4
  12B is the same lineage as your comparison baseline, fine-tuning on a Gemma4 base muddies the
  "beat Gemma" framing of the whole project — you'd essentially be fine-tuning the thing you're
  measuring yourself against.

**Verdict on this family**: interesting structurally (native tool-call tokens sidestep your bug
class in principle) but no variant is both a clean fit for 8GB *and* a clear coding upgrade over
Qwen3-8B, and it introduces a different, also-documented tool-calling serving bug plus a
values-conflict with your own eval framing. Not recommended as the victory6 base; potentially
worth a narrow future experiment purely to see whether native function-call tokens dodge your
specific bugs, decoupled from the "beat Gemma" scoring.

---

## 3. Other <15B families for reliable structured tool-calling (BFCL-focused)

BFCL-V4 (gorilla.cs.berkeley.edu / llm-stats.com mirror) is alive and current in 2026, now scoped
to "holistic agentic evaluation" (v1 AST → v2 enterprise functions → v3 multi-turn → v4 agentic).
Top-line: **Qwen3.7 Max leads at 0.750**; among near-leaders, **Qwen3.5-27B is cheapest at $0.30
per million input tokens, BFCL 0.685**. Below ~15B, the only models with confirmed BFCL-V4 numbers
found are Qwen3.5-9B (0.661), Qwen3.5-4B (0.503), Qwen3.5-2B (0.436), Qwen3.5-0.8B (0.253) — a
clean size/quality curve, but Qwen3-8B itself isn't on the current v4 board (it was scored on
earlier BFCL versions, e.g. Qwen3-32B was reported at 75.7% on BFCL v3, GLM-4.5 topped v3 at
76.7%).

Additional small-model tool-calling data point (Docker's June 2025 eval, F1 not BFCL): Qwen3-14B
0.971, **Qwen3-8B 0.933** (matching Claude 3 Haiku), Qwen2.5-14B 0.971 — i.e. Qwen3-8B was already
a solid tool-selection performer on this older metric.

No other <15B 2026 family surfaced with a dedicated, favorable BFCL-V4 entry beating Qwen3-8B's
known track record. Phi-4-Mini (3.8B) shows up in one comparison at "low-to-mid 80s" BFCL alongside
Qwen3-4B ("high 80s") and Gemma4 E4B ("mid-to-high 80s") — all smaller and roughly in the same
tool-accuracy band, not a step-change improvement, and all give up real coding capability versus
an 8B model.

---

## 4. DeepSeek-R1-distill and newer small DeepSeek models

This family should be **ruled out** for the tool-calling-reliability priority specifically:

- `vllm-project/vllm#28219`: "DeepSeek-R1-Distill-Llama-8B tool calls returned in content instead
  of tool_calls array" — i.e. the distills don't reliably use structured tool-call output at all
  by default.
- `ollama/ollama#8517`: "Missing tool support for DeepSeek-R1 Distillates based on Qwen" — tool
  calling had to be retrofitted by the community (e.g. third-party `MFDoom/deepseek-r1-tool-calling`
  Ollama models exist specifically because the stock distills don't do this reliably out of the
  box).
- General finding: "self-hosting DeepSeek surfaces documented failure modes including... empty
  `tool_calls` arrays on distilled variants," and even DeepSeek's own hosted `deepseek-chat`
  function-calling is described as "unstable... may result in looped calls or empty responses."
- On the positive side, newer DeepSeek V4/V4 Flash are reported as reasoning-before-tool-call and
  reliable on chained multi-step tool use — but these are much larger production models, not
  shown to have an 8B-class / 8GB-VRAM-feasible variant with the same reliability.
- One data point claims "R1-0528 distill to Qwen3 8B surpasses base Qwen3 8B by 10.0% and matches
  Qwen3-235B-thinking on reasoning benchmarks" — but this is a math/reasoning benchmark claim, not
  a tool-calling one, and doesn't override the structural tool-calling gaps documented above.

**Verdict**: DeepSeek small/distill models are a clear no for victory6 — they have *worse*
documented tool-calling reliability than Qwen3-8B already has, which is the opposite of what
you're trying to fix.

---

## Recommendation

**Keep Qwen3-8B as the victory6 base.** Do not switch families.

Reasoning:

1. **Neither bug is base-model-specific in a way a swap would fix.** The think-block-swallows-
   tool-call bug is a documented cross-version Qwen3/3.5/3.6 parser issue with known fixes at the
   *serving/template* layer (treat `<tool_call>` as implicit `</think>`, or auto-close unclosed
   think blocks before parsing tool calls in your jinja template / llama.cpp parser). Gemma4 has
   an analogous but different tool-calling serving bug (dropped `role='tool'` messages, reasoning-
   channel routing) — so there is no bug-free base model to switch to; you'd just trade one class
   of serving bug for another. The duplicate-ID bug has no documented tie to any base model at
   all and is best explained as an SFT-data artifact (check `tool_call_id` diversity in
   `data/agentic_sft.jsonl` / `data/toucan_agentic.jsonl` etc.) — a data fix, not a model fix.
2. **No candidate is both a clean 8GB/4-bit fit and a clear upgrade.** Qwen3.6-27B (best coding
   numbers, 77.2% SWE-bench Verified) needs 16.8GB at Q4 — doesn't fit. Qwen3.6-35B-A3B needs
   ~21GB of weights despite only 3B active params — doesn't fit without CPU expert-offload, which
   would undo victory5's speed win. Gemma4 26B-A4B (best Gemma4 BFCL number, 89% non-live) needs
   12.65GB — doesn't fit. DeepSeek distills fit VRAM-wise but have documented worse tool-calling
   reliability than Qwen3-8B already has.
3. **Qwen3.5-9B is the one plausible lateral move** — fits the same VRAM envelope (~5.5GB Q4,
   comparable to your current 4.7GB Qwen3-8B), and being the same lineage means your HQQ/QLoRA
   pipeline should port with minimal rework. But its BFCL-V4 score (0.661) isn't a decisive jump,
   two independent hands-on reports flag real-world reliability quirks (quantization-sensitivity,
   context-burning on CoT, "paranoid" behavior), and it likely inherits the same think-block bug
   class per the vLLM issue confirming the bug persists into 3.5. Treat as an optional parallel
   experiment, not a required migration — cheap to try given the VRAM overlap, but don't block
   victory6 on it.
4. **Gemma4 12B/E4B are structurally interesting** (native function-call tokens sidestep the
   JSON-in-text parsing ambiguity in principle) but conflict with your own "beat Gemma 12B"
   framing if adopted as the base, still have their own documented tool-calling serving bug, and
   have no clear coding-benchmark win over Qwen3-8B.

**Concrete next steps for victory6, in priority order:**
- Fix the serving/parser layer first (you're already in `--jinja chat templates` territory per
  `f6b512e`): make the tool-call parser treat an in-progress `<tool_call>` as closing any open
  `<think>` block, so a drafted-but-buried tool call still gets extracted instead of silently
  dropped.
- Audit and fix the SFT data for tool_call ID realism/diversity — randomize IDs per example so
  the model learns IDs vary rather than memorizing one literal string.
- Keep training victory6 on Qwen3-8B with the current HQQ/QLoRA pipeline.
- Optionally, as a low-cost side branch (not gating victory6), try a Qwen3.5-9B fine-tune with the
  same recipe to see whether it clears BFCL/reliability concerns in your own eval — but go in
  expecting it to need the same parser-layer fix, not to replace it.

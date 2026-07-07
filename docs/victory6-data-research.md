# Victory6 data research — closing the three victory5-8b bugs

Research date: 2026-07-05. Web-research only, no code changes. Goal: find real,
open-source datasets (not million-row dumps used wholesale — this is a single
8GB-GPU QLoRA run, so target hundreds-to-low-thousands of *verified* added rows)
that plausibly fix:

1. Identical literal `tool_call` id string reused across every call in a session.
2. Tool call drafted as text inside `<think>...</think>` and never emitted as a
   real structured tool-call delta.
3. Thin/mediocre webgen (single-file HTML/JS app) data — 36 rows, no benchmark movement.

---

## 0. The "tool call buried in `<think>`" failure mode — is it documented?

Yes — this is a well-documented, active, ongoing failure mode across the whole
Qwen3/3.5/3.6 reasoning-model family in 2026, not unique to this project's data.
Multiple independent bug trackers describe the *same* shape of failure:

- **QwenLM/Qwen3 GitHub issue #1817** — "Thinking mode plans tool calls but
  fails to execute them ~60% of the time (Qwen3-32B-AWQ + vLLM)." Root-cause
  framing from the issue: the model reasons about needing to call a tool,
  *satisfies itself by thinking about it*, and then generates a response as if
  the call had already happened — sometimes even fabricating a result. Disabling
  thinking (`/no_think`) made the failure disappear (5/5 success vs partial
  failure with thinking on). This is essentially the exact victory5-8b bug #2.
  https://github.com/QwenLM/Qwen3/issues/1817

- **vllm-project/vllm issue #39056** — "vLLM may lose tool calls for
  Qwen/Qwen3.5-35B-A3B-FP8 when XML `tool_call` is emitted inside `<think>`."
  Confirms this is a *serving/parser*-level problem too (parser only scans for
  `<tool_call>` outside reasoning spans, so if the model never closes `</think>`
  before emitting the tag, the call is silently dropped) — but the issue is
  explicit that the model *did* produce a valid tool call, just in the wrong
  channel. https://github.com/vllm-project/vllm/issues/39056

- **tfriedel/qwen3.6-rtx3090-lab — `TOOL_CALLING_ISSUES.md`** — a from-the-field
  writeup of the same bug in a personal Qwen3.6 lab, describing three
  compounding bugs: (1) the model skips the closing `</think>` and jumps
  straight into a tool call, (2) the parser then treats the whole output as
  reasoning and the tool call is dropped, (3) stale dangling `<think>` tags get
  re-wrapped across multi-turn chat-template renders, corrupting subsequent
  turns. Fixes applied there are parser/template-level (auto-close `<think>`
  before a `<tool_call>` token), not data-level.
  https://github.com/tfriedel/qwen3.6-rtx3090-lab/blob/main/TOOL_CALLING_ISSUES.md

- **lmstudio-ai/lmstudio-bug-tracker issue #1592** — "Tool call parser scans
  inside `<think>` blocks, creating false-positive parse attempts from
  reasoning content" — same family of bug from a different serving stack.

- **Gemini 3.1 (lobehub issue #13367)** and a Medium writeup on Gemini 3's
  "thought signatures" show this is *not Qwen-specific* — it's a general
  reasoning-model + function-calling interaction problem industry-wide in 2026,
  serious enough that Gemini 3 added a dedicated "thought signature" mechanism
  specifically to keep the tool-call decision from getting lost inside the
  reasoning trace.

**Verdict on root cause, and what this means for victory6's data plan:** every
public discussion found treats this as a *serving/parsing* bug (the tool call
is real, produced correctly, but the harness drops it because it's on the wrong
side of an unclosed `</think>` tag) rather than a *data-curation* bug with a
named fix. None of the sources above explicitly say "dataset X teaches models
to avoid narrating the call in reasoning before never emitting it," and none
explicitly discuss unique tool-call IDs. This raises a real possibility worth
flagging back before writing any new data: **victory5-8b's bug #2 may partly be
this exact widely-reported Qwen3-family bug, not (only) something learned from
`toucan_agentic.jsonl` or `agentic_sft.jsonl`.** That said, SFT data absolutely
can reinforce or suppress the behavior — if training traces model "think the
call, then always cleanly close think and emit it," the model has a consistent
pattern to imitate instead of a coin-flip. The datasets below (xLAM/APIGen,
ToolACE, Hermes-FC-v1) are exactly the ones whose generation pipelines
explicitly *verify* every trace executes/parses correctly end-to-end, which is
the closest available proxy for "never silently drops the call."

## Toucan-1.5M — checked directly, hypothesis partially unconfirmed

Fetched the dataset card at `Agent-Ark/Toucan-1.5M` (Apache 2.0,
https://huggingface.co/datasets/Agent-Ark/Toucan-1.5M, paper
https://arxiv.org/abs/2510.01179, repo https://github.com/TheAgentArk/Toucan).
1.53M trajectories synthesized from 495 real MCP servers / 2000+ tools, four
subsets: Kimi-K2 (519k), OSS (457k), Qwen3 (552k), and a curated **SFT subset
(119k rows)** meant to be training-ready. The card documents the `messages` /
`target_tools` schema but **does not explicitly document the `tool_call.id`
field's uniqueness behavior** in the README text surfaced by the fetch — i.e.
this needs a direct row-level inspection of `data/toucan_agentic.jsonl` (this
project's own converted 300-row subset) and, ideally, a raw sample of
`Agent-Ark/Toucan-1.5M`'s SFT split to see if upstream Toucan rows already vary
their IDs or whether the flattening/conversion step to this project's
`{messages, tools}` format is what collapsed them to a constant. This is a
**code/data-inspection task, not a web-research one** — recommend a quick local
check (e.g. `jq` over `data/toucan_agentic.jsonl` for distinct `tool_call.id`
values, and if feasible pulling a few raw rows of the upstream SFT subset from
HF to compare) before assuming the fix is "replace Toucan" rather than "fix the
converter."

---

## A. Frontend / web-app generation datasets

| Dataset | Link | Scale | License | Fit |
|---|---|---|---|---|
| **WebSight** (v0.1/v0.2) | https://huggingface.co/datasets/HuggingFaceM4/WebSight | 823k (v0.1) / ~2M (v0.2, 2.5x) screenshot→HTML/CSS pairs | not explicitly stated in card as of this search — check before use, HF-hosted synthetic data | Screenshot-to-code, **not interactive**: pages are synthetically generated static Tailwind layouts with placeholder/real images, no real app logic (no state, no event handlers doing anything meaningful). Wrong shape for this project's actual eval (interactive single-file apps with real logic) — only useful if a vision encoder were in play, which it isn't here. **Not recommended.** |
| **Design2Code** | https://github.com/NoviScl/Design2Code, HF page linked from blog | 484 real webpages (test-only benchmark, not a training set) | research use | This is a *benchmark*, not training data (484 pairs, C4-sourced). Useful only as an eval reference, not for SFT rows. **Not recommended as training data.** |
| **WebCode2M** | https://webcode2m.github.io/, https://arxiv.org/abs/2404.06369 | 2.56M webpage-design→HTML/CSS pairs, built from Common Crawl (~0.5B pages filtered down) | **research use only** (explicitly stated) | Real-world diversity (vs. WebSight's synthetic pages), but same fundamental mismatch: screenshot-to-code, not "write an interactive app from a text prompt with working logic." Also research-only license is a concern if any output is ever shared/distributed. **Not recommended.** |
| **DCGen** | https://github.com/WebPAI/DCGen, https://arxiv.org/abs/2406.16386 | 348 real websites curated, 111 held out for eval | check repo (FSE'25 paper artifact) | Same screenshot-to-code shape, small scale, mostly an eval/methodology paper (divide-and-conquer prompting technique) rather than a large reusable SFT corpus. **Not recommended.** |

**Blunt finding for category A: nothing found in open-source land actually
matches this project's real use case (generate a polished, *interactive*,
single-file HTML/CSS/JS app with working logic — games, tools, forms with
real state — from a text prompt, no reference screenshot).** Every public
"web code generation" dataset in wide circulation (WebSight, Design2Code,
WebCode2M, DCGen, and the newer UI-Bench/Widget2Code/Interaction2Code papers
that turned up alongside them) is built around the **image/screenshot-to-code**
task, which optimizes for visual fidelity to a static reference, not for
"the todo list app actually persists state and the counter buttons actually
work." Pulling rows from any of them would just reinforce "produce
plausible-looking markup," which is not the reported failure (thin webgen data,
8/12 vs 9/12) — the bug is depth/correctness of interactive logic, and no
existing dataset teaches that better than more of this project's own
Claude-authored rows would. **Recommendation for category A: do not import an
external dataset; keep authoring targeted, verified single-file interactive
app rows in-house** (the approach already validated tonight after dropping the
Gemma-12B distillation route) — but structure new rows explicitly around the
project's own webgen suite's failure categories (whatever 4 of the 12
benchmark scenarios still fail) rather than generic app diversity, and lean on
Claude to generate + Claude-grade-verify (run the generated HTML/JS
in a headless check) each new row before it goes in the mix, same discipline
already used for `planning_hard.jsonl`.

## B. Agentic tool-use / function-calling SFT datasets

| Dataset | Link | Scale | License | Fit / notes |
|---|---|---|---|---|
| **Salesforce xLAM / APIGen-60k** | https://huggingface.co/datasets/Salesforce/xlam-function-calling-60k, pipeline paper https://github.com/SalesforceAIResearch/xLAM | 60k, generated over a pool of 3,673 executable APIs across 21 categories | **CC-BY-NC-4.0 — research only** | Every row passes 3-stage verification: format check → **actual function execution** → semantic check; human eval showed >95% correctness. This directly targets "is the call well-formed and does it actually run" — closest available proxy to teaching clean, complete tool-call emission. **NC license blocks any commercial use**, but fine for a personal/research lab. A filtered sample (verified single-turn + multi-turn calls, few hundred rows) is a strong, low-risk add. |
| **APIGen-MT-5k** | https://huggingface.co/datasets/Salesforce/APIGen-MT-5k | 5k multi-turn trajectories | check card (Salesforce, likely same NC family) | Multi-turn version of the above — more directly analogous to a real multi-tool-call agent session (like the 19-tool-call conversation that exposed bug #1). Worth pulling a verified subset. |
| **ToolACE** | https://huggingface.co/datasets/Team-ACE/ToolACE | 11.3k rows (default split), synthesized over a self-evolved pool of 26,507 APIs across 390 domains | **Apache 2.0** | Dual-layer (rule-based + model-based) verification, explicit "formalized thinking process" guiding dialogue generation — i.e. it was built with a reasoning-then-act structure in mind, which is the exact junction where victory5-8b's bug #2 occurs. Fully permissive license. An 8B model trained on this alone reportedly reached GPT-4-class function-calling accuracy per the paper. **Good candidate**, and license is the cleanest of the bunch. |
| **NousResearch Hermes-Function-Calling-v1** | https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1, repo https://github.com/NousResearch/Hermes-Function-Calling | ~12k rows (5 sub-formats: single-turn FC, multi-turn FC, JSON-mode, "glaive" advanced JSON-mode, structured extraction) | **Apache 2.0** | This is the literal datamix that taught Hermes-2-Pro tool use + `<tool_call>` tag structure — same tag convention Qwen3 itself uses, so format is directly transferable. Rows do carry a UUID-style top-level conversation `id`, though the search could not confirm from the card alone whether individual tool_call ids vary appropriately within multi-call turns — worth a direct row inspection before assuming it's clean. Small, permissively licensed, purpose-built for exactly this. **Good candidate.** |
| **Glaive function-calling-v2** | https://huggingface.co/datasets/glaiveai/glaive-function-calling-v2 | 113k rows | Apache 2.0 | Older (2024), single-function-call-oriented, less structurally rich than ToolACE/xLAM for multi-tool multi-turn sessions. Usable but lower priority — mostly superseded in quality by the newer verified pipelines above. |
| **Gorilla / OpenFunctions-v2 training data** | https://github.com/ShishirPatil/gorilla, blog https://gorilla.cs.berkeley.edu/blogs/7_open_functions_v2.html | 65,283 question-function-answer pairs across Python/Java/JS/REST/CLI | **Apache 2.0** | Good multi-language API coverage, permissive license, but generated/eval-oriented toward the Berkeley Function-Calling Leaderboard rather than toward multi-turn agent trajectories. Lower priority than ToolACE/Hermes for this project's "long agentic session" failure mode. |
| **ToolBench / ToolLLM** | (not re-verified in depth this pass; widely cited alongside Gorilla) | ~126k instructions, 16k+ real APIs | Apache 2.0-ish (verify per release) | Large scale but heavier normalization effort to adapt to this project's schema; lower leverage per row than the smaller, cleaner verified sets above given the hundreds-not-millions budget. |

**Toucan-1.5M itself:** confirmed Apache 2.0, huge scale, real MCP-tool
grounding (a genuine strength — these are *real* tool executions, not
imagined APIs), but the id-uniqueness question needs the local row-inspection
step described above rather than more web research. If the local check
confirms upstream Toucan rows already vary tool_call ids correctly, the fix is
purely in this project's own `scripts/build_sft.py`/conversion step, and no
new dataset is needed for bug #1 at all — just a data-hygiene pass:
programmatically re-generate a fresh unique id (e.g. `call_<uuid4>`) per tool
call across every row already in the mix (Toucan-derived and
`agentic_sft.jsonl` alike) rather than trusting whatever the source encoded,
since this is trivially fixable in-house with zero new data.

## C. Existing-codebase iteration / SWE-agent datasets

| Dataset | Link | Scale | License | Fit |
|---|---|---|---|---|
| **SWE-Gym / SWE-Gym-Lite** | https://huggingface.co/datasets/SWE-Gym/SWE-Gym, https://huggingface.co/datasets/SWE-Gym/SWE-Gym-Lite, repo https://github.com/SWE-Gym/SWE-Gym | Full: 2.4k real tasks / 11 Python repos; Lite: 230 instances | check card (research artifact, MIT-ish per repo — verify) | Exactly the "modify an existing real codebase to fix a real issue" shape this project is missing — requires navigating a repo, coordinating multi-file edits, using tools against a live execution environment. Lite's 230 instances is right in this project's realistic per-run budget. |
| **SWE-Gym/OpenHands-SFT-Trajectories** | https://huggingface.co/datasets/SWE-Gym/OpenHands-SFT-Trajectories | curated SFT-ready trajectories (subset of the above, exact row count not confirmed this pass — check card) | check card | This is the *already-flattened-to-conversation-turns* version — likely the least conversion work for this project's `{messages, tools}` format. **Best single practical candidate for category C.** |
| **SWE-smith** | https://swesmith.com, repo https://github.com/SWE-bench/SWE-smith, paper https://arxiv.org/abs/2504.21798 | 50k task instances / 128 repos; 5,016 expert trajectories actually collected+used for SFT (capped at 3 trajectories/instance — they found repeatedly-solved "easy" trajectories *hurt* quality) | check repo/card | The paper's own finding is directly actionable here: **don't over-include "easy, repeatedly-solved" trajectories** — cap duplicates per task, same instinct this project already applies with "verified-by-construction" planning data. A filtered few-hundred-row sample of their harder/rarer trajectories would fit the realistic-iteration gap. |
| **nvidia/SWE-Hero-openhands-trajectories** | https://huggingface.co/datasets/nvidia/SWE-Hero-openhands-trajectories | 34k OpenHands trajectories, synthesized w/ Qwen3-Coder-480B | check card | Large, synthetic-from-strong-teacher, SFT-curated already. Good deep pool to sample a verified few hundred "modify existing code, multi-tool-call" rows from, but scale mismatch requires a real filter pass (e.g. by trajectory length/tool-call count/pass verification) rather than wholesale use. |
| **nebius/SWE-rebench-openhands-trajectories** | https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories | 67,074 trajectories / 1,823 Python repos, Qwen3-Coder-480B + OpenHands v0.54.0 | check card | Same shape as above — large, needs filtering, but real repos + real issues gives a wide pool to pick verified realistic-iteration examples with actual multi-turn tool sequences (directly exercises correct tool_call id sequencing over many turns, incidentally also useful for bug #1). |

---

## Recommendation for victory6 (given the 8GB-GPU / hundreds-to-low-thousands-rows budget)

**Do this, in priority order:**

1. **Fix bug #1 first, in-house, with zero new data.** Before importing
   anything, run a local check on `data/toucan_agentic.jsonl` and
   `data/agentic_sft.jsonl` for `tool_call.id` uniqueness, confirm whether the
   constant string is present at the raw-source level (pull a few live rows of
   `Agent-Ark/Toucan-1.5M`'s SFT subset to compare) or introduced by this
   project's converter, then patch the converter to stamp a fresh unique id per
   call across the whole mix. This is almost certainly higher leverage than any
   dataset swap for bug #1 specifically, and it's free.

2. **For bug #2 (tool call buried in `<think>`), add a small, high-verification
   agentic-format set: Team-ACE/ToolACE (Apache 2.0, ~11.3k rows — sample a
   verified few hundred) + NousResearch/hermes-function-calling-v1 (Apache 2.0,
   ~12k rows, uses the same `<tool_call>` tag convention Qwen3 already emits).**
   Both were built with execution/format verification loops, which is the
   closest available proxy for "the call is always cleanly emitted, never just
   narrated." Treat this as reinforcement of the *pattern* "think, close think,
   then call" via consistent exemplars — not a guaranteed fix, since public
   evidence suggests this is partly a Qwen3-family serving/parser-level bug
   (see section 0) that may need a decoding/template-side mitigation
   (e.g. force-closing `</think>` before a `<tool_call>` token during eval, as
   the tfriedel writeup does) in addition to data changes.
   Skip xLAM/APIGen-60k and APIGen-MT-5k despite being the most rigorously
   verified — their CC-BY-NC-4.0 license is a real constraint if the resulting
   model or its outputs are ever shared beyond personal use; keep them as a
   fallback only if Apache-licensed options prove insufficient.

3. **For category C (realistic existing-codebase iteration), pull a filtered
   few-hundred-row sample from SWE-Gym/OpenHands-SFT-Trajectories** (already
   flattened to conversational SFT format, least glue code) **or SWE-smith's
   harder/rarer trajectories** (the paper's own finding — cap repeated-easy
   trajectories at ~3 per task — is directly reusable guidance for how to filter
   whichever pool is chosen). This is the one true gap: nothing in the current
   mix (`toucan_agentic`, `agentic_sft`, `planning_hard`) actually exercises
   "here is a real, already-imperfect codebase, go modify it," which is most of
   what a coding agent does in practice.

4. **For category A (webgen), do not import an external dataset** — every
   candidate found (WebSight, Design2Code, WebCode2M, DCGen) targets
   screenshot-to-static-markup fidelity, not interactive-app logic correctness,
   which is the actual reported gap (8/12 vs 9/12, unchanged). Keep authoring
   in-house, targeted at the specific failing benchmark scenarios, each row
   verified by actually running the generated app, same discipline as
   `planning_hard.jsonl`'s "verified-by-construction" approach.

**Single biggest risk/blind spot across this whole plan:** none of the
tool-calling datasets in category B were found to explicitly document
"resistant to burying calls in `<think>`" as a tested property — that's an
inference from "these pipelines verify execution/format," not a confirmed
causal fix. If victory6 still shows the bug-#2 failure pattern after adding
ToolACE/Hermes rows, the next lever is very likely template/parser-side (force
`</think>` closure before any `<tool_call>` emission at serve time), not more
training data — worth testing that decode-time mitigation in parallel rather
than treating this as purely a data problem.

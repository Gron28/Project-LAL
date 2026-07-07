# Multi-mode agentic workflows + a context-light orchestrator — research handoff

**Audience note (read this first):** this doc is written for whoever picks this up next —
expected to be Fable 5 ("mythos"), a different model than the one who wrote this. The chat this
came out of will be deleted, so nothing here assumes you have that conversation. Everything
you need — the user's own words, the research, the exact state of the codebase — is below.
Do your own deeper research too; what's here is a solid first pass in ~30 minutes, not
exhaustive. The user (Gron/Felipe) explicitly wants YOUR read on this, not just mine —
disagree with my scoping recommendation if you think it's wrong.

## 1. The user's request, in his own words

> maybe we could like have different toggles for agentic workflows? maybe a default one, one
> for tiny code adjustments, one for planning, one for deep research.
>
> and like one that doesn't really do anything itself but it calls others. like an
> orquestrator that doesn't consume context or not that much, but it instead dynamically calls
> sub agents from any kind, from 8b to 4b to 2b to 0.5b etc. and starts out by calling a
> researcher or researcher agents then it feeds that to planner agents. and then to red team
> agents, and then planning again, then iterativo agents, and finally presentation agents that
> prepare a digestión of all that was learnt. none of the subagents get overloaded with context
> each gets what it needs. and we can have everything in the same chat. maybe another agent
> will need to run to summerize each finding so the orchestrator and other agents that need to
> know can know without the full context.
>
> I think it would be cool at least to experiment with, although I know for sure that shit will
> take a long as time to do simple tasks, but that's why it is a different toggle, it is only
> for cases where maybe I want to try a hard project over night etc.

Two distinct asks, don't conflate them:
1. **Workflow "toggles"** — a mode selector changing how the `/code` agent behaves per task
   type: default, tiny-edit, planning, deep-research.
2. **An "orchestrator" mode** — a deep, slow, overnight-capable pipeline: researcher(s) →
   planner → red-team → planner (again) → iterate → presentation/digest, with sub-agents of
   varying model sizes (8B down to 0.5B), each getting only the context it needs, with a
   dedicated summarizer agent compressing findings so nobody downstream needs the full raw
   transcript.

He's explicit that slowness is fine and expected for (2) — it's opt-in, for hard overnight
tasks, not the default path.

## 2. Why this isn't starting from zero — what already exists

The `/code` agent (mini-claude-code) already has a **working, minimal version of exactly the
mechanic the user is describing**, just single-level and not model-size-aware yet:

- `web/src/lib/agent-tools.ts` — `spawn_agent` tool (search for `case "spawn_agent"`):
  delegates a self-contained subtask to a helper agent that has the same file/web/python tools
  (but `depth >= 1` blocks further nesting — no recursive spawning). It runs its own
  `runToolLoop` with its own message array (`[system, user]`, NOT the parent's full history),
  and returns only a final text report string (`[${agentId} report]\n${report}`) back to the
  parent — the parent's context never sees the sub-agent's raw tool calls/outputs, only the
  digest. **This is already "context isolation + summarization on return."**
- `web/src/lib/toolloop.ts` — `runToolLoop()`: the core agentic loop (model call → tool_calls →
  execute → repeat until a non-tool-call reply or `maxRounds`). Takes `baseUrl`, `model`,
  `maxRounds`, `maxTokens`, `think` as **per-call parameters already** — meaning a caller can
  already invoke it with a different model/round-budget/token-budget per sub-agent. The
  plumbing for "different agents get different limits" already exists; nothing currently
  varies it deliberately by role.
- `web/src/app/api/agent/loop/route.ts` — the `/code` HTTP endpoint. Currently hardcodes
  `maxRounds: 24, maxTokens: 4096` for the top-level agent regardless of task. This is the
  natural place a "mode" parameter would plug in (swap these constants, the system prompt, and
  the model per mode).
- Model switching machinery: `ensureServing(model, minCtx)` in `web/src/lib/lab.ts` — loads a
  given local GGUF or Ollama model, unloads whatever's currently resident first (GPU is
  single-tenant on this box, see §4). Already handles both local llama-server-served GGUFs and
  Ollama-served models transparently to callers.

So the shape of the fix is: **teach `spawn_agent` (or a new sibling tool) to accept an explicit
model/role, add a mode selector that changes the top-level agent's prompt+budget+model, and
add one more tool (or a system-prompt instruction) whose whole job is compressing a sub-agent's
raw findings before they go back up.** Not a from-scratch multi-agent framework.

## 3. External research (2026) — how the field thinks about this

### Orchestrator-worker is the standard shape, and it's already what he's describing
Three topologies dominate production multi-agent deployments in 2026: supervisor/hierarchical,
orchestrator-worker (~70% of deployments), and swarm (peer agents, no central control). A
supervisor reads the goal, decides which sub-team/agent handles it, dispatches, and aggregates
results — this is exactly "orchestrator that calls researcher → planner → red-team → …".
[Multi-Agent AI Orchestration Guide & 2026 Updates](https://www.codebridge.tech/articles/mastering-multi-agent-orchestration-coordination-is-the-new-scale-frontier),
[6 Multi-Agent Orchestration Patterns for Production (2026)](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)

### The context-overflow problem is formally studied, and it validates the hierarchy instinct
A January 2026 paper, [**Phase Transition for Budgeted Multi-Agent Synergy**](https://arxiv.org/abs/2601.17311),
formalizes exactly why the user's "researcher → planner → red-team → planner → iterate →
presentation" *chain/tree* shape is right rather than a flat "orchestrator personally talks to
10 workers" star: a context window `W` imposes a hard fan-in limit, so **star topologies
saturate at roughly `N ~ W/m` agents** (context window ÷ message length) and stop improving
past that no matter the compute budget — "which is why star organizations often stop improving
beyond a modest scale." A hierarchy (bounded fan-in at each level, with results compressed
before going up a level) sidesteps this because no single node ever has more than a few
inputs' worth of context at once. This is a direct, citable justification for "orchestrator
doesn't hold everything itself, it holds only what's been digested down to it."

### The four standard 2026 mitigations for context bloat
Write to offload, select to stay relevant, compress to cut clutter, isolate to prevent
cross-contamination. In multi-agent orchestration specifically: "the orchestrator compresses
each sub-agent's output down to the essential result before folding it back into the main
context, allowing teams to run agents on tasks that would overflow any single context window
many times over." A common trigger heuristic is summarizing when context hits 70-80% capacity,
keeping a condensed history + full-fidelity recent messages.
[Agent Context Engineering 2026](https://agentmarketcap.ai/blog/2026/04/11/agent-context-engineering-sliding-windows-memory-2026),
[Context compaction in agent frameworks](https://dev.to/crabtalk/context-compaction-in-agent-frameworks-4ckk)

This maps directly onto the user's "another agent will need to run to summarize each finding" —
that's a **compress** step, and it's the mainstream-recommended solution, not a hack.

### Claude Code's own subagents (i.e., what `spawn_agent` already imitates)
A subagent is a named, isolated instance with its own system prompt, own context window, own
tool access, own permission mode. The parent delegates a task, the subagent works entirely in
its own context, and returns a summary rather than dragging the full working transcript back —
"context issues [are solved] by giving each delegated task its own isolated context." This is
worth reading not as "prior art to imitate" but as "the same architecture family the current
codebase already chose (see §2) — this is validation, not a new direction."
[Claude Code Subagents: The Complete Guide](https://medium.com/@sathishkraju/claude-code-subagents-the-complete-guide-to-ai-agent-delegation-d0a9aba419d0),
[Context management in agent harnesses](https://arize.com/blog/context-management-in-agent-harnesses/)

### STORM — a concrete reference architecture for the research→outline→write half of the pipeline
Stanford's [STORM](https://storm-project.stanford.edu/research/storm/) system produces
Wikipedia-quality research reports via a two-stage multi-agent pipeline: **pre-writing**
(simulated multi-perspective conversations between a writer persona and topic-expert agents,
grounded in live web search, producing an outline + collected citations) then **writing**
(synthesizing the outline + references into a coherent final piece). The key insight worth
stealing: citations/findings are collected *during* the research conversation, not
reconstructed after the fact — this is why STORM's outputs are measured as 25% more
"organized" and 10% broader in coverage than a plain outline-then-retrieve baseline. Relevant
to the "researcher agent(s) → planner" half of the user's pipeline specifically.

### Reflection / Generator-Critic — the "red team" stage has a name and known variants
The user's "red team" stage is the standard **reflection** / **generator-critic** pattern:
generate → critique → refine, looped. Three documented critique variants worth choosing
between: **self-critique** (same model, different prompts for generation vs. evaluation),
**cross-model critique** (a *different* model evaluates — arguably the more honest "red team"),
and **tool-grounded critique** (a test suite, linter, or executable check provides
deterministic feedback instead of another LLM's opinion). For a coding agent specifically,
tool-grounded critique (does it run? do the tests pass?) is usually stronger evidence than
another model's opinion, and cheap to run on a small/fast model.
[Reflection Agent Pattern docs](https://agent-patterns.readthedocs.io/en/stable/patterns/reflection.html),
search results on Self-Refine/Reflexion frameworks.

### Model cascades / routing — the "8B down to 0.5B" half
Cascaded inference serves most requests with a small model and escalates only the hard cases
to a large one; production systems report **45-85% cost reduction while retaining ~95% of
quality** this way. Routing signals used in practice: intent classification, a complexity
estimate, or similarity to past queries whose difficulty is already known. For this project,
the router doesn't need to be learned/statistical — the orchestrator's own role-assignment
("this is a `web_search` fan-out task, give it to the 0.5B or 2B tier; this is the red-team
critique, give it the 8B") already IS the routing decision, made once per stage rather than
per-token.
[LLM Routing and Model Cascades: How to Cut AI Costs](https://tianpan.co/blog/2025-11-03-llm-routing-model-cascades),
[A Unified Approach to Routing and Cascading for LLMs](https://arxiv.org/html/2410.10347v3)

### Running several model sizes on one small GPU — the specific hardware-constraint angle
Directly relevant given this box has **one 8GB AMD RX 6650 XT, single-tenant** (see §4): a
concrete existing project, **lmxd**, runs three small local agents on a single 8GB GTX 1080 by
routing all of them through one shared llama.cpp backend process, admitting models against a
"VRAM ledger," and **swapping an inactive agent's KV-cache state to host RAM** rather than
fully unloading/reloading weights each switch — cheaper than a cold reload when the same model
will be reused shortly. Worth reading as a reference for how to make model-switching cheaper
than the naive "unload, reload from disk every time" this codebase currently does via
`ensureServing`.
[Run 3 Local AI Agents on 8GB GPU with lmxd](https://windowsforum.com/threads/run-3-local-ai-agents-on-8gb-gpu-with-lmxd-vram-ledger-and-kv-swapping.430754/)

## 4. Hard constraints from THIS codebase (not generic advice — specific to this box)

- **GPU is single-tenant, no exceptions.** One 8GB AMD RX 6650 XT. This has bitten this
  project multiple times already (see `HANDOFF.md` bug list — an unmanaged cross-backend model
  switch once OOM-killed system-critical daemons like NetworkManager). `ensureServing()` in
  `web/src/lib/lab.ts` already unloads whatever's resident before loading the next model — any
  orchestrator design MUST route every model load through this function, never spawn a second
  serving process directly.
- **Model switching is NOT free.** Every swap between different model sizes means a real
  unload + reload (seconds to tens of seconds depending on model size and whether it's already
  in the OS page cache). An orchestrator that naively round-robins model sizes call-by-call
  will spend a large fraction of an overnight run just reloading weights. **Batch same-model
  calls together where the pipeline structure allows it** (e.g., run ALL research sub-agents on
  the small model in one batch before switching up to the bigger model for planning), rather
  than switching per-call. This is the single most actionable hardware-specific design point.
- **RAM is 15GB, also tight.** Relevant if any stage wants to keep multiple sub-agent
  transcripts resident in Node process memory simultaneously — shouldn't be a real problem
  (text, not model weights) but worth remembering this isn't a beefy box anywhere.
- **Available models right now** (`GET /api/agent/models`): `qwen3-4b-stock`, `victory3` (2.5GB
  Q4, fine-tuned 4B), `victory4-8b` (5GB Q4, fine-tuned 8B — this session's training run, see
  `HANDOFF.md`), `gemma4:12b`/`gemma4:e2b`/`gemma4:e4b` (Ollama), `qwen2.5-coder:1.5b`,
  `qwen2.5-coder:3b`, `qwen3:8b`. For a genuine 0.5B tier, `Qwen/Qwen2.5-0.5B-Instruct` is
  already a known/downloadable option (see `TRAIN_BASES` in `web/src/lib/lab.ts`) but isn't
  pulled/converted to GGUF yet — that's a prerequisite step, not just a config change.
- **The tool-call-memory bug fixed this same session is directly relevant.** Until just now,
  `/code`'s conversation history sent back to the model on each turn was a lossy summary
  (final text only, no tool-call record) — meaning an agent could forget it already called a
  tool and repeat the work. This was just fixed (`web/src/app/code/page.tsx`,
  `reconstructSession`'s `history` is now the raw transcript verbatim). **Any orchestrator
  design inherits this same risk at every level** — a sub-agent, the orchestrator, and a
  "digest" agent all need SOME real record of what already happened, not just vibes-based
  summaries, or you'll rebuild the exact bug that was just fixed, one level up.
- **Existing suite/benchmark infrastructure** (`web/src/lib/graders.ts`, the 7-suite battery
  in `HANDOFF.md`) has an `agentic` suite already grading real tool-use — worth checking
  whether an orchestrator mode should get its own suite eventually, or whether that's premature
  before the mode even has a first working version.

## 5. A concrete open question research didn't settle — worth Fable 5's own judgment

The 45-85%-cost-savings cascade literature is about **routing single requests** to the right
size model. The user's ask is closer to **role-based static assignment** (researcher tier vs.
red-team tier get different sizes by design, not by a per-call complexity classifier). Given
this box's swap cost, I'd bet role-based static assignment beats a dynamic per-call classifier
here — dynamic routing's whole value proposition (avoid paying for the big model on easy
requests) matters less when "using the big model" and "using the small model" cost roughly the
SAME latency once you're mid-batch on one of them, and the classifier itself is extra
inference. But this is a judgment call, not something the research nails down for a
single-GPU local setup specifically — worth Fable 5 either confirming or pushing back on.

## 6. Recommended scope for a first implementation (mine — not a decision, a starting point)

Don't build the full 5-stage pipeline first. Build the primitives, prove them, then let the
orchestrator mode's *system prompt* drive the pipeline shape rather than hardcoding stages in
TypeScript:

1. **Mode selector** in `/code`'s UI + `POST /api/agent/loop` body (`mode: "default" |
   "quick-edit" | "planning" | "deep-research" | "orchestrator"`), each mapping to a preset
   `{maxRounds, maxTokens, systemPromptAddendum, defaultModel}` in `loop/route.ts`.
2. **`spawn_agent` gains an explicit `model` param** (currently always inherits the parent's
   `opts.model` — see `agent-tools.ts`), so the orchestrating model can deliberately hand a
   sub-task to a smaller/faster model.
3. **A `digest_findings` tool or automatic post-`spawn_agent` compression step** — after a
   sub-agent returns its raw report, optionally run ONE more small/fast model call whose only
   job is compressing that report to N tokens before it re-enters the parent's context. Cheap
   insurance against the star-topology saturation math in §3.
4. Only after (1)-(3) exist and are tested: let "orchestrator mode"'s system prompt instruct
   the model to actually run the researcher→planner→red-team→planner→iterate→presentation
   sequence using these primitives, rather than hand-coding that sequence as fixed application
   logic. This keeps the pipeline shape adjustable via prompt iteration instead of a redeploy,
   which matters a lot for something explicitly framed as "experimental."

## 7. Where things are, file-by-file (for fast orientation)

| What | Where |
|---|---|
| Sub-agent delegation (existing) | `web/src/lib/agent-tools.ts` — `spawn_agent` case, `makeAgentExecutor` |
| Core tool loop | `web/src/lib/toolloop.ts` — `runToolLoop()` |
| `/code` HTTP endpoint | `web/src/app/api/agent/loop/route.ts` |
| `/code` UI | `web/src/app/code/page.tsx` |
| Model load/switch/GPU management | `web/src/lib/lab.ts` — `ensureServing`, `stopServing`, `servingModel` |
| Trainable/available small models | `web/src/lib/lab.ts` — `TRAIN_BASES` |
| Ongoing training/benchmark narrative, known bugs, hardware lessons | `HANDOFF.md` (repo root) |
| This doc | `docs/orchestrator-research.md` |

## 8. What's explicitly NOT decided yet — don't assume these

- Whether "orchestrator mode" lives in `/code` as a mode toggle, or as a wholly separate page/
  surface. The user said "we can have everything in the same chat" — leaning toward same
  surface, different mode, but not confirmed.
- Whether the digest/compression step is its own tool call, an automatic wrapper around
  `spawn_agent`'s return, or a distinct model role entirely.
- Exact preset values (maxRounds/maxTokens per mode) — nothing benchmarked yet, pick sane
  defaults and iterate.
- Whether to pull a genuine 0.5B model now or defer until the primitives are proven on the
  models already available locally.

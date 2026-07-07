# Orchestrator-mode delegation research — why the 8B model never called `spawn_agent`, and what actually fixes it

**Context:** `docs/orchestrator-research.md` already covers topology theory (orchestrator-worker vs.
star, the Phase Transition paper, STORM, reflection/red-team patterns, model cascades, lmxd). This
doc does NOT re-derive that — it picks up from tonight's live-test failure: an 8B Qwen3 fine-tune,
given an explicit "you are a COORDINATOR, delegate everything via spawn_agent" system prompt, ran an
18-round session of direct `grep` calls and **never invoked `spawn_agent` once**. This is a
zero-shot instruction-following gap, and the question is what concretely fixes it — not more
prompting, but mechanisms with evidence behind them.

Current mechanism in the codebase (`web/src/lib/agent-tools.ts`): the top-level agent gets the FULL
`AGENT_TOOL_DEFS` list (file read/write/edit/grep/shell/python/web/vision/**and** `spawn_agent`) —
delegation is one tool among many, entirely optional, selected only if the model's own judgment
picks it. Nothing currently prevents or discourages direct action.

---

## 1. Anthropic's own multi-agent research system — concrete architecture

Source: [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (Anthropic engineering blog), corroborated by
[Simon Willison's notes](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/) and the
[ZenML LLMOps case study](https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks).

- **Topology:** orchestrator-worker. A **Lead Researcher** (Claude Opus 4) decomposes the query,
  writes its plan to external memory (so it survives context truncation past 200K tokens), and
  spawns 3-10+ subagents (Claude Sonnet 4) that work in parallel, each with a "clearly divided"
  self-contained task description.
- **What triggers delegation vs. direct action:** delegation is the *default and only* mode for
  the lead agent on real queries — there is no "direct action" fallback path; the lead agent's job
  is entirely decomposition + spawning + synthesis. Effort scaling is explicit in the prompt:
  simple fact-finding → 1 subagent, 3-10 tool calls; direct comparisons → 2-4 subagents, 10-15
  calls each; complex/breadth-first research → 10+ subagents with clearly divided responsibilities.
- **Context/token budget management:** subagents write outputs to external state (filesystem/
  artifacts) rather than round-tripping full transcripts through the orchestrator; the orchestrator
  only ever sees compressed results. Long-horizon sessions spawn *fresh* subagents with clean
  context, handing off continuity via saved plan state, not raw history replay.
- **Training vs. prompting — explicit answer:** the system is **prompting-only, no fine-tuning**.
  Anthropic states the strategy is "instilling good heuristics rather than rigid rules," arrived at
  by literally watching agent transcripts in Console, diagnosing failure steps, and rewriting
  prompts/tool descriptions (one iteration — rewriting tool descriptions — cut future task time by
  40%). **This matters directly for the local project: Anthropic gets zero-shot delegation to work
  using prompting alone only because the underlying model (Opus 4 lead, Sonnet 4 workers) has an
  enormous, intact instruction-following prior.** That budget does not exist in an already-SFT'd 8B
  local model — see §4.
- **Measured failure modes** (useful as a checklist for the local orchestrator prompt): spawning 50
  subagents for trivial queries; endless search for sources that don't exist; subagents
  "distracting each other" with excess status updates; systematic bias toward SEO content farms
  over authoritative sources; subagents duplicating each other's work when task descriptions were
  vague (the single most relevant failure to the "never delegated at all" bug — it shows that even
  Anthropic's frontier setup breaks when task descriptions aren't forced to be complete/specific).
- **No tool-restriction mechanism reported.** The blog does not describe restricting the lead
  agent's own tool palette — it apparently keeps full tool access and chooses to delegate anyway.
  This is notable precisely because it's the opposite of what turned out to be necessary for this
  project's much smaller model (§6).

Sources: [Anthropic engineering post](https://www.anthropic.com/engineering/multi-agent-research-system), [Simon Willison summary](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/), [ZenML case study](https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks), [ByteByteGo writeup](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent)

---

## 2. How OSS frameworks actually get a coordinator to delegate

Direct answer to the (a)/(b)/(c)/(d) question: **it's almost entirely (c) prompting, with (b)
architectural restriction as a real but partial and fragile second lever. (a) fine-tuning
specifically for a coordinator role is not something any of these frameworks do or need — because
none of them run on an already-narrowly-SFT'd small model.** Details per framework:

| Framework | Mechanism | Is delegation architecturally forced? | Evidence it actually works |
|---|---|---|---|
| **AutoGen / AG2** | `GroupChatManager` | **Yes — the cleanest real example of (b).** The manager's `llm_config` literally **cannot accept tools/functions at all**; its only job is speaker selection and message routing. It is structurally incapable of executing a file/shell tool itself. | Documented core design, not a config option — see [GroupChatManager docs](https://docs.ag2.ai/latest/docs/api-reference/autogen/GroupChatManager/) and a live bug thread confirming tools "cannot be found" by the manager because it was never wired to call them ([GitHub issue #2472](https://github.com/microsoft/autogen/issues/2472)). |
| **LangGraph** | Supervisor + "handoff tools" | Partial. The supervisor's action space *can* be restricted to nothing but handoff tools (`create_handoff_tool` per destination agent), but this is a pattern you must deliberately build — LangGraph "doesn't have a great default story for scoped delegation/tool-level enforcement" out of the box. | [langgraph-supervisor docs](https://reference.langchain.com/python/langgraph-supervisor), [tool-level permission enforcement writeup](https://dev.to/cogniwall/securing-langgraph-multi-agent-workflows-how-to-enforce-tool-level-permissions-13cm) |
| **CrewAI** | Auto-generated "manager" agent in `Process.hierarchical`, using built-in `Delegate work to coworker` / `Ask question to coworker` tools | Nominally yes (manager isn't given task tools directly) — **but in practice this is reported broken**: a documented case found the "manager" performs **no actual orchestration at all**, just executes every defined task sequentially regardless of relevance, with the last agent's output silently overwriting earlier ones. | [Why CrewAI's Manager-Worker Architecture Fails — and How to Fix It](https://towardsdatascience.com/why-crewais-manager-worker-architecture-fails-and-how-to-fix-it/) — the author's fix was **not** more architecture, it was replacing the auto-manager with a hand-written triage prompt (explicit "categorize first, then conditionally invoke only relevant specialists, then terminate") — cut tokens ~50% and took quality from "poor" to "good." This is direct evidence that architecture alone (b) is not sufficient without (c) prompt scaffolding on top. |
| **OpenHands (software-agent-sdk)** | `DelegateTool` / `TaskToolSet` | **No** — explicitly NOT forced. Docs confirm the main planning agent keeps full tool access and *decides itself*, per task, whether to act directly or spawn a sub-agent. Delegation flows through the same event-sourced history as any other action (auto-condensed/replayed like everything else). | [OpenHands delegation docs (DeepWiki)](https://deepwiki.com/OpenHands/software-agent-sdk/3.3-sub-agent-delegation-and-task-management) |
| **MetaGPT** | Role-based agents (Product Manager, Architect, Engineer, QA) each bound to a fixed SOP stage | Structural at the *pipeline* level (each role's action space is scoped to its stage by the SOP graph), not at the *tool-palette* level within a role. This is closer to hardcoded pipeline stages than to a general coordinator/dispatch primitive. | (background knowledge, consistent with the framework's published design — not independently re-verified this session) |

**Takeaway for this project:** the one framework that does exactly what your `spawn_agent`-only
hypothesis (b) describes — a coordinator that is *structurally incapable* of doing the work itself —
is AutoGen/AG2's `GroupChatManager`. It works because the manager's LLM config never has tools
wired to it, full stop, not because of any special training. But even where frameworks attempt
tool-restricted delegation (CrewAI), it still needed explicit conditional prompt logic to actually
behave correctly — restriction alone stops the "did the work itself" failure mode, but doesn't
by itself guarantee *good* delegation decisions.

---

## 3. "Engram" — three distinct things found under this name, none of them a single obvious answer

You had no confident prior on this term. Web research surfaced **three unrelated things**, all real,
all from 2025-2026 — worth being precise about which is which:

1. **ENGRAM (academic paper, arXiv 2511.12960)** — "Effective, Lightweight Memory Orchestration for
   Conversational Agents." A memory system that classifies each conversation turn into one of three
   canonical types (episodic / semantic / procedural) via a single router, embeds and stores each as
   a typed record, and at query time retrieves top-k dense neighbors per type and merges them with
   simple set operations before handing them to the model as context. Reports state-of-the-art
   results on the LoCoMo long-horizon benchmark and beats a full-context baseline by 15 points on
   LongMemEval **while using ~1% of the tokens**. Explicitly positioned as simple/interpretable/
   swappable, in contrast to heavier knowledge-graph or OS-scheduler-style memory architectures.
   [Paper](https://arxiv.org/abs/2511.12960), [OpenReview listing](https://openreview.net/forum?id=qajz4UkgIw)
2. **DeepSeek's "Engram" (Jan 2026, model-architecture level, not agent-level)** — a "conditional
   memory" layer added *inside* the transformer itself, separating factual lookup from reasoning to
   add a second sparsity axis (distinct from MoE's sparsity). This is a pretraining/architecture
   research direction, not something you'd adopt for an already-trained local model.
   [Introl writeup](https://introl.com/blog/deepseek-engram-conditional-memory-architecture-january-2026), [explainer](https://medium.com/@graison/engram-explained-deepseeks-conditional-memory-adds-a-second-sparsity-axis-512cdfaaf93f)
3. **`engram-ai.dev`** — a product/project literally branded "Engram — Memory for AI Agents" (found
   the domain, did not deep-dive its internals this session — flagged for a follow-up look if you
   want more than the name confirmed).

**Relevance to this box (resource-constrained, single 8GB GPU, local):** of the three, **#1 (the
ENGRAM paper's router+retriever design) is the actionable one.** It requires only a small embedding
model + a lightweight typed store — no knowledge graph, no extra scheduler process — and the reported
~1%-of-tokens context cost is exactly the kind of budget this hardware needs. It's a direct upgrade
path for two things you already do by hand: (a) the `digestReport`/`spawn_agent` compression step in
`agent-tools.ts`, and (b) your own `MEMORY.md` index pattern — ENGRAM's episodic/semantic/procedural
split is a more principled version of the same idea (index of typed, retrievable summaries instead
of one flat file). #2 is not applicable (that's changing DeepSeek's own pretraining, not something
you can bolt onto a Qwen3 fine-tune). #3 needs more digging if you want to pursue it specifically.

---

## 4. PewDiePie's "Odysseus" — verified real, but architecturally not the reference case you need

Confirmed directly (not just via search-summary hearsay): fetched the **live GitHub API** for the
repo and its raw README.

- Real account: `pewdiepie-archdaemon` (also hosts a second small public repo, `dionysus`,
  described as "laptop" — likely his personal dotfiles). "archdaemon" reportedly nods to his
  Arch Linux setup. Corroborated independently by [dev.to writeup](https://dev.to/jenueldev/pewdiepie-built-an-open-source-ai-workspace-and-the-point-is-bigger-than-the-hype-579m), [XDA Developers hands-on](https://www.xda-developers.com/tried-pewdiepie-open-source-ai-workspace-odysseus-weirdly-great/), and a Substack writeup — multiple independent outlets, not a single unverified source.
- Repo: `pewdiepie-archdaemon/odysseus`, created 2026-05-31, **80,868 stars / 10,597 forks** as of
  this check (still being actively pushed to, last push same day as this research), AGPL-3.0-or-later,
  Python (51.5%) + JS/CSS/HTML frontend, Docker-compose deploy (`docker compose up -d --build`,
  serves on `localhost:7000`).
- **Actual features** (from the real README, not paraphrase): a self-hosted "AI workspace" —
  Chat+Agents (local/API models, tools, MCP, files, shell, skills, memory), a "Cookbook"
  (hardware-aware model recommendations/downloads/serving — conceptually close to what your
  `lab.ts`/`TRAIN_BASES` already does), "Deep Research" (multi-step web research + report
  generation), model-comparison ("Compare"), a writing-first document editor, email/notes/tasks/
  calendar integration, and a distinctive **agent-migration manifest** feature (`docs/agent-migration.md`,
  schema `agent-migration.v1`) — a source-neutral JSON format for porting another agent's memories/
  skills/conversation-threads into Odysseus without blind-trusting the source agent's full state,
  explicitly separating "archive documents" (kept for search/reading) from "memory candidates"
  (reviewed before being promoted to durable memory).
- **What it is NOT, as far as public docs show:** there is no dedicated multi-agent
  orchestrator/coordinator subsystem with a hierarchical researcher→planner→red-team pipeline —
  no `agents.md`/architecture doc describing that, and a GitHub code search for "delegate" in the
  repo returned nothing. Structurally, Odysseus reads as a **single richly-tooled agent inside a
  full personal-workspace app** — i.e., it sits at the same altitude as your own `/code` agent
  (one agent, many tools, MCP support), not at the altitude of a LangGraph/AutoGen-style multi-agent
  supervisor system. **Its relevance to the specific "make the coordinator actually delegate" problem
  is limited** — the one transferable idea is the agent-migration manifest's archive/candidate
  memory split, which is a reasonable pattern for a "digest agent" designing what survives into
  orchestrator memory vs. what stays as raw archive.

Bottom line: Odysseus is real and large, but it is not a hierarchical-delegation reference
architecture — don't expect to mine it for the coordinator-tool-restriction problem specifically.

Sources: [github.com/pewdiepie-archdaemon/odysseus](https://github.com/pewdiepie-archdaemon/odysseus), [live GitHub API check performed this session], [dev.to](https://dev.to/jenueldev/pewdiepie-built-an-open-source-ai-workspace-and-the-point-is-bigger-than-the-hype-579m), [XDA Developers](https://www.xda-developers.com/tried-pewdiepie-open-source-ai-workspace-odysseus-weirdly-great/)

---

## 5. Additional 2026 context/memory techniques not already in `orchestrator-research.md`

- **Layered hot/warm/cold memory** is the dominant 2026 production pattern beyond simple
  compaction: verbatim recent turns (hot), rolling detailed summaries for a middle band (warm),
  broad goal/constraint summaries for everything older (cold). Critically, **anchored iterative
  summarization — merging new information into the persistent summary rather than regenerating it
  from scratch each time — measurably beats full-reconstruction summarization** on accuracy,
  completeness, and task continuity. [Agent Context Engineering 2026](https://agentmarketcap.ai/blog/2026/04/11/agent-context-engineering-sliding-windows-memory-2026)
- **Manus** (production agent platform): aggressively prunes tool *output* from context immediately
  after the model has acknowledged it, rolls up summaries at workflow-phase boundaries (not on a
  fixed token cadence), and offloads full tool results to structured storage, keeping only
  task-critical residue in the live context window.
- **LangChain "Deep Agents"**: automatically offloads large tool inputs/outputs to the filesystem
  and replaces them in-context with a reference/path, using filesystem tools to re-retrieve on
  demand — this is very close to what `digestReport`/`spawn_agent`'s report-compression already
  does, but generalized to *any* oversized tool output, not just sub-agent reports specifically.
  Worth considering extending `agent-tools.ts`'s pattern from "compress sub-agent reports" to
  "compress any tool output over N tokens, write full version to workspace, keep a path reference."
  [Deep Agents context engineering docs](https://docs.langchain.com/oss/python/deepagents/context-engineering)
- **Proactive memory extraction** (arXiv 2601.04463, "Beyond Static Summarization"): argues that
  *waiting* to summarize passively loses signal — an agent should proactively decide, turn by turn,
  what's worth promoting to durable memory rather than compressing after the fact. Conceptually
  compatible with your existing `MEMORY.md` index workflow (memory entries written as things happen,
  not reconstructed from a transcript afterward).

---

## 6. Concrete, actionable recommendations — not "better prompting"

The core diagnosis, combining §1-§2 with two additional pieces of directly relevant tool-use
research found this session:

- **["The Illusion of Role Separation"](https://arxiv.org/html/2505.00626v2)** — fine-tuned LLMs do
  not learn genuine system/user role semantics; they rely on two shortcuts instead: (1) matching the
  *task type* they've seen in training regardless of which message role it appeared in, and (2)
  treating whatever's nearest the beginning of the context as the "real" instruction. **If your
  8B fine-tune's SFT mix (`agentic_sft.jsonl`, `toucan_agentic.jsonl`, etc.) contains no examples
  pairing a "you are a coordinator" system prompt with a spawn_agent-only trajectory, the model has
  literally no learned association for that task type** — it falls back to whatever task type it
  *does* recognize from training (direct multi-tool-call chains), regardless of what the system
  prompt says. This is not a "the model didn't listen" problem, it's a "the model was never shown
  this task type" problem.
- **["LLM Agents Already Know When to Call Tools — Even Without Reasoning"](https://arxiv.org/pdf/2605.09252)**
  — base models often have decent latent judgment about when to call a tool at all, but this
  judgment measurably **degrades under standard SFT/reasoning-focused fine-tuning**. Combined with
  your own prior "think-displacement lesson" memory (SFT without think-blocks lobotomized Qwen3
  reasoning), this is a second, independent line of evidence that your training pipeline can
  actively erase capabilities the base model started with — delegation judgment may be one of them.

Given that, in priority order:

1. **Ship a tool-palette restriction for orchestrator mode — same-day change, no retraining
   required, and it's the one mechanism in this whole research pass with a clean working precedent
   (AutoGen/AG2's `GroupChatManager`, §2).** In `web/src/app/api/agent/loop/route.ts`, when
   `mode === "orchestrator"`, do not hand the top-level `runToolLoop` call `AGENT_TOOL_DEFS` — hand
   it a tiny tool list: `spawn_agent` plus maybe a `finish_report` tool, nothing else (no
   `grep`/`read_file`/`run_shell`/etc.). This makes "do the grep chain myself" **structurally
   impossible** rather than merely discouraged — it doesn't rely on the model's judgment at all,
   which is exactly the gap that just failed. Sub-agents spawned via `spawn_agent` keep their
   current full toolset (`SUB_TOOL_DEFS`, already correctly scoped in `agent-tools.ts`) — only the
   top-level orchestrator's own palette needs restricting, and only in this one mode.
2. **Layer a small number of concrete few-shot trajectories into the orchestrator system prompt
   itself** — 2-3 short examples showing "system: you are the coordinator" → "assistant: (calls
   spawn_agent with a fully self-contained task string)" → "tool result: [helper report]" →
   "assistant: (calls spawn_agent again or produces final digest)". This is the cheapest available
   patch for the role-association gap from the Illusion-of-Role-Separation finding — it's the
   few-shot analog of that paper's own (self-described as weaker but real) mitigation of "data
   augmentation with role-appropriate examples." Do this in parallel with (1), not instead of it —
   (1) makes bad behavior impossible, (2) makes the *good* behavior more fluent once the model has
   no other option anyway.
3. **If you retrain this model again, add a small dedicated orchestrator-role SFT slice** — order
   of a few hundred to low thousands of examples is the evidence-backed range (the AWS SLM tool-
   calling paper found meaningful behavior shift from targeted fine-tuning at that scale, not
   full-dataset-sized retraining). Each example: coordinator system prompt (vary its exact wording
   across examples — don't let the model key on one fixed string, per the role-separation paper's
   warning about shortcut learning) + a user task + an assistant trajectory that **only** calls
   `spawn_agent`, never a direct file/grep/shell tool, ending in a synthesized final report. Keep
   think-block formatting consistent with the rest of your mix — your own "think-displacement"
   memory note already proved format mismatches silently break this model family, and an
   orchestrator slice is exactly the kind of small, distinct-flavored addition that could
   reintroduce that bug if built carelessly.
4. **Test order:** ship (1) first and rerun the same overnight-scale scenario before spending a
   training cycle on (3). Per the CrewAI case study in §2, tool restriction alone sometimes isn't
   sufficient (their manager still executed everything sequentially without real judgment) — so
   watch specifically for a *new* failure mode after (1): the orchestrator dutifully calling
   `spawn_agent` but handing it a single giant undifferentiated task (dumping its whole problem on
   one helper instead of decomposing), or refusing to produce a final synthesis. If that shows up,
   that's the signal (3) is actually needed, not just (1)+(2).

**Single biggest risk in this plan:** Anthropic's own postmortem (§1) shows that even a
frontier-scale, fully capable model still makes bad *decomposition* decisions (over-spawning, vague
task descriptions causing duplicate work) purely from prompting — an 8B model with a *restricted*
toolset removes the "did it delegate at all" failure but does not automatically guarantee *good*
task decomposition once it's forced to. Budget for a second observation pass specifically on task-
description quality, not just "did spawn_agent get called."

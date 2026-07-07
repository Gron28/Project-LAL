# Orchestration frameworks — deep dive (CrewAI, LangGraph, Microsoft Agent Framework)

Builds on `docs/orchestrator-research.md` (Anthropic's own multi-agent system, initial
AG2/CrewAI/LangGraph findings) and the live finding that an 8B local model given a "delegate
everything" system prompt with full tool access called `spawn_agent` **zero** times across an
18-round session — it just did the work directly. A same-day fix (restricting the orchestrator's
tool palette to `spawn_agent` + read/list/write only) was built and typechecked but not yet
live-tested. This doc verifies that fix against live source inspection of three real frameworks,
not blog-level summaries, and surfaces one new mechanism not yet considered.

## 1. CrewAI — verified directly against current `main` branch source (`crewai/crew.py`, `tools/agent_tools/*.py`)

The "manager failed, needed hand-restriction" story in `orchestrator-research.md` is a 2025-era
blog anecdote and is **outdated/incomplete**. Live source inspection shows CrewAI's hierarchical
process already **structurally forces** tool restriction on the manager, exactly like AG2's
`GroupChatManager`:

- `Crew._create_manager_agent()` (crew.py L1480-1504): if a user supplies a custom
  `manager_agent` that has any `tools` set, CrewAI logs a warning, clears the tools, and
  **raises an Exception** — a custom manager with task tools is a hard error, not a config choice.
- The auto-created default manager gets `tools=AgentTools(agents=self.agents).tools()` —
  literally just two tools, `DelegateWorkTool` ("Delegate work to coworker") and
  `AskQuestionTool` ("Ask question to coworker"). No file/shell/search tools are ever wired to
  it. This is CrewAI's `spawn_agent`-equivalent, enforced at the framework level.
- **State-passing mechanism (verified in `base_agent_tools.py`)**: delegation is a **structured
  handoff object with two string fields** — `task` (description) and `context` (freeform
  string) — not a raw transcript replay. `_execute()` builds a brand-new
  `Task(description=task, agent=selected_agent, ...)` and calls
  `selected_agent.execute_task(task_with_assigned_agent, context)`. The sub-agent runs fresh; it
  does not see the manager's or other agents' full history. This is the same shape as this
  project's `spawn_agent` (`[system, user]` fresh messages, digest back).
- A telling comment in the delegate tool's `_get_coworker`/name-sanitizing code: quotes are
  stripped from agent names because *"less-powerful LLMs have difficulty producing valid JSON"*
  for the delegation tool call — CrewAI's own maintainers hit small-model tool-calling
  fragility and built defensive parsing for it. Directly analogous to this project's 8B-model
  concern.
- **What the older "manager fails" reports actually show**: not "did it delegate at all"
  (that's structurally forced) but **decomposition/routing quality** — the manager delegating to
  the wrong/all agents regardless of relevance, or one agent's output silently overwriting
  another's. The fix in that case study was a hand-written triage prompt layered *on top of* the
  already-restricted manager, not a replacement for restriction. This matches this project's own
  diagnosis (tool-restriction ≠ good decomposition) almost exactly, and should be read as
  validation of the planned two-layer approach (restrict + few-shot), not as evidence the
  restriction itself is insufficient.
- **Memory/embeddings gotcha directly relevant to a local-only setup**: `memory=True` in
  CrewAI silently calls OpenAI's embeddings API by default even when the LLM is fully local via
  Ollama (multiple GitHub issues, e.g. #447, #685, #4028) — you must explicitly configure
  `embedder={"provider": "ollama", ...}` or you'll get `AuthenticationError`s despite never
  intending to touch a hosted API. Worth remembering if this project ever adopts a CrewAI-*shaped*
  pattern — an accidental network dependency is exactly the kind of thing that silently breaks
  "fully local."

## 2. LangGraph — checkpointing, state schema, supervisor tool restriction

- **Checkpointing**: a `checkpointer` (e.g. `InMemorySaver`, or persistent backends) is compiled
  into the graph; state snapshots are keyed by `thread_id` for "short-term, thread-scoped memory"
  (conversation continuity, time-travel, fault tolerance, resume-after-crash). Each subgraph
  manages its **own checkpoint namespace** — a subgraph's internal state updates are not
  automatically visible to the parent unless deliberately surfaced via `Store` or explicit
  output-schema mapping.
- **State schema / reducers**: state is a `TypedDict`/dataclass/Pydantic schema; each node
  reads/writes it. Plain fields overwrite by default; `Annotated[list, add_messages]`-style
  reducers make specific fields (message lists, findings, errors) accumulate instead of
  overwrite. This is the mechanism for "don't let sub-agent N clobber sub-agent N-1's
  contribution."
- **Context isolation between supervisor and workers IS a documented, real mechanism** (more
  concrete than the prior research doc's "no great default story" framing suggested, though that
  framing is still directionally correct for *tool restriction* specifically — see below):
  subgraphs can declare `OverallState` (full internal schema), `InputState`/`OutputState`
  (narrow schemas constraining what flows in/out), and `PrivateState` (internal-only channels
  never exposed to the parent). This gives genuine structural context isolation — a worker
  subgraph's raw scratch state never leaks upward, only whatever fields are declared in its
  `OutputState`.
- **Supervisor tool restriction — confirmed still NOT a strong default.** Both
  `langgraph-supervisor`'s `create_handoff_tool()` pattern and the newer LangChain "subagents"
  primitive (`docs.langchain.com/oss/python/langchain/multi-agent/subagents`) put the burden on
  the developer: "there's no technical barrier forcing delegation... the architecture assumes
  the parent will choose appropriately." The documented three-layer mitigation from one
  production writeup: (1) give the supervisor zero specialist tools, only `route`/`finish`
  handoff tools, (2) forbid direct action in the prompt, (3) an automated route-accuracy
  evaluator that fails CI on violations — explicitly stating layer (3), not (1)/(2) alone, "is
  the one that actually keeps it out long-term." This is a genuinely new idea not in the existing
  docs: **an automated eval/grader that specifically checks "did the top-level agent call a
  non-delegation tool" and fails the run/build if so** — a testable regression guard for the
  exact bug that was just fixed, not just a one-time prompt/tool-palette change.
- **Subagent context/memory passed**: confirmed default is task description as a fresh human
  message; subagents are explicitly "stateless... each invocation starts with fresh state," with
  an opt-in path to pull additional parent state via `ToolRuntime` if you want a subagent to see
  more (full history, prior results, metadata) — same tradeoff space as `spawn_agent`, just more
  explicitly named as a dial you can turn.
- **Token budget across many nodes**: no built-in budget/router beyond the reducer/isolation
  mechanisms above — LangGraph gives you the primitives (subgraph state scoping, checkpointing)
  but you still design the actual token-budget policy yourself, same conclusion as before, now
  with more precise supporting detail on *how* you'd implement it (narrow `OutputState` schemas
  are the concrete lever, not a vague "compress somehow").

## 3. Microsoft Agent Framework (MAF) — confirmed real, GA, and directly relevant

- **Verified concretely**: MAF 1.0 shipped GA April 3, 2026, is the official unification of
  AutoGen + Semantic Kernel (same engineering teams), built by Microsoft, with parity
  Python/.NET APIs. **AutoGen and Semantic Kernel are now in maintenance mode** (security/bug
  fixes only, no new features) — MAF is where new orchestration patterns land going forward.
  Note: **AG2** (the community fork already cited in prior research as the clean
  `GroupChatManager` tool-restriction example) is a *separate* project from Microsoft's AutoGen
  and is unaffected by this — it continues independently.
- **Orchestration patterns, stable**: sequential, concurrent, **handoff**, **group chat**, and
  **Magentic** (Magentic-One's manager pattern), all supporting streaming, checkpointing,
  human-in-the-loop, pause/resume.
- **Handoff pattern — a genuinely new, non-obvious finding**: MAF's own docs explicitly state
  **you cannot force an agent to always delegate via a handoff tool** — *"It is also not
  possible to force an agent to always handoff by requiring it to call the handoff tool because
  the agent won't be able to generate meaningful responses otherwise."* This is Microsoft's own
  engineering team independently confirming, via a different framework, the exact same tension
  this project just hit: pure tool-restriction on a "can either answer or delegate" agent doesn't
  compose cleanly, because sometimes answering directly (or asking the user) is the correct move,
  not a bug. Their answer for the interactive case is to fall back to a human-input request
  rather than force a tool call — not directly transferable to an unattended-overnight use case,
  but confirms the "restrict-to-only-spawn_agent" approach is the right one **specifically
  because this project's orchestrator's job is 100% decomposition with no legitimate "just answer
  directly" case** — MAF's caveat doesn't apply to a pure-coordinator role, only to a
  "conversational agent that sometimes also delegates" role.
- **Magentic pattern — the closest architectural cousin to the target design, and evidence for
  stronger structural enforcement than tool-restriction alone**: the `manager_agent` in
  `MagenticBuilder` is created as a plain `Agent(name=..., instructions=..., client=...)` **with
  no `tools=` parameter at all** in every documented example — worker agents (researcher, coder)
  get tools, the manager doesn't get any application/task tools, ever. Critically, the manager's
  "delegate to X" decision isn't even exposed to the model as an arbitrary tool call the way
  AG2/CrewAI do it — it's produced as **structured output**: a `MagenticProgressLedger` (fields:
  `IsRequestSatisfied`, `IsInLoop`, `IsProgressBeingMade`, `NextSpeaker`, `InstructionOrQuestion`)
  plus a `TaskLedger`/plan, both framework-internal data structures, not natural-language tool
  calls the model could fumble. This is a **stronger mechanism than what's already been
  considered**: instead of merely removing tools from the coordinator (which still requires the
  model to correctly emit a `spawn_agent` tool call in valid JSON — the exact CrewAI-noted
  small-model JSON fragility risk above), MAF's Magentic manager's *entire output space* is a
  small structured schema (next speaker + instruction string), which is both easier for a weak
  model to produce reliably and impossible to "do the work myself" with, because there is no
  "do the work myself" action in its output schema at all. **This is the single most actionable
  new idea from this research pass**: consider whether the orchestrator's decision each turn can
  be constrained to a small structured object (`{next_agent, instruction}` or similar, via
  constrained decoding / grammar-constrained generation, which local llama.cpp/GGUF serving
  already supports) rather than relying on tool-call JSON emission for delegation — removes an
  entire class of small-model failure (malformed tool calls, or choosing to answer directly
  because "spawn_agent" is competing against other action affordances in the same generation
  space).
- **Stall/replan handling**: Magentic tracks consecutive non-progressing rounds via the progress
  ledger and automatically triggers a replan after `max_stall_count` — a built-in mechanism for
  "the model is going in circles," worth stealing conceptually regardless of framework choice.
- **Single-GPU / local model support**: MAF explicitly lists **Ollama** as a supported model
  provider alongside Foundry/Anthropic/Azure OpenAI/OpenAI
  (`agent-framework/agents/providers`). Like CrewAI and LangGraph, MAF's "agents" are just
  differently-prompted/differently-toolscoped clients pointed at the same chat-completions
  endpoint — nothing in any of the three frameworks requires N separate model server processes.
  All three are compatible in principle with routing every "agent" through the same single
  `ensureServing`-managed llama-server/Ollama backend this project already uses; the frameworks'
  abstraction (agent = prompt + tool list + shared client) already matches a single-backend
  constraint, it's just that none of them are *designed* around this project's specific
  "swapping costs real wall-clock time so batch same-model work together" constraint — that's a
  scheduling policy layered on top of any of them, not something they model natively (confirms
  and slightly sharpens the earlier `lmxd`-based conclusion in `orchestrator-research.md`).

## Direct answers, synthesized across all three

- **Single-GPU/single-model constraint**: none of the three frameworks assume "swapping is
  free" in a way that's actually incompatible with this project — they're all backend-agnostic
  (agent = client + prompt + tools), so they'd happily run every "agent" against the same
  resident llama-server instance. But none of them *model* this project's specific cost
  (seconds-to-minutes swap latency) as a first-class scheduling concern either — that logic
  (batch same-model calls, `ensureServing`) has to be layered on top of whichever pattern is
  picked regardless of framework. Adopting any of these frameworks wholesale would not remove or
  reduce this work.
- **Context/memory passed between agents**: all three converge on the same answer — **a
  structured handoff object (task description + context string, or task ledger + progress
  ledger), not a full transcript replay, and not a bare one-line summary either.** CrewAI: two
  strings (`task`, `context`). LangGraph subagents: task-as-human-message by default, optionally
  richer via `ToolRuntime`. MAF Magentic: a structured `TaskLedger` + `ProgressLedger` object.
  This validates (doesn't just confirm) this project's existing `spawn_agent` design of fresh
  `[system, user]` messages + returned digest string — arguably it's worth going one step further
  toward MAF's ledger richness (a small structured object instead of a single opaque report
  string) without adopting the whole framework.
- **What's NOT yet considered that would directly help**: two concrete new levers surfaced this
  session, both worth prototyping cheaply before any retraining:
  1. **Grammar/schema-constrained decoding for the orchestrator's delegation decision** (MAF
     Magentic's structured-ledger insight) — instead of the model needing to correctly emit a
     `spawn_agent(...)` tool call in valid JSON among a still-open-ended generation space,
     constrain its per-turn output to a tiny fixed schema (`next_agent`, `instruction`) via
     llama.cpp/GBNF grammar constraints (already supported by llama-server) — this removes both
     the "chose not to delegate" failure mode and the "malformed tool call" failure mode
     CrewAI's own code defensively works around, without needing a bigger/different model.
  2. **An automated CI/eval regression check for delegation compliance** (the LangGraph
     three-layer supervisor-restriction writeup's layer 3) — add a check to the existing
     `graders.ts`/`agentic` suite that specifically asserts "in orchestrator mode, zero
     non-`spawn_agent` tool calls occurred at the top level," so this exact bug can never
     silently regress after future prompt or model changes, the same way any other regression
     would be guarded against.

## Verdict

**Yes, there is one worthwhile architectural refinement beyond the tool-restriction fix already
built — but no, none of these three frameworks are worth adopting wholesale.**

All three frameworks (CrewAI, LangGraph, Microsoft Agent Framework) independently converge on
exactly the shape already built: a coordinator with a structurally minimal tool/action palette,
receiving and returning **structured handoff objects (task+context strings, or ledgers), not raw
transcripts** — this is strong, freshly-verified (source-level, not blog-level) confirmation
that the same-day fix is the right mechanism, not a stopgap. CrewAI's *current* source (not the
outdated 2025 anecdote) actually enforces manager tool-restriction as a hard exception,
identical in spirit to this project's fix — the CrewAI "failures" people report are
decomposition-quality problems layered on top of an already-restricted manager, which matches
this project's own stated risk almost exactly.

None of the frameworks are worth adopting as infrastructure: all three assume a hosted-API
mental model where model identity is just a string parameter to a client object, none of them
model the actual scarce resource (GPU residency / swap latency) as a first-class concept, and
CrewAI specifically carries a real risk of silently phoning home (OpenAI embeddings for
`memory=True`) that would be actively harmful to reintroduce into a fully-local project.
Bringing in a framework here would mean re-solving problems (fresh-context sub-agents,
structured handoffs, digest-on-return) this codebase has already solved, in exchange for a large
dependency and a mental model (free model-swap, hosted-API assumption) that actively fights this
project's hardware.

**The one idea worth prototyping that isn't already in the plan**: Microsoft Agent Framework's
Magentic manager doesn't just have zero tools — its entire per-turn decision is a small
**structured object** (next-speaker + instruction), not a free-form tool call the model has to
get right. For an 8B model with a documented weak zero-shot instruction-following prior, this is
strictly stronger than "remove tools and hope it emits a correct `spawn_agent` call": use
**grammar-constrained decoding** (llama.cpp/GBNF, already available via llama-server) to make the
orchestrator's output *literally only capable of* being `{next_agent, instruction}`, removing
malformed-tool-call risk entirely — a cheap, no-retraining addition to test right after the
tool-restriction fix, before reaching for SFT.

**Verified against this project's own `llama-b9835` binary** (not assumed from upstream docs):
`llama-server --help` confirms `--grammar`, `--grammar-file`, `--json-schema`/`-j`,
`--json-schema-file`/`-jf` exist as server-launch flags, and `strings` on the shipped
`libllama-server-impl.so` confirms the compiled request-parsing code recognizes the literal keys
`"json_schema"`, `grammar`, `grammar_triggers`, `grammar_lazy` — per-request grammar/schema
constraints are compiled into this build. Caveat also found: the OpenAI-style `response_format`
field on this build is constrained to `"text"` or `"json_object"` only — the standard OpenAI
`response_format: {type: "json_schema", ...}` wrapper is **not** the right integration point;
the correct approach is a flat top-level `json_schema` (or `grammar`) field directly in the
request body, a llama.cpp-native extension, not an OpenAI-standard one. This is still not fully
proven end-to-end (static string analysis confirms the fields are recognized, not that the
specific chat-completions handler path threads them through to the sampler for this exact
build/version) — a live `curl` test is required before committing further code to this idea.

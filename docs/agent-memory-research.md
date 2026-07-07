# Agent memory & context-optimization landscape (2026) — deep dive

Builds on `docs/orchestrator-research.md` (context compaction, hot/warm/cold layering) and
`docs/victory6-architecture-research.md` (ENGRAM arXiv paper 2511.12960 — episodic/semantic/
procedural router; that paper is NOT the same thing as any GitHub "Engram" project, see §5).
This doc goes wider: six specific projects, verified live (GitHub, PyPI, docs fetched directly
this session, not just search snippets), scored on (a) real/maintained, (b) local-fit, (c) the
one adoptable mechanism.

## 1. Letta (formerly MemGPT)

**(a) Real, actively maintained.** OS-inspired three-tier memory: **core** (always in-context,
labeled string blocks like `human`/`persona`, edited via agent tool calls
`core_memory_append`/`core_memory_replace` — this IS the self-editing-memory idea), **archival**
(vector DB, unlimited size, explicit search), **recall** (full conversation history in a DB,
searchable rather than replayed). The agent is its own memory controller — it decides when to
write/search each tier via tool calls, not an external heuristic.

**(b) Local fit — mixed.** Ships with SQLite by default (`~/.letta/letta.db`) with `sqlite-vec`
for vector similarity — genuinely runs with zero extra services. But: SQLite is explicitly
**not officially supported for migrations** (Postgres+pgvector is the "real" path), and the
full/recommended deployment is Docker + Postgres. Running the whole Letta *server* (it's a
stateful agent platform, not just a memory library) is heavier than this project needs — it
wants to own the agent loop, not slot into `toolloop.ts` as a dependency.

**(c) What's worth adopting:** not the framework — **the core-memory-block pattern itself**.
A small number of labeled, bounded (e.g. ≤500 token), agent-editable string blocks that live in
every prompt (e.g. `project_conventions`, `known_gotchas`, `current_task_state`) which the model
updates via explicit tool calls (`memory_replace`, `memory_append`) is directly portable to
`/code` with zero new infra — just 2 new tools in `agent-tools.ts` and a block store as flat
files or a `memory.json`. This is the single cheapest, highest-value idea from this whole
survey for the `/code` agent's per-session memory gap.

## 2. Mem0

**(a) Real, actively maintained**, large user base, Python/TS SDKs.

**(b) Local fit — depends heavily on which "Mem0" you mean.** The full **self-hosted stack**
(what their own Docker guide ships) is three containers: FastAPI + **Postgres/pgvector** +
**Neo4j** — infra this box doesn't have and shouldn't stand up for one coding agent. BUT the
**Python library** used directly (not the hosted server) can run with a local Chroma vector
store + local sentence-transformers embeddings + Ollama for the extraction LLM, entirely
offline, no Docker, no cloud key — this is a legitimate dependency-light path (adds `chromadb`
as a Python dependency, which is a modest ask, not a "new infra" ask).

**Memory-promotion mechanism (the actually interesting part):** on every `add()` call, an LLM
extracts salient facts/preferences from the new turn, then a second step does semantic-
similarity matching against existing stored memories and picks ADD / UPDATE / DELETE /
NOOP per fact — i.e., **memory writes are themselves LLM-mediated decisions**, not
just "append everything then compress later." This decouples "what happened" (raw transcript)
from "what's worth remembering" (a curated fact store) cleanly.

**(c) What's worth adopting:** the **extract → dedupe-or-update decision** loop, not the hybrid
vector+graph+KV storage engine. For this project a much smaller version is sufficient: after a
session/subagent completes, one small-model call extracts 0-N atomic facts, then a plain
substring/embedding-similarity check against a local flat memory file decides
add-vs-update-vs-skip. No vector DB required if the fact store stays small (hundreds, not
millions, of entries) — a local sentence-transformers embedding + brute-force cosine over an
in-memory list is entirely adequate at this scale and needs no server process.

## 3. Graphiti (Zep)

**(a) Real, actively maintained** (196+ releases, active issue/PR traffic, backed by a funded
company), academically documented (arXiv 2501.13956), strong published benchmark results
(LongMemEval: +18.5% accuracy, -90% latency vs. naive approaches).

**(b) Local fit — infra-heavy, this is the one to mostly skip.** Requires a genuine **graph
database**: Neo4j (5.26+) is the primary supported target, FalkorDB is the lighter alternative
(has an embedded "Lite" mode needing Python 3.12+, avoiding a separate server process), Kuzu
support is now deprecated/unmaintained upstream. Even the "lightest" real path still means
adding and operating a graph-native query engine (Cypher-like) alongside the existing stack —
a categorically bigger footprint than anything else in this list, for a single local agent whose
session memory doesn't currently need multi-hop relationship queries.

**(c) What's worth adopting — one concept, not the engine:** the **bi-temporal edge model**
(every fact/relationship has both "when it was true" and "when it was recorded," so
contradictions get invalidated rather than silently overwritten, preserving history). If the
orchestrator's cross-agent memory ever needs "this used to be true, then agent X changed it,"
that's the one idea worth stealing conceptually — implementable as a plain append-only JSONL of
`{fact, valid_from, valid_until, source_agent}` records, no graph DB needed, just discipline
about never mutating past records in place. Skip the actual project.

## 4. Cognee

**(a) Real, actively maintained** — notably larger/more active than the others surveyed here
(27.1k stars, 8,429 commits, 121 releases, latest June 2026).

**(b) Local fit — genuinely good, best of the graph/vector-hybrid tools surveyed.**
Cognee's own docs state local development "stays fully embedded — SQLite, LanceDB, and
Kuzu — with no extra services to stand up"; `pip install cognee` + Python 3.10+ is the entire
setup, no Docker required. This is the one heavyweight-sounding project that actually clears
the "no infra this box doesn't have" bar as shipped, not just via a workaround.

**Caveat specific to this hardware:** the `cognify` step (turns raw text into a graph of
entity/relationship triples) is **LLM-call-heavy** — every ingested chunk costs a real
inference call for entity/relation extraction. On a single 8GB GPU that's already paying a
real cost for model-swapping (per `orchestrator-research.md` §4), running Cognee's full
graph-construction pipeline over every session transcript would compete for the same GPU
time as the agent's own work — not free just because it's "local."

**(c) What's worth adopting:** the **operation-name framing** (`Remember`/`Cognify`/`Recall`/
`Forget` as four distinct, individually invokable memory lifecycle stages) is a clean mental
model for structuring `/code`'s own memory API, even implemented with zero graph DB: "remember"
= append raw note, "cognify" = periodic small-model pass that extracts structured
facts/entities from recent notes into a flat store, "recall" = retrieval (BM25 over flat files
is enough at this scale), "forget" = explicit pruning. Skip the actual Kuzu-backed graph engine
unless/until cross-file relationship queries become a real, felt need.

## 5. "Engram Core" — does NOT exist as a single project matching the user's description

Searched directly (not assuming continuity with the arXiv paper already documented in
`victory6-architecture-research.md` §3, which is unrelated — that paper is general
episodic/semantic/procedural memory routing for conversational agents, nothing code-specific).
There is **no single project literally named "Engram Core"** that matches "structural code
context optimization for developer agents." What actually exists under the "Engram" name is a
crowded namespace of **at least six unrelated projects**, several created/renamed very recently:

| Project | What it actually is | Code-context-specific? |
|---|---|---|
| `deepseek-ai/Engram` | Model-*architecture* research (conditional memory/lookup layer inside a transformer) — pretraining-level, not agent-level. Already flagged as N/A in prior doc. | No |
| PyPI `engram-core` (0.3.0, Feb 2026, author "Levent") | Generic zero-config local memory layer for AI agents (SQLite, full-text + optional embeddings, multi-agent namespaces, memory decay). **Verified via PyPI page — description is generic memory, explicitly NOT code-structure-aware.** | No |
| `NickCirv/engram` | **The closest real match to the user's description.** "The context spine that 10x's every AI coding session" — intercepts file reads at the IDE boundary, builds a tree-sitter AST-based knowledge graph (calls/imports/co-changes across files), tracks "bi-temporal mistakes" from git revert history, substitutes raw file reads with ~500-token structural summaries. Claims a measured 89.1% per-file token reduction on its own 87-file repo (163,122 → 17,722 tokens), benchmarked via a script in-repo, not just a marketing number. Local SQLite via sql.js WASM, zero cloud, Apache 2.0, live in 8 IDEs incl. Claude Code. Actively developed (v4.5.0, June 2026; 137 stars, 20 releases, 1,149 tests). | **Yes — this is the real thing the user was pointing at, just not named "Core."** |
| `Gentleman-Programming/engram` | Go binary, SQLite+FTS5, MCP server/HTTP/CLI/TUI, generic persistent memory for coding agents — general-purpose, not AST/structure-aware specifically. | Partially |
| `softmaxdata/engram` | "Brain-inspired portable context database" — a server running a canonical LLM ("the Reflector") over all agent input, contexts with intent anchors + bounded core memory + activity ledger. Generic multi-agent memory server, not code-structure-specific. | No |
| `EvolvingLMMs-Lab/engram` | Privacy-first, E2E-encrypted personal memory layer ("Signal for AI Memory") — general personal-assistant memory, not code-specific. | No |

**Verdict:** if "Engram Core" was recalled as "structural code context optimization for
developer agents," the real project matching that description is `NickCirv/engram` (unqualified
name, not "-core"), and even that is a young, modestly-starred (137★) project — worth reading
for the *idea*, not worth taking a hard dependency on. There is no evidence a project literally
named "Engram Core" with this description exists; treat the specific name as a
misremembering/hallucination risk and use `NickCirv/engram`'s actual mechanism as the reference
instead.

**(c) What's worth adopting regardless of the name confusion:** the core mechanism —
**AST-aware structural summarization of files instead of raw re-reads, cached and invalidated by
git-diff/co-change tracking** — is directly relevant to `/code`'s `read_file`/`grep` tool costs
and cheap to build locally: tree-sitter is a small, well-understood dependency (no server, no
DB), and "cache a structural summary keyed on file hash, invalidate on write" is a straightforward
addition to `agent-tools.ts` that doesn't require adopting any external framework.

## 6. ReMe (agentscope-ai/ReMe, formerly MemoryScope)

**(a) Real, actively maintained, verified directly via GitHub fetch.** Maintained by Alibaba's
AgentScope team, 880+ commits, 62 releases, latest v0.4.0.6 (July 2026), with an ACL 2026
Findings paper behind it (arXiv 2512.10696, "Remember Me, Refine Me"). This is a legitimate,
well-evidenced match for "file-based context compression layer for token-efficient sessions" —
confirmed, not a hallucination.

**(b) Local fit — good, this is the most directly reusable pattern of the six.** Storage is
**plain Markdown files with YAML frontmatter and wikilinks** — no vector DB or graph DB is
required; BM25 keyword search is built in with zero external dependencies, and
embeddings/semantic search are opt-in only (env-var gated, degrades gracefully without them).
This is architecturally close to what the project already does by hand
(`_orchestrator/plan.md`, `MEMORY.md`) — ReMe is a more disciplined, staged version of the exact
same idea, not a different paradigm requiring new infra.

**Pipeline (the actually valuable part):** four escalating stages — **Auto Memory** (raw
conversation → daily memory cards), **Auto Resource** (external files → source-linked daily
cards), **Auto Index** (BM25 + wikilink graph maintenance, no embeddings needed), **Auto Dream**
(a periodic consolidation pass distilling daily cards into `digest/` — durable
personal/procedural/wiki memory). Data flows `session/ → daily/ → digest/`, each stage a
progressive compression, never a single one-shot "summarize the whole transcript" pass.

**(c) What's worth adopting — directly, almost as-is:** the **session → daily → digest
three-stage folder pipeline with wikilinks**, applied to both halves of this project's gap:
- `/code` session memory: raw transcript stays as-is (already fixed per
  `victory6-architecture-research.md` §4's tool-call-memory bug fix) → a small-model pass
  produces a "daily card" per session (what changed, what was learned, open threads) →
  periodic "dream" pass merges related daily cards into a durable per-project digest file.
- Orchestrator cross-agent memory: this is nearly a direct fit for the existing
  `_orchestrator/plan.md` pattern — turn plain markdown into frontmatter+wikilinked cards per
  sub-agent run, with an explicit consolidation step that merges related findings instead of
  letting the plan file grow unbounded. BM25 (a small, pure-Python/local dependency, e.g.
  `rank-bm25`) is enough for retrieval at this scale — no embedding model or vector DB needed
  unless recall quality proves insufficient in practice.

---

## Cross-cutting comparison

| Project | Actively maintained? | Runs with zero heavy new infra? | Adoptable mechanism (not the framework) |
|---|---|---|---|
| Letta | Yes | Partially (SQLite works but unsupported for migration; full deployment wants Postgres+Docker) | Labeled, bounded, agent-editable core-memory **blocks** as explicit tool calls |
| Mem0 | Yes | Only via the raw Python library + local Chroma/Ollama, not the "real" self-hosted stack (Postgres+Neo4j+FastAPI) | LLM-mediated **extract → add/update/delete/noop** decision per fact |
| Graphiti | Yes | No — needs a graph DB (Neo4j/FalkorDB), even "lite" mode is a step up in footprint | Bi-temporal fact validity (`valid_from`/`valid_until`) as append-only JSONL, no graph engine |
| Cognee | Yes (most active of the graph/vector tools) | Yes as shipped (SQLite+LanceDB+Kuzu fully embedded, no Docker) — but the `cognify` step is real GPU-competing compute | Remember/Cognify/Recall/Forget as four named memory-lifecycle operations |
| "Engram Core" | N/A — no such project exists under that exact name/description | N/A | Closest real match is `NickCirv/engram`: AST-aware structural file summaries cached + invalidated on write, using tree-sitter (small, no server) |
| ReMe | Yes, verified | Yes — plain Markdown + optional BM25, embeddings fully opt-in | session → daily → digest three-stage folder pipeline with frontmatter + wikilinks |

## Recommendations — what's actually worth building here

**Build (small, local-first, justified by this survey):**
1. **Core-memory blocks for `/code`** (from Letta): a handful of labeled, bounded, agent-editable
   markdown/JSON blocks (`project_conventions.md`, `known_gotchas.md`, `current_task_state.md`)
   injected into every session's system prompt, with two new tools
   (`memory_read`/`memory_write`) in `agent-tools.ts`. No new dependency at all — this is the
   highest value-to-effort item in the whole survey and directly plugs the "zero persistent
   memory beyond one conversation" gap named in the task.
2. **A session → daily → digest pipeline for both `/code` and the orchestrator** (from ReMe):
   plain markdown + frontmatter, BM25 (`rank-bm25`, pure Python, no server) for retrieval,
   embeddings deferred/optional. This generalizes the existing `_orchestrator/plan.md` pattern
   rather than replacing it, and gives `/code` a real cross-session memory store for the first
   time.
3. **A tiny extract-then-dedupe fact loop for the orchestrator's cross-agent memory** (from
   Mem0's mechanism, not its infra): after each sub-agent/`digest_findings` call, one small-model
   pass extracts atomic facts, checked against existing facts via local embedding
   cosine-similarity (a small sentence-transformers model already fits this box) or even plain
   substring/fuzzy match at first, deciding add/update/skip — avoids the plan file growing
   monotonically and unboundedly, which is the orchestrator's current failure mode.
4. **AST-aware structural file caching for `read_file`/`grep`** (from `NickCirv/engram`'s actual
   mechanism): tree-sitter-based structural summaries cached by file hash, invalidated on write —
   cuts the token cost of repeated file reads within long agent sessions, complementary to (1)-(3)
   rather than competing with them.

**Skip as overkill for this hardware:**
- **Graphiti** — needs a graph database; this box has no graph DB and no felt need yet for
  multi-hop relationship queries over a single agent's session memory. Revisit only if
  cross-session entity-relationship queries become a proven, recurring need.
- **The full Mem0 or Letta *servers*** — running either as a standalone service (Docker, Postgres,
  possibly Neo4j) is infra this project doesn't have and doesn't need for one local coding agent;
  their *mechanisms* are worth stealing (items 1 and 3 above), their *platforms* are not worth
  deploying.
- **Cognee's full graph-construction pipeline** — the embedded local mode is genuinely
  lightweight to install, but routing every session transcript through an LLM-driven
  entity/relation extraction pass is real, recurring GPU time this box can't spend for free;
  the flat-file/BM25 approach (item 2) delivers most of the same practical benefit far cheaper.
- **Adopting any literal "Engram Core" dependency** — it doesn't exist under that name/
  description; don't take a dependency on `NickCirv/engram` itself either (young, 137★, IDE-hook
  architecture built for a different integration surface than this project's own `agent-tools.ts`)
  — reimplement the cache-and-invalidate idea directly instead.

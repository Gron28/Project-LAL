# Project-LAL capability elevation plan

Status: proposed deep plan; subordinate to the foundation roadmap.
Created: 2026-07-19.
Repository basis: `a2f0ea8cbccc22eba54b9aff0661f6b4b0509e63` plus this
documentation-only plan change.

This document turns the long-term Project-LAL vision into an ordered technical
program. It is intentionally not permission to skip the active reliability,
repository-boundary, or security work in
[`project-lal-foundation-roadmap.md`](project-lal-foundation-roadmap.md).

The desired outcome is a free, local-first personal AI workstation that helps an
ordinary person discover, run, compare, train, and compose capable agents on the
hardware they already own. The optimization target is useful, trustworthy work
per constrained machine—not model size, benchmark theater, or feature count.

## 1. Executive decision

Project-LAL should make one architectural move before expanding its surfaces:

> Establish one local capability registry and job control plane, consumed by the
> web UI, LAL CLI, HIVE, training, benchmarking, and runtime gateway.

The registry is broader than a model list. It records immutable artifacts,
source revisions, licenses, runtime compatibility, hardware observations,
evaluation evidence, dataset lineage, and relationships between base models,
quantizations, adapters, conversations, and runs.

The system then has one coherent shape:

```text
Remote catalogs             Local control plane                 Consumers
Hugging Face ─┐       ┌─ capability registry ─────────────┐     Web UI
Ollama ───────┼──────▶│ artifacts + provenance            │──── LAL CLI
Local files ──┘       │ jobs + quotas + approvals          │──── Chat / Code
                      │ runtime profiles + GPU lease       │──── HIVE
Web/media sources ───▶│ evaluations + datasets + lineage   │──── Train / Bench
                      └────────────────────────────────────┘
```

Four decisions follow:

1. Model discovery and downloading are asynchronous host jobs, never arbitrary
   browser-side file fetches.
2. Model quality and machine fit are separate axes. Project-LAL does not publish
   a deceptive universal score.
3. A visual HIVE editor compiles a typed graph into the existing durable
   `WorkflowSpec`; the canvas never owns execution truth.
4. Open inquiry is epistemically permissive and operationally bounded. Defensive
   security work requires declared scope, authorization, isolation, and audit.
5. The public checkout contains portable engines and schemas. Host facts,
   personal paths, secrets, compatibility exceptions, mutable data, and local
   experimental recipes live in versioned state outside Git.
6. The present Linux/GNOME/AMD machine is the first supported compatibility
   capsule and regression baseline. Portability work must reproduce its working
   behavior before replacing any current path; it is not a license for a big-bang
   cleanup.

## 2. What already exists and must be preserved

The implementation is not starting from zero. Important working seams are:

- `web/src/lib/lab.ts` discovers local GGUF and Ollama artifacts, owns the
  llama.cpp/Ollama handoff, enforces a single practical GPU lease, records
  hardware observations, runs benchmarks, and manages training processes.
- `web/src/app/api/agent/models/route.ts` is already the shared web model/settings
  endpoint, but its model representation is only name/source/size.
- `web/src/lib/runs.ts` and `web/src/lib/protocol/` provide durable run ledgers,
  replay, typed event validation, lifecycle state, and retention.
- `web/src/lib/lal-cli.ts` already provides authenticated CLI device access and
  a capability-oriented gateway surface.
- `web/src/lib/hive/store.ts` already has SQLite tables for workflows, nodes,
  events, artifacts, evidence, model profiles, approvals, side effects,
  datasets, checkpoints, and role overrides.
- `web/src/lib/hive/contracts.ts` already defines model capabilities, typed task
  envelopes, workflow nodes, routing decisions, budgets, and validation.
- `web/src/lib/hive/provenance.ts` already hashes corpora, records ordered example
  membership, quarantines proposed examples, and separates candidate creation
  from promotion.
- `web/src/lib/autopsy.ts` already derives deterministic failure diagnoses and
  per-model run reports.
- Browser chat already accepts image attachments and routes them through local
  Ollama vision models. The inherited CLI contains image and audio bridge code,
  though LAL parity and provenance are incomplete.

These are foundations to consolidate, not competing prototypes to replace.

## 3. Current gaps that determine sequence

### 3.1 Trust boundary

The CLI inference gateway is authenticated, but most browser APIs trust network
placement. Several mutation routes accept an absolute workspace chosen by the
request. `resolveSafe` prevents escaping that selected root, but the selection
itself is not an authorization grant. Model deletion, filesystem writes, Git
operations, training, HIVE execution, and downloads therefore need a common
application authorization layer before the system is widened.

Tailscale Serve can forward verified identity and application-capability headers
and applies tailnet grants, but Tailscale explicitly recommends that a backend
which trusts those headers listen only on localhost. LAL should use those signals
when present while retaining a local-session authentication path for machines
without Tailscale.

### 3.2 Split model truth

The web inventory, HIVE model profiles, settings file, runtime singleton, Ollama
manifests, local filenames, and CLI model surface represent overlapping truths.
None is a complete durable identity for a particular byte-level artifact.

### 3.3 Evaluation truth

The benchmark UI is useful for experiments but does not yet guarantee immutable
suite versions, model hashes, runtime revisions, hardware snapshots, repeats,
raw outputs, grader revisions, or statistically meaningful comparison.

### 3.4 Media truth

Images and audio can enter selected paths, but they are not yet first-class
content-addressed evidence with origin, derivation, extraction model, consent,
retention, and cross-surface rendering.

### 3.5 HIVE authoring truth

HIVE has a real durable DAG engine and fixed templates. The UI visualizes a run,
but it is not yet a versioned graph authoring system. The API accepts a custom
`spec`; a safe authoring layer must validate and compile that spec before a run.

### 3.6 Open-source truth

The repository remains internally described and has no root release license or
complete distribution/security contract. The inherited CLI license cannot grant
rights to every root-owned file by implication.

### 3.7 Host-bound system truth

`PORTING.md` accurately documents that the current trainer, service, monitoring,
and deployment paths were tuned for one Linux/GNOME host: an AMD RX 6650 XT
presented to ROCm as another target, 8 GB VRAM, about 16 GB RAM, one particular
Python environment, systemd, NVM, Tailscale, Ollama, and a local llama.cpp build.
That document is valuable evidence, but its current operational answer is still
to have every new owner or coding agent retune source code.

The machine contract currently leaks through the whole system:

- `gpuTrainEnv()` and `web/run_web.sh`, which default an RDNA2 ROCm override;
- `scripts/fakebin/rocminfo`, a deliberate compatibility shim for this card;
- state paths for runs, HIVE, memory, settings, conversations, benchmarks,
  webshots, CLI devices, and prompts derived from the web process working
  directory;
- Linux `/proc` and `/sys` monitoring with a fixed DRM `card1` and AMD-specific
  sensors;
- process discovery/control through `ps`, `pgrep`, `pkill`, signals, and systemd
  cgroups;
- fixed llama.cpp build layout, Ollama store layout, loopback endpoints, context
  policy, and reserved ports;
- service/install/update paths that assume systemd, one NVM version, GNOME desktop
  integration, Tailscale Serve, and another local service occupying port 443;
- the supported Linux-host/Windows-client/phone topology, embedded in release,
  pairing, update, and smoke workflows;
- route and preview assumptions inherited from a single-user LAN/tailnet deployment;
- fixed `.venv/bin/python`, repository-relative `data/`, `out/`, `models/`, and
  llama.cpp paths in the web training controller;
- hard-coded `cuda:0` assumptions and 8 GB/15 GB survival techniques in the HQQ,
  QLoRA, offload, and Lens experiments;
- a systemd unit whose working directory names the current owner's Desktop;
- one personal absolute upload path in `build_sovereign.py`;
- unpinned remote dataset revisions and direct `resolve/main` downloads in
  several importers;
- no reproducible Python dependency contract for the training backends.

Some of these are correct choices for this owner and topology. The flaw is not
that they exist; it is that implementation, detected fact, local policy, and
universal product default are not separated. Runtime data is ignored, which is
correct, but much of it is still written under the checkout. Ignoring a path is
not the same as separating product source from mutable owner state.

## 4. Non-negotiable invariants

1. **Local by default.** Core use does not require a provider account. Network
   sources are optional adapters whose activity is visible.
2. **One authoritative state.** Web and CLI render the same model, job, run,
   artifact, and workflow records through a shared versioned protocol.
3. **Bytes define identity.** A mutable model name or `latest` tag is never the
   durable identity used for evaluation or training lineage.
4. **No hidden hardware claims.** Context, offload, memory, speed, and load state
   are measured or shown as unknown.
5. **No universal model winner.** Comparisons preserve quality, reliability,
   latency, throughput, memory, energy, and workload fit as separate dimensions.
6. **One GPU owner.** Downloads may use disk/network concurrently, but inference,
   evaluation, training, Lens, and media processing participate in the existing
   host resource lease.
7. **Graphs are data.** A HIVE definition is immutable and versioned once run;
   edits create a new revision.
8. **Execution is recoverable.** Long jobs checkpoint progress, support cancel,
   and settle durably after restart.
9. **External content is untrusted.** Model cards, web pages, images, transcripts,
   archives, filenames, and tool output cannot become system instructions.
10. **Evidence survives synthesis.** Derived claims retain links to exact source
    artifacts and transformations.
11. **Referenced artifacts are protected.** Retention never silently deletes
    bytes referenced by a promoted model, reproducible evaluation, or dataset
    manifest.
12. **Open inquiry does not imply unscoped action.** Reasoning about a subject and
    executing a consequential tool are separate permissions.
13. **One checkout runs on many hosts.** Hardware adaptation changes external
    facts, profiles, or recipes; it does not require a private source fork.
14. **Detection never silently becomes policy.** Probes report capabilities and
    failures. A user or reviewed recipe decides whether an unsupported workaround
    such as a GPU-target override is acceptable.
15. **Training environments are optional and isolated.** A core install does not
    pull every CUDA, ROCm, MPS, or quantization dependency.
16. **Compatibility changes are proven, not presumed.** The current owner's chat,
    code, CLI attach, HIVE, model serving, monitoring, service restart, and tiny
    training workflows are golden acceptance paths during migration.

## 5. Canonical domain model

Use SQLite for metadata and content-addressed files for large bytes. This matches
the current single-host topology and existing HIVE store. Do not add a server
database until measured concurrency requires it.

### 5.1 Core records

#### `catalog_sources`

Defines an adapter, not a model:

- `id`, `kind` (`huggingface`, `ollama`, `local`), base endpoint;
- enabled/disabled state, last refresh, cache policy;
- credential reference, never credential contents;
- network policy and trust notes.

Initial adapters are Hugging Face, Ollama, and local import. Additional sources
must implement the same read/search/resolve contract.

#### `model_records`

Represents a logical model or fine-tuned descendant:

- stable internal ID, display name, upstream namespace/repository;
- family, architecture, parameter count, modalities, languages;
- intended uses, limitations, upstream card snapshot and retrieval time;
- declared base model and datasets;
- declared license plus `license_status` (`verified`, `declared`, `unknown`,
  `incompatible`);
- tags and publication metadata;
- local notes, rating, pin/archive state.

Upstream metadata is evidence, not truth. Locally measured capabilities live in
evaluation and runtime records.

#### `artifacts`

Represents exact bytes:

- SHA-256 primary identity, model ID, source revision/commit and source URL;
- filename, byte size, media type, format, quantization, shard membership;
- local path or content-addressed blob location;
- expected and observed hashes, verification state;
- download/import job, created/accessed timestamps;
- parser/runtime compatibility and quarantine state.

For GGUF, import available GGUF metadata such as architecture, parameter count,
training context, vocabulary, and tensor data layout. Preserve unknown keys so
new GGUF metadata does not require a destructive migration.

#### `runtime_profiles`

Separates a model artifact from a way of running it:

- backend and backend revision;
- artifact or Ollama manifest digest;
- context, batch, GPU layers/offload, chat template hash, sampling defaults;
- supported input/output modalities and tool/structured-output probes;
- last verified host fingerprint and probe result;
- user-visible name and managed/internal state.

The current Gemma managed profile becomes an ordinary runtime profile instead of
a suffix convention hidden in `lab.ts`.

#### `host_facts` and `host_profiles`

Keep measurements separate from preferences:

- `host_facts` is generated, timestamped probe evidence: OS/build/architecture,
  CPU and RAM, accelerators and memory, driver/runtime versions, filesystem and
  free-space facts, service manager, executable discovery, and backend probe
  results;
- `host_profiles` is owner-authored policy: allowed storage roots, preferred
  runtimes, concurrency/power limits, optional backend environment, and accepted
  compatibility exceptions;
- both carry a schema version and a stable host ID; exports redact usernames,
  absolute paths, network addresses, tokens, and device serials by default;
- a fact can become stale, while a profile can be invalid. Neither is compiled
  into repository source.

#### `training_recipes` and `training_runs`

A training recipe is a versioned declaration, not an arbitrary shell command:

- runner/plugin ID and exact recipe revision;
- supported model families and input dataset schema;
- required capabilities and tested compatibility classes;
- parameter defaults and safe ranges for block size, precision, quantization,
  LoRA, batch/accumulation, checkpointing, validation, and merge/export;
- resource estimates, expected phases, resumability, outputs, and validation;
- explicit environment-variable allowlist and documented compatibility
  exceptions;
- dependency bundle/lock identity and source revision.

A training run binds that recipe to exact host facts, host profile, base artifact,
dataset version, source revision, dependency environment, arguments, checkpoints,
logs, evaluations, and outputs. The current `ExperimentRecord` becomes a migration
source rather than a second permanent training truth.

#### `jobs`

One durable job abstraction covers download, verify, import, probe, benchmark,
evaluation, conversion, quantization, training, transcription, and cleanup:

- ID, kind, requested-by identity, capability scope;
- state (`queued`, `waiting_approval`, `running`, `paused`, `succeeded`,
  `failed`, `cancelled`, `interrupted`);
- resource request (`network`, `disk`, `cpu`, `gpu`, `workspace`);
- progress counters and phase, checkpoint, structured error;
- inputs/outputs as artifact references;
- parent job and run/workflow correlation IDs;
- timestamps, log location, retention class.

Do not pretend every job can resume mid-byte or mid-kernel. Its record must state
whether restart means resume, retry from a verified checkpoint, or restart.

#### `evaluation_suites`, `evaluation_runs`, `evaluation_cases`

An immutable suite version includes:

- task definitions, prompt/template hashes, dataset revision/hash and license;
- scorer/grader identity and revision;
- contamination notes, splits, seeds, repeats, warmup policy;
- capability domain and minimum runtime requirements.

An evaluation run binds the suite to:

- exact artifact/runtime profile and chat-template hash;
- host hardware/software fingerprint;
- all decoding options and environment revisions;
- raw per-case inputs/outputs, timings, tool traces, grader results;
- interruptions, exclusions, and confidence intervals where meaningful.

#### `datasets` and `dataset_examples`

Extend the existing HIVE provenance rather than adding a separate training DB:

- immutable dataset version and ordered example IDs;
- source card snapshot, license, purpose, collection/generation method;
- parent datasets/artifacts/runs and transformation job;
- split membership and leakage group;
- deterministic checks, quarantine/review state;
- consent/privacy notes where applicable.

#### `media_assets` and `derivations`

A media asset is an artifact with additional evidence metadata:

- origin (`upload`, local file grant, URL, screenshot, generated);
- original URL and page URL, retrieval time, HTTP metadata where applicable;
- detected and declared MIME types, dimensions/duration;
- user ownership/consent note and retention class;
- thumbnail/waveform/OCR/transcript/caption children;
- transformation model/runtime and confidence/language.

Model the lineage as entities and activities: source image → normalization job →
vision observation; audio → transcription job → timestamped transcript. This is
compatible with the W3C PROV entity/activity/agent model without requiring RDF.

### 5.2 Relationships that must be queryable

- Which exact model bytes and runtime generated this message or tool call?
- Which conversations and HIVE nodes used a model before it was deleted?
- Which benchmark evidence supports a capability badge?
- Which dataset examples and code revision produced an adapter?
- Which evaluation caused a candidate to be promoted or rejected?
- Which remote source and transformation produced a quoted image observation?
- Which artifacts are protected from eviction, and why?

If a schema cannot answer these questions, it is not yet sufficient.

## 6. Model discovery, selection, and download

### 6.1 Discovery

Hugging Face supports server-side search/filtering by text, author, task tags,
parameter range, application compatibility, popularity, and update time. LAL
should expose a deliberately smaller query contract:

- query text;
- modality/capability;
- maximum parameters and estimated disk/RAM/VRAM;
- format/backend compatibility;
- non-gated only by default;
- license allow/deny/unknown policy;
- sort by relevance, recently updated, downloads, or measured local fit.

Search results are remote candidates, visually distinct from installed models.
Popularity and freshness are context, never quality proof.

### 6.2 Resolution before download

Selecting a candidate performs a metadata-only resolution job:

1. Resolve a concrete upstream revision.
2. Fetch and snapshot the model card/license metadata.
3. List candidate files and sizes.
4. Identify compatible GGUF/Ollama variants and quantizations.
5. Estimate disk headroom and hardware feasibility.
6. Display gated-model or license requirements.
7. Produce a download plan the user can approve.

Hugging Face supports dry-run file sizing, revision pinning, file-pattern filters,
shared caching, checksum verification, and cache pruning. Prefer its maintained
client or exact HTTP behavior over reconstructing the Hub protocol casually.

### 6.3 Download state machine

```text
candidate
  → resolving
  → awaiting approval
  → reserving disk
  → downloading to partial area
  → verifying bytes
  → importing/registering
  → compatibility probe
  → installed | quarantined | failed
```

Requirements:

- download into a temporary/partial path, then atomically promote verified bytes;
- stream byte and file progress to the shared protocol;
- cancel without registering partial artifacts;
- resume only when the source adapter verifies revision/range semantics;
- reserve enough disk for download plus conversion and rollback where relevant;
- never enable insecure transport by default;
- preserve source revision and observed digest;
- let the owner delete an artifact only after showing protected references;
- offer dry-run cache cleanup before destructive cleanup.

Ollama pulls already stream progress and should be wrapped as jobs. LAL should
record the resulting manifest/layer digests instead of treating a mutable Ollama
name as immutable identity.

### 6.4 Selection

There are three distinct selections:

1. **Default preference:** what the owner would like to use.
2. **Runtime eligibility:** what can load now with the requested context and
   capabilities on this host.
3. **Per-task routing:** what best fits a declared task policy.

The selector must never stop live work silently. The current endpoint stops all
runs during a model switch; the new contract must return an impact plan first:
resident model, active leases/runs, estimated load, context/offload target, and
whether confirmation is required.

### 6.5 Common-PC recommendation

Produce a Pareto view rather than one rank:

- quality by capability domain;
- verified task-completion reliability;
- TTFT and output tokens/second at named prompt sizes;
- peak RAM/VRAM and disk;
- energy per completed case when measurable;
- maximum verified context before unacceptable offload/OOM;
- model-load and model-swap time.

Profiles such as `8 GB VRAM + 16 GB RAM`, `CPU-only 16 GB`, or the actual host
can filter infeasible artifacts before ranking. A small model that finishes a
workflow reliably may outrank a larger model that frequently exhausts context or
memory.

## 7. Evaluation and model profiles

### 7.1 Evaluation layers

1. **Import claims:** upstream model-card results, labelled author-reported.
2. **Compatibility probes:** load, context, modalities, structured output, tools.
3. **Fast local smoke:** seconds/minutes; detects broken templates or conversions.
4. **Capability suites:** instruction, code, tools, research, vision, audio.
5. **Workflow evaluations:** end-to-end verified completion and recovery.
6. **Efficiency suite:** common-PC latency, throughput, memory, optional energy.
7. **Promotion gates:** blind held-out improvement plus core-regression limits.

Never merge author-reported and LAL-measured results into one unlabeled number.

### 7.2 Reproducibility rules

- Pin suite version, dataset revision, prompt/chat template, model bytes, runtime,
  grader, decoding settings, seed, and host fingerprint.
- Keep raw case outputs and error states.
- Use a warmup and at least three measured repetitions for performance profiles,
  following the shape used by MLPerf Client; show dispersion, not only an average.
- TTFT and subsequent tokens/second are separate user-experience metrics.
- Performance comparisons across different hosts are grouped, not mixed.
- Optimization/quantization must meet a quality floor before performance results
  are presented as acceptable.
- LLM judges may be advisory; deterministic or human-verifiable evidence remains
  required for promotion gates.
- Evaluation failures are data. Parser failure, refusal, timeout, OOM, invalid
  tool call, and wrong answer remain distinct outcomes.

The existing seed suites and graders remain useful. Their next evolution is an
immutable suite manifest and case ledger, not immediate replacement with a large
external harness. Later, an adapter can import/export compatible tasks to
`lm-evaluation-harness`, whose versioned YAML task format, logged samples, and
saved chat templates provide a useful reproducibility reference.

### 7.3 Model profile UI

Each model page should present:

- identity and exact installed artifacts;
- upstream card, license, intended use, limits, and source revision;
- available runtime profiles and verified capabilities;
- local hardware fit and measurements;
- evaluation results by domain and evidence quality;
- known failure patterns from autopsy;
- conversations/runs using the model;
- base/dataset/adapter lineage;
- actions: load, unload, benchmark, compare, derive, export, or guarded delete.

Chat histories should remain conversation records with a model relationship, not
be physically nested inside a model record. A conversation that switches models
needs per-turn/run attribution.

## 8. Multimodal evidence and tools

### 8.1 One ingestion pipeline

Web chat, Code, CLI, HIVE research, uploads, and web capture use the same media
ingestion service:

1. authorize source (upload, granted local path, or allowed URL);
2. stream with strict byte/time limits;
3. detect file type from bytes and compare declared MIME;
4. hash and store the original once;
5. extract basic metadata and safe preview;
6. create optional derived observations (OCR, caption, transcript);
7. attach artifact references to conversation/run/evidence events.

Protect uploads from parser exploits, oversized files, archive bombs, active
content, filename traversal, and storage exhaustion. Media processors run with
no workspace write access and no network unless the job explicitly needs it.

### 8.2 Vision

Ollama vision accepts images with chat requests, and structured outputs can
constrain descriptions. LAL should add:

- `observe_image` returning a typed observation with model/runtime attribution;
- multiple-image comparison with explicit image IDs;
- screenshot and page-image collection as evidence artifacts;
- OCR as a separate derivation from semantic description;
- bounding-region/crop references so an agent can say what part it interpreted;
- a low-cost routing policy: metadata/OCR first, fast vision, quality vision only
  when uncertainty or task requirements justify it.

Web image acquisition must not grant general server-side URL access. Reuse the
research URL policy, block local/link-local/private network destinations unless
explicitly authorized, cap redirects and bytes, and retain the final URL.

### 8.3 Audio

Treat capture, transcription, translation, and synthesis as distinct stages.
The first complete local path is:

- user attaches/records audio;
- host stores the original artifact;
- a small local transcription runtime produces timestamped text plus language;
- the transcript is marked machine-derived and editable;
- downstream agents receive transcript and artifact reference;
- corrections are retained as a human derivation, not overwritten truth.

Whisper documents substantial hardware variation across model sizes. LAL should
benchmark at least one tiny/base and one higher-quality local profile on the
actual machine instead of setting one global transcription model.

### 8.4 Protocol additions

After the shared protocol package exists, add versioned events such as:

- `artifact_registered`, `artifact_progress`, `artifact_observation`;
- `media_processing`, `transcript_delta`, `transcript_ready`;
- `source_snapshot`, `derivation_recorded`.

Events carry IDs and bounded display summaries, not embedded multi-megabyte
base64 payloads. Web and CLI fetch bytes through authorized artifact endpoints.

## 9. HIVE visual workflow architecture

### 9.1 Product model

The visual canvas is a graph editor and run debugger over HIVE’s current engine.
It has three modes:

- **Design:** edit a draft workflow revision.
- **Validate:** compile, display errors, estimate capabilities/resources.
- **Run/inspect:** render the immutable executed revision with live and replayed
  node state, evidence, messages, tools, approvals, and audits.

React Flow is a reasonable candidate because it supports custom React nodes,
multiple named handles, typed connection validation, grouping, and custom edges.
Dependency and license review belongs in the implementation slice. The stored
graph format must remain LAL-owned so the engine is not coupled to a canvas
library.

### 9.2 Graph schema

`WorkflowDefinition`:

- stable workflow ID and immutable revision hash;
- contract version, name, description, kind, owner;
- ordered nodes and edges;
- resource budget and default policy;
- input/output schema;
- layout metadata separated from execution semantics;
- parent revision and change note.

`NodeDefinition`:

- ID, node type, role/action;
- named typed input and output ports;
- prompt template reference and editable variables;
- model requirements or exact profile override;
- permitted tools and approval policy;
- retry/idempotency/timeout/context policy;
- verification gate and optional/required state.

`EdgeDefinition`:

- source node/port, target node/port;
- data type and mapping;
- condition over validated structured output;
- priority for mutually exclusive branches;
- no arbitrary code in the first release.

### 9.3 Initial node palette

- Task intake / understanding
- Human question and answer
- Bounded router
- Research query generation
- Search / fetch / evidence ledger
- Planner
- Model worker
- Tool worker
- Deterministic check
- Verifier / requirement audit
- Human approval
- Merge / select
- Artifact output / final report

Every palette node maps to an existing or deliberately added engine action. A
node that exists only visually cannot ship.

### 9.4 The requested understanding flow

The proposed first user-editable template is:

```text
User prompt
    │
Understanding (conversation-strong model)
    │ typed RoutingDecision
    ├── needs_clarification ─▶ Q&A ─────────────┐
    ├── needs_research ──────▶ Research ────────┤
    ├── ready_to_plan ───────▶ Planning ────────┤
    └── direct_action_allowed ▶ Implementation ─┤
                                                ▼
                                    Verification / response
```

The understanding model does not directly invent edges or tools. It emits a
validated decision from a finite enum with reasons, uncertainties, and required
inputs. Multiple branches may run only when the template explicitly permits a
join. Q&A appears in the same mission conversation and resumes the paused node.

### 9.5 Compilation and validation

Before execution, the compiler rejects:

- missing or incompatible ports;
- cycles unless a bounded loop node explicitly owns them;
- unreachable required nodes or deadlocked joins;
- coordinator nodes with worker tools;
- mutation nodes without workspace grants/approvals;
- capabilities no installed eligible model satisfies;
- budgets below minimum declared stage needs;
- unversioned prompts, invalid retry policies, or unsafe raw conditions;
- workflows whose output cannot satisfy the task envelope.

The compiler emits the existing `WorkflowSpec` plus a validation report. HIVE’s
current workflow recovery, ledger, evidence, side-effect idempotency, and
verification logic remain execution truth.

### 9.6 Audit-driven improvement

Graph analytics should answer:

- which node/edge failed most often;
- where humans had to intervene;
- which routes were chosen and whether they later proved useful;
- model swaps and time/tokens per successful stage;
- evidence gaps, invalid outputs, context exhaustion, and repeated repairs;
- comparison between workflow revisions on the same held-out missions.

Do not optimize a graph from success rate alone. Include quality, resource cost,
human effort, and regression domains.

### 9.7 Resource-aware specialist organization

Treat a HIVE agent as a durable logical role, not a permanently running process or
resident model. A host may define dozens or hundreds of specialists while loading
only the current working set. The scheduler temporally multiplexes scarce RAM/VRAM:

```text
Role directory + durable queues + organizational memory
                         │
                         ▼
                 attention/scheduler
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
       loaded role   hot adapter   generalist fallback
       (one/few)     on shared base  when specialization fails
             │           │           │
             └───────────┴───────────┘
                         ▼
            shared artifacts / blackboard
```

Each role declares:

- purpose, input/output contracts, allowed tools, decision authority, escalation,
  and completion evidence;
- preferred model/runtime/adapter plus compatible fallbacks;
- context and artifact requirements, expected resource cost, load/warm state, and
  concurrency safety;
- role-specific and system-level evaluation evidence;
- training dataset lineage, promotion status, and last verified host class.

Processes are disposable; role identity, task state, artifacts, checkpoints, and
memory are durable. Specialists communicate primarily through typed task envelopes
and shared artifacts rather than recursively copying whole conversations. This
prevents context multiplication from consuming more memory than model execution.

The factory and brain metaphors map to testable mechanisms:

- **factory:** queues, stations/roles, bounded work orders, quality gates, rejected
  work, rework, throughput, and bottleneck evidence;
- **brain:** specialized functions, working memory, attention/residency scheduling,
  inhibition/cancellation, confidence, and integration into one response.

Do not assume that more roles improve the whole. Evaluate the organization as a
system and run ablations: generalist alone, generalist plus verifier, selected
specialists, and full graph under identical time/token/resource budgets. A specialist
is promoted only if it improves its role and the end-to-end organization. The router
must be able to bypass, replace, or fall back from a specialist whose confidence,
schema compliance, or runtime state is poor.

Shared-base LoRA adapters are the best initial constrained-host experiment because
they can make role changes cheaper than loading independent full models. They are
not a permanent architectural requirement: the role contract resolves to a runtime
profile, so a future small model, a more capable owner-controlled host, or a different
architecture can fill the same role without changing the workflow graph.

## 10. Open inquiry and defensive research

### 10.1 Product language

Avoid promising “jailbroken” behavior. The implementable goal is:

> Epistemically open research with strict evidence discipline and
> capability-bounded execution.

The system may examine controversial, speculative, dual-use, medical, energy,
or security questions without social discomfort becoming an evidentiary rule.
It must distinguish observation, inference, speculation, uncertainty, and
contradiction. Tool execution remains governed separately.

### 10.2 Research contract

Every serious research mission declares:

- question, decision/use context, required output;
- source-quality and freshness requirements;
- known constraints and conflicts of interest;
- risk domain and whether expert review is required;
- evidence cutoff/retrieval times;
- definitions of done and uncertainty output.

For high-stakes scientific/medical conclusions, Project-LAL should expose source
quality, contradictions, and uncertainty prominently. It must not imply that a
local synthesis is clinical validation or professional advice.

### 10.3 Defensive security engagement

NIST SP 800-115 defines rules of engagement established before testing. A LAL
security mission therefore adds:

- authorization reference and owner attestation;
- explicit targets, excluded targets, time window, and allowed techniques;
- data handling and disclosure rules;
- rate/concurrency limits and stop conditions;
- default sandbox/network policy;
- approval class for any action that contacts or mutates a target;
- immutable action/evidence ledger and final defensive findings.

Modes:

1. **Knowledge/review:** no active target access.
2. **Local lab:** isolated fixtures/containers, network off by default.
3. **Authorized assessment:** scoped network tools and explicit engagement grant.

The system can be deeply useful for code review, threat modeling, log analysis,
malware understanding in isolation, configuration auditing, and remediation
without silently becoming an unscoped attack platform.

## 11. Authentication, authorization, and workspace grants

### 11.1 Request identities

- Local browser session established by a one-time local bootstrap.
- Tailscale user identity when requests arrive through trusted loopback Serve
  headers.
- Authenticated CLI device identity through the existing pairing token flow.
- Run/job capability tokens scoped to one object and action set.

Never accept Tailscale identity headers from a non-loopback direct connection.
Keep the web service bound to loopback in the supported remote topology.

### 11.2 Capabilities

Initial capabilities:

- `observe.status`, `observe.runs`;
- `chat.use`, `research.use`;
- `workspace.read:<grant>`, `workspace.write:<grant>`, `workspace.exec:<grant>`;
- `model.search`, `model.download`, `model.activate`, `model.delete`;
- `train.start`, `evaluate.start`, `gpu.stop`;
- `hive.design`, `hive.run`, `hive.approve`;
- `admin.devices`, `admin.storage`.

Browser routes enforce origin/CSRF protection for state changes. Every mutation
records actor, capability, target, result, and correlation ID without collecting
unnecessary prompt or project content.

### 11.3 Workspace grants

A workspace grant binds:

- canonical real path and stable ID;
- owner/requester identity;
- read/write/execute permissions;
- allowed execution location (host or named client);
- creation, last use, expiry/revocation;
- symlink and nested-mount policy.

API clients pass a grant ID, never an arbitrary absolute project root. The CLI
can create a session-scoped grant for its current directory while keeping tools
on the client that owns the project.

## 12. Storage, retention, and portability

Define configurable runtime roots rather than deriving every path from
`process.cwd()` or a fixed Ollama installation:

- state/DB;
- content-addressed artifacts;
- models and adapters;
- downloads/partials;
- datasets;
- runs/logs;
- caches;
- temporary work.

Every category has current bytes, soft quota, hard quota, retention policy, and
protected-reference count. Before a large job, a disk planner accounts for input,
temporary, output, and rollback space.

Deletion is two-phase for referenced objects:

1. mark/remove from active inventory;
2. garbage-collect bytes only when no protected reference remains.

Provide an inspectable dry run: what will be removed, why, bytes freed, and what
reproducibility will be lost. Hugging Face caches need explicit Windows handling
because symlink behavior can duplicate bytes; LAL measures actual disk use rather
than assuming cache deduplication.

## 13. Whole-system portability and external host configuration

### 13.1 The configuration boundary

Use a platform path resolver rather than `$HOME` string concatenation or the
checkout as a state directory. On Linux, follow the XDG Base Directory split; on
Windows, use the system Known Folders rather than assuming a drive or username.
Conceptually:

| Kind | Linux default | Windows default | Contents |
| --- | --- | --- | --- |
| Configuration | `$XDG_CONFIG_HOME/project-lal/` | local application data | `host.toml`, user policy, source definitions |
| Durable data | `$XDG_DATA_HOME/project-lal/` | local application data | models, datasets, adapters, content-addressed artifacts |
| State | `$XDG_STATE_HOME/project-lal/` | local application data | registry DB, run state, history, logs |
| Cache | `$XDG_CACHE_HOME/project-lal/` | local application cache | catalog/card cache, rebuildable downloads |
| Runtime | `$XDG_RUNTIME_DIR/project-lal/` | per-user temporary/runtime area | locks, sockets, transient leases |

The repository contains schemas, immutable defaults, fixtures, portable recipes,
and platform adapters. It does not contain an owner's generated profile, secrets,
mutable databases, model bytes, datasets, run logs, virtual environments, local
binary builds, or unsupported GPU workarounds.

Configuration precedence is deterministic and inspectable:

1. schema defaults shipped with the installed application;
2. optional system-administrator policy;
3. owner `host.toml` outside the checkout;
4. a named, versioned recipe;
5. allowlisted one-run CLI/API overrides.

Detected facts do not sit in this override stack: they are inputs against which
the resolved configuration is validated. Unknown keys are errors, deprecated keys
produce migrations, secrets are references into a protected secret store or
environment, and `lal config explain <key>` reports every contributing layer.

The first `host.toml` schema should be intentionally small. It needs path-root
overrides, runtime enable/preference, service bind/ports, storage quotas, resource
limits, and references to named compatibility packs. Model lists, experiment
parameters, downloaded metadata, measured GPU facts, and tokens do not belong in
this file. Per-recipe parameters live with a recipe or run request so the host
profile does not grow into another source tree.

### 13.2 Bootstrap and capability detection

Add one idempotent bootstrap/doctor flow shared by web and CLI:

1. resolve platform directories and create them with owner-only permissions;
2. discover Node/Python, Ollama, llama.cpp, FFmpeg, Git, sandboxing, service
   managers, CPU/RAM/disk, and candidate accelerators;
3. run cheap compile/runtime availability checks before any allocation-heavy
   probe;
4. run opt-in backend smoke probes for inference, 4-bit operations, forward and
   backward, conversion, and a tiny checkpoint/restart cycle;
5. write `host-facts.json`, propose—not silently enable—profile choices, and show
   unsupported/experimental status;
6. allow an anonymized diagnostic export so contributors can attach useful host
   evidence without exposing local paths or credentials.

Recipes request capabilities such as `accelerator.memory_mib >= 7800`,
`precision.fp16`, `quantization.hqq.forward_backward`, `ram.available_mib`, and
`backend.llama_cpp.gguf_convert`. They do not select themselves because the GPU
marketing name resembles the original machine. PyTorch's runtime accelerator
checks can inform probes, but backend-specific tests remain necessary: a visible
accelerator does not prove that HQQ, bitsandbytes, a dtype, or a model architecture
works.

### 13.3 Whole-system adapter boundary

Do not pursue portability through scattered `if Linux`, `if Windows`, or GPU-name
branches. Define narrow adapters behind one resolved host context:

| Concern | Portable contract | Initial working adapter/profile |
| --- | --- | --- |
| Paths and state | configuration/data/state/cache/runtime roots | current repository paths as a temporary compatibility adapter, then XDG paths |
| Process lifecycle | spawn, inspect, stop, ownership, health | Linux process groups, signals, `ps`/`pgrep`, and systemd cgroup evidence |
| Service lifecycle | install, start, stop, restart, status, logs | current systemd user service |
| System monitoring | CPU/RAM/GPU/VRAM/temperature/storage observations with `unknown` support | Linux procfs/sysfs for the present AMD host |
| Inference runtime | discover, probe, load, unload, generate, model-store import | current llama.cpp Linux/Vulkan build and local Ollama daemon |
| Network exposure | loopback binding, authenticated remote exposure, identity evidence | current Tailscale Serve topology |
| Desktop integration | launcher install and open-URL capability | current GNOME `.desktop`, `gio`, and `xdg-open` flow |
| Workspace execution | canonical grant, sandbox capability, command environment | current Linux/Bubblewrap path where available |
| Client distribution | build, manifest, checksum, install/update | current connected Windows LAL release path |
| Training backend | probe, launch, checkpoint, stop, convert/export | current AMD/ROCm/HQQ compatibility pack |

The initial adapter is allowed to be specific and even inelegant if it reproduces
today's behavior. The common contract must not reduce its information or reliability.
Other users add another adapter or profile behind the same contract instead of
editing shared domain logic. Unsupported adapters return structured `unsupported`
or `unknown` results; they do not fabricate zeros, silently choose a fallback, or
crash an unrelated page.

Only bootstrap and adapter modules read environment variables, platform directories,
`process.cwd()`, procfs/sysfs, service managers, or executable search paths. They
produce one validated, immutable `HostContext` consumed by the registry, API routes,
jobs, HIVE, web UI, and CLI gateway. Architecture tests reject new direct host reads
outside those boundaries. This is what prevents “one more harmless hard-code” from
slowly recreating a private fork for every contributor.

The current-host compatibility capsule lives outside Git and references public
adapter IDs. It captures exact path overrides, ports, service/network/desktop
choices, executable locations, hardware compatibility exceptions, resource limits,
and probe evidence. It never embeds personal source modifications. A redacted
fixture of its schema and expected resolved shape may live in the repository, but
not usernames, tokens, absolute personal paths, serials, tailnet names, or private
service topology.

### 13.4 Dependency and backend isolation

Introduce a small Python project for reusable training/data code with a base
dependency group and separate locked environments for supported backend classes.
Do not force a single Torch wheel across CPU, CUDA, ROCm, and MPS: their install
sources and compatibility matrices differ. A practical initial matrix is:

- `data`: dataset compilers/importers/validators, no accelerator required;
- `train-cpu`: correctness and tiny smoke jobs;
- `train-cuda`: an explicitly tested CUDA/Torch/quantization combination;
- `train-rocm`: an explicitly tested ROCm/Torch combination;
- `train-mps`: experimental until recipe-level forward/backward/export gates pass;
- local/experimental bundles: owner-managed and marked unsupported.

Lock files provide reproducible Python packages, but do not prove driver or GPU
compatibility. Every bundle therefore records both its lock identity and its last
verified host class. Containers may be offered as an optional supported backend,
especially where vendors publish tested images, but they cannot be the only path:
device pass-through, disk size, desktop integration, and Windows support must stay
explicit.

### 13.5 Training and data script disposition

Preserve every current lesson before moving anything. First create an inventory
manifest with file hash, purpose, input/output schema, upstream source/revision,
license, required packages, hardware assumptions, last known successful host/run,
known failures, and disposition. Then use these categories:

| Current files | Disposition | Reason |
| --- | --- | --- |
| `build_hive_role_dataset.py`, its test, and `convert_swe_traces.py` | promote into tested portable data/compiler modules | strongest current provenance, bounded-window, split, authority, and immutability contracts |
| `finetune_sft.py` | extract a portable reference SFT runner | assistant-span masking, grouped validation, checkpointing, and telemetry are reusable; device/model assumptions are not |
| `finetune_hqq.py`, `finetune_qlora.py`, `finetune_sft_offload.py`, `check_hqq.py`, `check_4bit.py` | preserve as versioned experimental backend recipes, then refactor behind capability probes | valuable constrained-hardware work, but currently tied to exact device/backends and historical library behavior |
| `finetune.py` and `build_sft.py` | historical raw/fractal experiment | raw next-token training degraded instruction behavior and should not remain a default path |
| `lens.py` and `compare_adapters.py` | generalize as analysis jobs after the registry/job layer | useful techniques, currently duplicate loader logic and assume a Qwen/LoRA/current-host shape |
| all `import_*.py` plus `convert_swe_traces.py` | declarative source adapters with pinned revisions and uniform manifests | good source-specific normalization is mixed with mutable URLs, fixed output paths/tokenizers, and duplicate contamination logic |
| `build_mix.py` and `verify_sft.py` | dataset compiler/validation services | make suite versions explicit and remove imports from the distillation experiment and scans of mutable live suites |
| `distill_gemma.py` | generalized, opt-in distillation job | teacher endpoint/model and local Ollama assumptions must be inputs; execution checks need a real sandbox contract |
| `gen_agentic_data.py`, `gen_coding_hard.py`, `gen_followthrough.py`, `gen_fractal_data.py`, `gen_instruct_hard.py`, `gen_planning_hard.py`, `gen_research_data.py` | versioned project-authored generator plugins | preserve deterministic behavior lessons, but never imply generated assertions equal independent quality evidence |
| `build_contemplative_sft.py` and `build_sovereign.py` | optional/personal recipe archive | narrow project goals; the latter includes a personal absolute seed path and neither belongs to a universal default install |
| `scripts/fakebin/rocminfo` and RDNA2 environment overrides | current-owner local compatibility pack outside the public core | intentionally misreports one GPU target; must require explicit acknowledgement and can never be auto-enabled for another owner |
| install/rebuild/release/smoke scripts | separate product operations from training recipes; keep supported platform adapters | systemd, GNOME, Tailscale, ports, and release topology need explicit platform capability checks rather than training-script sprawl |

This classification is not an instruction to delete history. Before source moves,
copy the exact legacy files plus inventory and hashes into a current-owner extension
pack outside the checkout, record the inventory in training history, retain the files
through a deprecation window, and tag the last revision that contains the original
experiments. A recipe returns to the public repository only after it has a schema,
license/provenance record, dependency contract, isolated test, documented
compatibility class, and a second-host acceptance result.

### 13.6 Dataset pipeline contract

Replace direct script-to-`data/*.jsonl` writes with jobs that produce immutable
dataset artifacts and manifests. Every source adapter must record:

- repository/dataset/config/split and exact revision or input hash;
- source and per-row license evidence, terms snapshot where relevant;
- retrieval time, adapter revision, tokenizer/chat-template revision;
- normalization, filtering, truncation/windowing, deduplication, contamination,
  executable-check, and drop statistics;
- ordered row IDs, final byte hash, schema version, intended role, and limitations.

Contamination checks take immutable evaluation-suite IDs as inputs. Importers do
not scan the live mutable web suite directory. Execution-based verification runs
in the same bounded sandbox contract as HIVE checks; a temporary directory alone
is not a security boundary. Training consumes a dataset artifact ID, never a
mutable filename.

### 13.7 Migration without breaking the current machine

Migrate by strangling the existing system, not by rewriting it first:

1. capture a read-only snapshot of current paths/state sizes, host facts, Python
   freeze, Node/runtime/binary versions, ports, environment overrides, service and
   Tailscale configuration, monitoring observations, and successful smoke commands;
2. add external paths and configuration in compatibility mode while continuing to
   read existing repository-local state;
3. make a current-host capsule reproduce today's behavior, including systemd,
   GNOME, Tailscale, Ollama/llama.cpp, Windows-client release, storage layout,
   monitoring, and the explicit RDNA2 compatibility pack;
4. copy and verify runtime data into external roots with a dry run, checksums, disk
   accounting, rollback, and no deletion of originals;
5. migrate one seam at a time—paths, health/status, service control, model runtime,
   network exposure, then training—keeping a compatibility read/write mode and a
   per-seam rollback;
6. after each seam, run the current-host golden flows before proceeding; route one
   low-risk data compiler, one tiny CPU training smoke, and finally the current HQQ
   recipe through the generic job/recipe contract;
7. accept on a second materially different host before declaring an adapter or
   recipe portable;
8. only after parity and backup evidence, stop writing mutable state under the
   checkout and retire compatibility reads in a later release.

Portability does not mean every feature works on every machine. It means installation
succeeds, unsupported capabilities are stated truthfully, the useful subset works,
and adding support does not require a private fork.

### 13.8 Contribution contract

Make the CPU/core path the universal contributor baseline. Pull requests can test
schemas, data compilers, migrations, job recovery, and tiny CPU recipes without a
GPU. Hardware-backed recipes have three visible support levels:

- **supported**: locked environment, maintained owner, CI or scheduled hardware
  evidence, and current compatibility table;
- **experimental**: reproducible recipe and at least one redacted host report, but
  incomplete platform coverage;
- **local**: external owner recipe with no upstream support claim.

A portability contribution supplies the recipe revision, redacted host facts,
dependency lock ID, probe results, smallest reproducer, output hashes, and failure
logs. CI rejects committed generated host profiles, personal absolute paths, and
new host/service/hardware reads outside the adapter boundary.
Maintainers promote support status from evidence; popularity, one successful launch,
or a model response is not enough. This lets NVIDIA, AMD, Apple, CPU-only, Windows,
and Linux contributors improve one shared system without pretending those backends
are interchangeable.

## 14. CLI provenance, reduction, and Project-LAL ownership

### 14.1 Current derivation truth

`apps/cli/` is not a small borrowed library. At the repository basis audited for
this plan it contains 3,148 tracked files, including 3,037 under its package tree.
A conservative search excluding tests, build output, snapshots, lockfiles, and
installed dependencies still finds 1,728 files containing Qwen/Gemini/Alibaba
identity, upstream package names, or related references. Copyright headers naming
Google or Qwen remain in roughly 2,743 files.

The root wrapper is named `@local-ai-lab/lal-cli`, but active internal packages are
still named `@qwen-code/qwen-code`, `@qwen-code/qwen-code-core`, and
`@qwen-code/acp-bridge`, point their repository metadata to QwenLM, and retain the
internal `qwen` binary. Active workspaces still include the TypeScript SDK, web
templates, audio capture, ACP bridge, and Telegram, Weixin, DingTalk, WeCom, Feishu,
QQBot, and example channel packages.

The provenance chain has two upstream layers: Qwen Code states that it was originally
based on Google Gemini CLI v0.8.2 and then developed independently; LAL was in turn
derived from Qwen Code. The local Apache-2.0 license carries Google and Qwen copyright
text, while `NOTICE-LAL.md` currently summarizes only the immediate Qwen derivation.
The top-level Project-LAL repository still lacks the final composition-wide license,
NOTICE, and third-party inventory.

This is legally usable as an Apache-2.0 derivative if its conditions and all other
dependency licenses are satisfied. It is not evidence that every retained file was
authored by Project-LAL. Product ownership and copyright authorship are related but
different claims.

### 14.2 What “ours” should mean

Project-LAL can and should own:

- the LAL product name, UX, architecture, release/update channel, gateway protocol,
  supported workflows, security posture, maintenance, and new contributions;
- the selection, integration, and modification of permitted upstream components;
- copyright in original Project-LAL additions and modifications to the extent the
  law recognizes them;
- responsibility for the distributed derivative as a Project-LAL release.

It must not imply sole authorship of retained Google/Qwen expression. The honest
product statement is eventually: “LAL is Project-LAL's terminal agent, containing
Apache-2.0-derived portions of Qwen Code and Gemini CLI; see NOTICE.” Attribution
belongs in About/licenses and source/release notices, not as competing product
branding throughout normal operation.

An independent rewrite is optional, not required by Apache-2.0. Rewrite only when a
smaller LAL-specific component is easier to understand and maintain than the retained
one. A cosmetic rename does not change provenance; a giant rewrite performed only to
avoid giving credit would waste working software and increase risk.

### 14.3 Immediate egress and supply-chain audit

Before public distribution, treat all inherited network behavior as untrusted until
proven reachable, necessary, and owner-approved. One concrete high-priority finding
already exists: `QwenLogger` posts usage statistics to an Alibaba RUM hostname, and
both core and CLI configuration currently default `usageStatisticsEnabled` to
`true`. The supported LAL managed-settings endpoint explicitly overrides usage
statistics and telemetry to `false` and disables inherited auto-update; the Linux
and Windows installation paths consume those settings. That is a meaningful current
mitigation, but privacy must not depend on a managed config file arriving intact or
every entrypoint using it. The tree also retains upstream update checks/installers,
provider/OAuth paths, Alibaba endpoints, an upstream Qwen sandbox image, optional
binary downloads, extension sources, web fetch, MCP, and many channel integrations.

The audit must inventory every static and computed outbound destination and classify
it as:

- required LAL host/gateway traffic;
- explicit user-configured destination such as MCP, Git remote, model catalog, or
  optional provider;
- local-only telemetry/export;
- build/development-only retrieval;
- unreachable legacy code;
- forbidden upstream phone-home/update/auth/download behavior.

Add a deny-by-default network acceptance harness around CLI startup, one native turn,
one attached turn, tool execution, update check, sandbox start, and shutdown. It
records DNS/connect/fetch/spawn attempts and fails on destinations outside the test's
allowlist. Also run with DNS/network disabled. Static string scanning alone is not
enough because URLs may be assembled, redirected, configured, or launched by child
processes.

No release gate should depend on a user finding the correct privacy toggle. Default
LAL operation has zero third-party telemetry and zero upstream update/provider
onboarding traffic. Opt-in local OpenTelemetry can remain after sensitive-field,
retention, and exporter review.

### 14.4 File and subsystem disposition ledger

Create a machine-readable manifest for every retained CLI file or cohesive subtree:

- origin repository and exact upstream commit/blob hash;
- `retained_upstream`, `modified_derivative`, `lal_authored`, `generated`, or
  `third_party_vendored` classification;
- applicable copyright/license/SPDX identifiers;
- runtime reachability and owning LAL capability;
- keep, adapt, replace, quarantine, or remove decision;
- tests and dependencies that protect its disposition.

Initial decisions:

| Surface | Direction |
| --- | --- |
| Ink terminal rendering, streaming tool loop, file/shell/Git, approvals, folder trust, session recovery, context handling, headless mode | keep and harden while preserving provenance |
| LSP, MCP, worktrees, sandbox mechanism, ACP/daemon, audio | retain only where a supported LAL workflow and acceptance test proves value |
| model/provider configuration and native turn transport | replace with one LAL gateway/client protocol plus explicit optional adapters |
| settings/state paths, memory names, environment variables, package namespaces, command/help text | migrate to LAL names with versioned compatibility readers; do not break existing sessions/configuration |
| Alibaba RUM, upstream update/version checks, OAuth/onboarding, Qwen installers and release routes | disconnect first, then remove unless explicitly adopted as a non-default adapter |
| enterprise/consumer chat channels, general SDK, web-template/insight marketing surface, upstream sync tooling, unrelated locales/docs/automation | remove from the shipping workspace unless a written LAL product decision retains them |
| upstream sandbox/container and optional native binary downloads | replace with reproducible LAL-controlled artifacts or require an explicit external adapter |
| computer use and arena/team features | quarantine until their authority, resource contention, and overlap with HIVE are deliberately resolved |

Reachability matters more than string counts. First disconnect an unwanted subsystem
from entrypoints and prove it unreachable; then delete it with its dependencies,
tests, settings, translations, schemas, and release assets in one reviewed slice.
Never leave dead configuration suggesting unsupported behavior.

### 14.5 Namespace and state migration

Renaming thousands of imports in one pass creates risk without immediate user value.
Use an ordered compatibility migration:

1. normal UI, help, errors, prompts, release artifacts, executable, and API identity
   become LAL-only except About/licenses;
2. new settings/state use Project-LAL platform directories and names;
3. old `.qwen`, `QWEN_*`, `QWEN.md`, internal extension descriptors, and session
   formats are imported through explicit, tested compatibility readers without
   deleting originals;
4. public package metadata and binaries move to Project-LAL namespaces;
5. internal package namespaces change only after dependency/reachability reduction
   makes the change small enough to review;
6. compatibility aliases receive a deprecation and export path, then disappear in a
   major release—not silently during cleanup.

Model names such as Qwen remain legitimate model metadata. Product/framework naming
must not use Qwen trademarks except for attribution and accurate compatibility
descriptions.

### 14.6 Distribution and attribution gate

Before calling the repository publicly open source or publishing a LAL CLI release:

- recover and record the exact Qwen fork/base and its Gemini ancestry from preserved
  history/archive rather than relying on memory;
- select the root license after a complete composition audit; Apache-2.0 is the
  lowest-friction candidate for the retained CLI inheritance, not an automatic
  conclusion for unknown assets;
- ship an unmodified license text, a composition-wide NOTICE/attribution file,
  source notices required for modified retained files, and a generated third-party
  dependency/license report in source and binary distributions;
- preserve applicable Google/Qwen and other third-party notices while adding
  Project-LAL notices only for Project-LAL work;
- produce an SBOM, dependency audit, release checksums, and provenance/attestation;
- verify that release archives actually contain the required license/notice files
  and no private config, tokens, archives, source maps with secrets, or unused
  upstream payloads.

This plan is an engineering compliance program, not a substitute for legal review
before a consequential public release.

### 14.7 Completion criteria

- default CLI startup and supported turns make no non-allowlisted network requests;
- no Alibaba/Qwen/Google product onboarding, telemetry, update, auth, support, or
  release route is reachable from normal LAL operation;
- About/licenses accurately shows the complete derivation chain;
- every shipping file/subtree has an origin/disposition/license record;
- normal user-facing identity, package metadata, executable, update channel, and
  configuration are Project-LAL-owned;
- unused upstream workspaces and their dependency closure are absent;
- retained capabilities have LAL acceptance tests and an accountable maintainer;
- source and binary releases pass automated license/NOTICE/SBOM/privacy inspection;
- the current Linux host and connected Windows client remain functional throughout
  the reduction.

## 15. Observability and protocol

Complete `packages/protocol/` before adding broad event vocabulary. Use one
correlation model across host and client:

- `trace_id`: user intent across conversation/workflow/job;
- `run_id`: one execution;
- `span/node/job_id`: bounded operation;
- `artifact_id`, `model_artifact_id`, `runtime_profile_id` where relevant.

OpenTelemetry’s separation of traces, metrics, and logs is a useful semantic
reference, but LAL does not need to deploy an external collector. Export remains
opt-in. High-cardinality IDs belong in ledgers/traces, not unbounded metric label
sets.

Required truth surfaces:

- current job/run owner and phase;
- model requested, resolving, loading, resident, unloading, failed;
- actual context/offload/backend;
- GPU lease queue and holder;
- disk reservation and bytes transferred;
- model/runtime/suite identities on every evaluation;
- unknown state rendered explicitly.

## 16. Web and CLI parity

The host API owns domain behavior. Web and CLI are clients with different
interaction strengths.

| Capability | Web | LAL CLI |
| --- | --- | --- |
| Search remote catalog | rich filters/cards | searchable table/picker |
| Approve download | storage impact dialog | explicit summary prompt |
| Download progress | job drawer | durable progress line + `/jobs` |
| Model profile | full evidence tabs | concise facts + web handoff |
| Select/activate | impact preview | `/model use` impact preview |
| Evaluate/compare | charts and case drilldown | summary + artifact paths |
| Media attach | picker/capture | local path/URL under policy |
| HIVE design | 2D graph | inspect/validate/run; web handoff to edit |
| HIVE run | mission control | full attach/replay/steer |

The CLI should not reproduce a complex graph canvas in a terminal. It must still
validate, list revisions, inspect nodes/edges, run, attach, pause, steer, approve,
and open the web editor.

## 17. Ordered implementation program

Each slice is independently releasable and has an acceptance gate. Later slices
do not start because an earlier one merely compiles.

### Gate A — finish active foundation work

- real shared protocol package;
- native/attach event reconciliation;
- full storage inventory and remaining retention categories;
- repository boundary decision and inherited CLI reduction plan;
- hashed whole-system host-assumption/training-script inventory and current-host
  reproducibility snapshot;
- real Windows terminal acceptance evidence.

Exit: current Milestone 2 truth criteria pass and the supported daily workflow
remains reliable.

### Gate B — contain inherited CLI egress and provenance

- recover exact Qwen/Gemini base commits and build the initial file/subtree
  provenance ledger;
- add outbound-destination inventory and deny-by-default startup/turn/update tests;
- disconnect default Alibaba RUM usage statistics, upstream updates/onboarding,
  and implicit downloads from the supported LAL entrypoint;
- verify source and current release artifacts contain the correct license and
  derivation notices;
- mark every inherited workspace keep, quarantine, or remove before adding more
  dependencies to it.

Exit: the supported LAL CLI makes no unapproved third-party request, its current
derivation is explicit, and reduction can proceed without breaking the Linux/Windows
daily workflow.

### Parallel Track H — HIVE specialist factory

HIVE architecture and evidence work proceeds alongside the numbered slices; it does
not wait for every later UI feature, but it cannot bypass their security, identity,
job, artifact, or evaluation contracts.

- **H0, now:** freeze single-agent comparison baselines; formalize role/task/tool
  contracts; render and replay current workflows; simulate residency/resource
  schedules without training or loading extra models.
- **H1, after registry/jobs:** durable role directory, organizational task queues,
  artifact blackboard, generalist fallback, resource-aware dispatch, and adapter/base
  load-cost telemetry.
- **H2, after evaluation/dataset contracts:** train one narrowly diagnosed role at a
  time, run role and end-to-end ablations, quarantine candidates, and promote only
  measured improvements.
- **H3, with graph authoring:** make the factory/brain organization visible and
  editable through typed graphs, queue/station views, bottlenecks, interventions,
  and exact revision replay.

Track acceptance is organizational, not theatrical: under identical time, token,
RAM/VRAM, and tool budgets, a selected specialist organization must beat the
generalist baseline on held-out missions while preserving recovery, authority, and
truthful completion.

### Slice 1 — browser trust boundary and workspace grants

- request identity middleware and mutation authorization;
- Tailscale identity/loopback validation plus local browser session;
- CSRF/origin enforcement;
- replace arbitrary server project paths at API boundaries with grants;
- device/grant administration and audit records.

Acceptance:

- unauthenticated mutations fail;
- spoofed Tailscale headers fail on direct/LAN access;
- a granted workspace works and a sibling path does not;
- revocation takes effect for new actions;
- existing CLI inference/attach smokes continue to pass.

### Slice 2 — external configuration and whole-system adapter boundary

- platform path resolver and versioned host/profile/recipe schemas;
- `doctor` fact collection, safe diagnostic export, and config explanation;
- process, service, monitoring, runtime, network, desktop, workspace, client
  distribution, and training adapter contracts;
- move current defaults into an explicit current-host compatibility capsule;
- optional Python dependency bundles and tiny backend probes;
- repository-local state compatibility reader and migration dry run.

Acceptance:

- a clean clone starts its supported core without source edits or an accelerator;
- generated configuration/state contains no repository-tracked changes;
- the current host reproduces its service lifecycle, dashboard truth, chat/code,
  CLI attach, HIVE, model serving, remote exposure, and tiny training smoke only
  when its explicit compatibility capsule is enabled;
- disabling a new adapter seam or restoring the old path recovers the last working
  behavior without moving or deleting owner data;
- a second host resolves a different truthful profile from the same source
  revision;
- invalid/unknown config and unsupported recipe requirements fail before a large
  download or training allocation.

### Slice 3 — central registry, read-only migration

- registry schema and repository layer;
- import existing local GGUF/Ollama inventory and HIVE model profiles;
- exact artifact/runtime IDs exposed by a versioned API;
- adapt web model selectors and CLI catalog reads without adding downloads;
- retain compatibility aliases during migration.

Acceptance:

- every installed visible model resolves to exact bytes/manifest and runtime;
- no duplicate logical records after repeated discovery;
- current model switching behavior remains functional;
- web, CLI settings, and HIVE read one catalog.

### Slice 4 — durable jobs and resource scheduler

- job table/ledger/protocol;
- disk reservation and GPU lease integration;
- start/cancel/recover semantics and job UI/CLI;
- convert existing long train/bench operations incrementally.

Acceptance:

- restart settles or resumes each declared job kind correctly;
- cancellation releases child processes/resources;
- two GPU jobs cannot overlap;
- progress never claims completion before output verification.

### Slice 5 — model search, resolve, and download

- Hugging Face search/metadata adapter;
- Ollama catalog/name resolution and pull wrapper;
- resolution plan, license status, hardware estimate;
- verified partial download/import, progress, cancellation, cache inspection;
- guarded deletion and protected references.

Acceptance:

- search works while offline state degrades visibly;
- a pinned small test artifact downloads, verifies, imports, probes, and appears
  in both web and CLI;
- interrupted download never appears installed;
- disk-shortfall refusal occurs before large transfer;
- digest/revision and card snapshot survive source changes.

### Slice 6 — model and dataset profiles

- full model profile and lineage views;
- upstream claims separated from local evidence;
- dataset cards/manifests and relationship queries;
- per-turn model attribution in conversations;
- storage/provenance impact on delete.

Acceptance: the relationship questions in Section 5.2 are answerable from UI/API
and produce stable exportable records.

### Slice 7 — evaluation foundation

- immutable suite/case/run schema;
- importer for current seed suites and benchmark results;
- exact runtime/hardware capture;
- raw case outputs, repeats, errors, comparison views;
- fast smoke and common-PC efficiency suite;
- optional `lm-evaluation-harness` adapter after the native contract is proven.

Acceptance:

- rerunning an unchanged suite is reproducible within declared stochastic bounds;
- changing chat template/runtime creates a distinct comparable profile;
- quantization must pass quality floor before efficiency recommendation;
- report export contains sufficient IDs to reproduce the run.

### Slice 8 — unified media artifacts

- content-addressed upload/local/URL ingestion;
- authorized artifact serving and previews;
- browser and CLI image attachment on the shared protocol;
- typed vision observation and web screenshot/image evidence;
- transcription jobs and editable timestamped transcripts.

Acceptance:

- one image/audio artifact can be used from web, CLI, and HIVE with identical ID;
- observations cite source and processing model;
- unsafe/oversized media and private-network URL fetches are rejected;
- deleting a conversation does not silently destroy a protected research source.

### Slice 9 — HIVE graph read/validate view

- LAL-owned graph revision schema;
- render existing research/coding templates as graphs;
- compiler/validator to current `WorkflowSpec`;
- run replay overlays on the exact graph revision;
- CLI graph inspection and web handoff.

Acceptance: current fixed workflows compile byte-equivalently in execution
semantics and existing HIVE lifecycle tests remain valid.

### Slice 10 — bounded HIVE visual authoring

- clone-to-draft, custom nodes, named ports, valid connections;
- node configuration forms and model/tool/budget policies;
- revision diff, validate, publish, run;
- requested Understanding → Q&A/Research/Plan/Implement template;
- no arbitrary code conditions or unbounded loops.

Acceptance:

- invalid graphs cannot publish;
- executed revision is immutable;
- restart/replay shows the same graph and node results;
- routing choices and operator interventions are auditable.

### Slice 11 — open inquiry and defensive engagement profiles

- research contract and evidence-status UI;
- open-inquiry evaluation axes and calibration;
- security engagement/ROE record, scoped tool policy, isolation modes;
- high-risk action approvals and defensive report template;
- held-out workflow evaluation before wider tool access.

Acceptance:

- benign sensitive research is not prematurely terminated;
- unsupported claims fail citation verification;
- a local lab security mission works with network disabled;
- out-of-scope target/tool actions are mechanically blocked and audited.

### Slice 12 — self-improvement and public release readiness

- verified run → quarantined example → deterministic review → dataset version →
  training job → candidate → blind evaluation → explicit promotion;
- migrate one importer/compiler and one portable SFT recipe from the legacy
  script inventory; retain the current-owner HQQ pack externally;
- artifact/dataset/model cards export;
- root license/NOTICE/derivation audit, security policy, contributor path;
- fresh-clone CI, dependency/license review, release checksums/attestation;
- supported-platform and privacy documentation.

Acceptance: one small specialist improvement is reproducible end to end without
manual provenance reconstruction, and one public release candidate can be built
and verified from a clean clone.

## 18. First fourteen implementation packages

These are intentionally narrower than the slices and should become individual
design/test/implementation reviews when work is authorized:

1. Browser threat model and request identity contract.
2. CLI provenance/egress inventory and deny-by-default network acceptance harness.
3. Workspace-grant schema and read-only compatibility mapper.
4. Shared protocol package migration.
5. Whole-system host-assumption inventory and current-host capsule snapshot.
6. Platform-directory resolver, host/profile schema, and redacted `doctor` facts.
7. Process/service/monitor/runtime/network adapter contracts with compatibility
   implementations for the present host.
8. Legacy training-script manifest and current AMD training compatibility pack.
9. Capability-registry schema and existing-inventory importer.
10. Versioned read-only registry API consumed by one web selector and CLI.
11. Durable generic job ledger with a fake checkpointable test job.
12. Disk planner and content-addressed artifact store.
13. Hugging Face metadata/search/resolve adapter with no download mutation.
14. Verified small-artifact download plus evaluation/dataset manifest vertical
    slice.

Do not begin with the visual canvas. It becomes straightforward only after
identity, registry, jobs, protocol, and evaluation have stable contracts.

## 19. Test and acceptance strategy

### Contract tests

- protocol compatibility across web/CLI versions;
- schema migrations from real current `.data` fixtures;
- catalog adapter fixtures, including upstream changes and missing metadata;
- graph compile/validation golden fixtures;
- authorization matrix for every mutation route.
- CLI provenance manifest, release license/NOTICE contents, and outbound destination
  allowlist for every supported entrypoint.

### Failure injection

- process/service restart during resolve, download, verify, load, evaluation,
  training, media processing, and HIVE nodes;
- disk full before and during jobs;
- network loss, range mismatch, corrupt digest, malformed card/media;
- blocked DNS/connect attempts and redirects to upstream telemetry, update, auth,
  download, sandbox, provider, and channel destinations;
- backend OOM/crash and GPU reset;
- stale/revoked device or workspace grant;
- protocol unknown event and newer graph revision.

### Real-machine acceptance

- current Linux/GNOME host, real AMD GPU and constrained RAM, treated as the
  protected golden baseline rather than merely one portability sample;
- service install/restart/recovery, dashboard readings, Ollama and llama.cpp
  handoff, chat/code/HIVE, Tailscale access, local and Windows CLI attach, and a
  bounded training smoke on that baseline;
- Windows terminal client over Tailscale;
- phone attach/continue;
- CPU-only or deliberately GPU-disabled fallback where supported;
- clean-clone/rebuild with runtime data outside the repository.

### Evidence discipline

Every milestone report names:

- exact revision and test command;
- fixture or real host;
- artifact/run/job IDs;
- failures and exclusions;
- observed storage/process/GPU state after cleanup.

## 20. Risk register

| Risk | Consequence | Control |
| --- | --- | --- |
| Feature breadth outruns foundation | many impressive but unreliable modes | gates and independently accepted slices |
| Remote catalog compromise/mutable tags | untrusted or irreproducible weights | pinned revisions, digests, quarantine, card snapshot |
| Disk exhaustion | service/training failure and data loss | reservation, quotas, partial area, reference-aware GC |
| Model score Goodharting | routing/training targets the test | multidimensional profiles, held-out sets, raw evidence |
| Hardware-specific conclusions | misleading recommendations | bind results to host/runtime; separate portability claims |
| Personal host logic remains in core | contributors fork source and cannot share fixes | external versioned host profiles, capability probes, identical checkout acceptance |
| Portability refactor breaks the only reliable host | working daily system is lost before alternatives exist | compatibility capsule, seam-by-seam strangler migration, golden flows, rollback, no destructive moves |
| Auto-detection enables an unsafe workaround | wrong kernels, corruption, or unstable host | facts separate from policy; explicit experimental compatibility packs and smoke gates |
| Python backend dependency collision | broken installs across CPU/CUDA/ROCm/MPS | optional locked bundles and backend-specific acceptance matrix |
| Legacy training knowledge is lost during cleanup | constrained-hardware lessons are repeated | external hashed archive, history record, migration tag, tested promotion path |
| Visual graph becomes a second engine | divergent recovery and semantics | compile to existing `WorkflowSpec` only |
| Prompt injection through cards/web/media | tool misuse or false research | untrusted artifact boundaries, typed extraction, tool policy |
| Security tooling exceeds authorization | harm to third parties | ROE, target grants, isolation, approval, audit |
| Inherited CLI surface remains dominant | maintenance/security burden | continue explicit reduction before public release |
| Inherited CLI phones home or downloads implicitly | privacy/supply-chain violation of local-first promise | early egress gate, default deny, destination harness, LAL-owned update/artifacts |
| Cosmetic rebranding erases derivation | dishonest authorship and license/trademark exposure | per-file provenance ledger, retained notices, accurate About/NOTICE language |
| Licensing ambiguity | cannot honestly release as open source | root/license/dependency/model/dataset audit |
| Telemetry grows without bound | local-first storage failure | bounded ledgers/metrics and explicit retention classes |
| Self-training amplifies errors | regressions with false provenance | quarantine, deterministic checks, blind gates, manual promotion |

## 21. Explicit non-goals for this program

- Hosting a public multi-tenant AI cloud.
- Automatically downloading whichever model is trending.
- Supporting every model backend in the first registry release.
- Reproducing a full graphical editor inside the terminal.
- Claiming sole Project-LAL authorship over retained Qwen Code or Gemini CLI source.
- Letting arbitrary JavaScript/Python execute as HIVE edge conditions.
- Claiming medical discoveries, security authorization, or model safety from an
  LLM judgment alone.
- Training bigger models merely because the pipeline can.
- Promising that every training/backend recipe works on every OS or accelerator.
- Treating a host profile as a substitute for upstream driver/runtime support.
- Replacing the current working Linux topology merely to make the source look
  cleaner or more abstract.
- Requiring simultaneous feature parity across all platforms before accepting a
  truthful, useful platform adapter.
- Introducing Kubernetes, a message broker, or a remote SQL service for the
  current single-user/single-host topology.

## 22. Decisions deliberately deferred

- Final root open-source license, pending composition/derivation review. The
  migration plan currently proposes Apache-2.0; the final NOTICE must cover the
  complete Google Gemini CLI → Qwen Code → Project-LAL derivation where retained.
- React Flow adoption, pending bundle, accessibility, maintenance, and license
  review during Slice 9.
- Whether to call `huggingface_hub` through a small isolated Python worker or
  implement a bounded TypeScript adapter. Prefer maintained semantics; measure
  packaging cost before deciding.
- Native audio capture in the CLI versus web handoff. Artifact/transcription
  protocol comes first.
- Additional inference backends. Define the adapter contract with llama.cpp and
  Ollama before adding more.
- Distributed/multi-GPU scheduling. The present one-GPU lease remains the truth.
- Exact Python environment/lock tooling. Adopt the standardized dependency-group
  and `pylock.toml` contracts where supported, but select an implementation only
  after CPU/CUDA/ROCm install prototypes and contributor ergonomics are compared.
- Whether any retained CLI subsystem warrants independent replacement after
  reachability reduction. Decide from maintainability/security cost, not a desire
  to hide permitted upstream ancestry.

## 23. Primary references used

The plan relies on primary project or standards documentation, current as of
2026-07-19:

- Hugging Face Hub: [search and filtering](https://huggingface.co/docs/huggingface_hub/en/guides/search),
  [revision-pinned/dry-run downloads](https://huggingface.co/docs/huggingface_hub/guides/download),
  [cache verification and pruning](https://huggingface.co/docs/huggingface_hub/en/guides/manage-cache),
  [model cards](https://huggingface.co/docs/hub/en/model-cards), and
  [dataset cards](https://huggingface.co/docs/hub/datasets-cards).
- Ollama: [streamed model pulls](https://docs.ollama.com/api/pull),
  [vision](https://docs.ollama.com/capabilities/vision),
  [structured outputs](https://docs.ollama.com/capabilities/structured-outputs),
  and [tool calling](https://docs.ollama.com/capabilities/tool-calling).
- llama.cpp/ggml: [llama.cpp model acquisition and server](https://github.com/ggml-org/llama.cpp),
  [server model metadata](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md),
  and [GGUF extensible metadata](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md).
- Evaluation: [lm-evaluation-harness task reproducibility](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/task_guide.md),
  [logged samples and interface](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/interface.md),
  [MLPerf Client](https://mlcommons.org/benchmarks/client/), and
  [NIST TEVV](https://www.nist.gov/ai-test-evaluation-validation-and-verification-tevv).
- Workflow/UI and observability: [React Flow concepts](https://reactflow.dev/learn/concepts/terms-and-definitions),
  [connection validation](https://reactflow.dev/api-reference/components/handle),
  [n8n execution/retry behavior](https://docs.n8n.io/workflows/executions/all-executions/),
  and [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/).
- Security and identity: [Tailscale Serve identity/app capabilities](https://tailscale.com/docs/features/tailscale-serve),
  [Tailscale grants](https://tailscale.com/docs/features/access-control),
  [NIST SP 800-115](https://csrc.nist.gov/pubs/sp/800/115/final), and
  [OWASP file-upload controls](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
- Provenance and audio: [W3C PROV-O](https://www.w3.org/TR/prov-o/),
  [W3C Trace Context](https://www.w3.org/TR/trace-context/), and
  [Whisper](https://github.com/openai/whisper).
- Open source/supply chain: [OSI FAQ](https://opensource.org/faq),
  [REUSE specification](https://reuse.software/spec/), and
  [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations).
- CLI derivation and licensing: the official
  [Qwen Code repository and Gemini CLI acknowledgment](https://github.com/QwenLM/qwen-code),
  [Qwen Code Apache-2.0 license](https://github.com/QwenLM/qwen-code/blob/main/LICENSE),
  [Apache-2.0 application/NOTICE guidance](https://www.apache.org/legal/apply-license),
  and [Apache licensing/distribution FAQ](https://apache.org/foundation/license-faq.html).
- Host configuration and training portability:
  [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/),
  [Windows Known Folders](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid),
  [Hugging Face Accelerate configuration](https://huggingface.co/docs/accelerate/package_reference/cli),
  [PyTorch accelerator runtime checks](https://docs.pytorch.org/docs/stable/generated/torch.accelerator.is_available.html),
  [PyTorch MPS backend](https://docs.pytorch.org/docs/stable/notes/mps),
  [ROCm/PyTorch compatibility](https://rocm.docs.amd.com/en/docs-7.2.2/compatibility/ml-compatibility/pytorch-compatibility.html),
  [Python dependency groups](https://packaging.python.org/en/latest/specifications/dependency-groups/),
  and the [`pylock.toml` specification](https://packaging.python.org/en/latest/specifications/pylock-toml/).

## 24. Definition of program success

Project-LAL is elevated when an ordinary owner can:

1. search current model catalogs and understand license, origin, hardware fit,
   and limitations before spending disk or time;
2. download a pinned artifact safely and see truthful progress across web/CLI;
3. run and compare models with reproducible quality and efficiency evidence on
   their own machine;
4. trace every fine-tuned model back to exact data, code, base weights, and gates;
5. give agents images, audio, and web evidence with inspectable provenance;
6. design a typed HIVE conversation/work graph visually, understand why it
   routed as it did, and replay/audit failures;
7. define many durable specialist roles while loading only a resource-bounded
   working set, and demonstrate through ablation that the resulting organization
   beats a generalist on appropriate held-out work;
8. conduct intellectually open research and serious authorized defensive work
   without granting unbounded operational power;
9. install and inspect the project as genuinely open-source software without a
   datacenter, provider dependency, or hidden telemetry requirement;
10. use a LAL CLI whose normal identity, release, network behavior, and maintenance
    are Project-LAL-owned while its retained upstream ancestry remains accurately
    attributed and auditable;
11. keep the same source checkout as every other contributor while their personal
   paths, hardware facts, service manager, monitoring backend, model-runtime
   locations, ports, network exposure, desktop integration, backend workarounds,
   recipes, secrets, and mutable data remain outside it; and
12. export a redacted, reproducible host/recipe/run report that makes a portability
    bug actionable without exposing private machine state.

That result expresses the project’s central claim: quality comes from careful
architecture, evidence, and iteration—not from making every model and system
bigger.

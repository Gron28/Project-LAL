# Instant adapters and continuous memory

Status: research-backed integration plan, 2026-08-02. No generated adapter is
eligible for routing until it passes the same held-out promotion gates as a
trained adapter.

## Outcome

Project LAL should treat context-to-LoRA hypernetworks as an experimental
adapter provider, not as a replacement for fine-tuning and not as a universal
model optimizer.

The first useful experiment is document/conversation memory on a small,
supported backbone. Improving Gemma 4 tool use is not a valid first target:
the released SHINE checkpoint targets the exact Qwen3-8B architecture and base
weights, and there is no released Gemma 4 hypernetwork. A generated LoRA is not
portable across unrelated architectures or independently fine-tuned base
weights.

Meanwhile, bounded rolling context should remain the production continuity
mechanism. A compact state plus a recent verbatim tail can make chat duration
effectively unbounded, but a literal zero-context chat is impossible: the model
must still receive the current request, system/tool contract, and either a
memory representation or adapter.

## What SHINE actually provides

SHINE is a meta-trained hypernetwork. At test time it performs a forward pass
over a context and emits a rank-8 LoRA; it does not run gradient descent for
each context. The expensive work has been moved earlier into training the
hypernetwork itself.

The released experiment has important boundaries:

- backbone: `Qwen/Qwen3-8B` in the Transformers/PyTorch representation;
- generated rank: 8; Meta-LoRA rank: 128;
- ordinary maximum input context during the reported experiments: 1,150
  tokens;
- meta-training: 6 billion tokens on eight NVIDIA A100 GPUs;
- reported adapter generation time: 0.3 seconds on the authors' hardware;
- task: primarily internalizing prose for reconstruction and question
  answering, not teaching arbitrary agent policies;
- long-context SHINE-R was trained/evaluated up to 18K tokens. It is recurrent,
  but its adapter storage grows linearly and it trails direct in-context input
  on the reported LongBench tasks.

SHINE is therefore not a diffusion model. Related parameter generators use
diffusion, but SHINE uses the frozen LLM plus Meta-LoRA as a context encoder and
a small Transformer to map memory states to parameters.

## Fit on the current host

The host has one AMD RX 6650 XT-class 8 GB GPU, 15 GiB system RAM, and about
190 GiB free disk. Its production models are normally quantized GGUFs served by
llama.cpp or Ollama.

The released SHINE path is not a production fit:

1. Qwen3-8B BF16 weights alone are roughly 16 GB, before the hypernetwork,
   activations, generated adapter, and runtime overhead.
2. The reference stack is PyTorch/Transformers and was published against CUDA;
   LAL serves its active local models through quantized llama.cpp/Ollama paths.
3. Keeping a normal 8B/12B model active on the same 8 GB GPU while running the
   SHINE backbone is not credible. CPU offload would also compete with only 15
   GiB RAM and would invalidate the published 0.3 second latency expectation.
4. Even a Qwen3-8B generated adapter must match the exact base checkpoint and
   target modules before it can be converted for llama.cpp. It cannot be
   applied to Qwen3.5, a community fine-tune, or Gemma 4 merely because the
   parameter count is similar.

SakanaAI's Doc-to-LoRA is the better first compatibility spike. It has a real
reference implementation and a 1.26 GB hypernetwork checkpoint for
`google/gemma-2-2b-it`; a community Qwen3-1.7B proof of concept uses a
144M-parameter hypernetwork. That is small enough to test on this host after
measuring the full base-plus-hypernetwork peak on ROCm. It remains a memory
experiment, not a tool-use claim, and neither checkpoint is compatible with
Gemma 4.

## Tool calling decision

Do not add a “make this model better at tools” button backed by SHINE.

The strongest directly relevant evidence currently cuts against it. The 2026
Meta-Tool controlled study tested a 227.8M-parameter hypernetwork on four tool
benchmarks. Few-shot examples contributed 21.5 percentage points and structured
documentation 5 points; the generated LoRA contributed no measurable gain.
Separately, PA-Tool reports gains up to 17% by aligning tool schemas to names a
small model already understands, without model training.

For Gemma 4, prioritize the cheaper, measurable path:

1. capture Gemma's tool-selection, argument, sequencing, and completion errors
   separately;
2. retrieve two to five verified examples matching the active tool/task;
3. benchmark compact documentation and schema aliases against the current
   schema;
4. train a conventional adapter on verified LAL trajectories only if those
   prompt-side changes plateau;
5. revisit generated tool adapters only when a Gemma-compatible hypernetwork
   or reproducible tool-policy result exists.

## Provider boundary

When the first spike passes, add generated adapters behind a provider boundary
rather than embedding SHINE-specific code in `lab.ts`:

```ts
type InstantAdapterRequest = {
  provider: "doc-to-lora" | "shine";
  exactBaseId: string;
  exactBaseHash: string;
  context: string;
  purpose: "memory" | "task";
};

type InstantAdapterArtifact = {
  path: string;
  sha256: string;
  baseHash: string;
  targetModules: string[];
  rank: number;
  generationMs: number;
  peakVramBytes: number;
  providerRevision: string;
};
```

The provider runs as a separate Python worker. The existing single-GPU lease
must cover generation, conversion, and probing. The artifact enters the
existing candidate registry and remains inactive until evaluation; it never
silently merges into base weights.

The training page may then expose a separate **Instant adapter (experimental)**
mode with truthful compatibility states:

- `ready`: exact supported base and provider checkpoint installed;
- `needs download`: known-compatible artifacts absent;
- `incompatible`: architecture/base hash/target modules do not match;
- `insufficient memory`: the measured peak cannot coexist with the requested
  resident runtime;
- `candidate`: generated and hashed, but not promoted;
- `rejected` or `promoted`: result of the existing evaluation gates.

## Continuous-memory design

Use two independent layers; neither should overwrite canonical history.

### Production layer: rolling dream

- Keep the complete transcript in the conversation/event ledger.
- At a measured context-fill threshold, fold only the oldest complete turns into
  a structured dream state.
- Preserve system/tool contracts and a recent verbatim tail.
- Merge the previous dream with the newly retired turns instead of repeatedly
  summarizing the full conversation.
- Track decisions, user preferences, unresolved work, file/artifact references,
  tool evidence, and uncertainty as separate fields.
- Emit a compaction event containing source turn IDs and the dream hash so the
  transformation is inspectable and replayable.
- Never treat the dream as evidence for successful tool execution; retain
  ledger/artifact pointers and re-check them when needed.

Compacting after every message is allowed as an opt-in experiment, not the
default. It roughly adds another model pass per turn, compounds summarization
loss, and provides little benefit while the raw window is mostly empty.

### Experimental layer: parameter memory

- Generate a transient context adapter from a stable dream/document chunk.
- Compare it with direct compact prompting at equal task and latency budgets.
- Reset/remove the adapter independently of deleting the conversation.
- Periodically regenerate from canonical source material; do not recursively
  generate only from earlier adapters.
- Preserve a small textual dream even when an adapter is active so state is
  inspectable and recoverable if the adapter/backend fails.

SHINE-R's “infinite” claim means unbounded sequential input with linearly
growing LoRA memory. It does not mean constant memory, perfect recall, zero
context, or an unchanged model forever.

## Required spike and acceptance gates

Do not download the full SHINE/Qwen3-8B stack first. Run the smaller
Doc-to-LoRA-compatible spike in an isolated environment and record:

1. exact repository and checkpoint revisions/licenses;
2. bytes on disk, cold-load time, generation time, peak VRAM and peak RAM;
3. whether generation runs on this ROCm device without source patches;
4. whether the adapter can be exported without numerical drift and served by
   LAL's llama.cpp path;
5. direct-context vs textual-dream vs generated-adapter accuracy on held-out
   questions, including contradictory updates and multi-turn recall;
6. base capability regression with the adapter enabled;
7. reset, crash recovery, and exact-base-hash rejection.

Minimum promotion gate for the experiment:

- at least 100 held-out questions across at least 20 unseen documents or
  conversations and three deterministic seeds;
- no material base regression;
- zero cross-base adapter acceptance;
- generated adapter must beat the textual rolling-dream baseline, not merely an
  empty-context base;
- end-to-end latency and memory must be useful on this host;
- all artifact lineage is reproducible from canonical context plus provider
  revision.

If the small spike cannot beat the textual dream or cannot run with acceptable
ROCm memory, stop there. The next investment should be rolling compaction and
schema/example optimization, not downloading the much larger SHINE stack.

## Primary references

- SHINE paper: <https://arxiv.org/abs/2602.06358>
- SHINE code/checkpoints: <https://github.com/MuLabPKU/SHINE>
- Doc-to-LoRA paper: <https://arxiv.org/abs/2602.15902>
- Doc-to-LoRA reference implementation: <https://github.com/SakanaAI/doc-to-lora>
- Meta-Tool tool-use study: <https://arxiv.org/abs/2604.20148>
- PA-Tool: <https://aclanthology.org/2026.acl-long.948/>

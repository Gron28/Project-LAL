# Project-LAL current state

Status date: 2026-07-22. This is the short, current implementation record. The
foundation roadmap determines order; the capability plan describes the longer
destination; the unimplemented-work audit records the remaining gaps.

## What works now

### Daily CLI

- `lal` is a native branded terminal agent with local file, edit, shell,
  sub-agent, web-search, and web-fetch tools. Tool execution stays on the client;
  model inference and authenticated internet egress are provided by the owner
  host. The last synchronized profile remains available while disconnected.
- `/research <question>` and explicit research requests enter an observable
  evidence workflow. Six successful distinct searches and four successfully
  opened sources are required before synthesis; failed calls do not count.
- Context compaction preserves instructions and tool attachments, oversized
  mutations fail early with repair guidance, repeated non-progress is bounded,
  and interrupted tool streams preserve recoverable content.
- Linux interactive rendering uses an alternate-screen viewport and suppresses
  redraws caused only by idle timers/telemetry. `lal --safe-terminal` is the
  compatibility fallback. Windows retains its working rendering path.
- Headless `lal -p` returns when its requested turn is complete. Interactive
  sessions retain background memory extraction/dreaming, but one-shot and SDK
  turns do not launch that maintenance after the answer.

### Shared model control

- `/models` is the canonical owner UI for installed GGUF/Ollama inventory,
  default selection, resident-model loading, per-model settings, context
  verification, deletion/export, and verified model acquisition.
- Each model has one durable profile: context, maximum output, GPU layers,
  temperature, top-p, top-k, repeat penalty, and thinking. Web Chat, Web Code,
  the inference gateway, and running CLI clients consume it. The web and CLI
  poll every two seconds, while the gateway also enforces it per request.
- Requested, verified, active, and model-native context are distinct values.
  The system does not report a requested setting as active before the matching
  runtime is alive.
- Qwen 3.5 9B completed real 60,046- and 100,051-token prompt tests with correct
  needle recall on the current AMD/Vulkan host. The stable profile uses a
  256-token batch and micro-batch, flash attention, quantized K/V cache, and one
  sequence. A different 131K configuration reset the Vulkan device at 13,824
  tokens, so it is not considered verified.

### Model acquisition and web

- The visible Models page can search Hugging Face, pin an immutable revision,
  inspect GGUF file hashes/sizes and license metadata, require license review,
  launch a resumable host job, show progress/error state, verify the completed
  bytes, and publish the model into the shared inventory.
- Web Chat and Code use the same inventory/profile source as the CLI. Empty and
  failed scans carry root-level diagnostics rather than silently showing a
  fictional zero-model state.
- The deployed service has health, process, durable-run, replay, stop, and model
  lifecycle surfaces. The release workflow builds, deploys, restarts, checks the
  tailnet routes, refreshes the local CLI, and publishes a checksum-pinned
  Windows runtime consumed by `lal update`.

## Important behavior

- Changing the saved default does not unexpectedly load it. `Load now` is a
  separate operation. A new web conversation and a newly launched CLI adopt the
  host default.
- A running CLI follows a changed host default only while it is still following
  the previous host default. A deliberate `/model` choice remains a session
  override. Settings for that selected model still update on the next turn.
- Chat/Code mode controls may deliberately override thinking or sampling for the
  current session; they do not mutate the shared model profile unless saved in
  model settings.
- Model downloads require network access, but installed models, local tools,
  conversations, and inference remain local/offline-capable.

## Work still required

1. Complete real Windows daily-use acceptance for `lal.28`, including live
   profile changes during a long session, reconnect, cancellation, and update
   rollback. Add native Linux/macOS release archives and signed manifests.
2. Finish cross-device native-run parity: one conversation identity and event
   stream for CLI, web, and phone, with full approvals, errors, context, model,
   and tool progress regardless of where the turn starts.
3. Move every mutable store into the capability registry with quotas,
   references, retention, cleanup tests, and disk-pressure behavior. Model
   downloads, conversations, caches, datasets, media, HIVE, benchmarks, and
   training outputs are not all bounded yet.
4. Make benchmarking decision-useful: immutable suite/model/runtime/hardware
   identity, repeats, raw evidence, comparisons without a fake universal score,
   and retention.
5. Restore HIVE only after workflow recovery, evidence, approvals, GPU/process
   ownership, and remote tool dispatch pass an end-to-end gate.
6. Restore training/fine-tuning only with isolated reproducible environments,
   dataset lineage, bounded storage, checkpoints, evaluation, and at least one
   demonstrated useful promotion.
7. Complete the browser authorization boundary for destructive model,
   filesystem, Git, training, HIVE, and download actions. Network placement by
   itself must not be treated as authorization.
8. Consolidate the repository boundary, remove or repoint inherited upstream
   telemetry/update/cloud surfaces, establish supported CI/fresh-clone setup,
   and finish host portability beyond the current Linux/AMD capsule.
9. Add richer beginner guidance: first-run hardware scan, model-fit explanation,
   storage estimates, download recommendations based on measured resources,
   and a guided first local chat without hiding technical truth.

## Acceptance source

Claims above should stay backed by automated tests, `CHANGELOG.md`, the guarded
host smokes, durable runtime logs, and recorded context experiments. When a
claim is no longer proven, move it back to the remaining-work list rather than
leaving aspirational UI text behind.

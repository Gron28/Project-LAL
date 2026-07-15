# HIVE specialist training

> Status: deferred experiment design. Current training datasets and candidates
> have not demonstrated a significant practical result; Project-LAL's
> reliability-first roadmap takes precedence.

HIVE's first trained cohort shares the installed `qwen3-4b-stock` GGUF and uses
three independently trained Qwen3-4B LoRA adapters:

- `coordinator_planner` — task contracts, bounded packages, and handoffs only.
- `coder_repairer` — inspect, mutate, check, diagnose, and repair.
- `verifier` — read-only requirement and completion audits.

Adapters always start from stock `Qwen/Qwen3-4B`; they are never stacked. A
candidate cannot enter automatic routing until its blind evaluation passes and a
separate promotion operation is approved.

## Base model: locked to Qwen3-4B (bake-off 2026-07-11)

Qwen3.5-4B was evaluated as a challenger under identical serving conditions
(b9835 binary supports its hybrid DeltaNet arch; no MoE in the 4B). Verdict —
rejected: 47.5 vs 82 decode tok/s (29 vs 62 at 6K context; the Vulkan linear-
attention path is unoptimized), coding 17/20 vs 19/20, and planning 1/14 under
the frozen 1536-token think budget (its chains of thought overrun the budget so
answers never arrive). Agentic was its only win (8/8 vs 7/8). Gemma 4 was ruled
out earlier: gemma4:12b already loses to stock Qwen3-4B on agentic and planning
locally, and the trainer/adapter pipeline is Qwen-specific. Revisit only if
llama.cpp lands fast DeltaNet kernels.

## Think policy

Specialist SFT targets carry the empty-`<think>` (no-think) format — public
teacher trajectories have no Qwen3 think spans, and synthesizing them is the
think-displacement trap. The engine therefore serves specialist adapters with
`enable_thinking:false` (stage completions and tool loops both); prompted roles
keep thinking. Never mix: a think-formatted suite measuring a no-think adapter
(or vice versa) measures the format mismatch, not the model.

## 1. Build an immutable role dataset

Create a JSON source specification. Every public source needs an explicit license;
generated/local sources need deterministic quality checks.

```json
{
  "sources": [
    {
      "path": "data/agentic_sft.jsonl",
      "source": "local-agentic-v1",
      "kind": "verified_local",
      "license": "project-authored",
      "checks": ["generator_assertions"]
    }
  ]
}
```

Build one role at a time:

```bash
.venv/bin/python scripts/build_hive_role_dataset.py \
  --role coder_repairer \
  --spec data/coder_sources.json \
  --out data/hive_coder_v1.jsonl \
  --block 1024 --tokenizer Qwen/Qwen3-4B
```

The builder normalizes conversations, checks role tool authority, rejects permanent
blind probes and benchmark overlap, removes duplicate prompts, rejects rows over the
actual chat-template context limit, and groups train/validation by task family. It
writes `data/hive_coder_v1.jsonl.manifest.json`; the trainers honor the manifest's
explicit split instead of re-splitting individual rows.

Registering the dataset in HIVE provenance is a separate approved operation:

```json
POST /api/hive/provenance
{
  "action": "register_role_dataset",
  "approved": true,
  "path": "../data/hive_coder_v1.jsonl",
  "manifestPath": "../data/hive_coder_v1.jsonl.manifest.json"
}
```

## 2. Run small gated training cycles

Use `/train`, choose **HQQ 4-bit**, base `Qwen/Qwen3-4B`, select a HIVE role, and
select the role JSONL. The UI automatically uses its adjacent manifest, the stock
runtime GGUF, a 10% grouped validation split, and adapter-only conversion.

Recommended sequence:

1. 100-step data/format smoke run.
2. 400–800-step candidate, validation enabled, snapshot every 100–200 steps.
3. Blind role and full-core evaluation.
4. Add only examples tied to diagnosed failures, then train a new immutable run name.

The proven trainer configuration remains HQQ 4-bit, LoRA rank 16/alpha 32 over
attention and MLP projections, and loss only on assistant/tool-call spans.
Coder decision windows are built and trained at block 2048 (their median length
is ~1400 tokens; 1024 would drop most of the dataset). The trainer now also
supports `--grad_accum N` (micro-batch accumulation, effective batch > 1),
`--warmup N` + `--cosine` (LR schedule), `--balance_sources` (uniform source
draw for mixed datasets), and a per-message `"train": false` flag that keeps an
erroneous assistant turn loss-masked while its failure observation and the
corrective turn still train — teach recovery, not the mistake. The train API
accepts `gradAccum`, `warmup`, `cosine`, `balanceSources`.

Public SWE trajectories enter through `scripts/convert_swe_traces.py`, which
streams nvidia/Open-SWE-Traces, keeps only `resolved == 1` rows from
permissive-license repos, and carves each long trajectory into at most 4
bounded decision windows (first_mutation / repair / verification) in the HIVE
tool schema — never blind truncation; over-budget windows are dropped whole.
The registry requires every row to carry non-empty `_hive.checks`, so declare
the converter's deterministic checks on the source in the spec. The best-validation adapter is converted with
`llama/src/convert_lora_to_gguf.py` into `models/hive-adapters/`. A candidate
manifest is written beside the model registry; no standalone merged model is
created for specialist runs.

## 3. Evaluate and promote

Evaluate stock Qwen3-4B single-agent, stock Qwen3-4B through HIVE, the best existing
single model through HIVE, and the candidate cohort with identical task and token
budgets. Individual adapters require:

- at least 30 held-out role tasks and two evaluation seeds;
- at least five points of role improvement;
- no more than two points of core regression;
- passing schema, tool, and live adapter compatibility probes;
- zero unauthorized role actions and no more than 5% false completion.

Submit the measurements to `POST /api/hive/evaluation` with
`kind: "specialist_adapter"`. Promotion then requires a distinct approval:

```json
POST /api/hive/provenance
{
  "action": "promote_specialist",
  "id": "coder_repairer:my-run",
  "approved": true,
  "secondApproval": true,
  "evaluation": {
    "heldOutRoleImprovementPoints": 7,
    "coreRegressionPoints": 1,
    "schemaTestsPassed": true,
    "toolTestsPassed": true,
    "heldOutTasks": 30,
    "seeds": 2,
    "unauthorizedActions": 0,
    "falseCompletionRate": 0.03,
    "adapterCompatible": true
  }
}
```

Promoted adapters are preloaded with the shared base and selected per request. A
candidate or rejected adapter never enters automatic routing; it can only be chosen
explicitly for evaluation.

## 4. Feed verified runs back into training

`harvest_workflow` extracts production-format trajectories only when the final
mechanical and independent requirement audit passed. Failed-run diagnostics remain
quarantined and cannot be approved as training rows. Harvested examples also remain
quarantined until reviewed:

```json
POST /api/hive/provenance
{ "action": "harvest_workflow", "workflowId": "hive-..." }
```

After approving individual examples, `export_role_examples` writes an immutable
role JSONL under `data/`; run it through the dataset builder again before training.
This keeps workflow success, human data approval, checkpoint creation, and active
role promotion as four distinct decisions.

## Live workspace and safety

The `/hive` Workspace tab displays the selected workspace tree, live code files,
decoded write/edit drafts, plan/research streams, and durable artifacts together.
HIVE shell commands and deterministic checks execute in Bubblewrap with only the
selected workspace writable, the rest of the home directory hidden, credentials
removed from the environment, and networking disabled. Selecting another workspace
in the mission form is the explicit authorization boundary for another folder.

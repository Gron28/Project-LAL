# Build a fast, genuinely useful local-model pool

The goal is a local model that approaches Gemma4 12B quality while responding much faster on this 16 GB Intel laptop. The workflow is now **delivery first**: assemble several credible candidates, perform only rapid weight-surgery experiments, and benchmark the completed pool once.

## Working rules

- Do not run inference or benchmarks while constructing the candidate pool.
- Time-box each weight-surgery theory to about five minutes of processing, excluding downloads.
- Do not perform long calibration runs, recovery training, or week-long experiments.
- Prefer MoE models because experts are structurally separable; do not repeat extreme dense-layer deletion.
- Produce loadable artifacts first. Compare quality and speed only after the pool is ready.

## Machine and runtime

| Component | Verified state |
|---|---|
| Laptop | ASUS Vivobook 14 Flip TP3407SA |
| CPU | Intel Core Ultra 7 256V |
| Memory | 15.5 GiB usable LPDDR5X unified memory |
| Integrated GPU | Intel Arc 140V |
| NPU | Intel AI Boost, 47 INT8 TOPS |
| NPU runtime | OpenVINO 2026.2.1 |
| Ollama acceleration | Intel Vulkan flags configured |

OpenVINO now works as a separate first-class LAL backend because Ollama does not use the NPU. The NPU ran the OpenVINO Qwen3 8B INT4 model at approximately 11.6 tokens/second.

## What was completed

### Runtime integration

- Added an OpenAI-compatible OpenVINO NPU server.
- Integrated OpenVINO model discovery, activation, health, chat, gateway, registry, and benchmark routing into LAL.
- Kept the Windows runtime isolated from the existing Linux/Tailscale setup.
- Verified seven focused Python tests, targeted lint, TypeScript, production build, and an end-to-end streamed NPU response.

### Training UI

- Added **Pruning lab** inside the existing Training page.
- Added model, dataset, pruning percentage, noise percentage, seed, sample, and token controls.
- Added projected parameter/storage visualization, persistent experiment history, process control, logs, and quick-test support.
- Added a code-calibration dataset with 96 local repository-derived examples.

### Compression tooling

- Created a Windows Python 3.12 pruning environment with current `llmcompressor`, Transformers, PyTorch, and `triton-windows`.
- Added a REAP structural MoE expert-pruning script.
- Added a dense block-influence pruning script.
- Installed a current llama.cpp converter and Windows quantizer.

## Experiment already completed

The controlled dense-model test used the same Qwen3 release family:

| Model | Stored size | Score | Speed |
|---|---:|---:|---:|
| Qwen3 0.6B | 522 MB | 11/16 | 109.8 tok/s |
| Qwen3 1.7B | 1.4 GB | 14/16 | 62.7 tok/s |
| Qwen3 1.7B pruned to six layers | 438 MB | 0/16 | 98.6 tok/s |

The pruned model retained 613,182,976 parameters but produced incoherent output. Removing 22 of 28 dense layers was a failed approach. It proved that random holes or extreme dense-depth removal are not the desired mechanism.

## Current hypothesis

Use **task-specific MoE expert extraction**:

1. Start from a code-specialized MoE.
2. Rank or cluster experts without running a long calibration workload.
3. Keep a diverse subset of experts and remap the routers.
4. Quantize the resulting model.
5. Add several resulting artifacts to the pool before testing anything.

This is the closest practical interpretation of extracting the “coding parts” of a larger model. Coding capability is distributed in dense models, but MoE experts are separate tensors that can be selected, merged, or removed.

## Candidate pool

### Selection gate before any further results

The next comparison must be a deliberately small cross-section, not a pile of
near-duplicates. Do not run inference, benchmarks, or calibration while this
list is being assembled. The recommended sample is:

1. **Qwen3 1.7B** as the small dense speed floor already measured.
2. **OpenVINO Qwen3 8B INT4** as the NPU/runtime axis.
3. **Qwen3-Coder 30B-A3B Q2_K_L** as the code-specialized MoE quality axis.
4. **GPT-OSS 20B compact GGUF** as an independently trained general MoE control.
5. **One existing 4-9B dense candidate** only if it is materially different from
   Qwen3 1.7B (Qwen3.5 9B is the current best fit).

This covers fast dense CPU/GPU, NPU, code MoE, general MoE, and mid-size dense
quality. It intentionally excludes more dense-layer deletion, multiple nearly
identical quantizations, and calibration-free expert surgery. Those can only
be justified after a base MoE has demonstrated a meaningful speed/quality
opportunity in the one shared comparison.

The language seen from the NPU model is not evidence that Windows locale is
changing model behavior. It is model/prompt behavior. The UI now exposes an
OpenVINO-only per-model response-language instruction so English or Spanish can
be selected without changing the computer locale.

### Existing candidates

- Gemma4 12B — quality baseline.
- Qwen3.5 9B.
- OpenVINO Qwen3 8B INT4 — NPU candidate.
- Qwen3.5 4B.
- Ministral 3B and 8B.
- Phi4 Mini.
- Qwen3 4B and 14B.

The broken 438 MB dense-pruned Qwen model is evidence only, not a serious candidate.

### Candidates to acquire without running

| Candidate | Architecture | Candidate file | Download size |
|---|---|---|---:|
| Qwen3-Coder 30B-A3B Instruct | Code MoE, about 3B active | Q2_K_L GGUF | 10.55 GiB |
| Qwen3.6 27B-A3B Coder | Community code MoE, about 3B active | Q2_K_L GGUF | 9.65 GiB |
| GPT-OSS 20B | MoE | compact GGUF | about 10.7–11.0 GiB |

The Qwen3-Coder model is the primary target. Its full expert set may already fit at Q2, providing a fast approximately-3B-active alternative without destructive pruning.

## Simple next plan

1. **Acquire the pool**
   - Download the three compact MoE candidates.
   - Register/import them without generating text.

2. **Produce rapid variants**
   - Add calibration-free expert selection based on weight norm and diversity.
   - Attempt 25%, 50%, and approximately 60% expert removal on Qwen3-Coder.
   - Abort any transformation that cannot produce a loadable artifact within the time box.

3. **Expose everything in Training**
   - Show downloaded candidates and generated variants together.
   - Label source model, quantization, expert count, stored size, and surgery method.

4. **Benchmark once**
   - Run the whole pool through one short coding/logic/instruction suite.
   - Measure quality, first-token latency, generation speed, and memory.
   - Compare every candidate directly against Gemma4 12B.

5. **Keep only winners**
   - Remove obviously broken or dominated artifacts.
   - Make the best fast model the local default.

## Repository state

The work is currently uncommitted. Important source files include:

- `scripts/openvino_npu_server.py`
- `scripts/reap_code_experts.py`
- `scripts/prune_dense_layers.py`
- `scripts/start-local-windows.ps1`
- `web/src/lib/pruning-lab.ts`
- `web/src/app/api/train/pruning/route.ts`
- `web/src/app/train/pruning-lab.tsx`
- `web/src/app/train/page.tsx`
- `web/src/lib/lab.ts`
- `tests/test_openvino_npu_server.py`
- `tests/test_lal_local_windows_launcher.py`

Generated `.next-*`, local environments, downloaded weights, datasets, and experiment outputs must remain uncommitted. A final clean build and browser verification are still required after the remaining UI work.

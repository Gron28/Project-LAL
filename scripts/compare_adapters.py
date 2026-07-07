"""Visualize the actual difference between two trained models — not raw weights (no
natural 'shape' to a weight matrix, would be arbitrary) but the LoRA delta each run
learned: for every (layer, module) pair, the real weight change is B @ A * (alpha/r),
exactly what stream_merge_and_save folds into the base model. Its Frobenius norm per
(layer, module) is a genuine, physically-meaningful "how much did this part of the
network change" fingerprint — cheap (CPU-only, ~250 small matmuls per model, a few
seconds) and comparable across runs since every run here shares the same LoRA
r=16/alpha=32 config and the same Qwen3-8B target modules.

  python scripts/compare_adapters.py --ckpt out/victory6-8b_ckpt/best --ckpt out/victory7-8b_ckpt/best
Writes one JSON object per --ckpt to stdout (one line each), or --out to a file.
"""
import argparse, json, os, re
import torch
torch.set_num_threads(2)  # this box may have a GPU run alive with its own CPU-side
                          # work (data loading, HQQ dequant); default torch grabs every
                          # core, which measurably slows the live run down. 2 threads
                          # keeps this comparison a background citizen, not a rival.
from safetensors import safe_open

LORA_TARGETS = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")


def load_deltas(adapter_dir):
    path = os.path.join(adapter_dir, "adapter_model.safetensors")
    cfg = json.load(open(os.path.join(adapter_dir, "adapter_config.json")))
    scaling = cfg["lora_alpha"] / cfg.get("r", cfg.get("lora_r", 16))

    pairs = {}  # (layer, module) -> {"A":.., "B":..}
    with safe_open(path, framework="pt") as f:
        for name in f.keys():
            m = re.search(r"layers\.(\d+)\.\w+\.(" + "|".join(LORA_TARGETS) + r")\.lora_(A|B)\.weight$", name)
            if not m:
                continue
            layer, module, which = int(m.group(1)), m.group(2), m.group(3)
            pairs.setdefault((layer, module), {})[which] = f.get_tensor(name)

    n_layers = max(l for l, _ in pairs) + 1
    matrix = [[0.0] * len(LORA_TARGETS) for _ in range(n_layers)]
    for (layer, module), ab in pairs.items():
        if "A" not in ab or "B" not in ab:
            continue
        delta = (ab["B"].float() @ ab["A"].float()) * scaling
        matrix[layer][LORA_TARGETS.index(module)] = round(delta.norm().item(), 4)
    return matrix


def load_evolution(ckpt_dir):
    """Every `step_N` snapshot dir under a run's _ckpt/ (written by --snapshot_every),
    read in step order — the delta matrix's history across training, not just its
    final state. Returns (steps, series) where series[i] is load_deltas()'s matrix
    at steps[i]."""
    snaps = []
    for d in os.listdir(ckpt_dir):
        m = re.match(r"step_(\d+)$", d)
        if m and os.path.exists(os.path.join(ckpt_dir, d, "adapter_model.safetensors")):
            snaps.append((int(m.group(1)), os.path.join(ckpt_dir, d)))
    snaps.sort(key=lambda t: t[0])
    steps = [s for s, _ in snaps]
    series = [load_deltas(d) for _, d in snaps]
    return steps, series


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", action="append", help="adapter dir (snapshot); repeatable")
    ap.add_argument("--evolution", help="a run's _ckpt dir — reads all step_N snapshots inside it")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    if not args.ckpt and not args.evolution:
        ap.error("need --ckpt (repeatable) or --evolution")

    results = []
    if args.evolution:
        name = os.path.basename(args.evolution.rstrip("/")).replace("_ckpt", "")
        steps, series = load_evolution(args.evolution)
        if not steps:
            ap.error(f"no step_N snapshots found in {args.evolution} — run with --snapshot_every > 0")
        results.append({"name": name, "modules": list(LORA_TARGETS), "steps": steps, "series": series})
    else:
        for ckpt in args.ckpt:
            name = os.path.basename(os.path.dirname(ckpt.rstrip("/"))).replace("_ckpt", "")
            matrix = load_deltas(ckpt)
            results.append({"name": name, "modules": list(LORA_TARGETS), "matrix": matrix})

    text = "\n".join(json.dumps(r) for r in results)
    if args.out:
        open(args.out, "w").write(text + "\n")
    else:
        print(text)


if __name__ == "__main__":
    main()

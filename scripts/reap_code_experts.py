"""Code-calibrated structural MoE pruning with an optional random-hole ablation.

Structural REAP pruning removes complete experts and can reduce the runnable
checkpoint. Random holes are retained only as an experiment control: ordinary
dense runtimes still store and multiply zeroed weights.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path
from typing import Any


MODEL_SPECS = {
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
        "parameters_b": 30.5,
        "active_b": 3.3,
        "layers": 48,
        "experts": 128,
        "active_experts": 8,
    },
    "Qwen/Qwen3-Coder-Next": {
        "parameters_b": 80.0,
        "active_b": 3.0,
        "layers": 48,
        "experts": 512,
        "active_experts": 10,
    },
}


def emit(event: str, **values: Any) -> None:
    print(json.dumps({"event": event, "ts": time.time(), **values}), flush=True)


def load_rows(path: Path, limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if len(rows) >= limit:
                break
            if not line.strip():
                continue
            value = json.loads(line)
            if isinstance(value.get("messages"), list):
                rows.append({"messages": value["messages"]})
            elif isinstance(value.get("text"), str):
                rows.append({"text": value["text"]})
            elif isinstance(value.get("instruction"), str):
                output = value.get("output", "")
                rows.append(
                    {
                        "messages": [
                            {"role": "user", "content": value["instruction"]},
                            {"role": "assistant", "content": str(output)},
                        ]
                    }
                )
            else:
                raise ValueError(f"{path}:{line_number}: expected messages, text, or instruction")
    if not rows:
        raise ValueError("calibration file contains no usable rows")
    return rows


def inject_random_holes(model: Any, fraction: float, seed: int) -> tuple[int, int]:
    """Zero a reproducible sample of expert weights without claiming size savings."""
    if fraction <= 0:
        return 0, 0
    import torch

    generator = torch.Generator(device="cpu").manual_seed(seed)
    changed = total = 0
    with torch.no_grad():
        for name, parameter in model.named_parameters():
            if ".experts." not in name or parameter.is_meta:
                continue
            flat = parameter.data.view(-1)
            total += flat.numel()
            for start in range(0, flat.numel(), 1_000_000):
                chunk = flat[start : start + 1_000_000]
                mask = torch.rand(chunk.numel(), generator=generator, device="cpu") < fraction
                if chunk.device.type != "cpu":
                    mask = mask.to(chunk.device)
                changed += int(mask.sum().item())
                chunk.masked_fill_(mask, 0)
    return changed, total


def estimate(model_id: str, prune: float) -> dict[str, Any]:
    spec = MODEL_SPECS[model_id]
    retained_experts = max(spec["active_experts"], round(spec["experts"] * (1 - prune)))
    # Experts dominate these MoE checkpoints, but embeddings, routers and
    # attention remain dense. Keep a conservative 12% non-expert floor.
    retained_ratio = 0.12 + 0.88 * (retained_experts / spec["experts"])
    return {
        **spec,
        "retained_experts": retained_experts,
        "estimated_parameters_b": round(spec["parameters_b"] * retained_ratio, 2),
        "estimated_bf16_gib": round(spec["parameters_b"] * retained_ratio * 2 / 1.073741824, 2),
        "estimated_q4_gib": round(spec["parameters_b"] * retained_ratio * 0.55 / 1.073741824, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=MODEL_SPECS, default="Qwen/Qwen3-30B-A3B-Instruct-2507")
    parser.add_argument("--calibration", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--offload-dir", type=Path, required=True)
    parser.add_argument("--prune", type=float, default=0.5)
    parser.add_argument("--noise", type=float, default=0.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument("--max-sequence-length", type=int, default=1024)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()

    if not 0 <= args.prune <= 0.9:
        raise SystemExit("--prune must be between 0 and 0.9")
    if not 0 <= args.noise <= 0.9:
        raise SystemExit("--noise must be between 0 and 0.9")
    plan = estimate(args.model, args.prune)
    emit("plan", model=args.model, prune=args.prune, noise=args.noise, seed=args.seed, **plan)
    if args.plan_only:
        return
    if not args.calibration or not args.calibration.is_file():
        raise SystemExit("--calibration must point to a code-focused JSONL file")

    from datasets import Dataset
    from llmcompressor import oneshot
    from llmcompressor.modifiers.pruning import REAPPruningModifier
    from transformers import AutoModelForCausalLM, AutoTokenizer

    random.seed(args.seed)
    args.output.mkdir(parents=True, exist_ok=True)
    args.offload_dir.mkdir(parents=True, exist_ok=True)
    rows = load_rows(args.calibration, args.samples)
    emit("phase", phase="loading tokenizer", samples=len(rows))
    tokenizer = AutoTokenizer.from_pretrained(args.model)

    def render(row: dict[str, Any]) -> dict[str, str]:
        if "text" in row:
            return {"text": row["text"]}
        return {
            "text": tokenizer.apply_chat_template(
                row["messages"],
                tokenize=False,
                add_generation_prompt=False,
            )
        }

    dataset = Dataset.from_list(rows).map(render)

    def tokenize(row: dict[str, str]) -> dict[str, Any]:
        return tokenizer(
            row["text"],
            padding=False,
            max_length=args.max_sequence_length,
            truncation=True,
            add_special_tokens=False,
        )

    dataset = dataset.map(tokenize, remove_columns=dataset.column_names)
    emit("phase", phase="loading model with CPU/disk offload")
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype="auto",
        low_cpu_mem_usage=True,
        device_map="auto",
        max_memory={"cpu": "11GiB"},
        offload_folder=str(args.offload_dir),
        offload_state_dict=True,
    )
    emit("phase", phase="calibrating code-relevant experts")
    oneshot(
        model=model,
        dataset=dataset,
        recipe=REAPPruningModifier(sparsity=args.prune),
        max_seq_length=args.max_sequence_length,
        num_calibration_samples=len(rows),
        moe_calibrate_all_experts=False,
    )
    if args.noise:
        emit("phase", phase="injecting random-hole control", noise=args.noise)
        changed, total = inject_random_holes(model, args.noise, args.seed)
        emit("holes", changed=changed, eligible=total, actual=(changed / total if total else 0))
    emit("phase", phase="saving compressed checkpoint")
    model.save_pretrained(args.output, save_compressed=True)
    tokenizer.save_pretrained(args.output)
    manifest = {
        "model": args.model,
        "prune": args.prune,
        "noise": args.noise,
        "seed": args.seed,
        "samples": len(rows),
        "max_sequence_length": args.max_sequence_length,
        "estimate": plan,
        "warning": "Random holes do not reduce dense checkpoint size; structural expert pruning does.",
    }
    (args.output / "lal-pruning-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    emit("done", output=str(args.output.resolve()), **plan)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", message=str(error), type=type(error).__name__)
        raise

#!/usr/bin/env python3
"""Structurally remove low-influence transformer blocks from a dense HF model."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as functional
from transformers import AutoModelForCausalLM, AutoTokenizer


DEFAULT_CALIBRATION = [
    "Write a Python function that returns the first duplicate in a list.",
    "Explain why a binary search requires sorted input.",
    "Fix this JavaScript bug: const total = items.reduce((a, x) => a + x.price);",
    "What is 37 plus 48? Answer with the integer only.",
    "All wugs are blue and no blue thing is red. Can a wug be red?",
    "Return the second word in: alpha beta gamma.",
    "Write a SQL query that groups orders by customer_id and sums amount.",
    "Describe the difference between a process and a thread.",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Local HF model directory")
    parser.add_argument("--output", required=True, help="Output HF model directory")
    parser.add_argument("--keep-layers", type=int, required=True)
    parser.add_argument("--calibration", help="Optional JSONL containing text/messages")
    parser.add_argument("--samples", type=int, default=8)
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--noise", type=float, default=0.0, help="Random zero fraction after structural pruning")
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def text_from_row(row: dict[str, Any]) -> str | None:
    if isinstance(row.get("text"), str):
        return row["text"]
    if isinstance(row.get("instruction"), str):
        return row["instruction"]
    if isinstance(row.get("messages"), list):
        parts = [
            str(message.get("content", ""))
            for message in row["messages"]
            if isinstance(message, dict)
        ]
        return "\n".join(part for part in parts if part)
    return None


def load_calibration(path: str | None, samples: int) -> list[str]:
    texts: list[str] = []
    if path:
        with Path(path).open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    text = text_from_row(json.loads(line))
                except json.JSONDecodeError:
                    continue
                if text:
                    texts.append(text)
                if len(texts) >= samples:
                    break
    if not texts:
        texts = DEFAULT_CALIBRATION[:samples]
    return texts


def score_layers(
    model: Any,
    tokenizer: Any,
    texts: list[str],
    max_length: int,
) -> list[float]:
    layers = model.model.layers
    totals = [0.0] * len(layers)
    counts = [0] * len(layers)
    hooks = []

    def make_hook(index: int):
        def hook(_module: Any, inputs: tuple[Any, ...], output: Any) -> None:
            source = inputs[0].detach().float()
            target = (output[0] if isinstance(output, tuple) else output).detach().float()
            influence = 1.0 - functional.cosine_similarity(source, target, dim=-1)
            totals[index] += influence.mean().item()
            counts[index] += 1

        return hook

    for index, layer in enumerate(layers):
        hooks.append(layer.register_forward_hook(make_hook(index)))

    model.eval()
    with torch.inference_mode():
        for text in texts:
            encoded = tokenizer(
                text,
                return_tensors="pt",
                truncation=True,
                max_length=max_length,
            )
            model(**encoded, use_cache=False)

    for hook in hooks:
        hook.remove()
    return [total / max(count, 1) for total, count in zip(totals, counts)]


def apply_random_holes(model: Any, fraction: float, seed: int) -> int:
    if fraction <= 0:
        return 0
    generator = torch.Generator(device="cpu").manual_seed(seed)
    zeroed = 0
    with torch.no_grad():
        for name, parameter in model.named_parameters():
            if not name.startswith("model.layers.") or parameter.ndim < 2:
                continue
            mask = torch.rand(parameter.shape, generator=generator) < fraction
            zeroed += int(mask.sum().item())
            parameter[mask] = 0
    return zeroed


def main() -> None:
    args = parse_args()
    if not 0 <= args.noise < 1:
        raise SystemExit("--noise must be in [0, 1)")

    model_path = Path(args.model).resolve()
    output_path = Path(args.output).resolve()
    tokenizer = AutoTokenizer.from_pretrained(model_path)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        dtype=torch.bfloat16,
        device_map="cpu",
        low_cpu_mem_usage=True,
    )
    original_layers = len(model.model.layers)
    if not 1 <= args.keep_layers <= original_layers:
        raise SystemExit(f"--keep-layers must be between 1 and {original_layers}")

    texts = load_calibration(args.calibration, args.samples)
    scores = score_layers(model, tokenizer, texts, args.max_length)
    ranked = sorted(range(original_layers), key=lambda index: scores[index], reverse=True)
    kept = sorted(ranked[: args.keep_layers])

    layer_types = list(getattr(model.config, "layer_types", []) or [])
    model.model.layers = torch.nn.ModuleList([model.model.layers[index] for index in kept])
    model.config.num_hidden_layers = len(kept)
    model.model.config.num_hidden_layers = len(kept)
    if layer_types:
        kept_layer_types = [layer_types[index] for index in kept]
        model.config.layer_types = kept_layer_types
        model.model.config.layer_types = kept_layer_types
    if hasattr(model.config, "max_window_layers"):
        model.config.max_window_layers = min(model.config.max_window_layers, len(kept))
    if hasattr(model.model.config, "max_window_layers"):
        model.model.config.max_window_layers = min(model.model.config.max_window_layers, len(kept))

    zeroed = apply_random_holes(model, args.noise, args.seed)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    output_path.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(output_path, safe_serialization=True)
    tokenizer.save_pretrained(output_path)

    manifest = {
        "source": str(model_path),
        "strategy": "block-influence structural depth pruning",
        "original_layers": original_layers,
        "kept_layers": kept,
        "removed_layers": [index for index in range(original_layers) if index not in kept],
        "layer_influence": scores,
        "parameter_count": parameter_count,
        "noise_fraction": args.noise,
        "zeroed_weights": zeroed,
        "calibration_samples": len(texts),
        "max_length": args.max_length,
        "seed": args.seed,
    }
    (output_path / "pruning-manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest))


if __name__ == "__main__":
    random.seed(42)
    torch.manual_seed(42)
    main()

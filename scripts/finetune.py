"""
LoRA fine-tune a local base model on a plain-text file, on the AMD GPU (ROCm).

This is the backend of the "training grounds": data .txt -> LoRA -> merged model
(ready for GGUF conversion + `ollama create`). Reusable & UI-drivable later.

  python scripts/finetune.py --base Qwen/Qwen2.5-0.5B-Instruct \
      --data data/proof.txt --out out/proof --steps 120 --merge

Progress is printed as JSON lines (step/loss) so a dashboard can stream it.
"""
import argparse, json, os, random, time
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32


def text_blocks(tok, path, block):
    ids = tok(open(path, encoding="utf-8").read(), return_tensors=None)["input_ids"]
    return [ids[i:i + block] for i in range(0, max(1, len(ids) - block), block)] or [ids[:block]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default="out/model")
    ap.add_argument("--steps", type=int, default=120)
    ap.add_argument("--bs", type=int, default=2)
    ap.add_argument("--block", type=int, default=256)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--target_loss", type=float, default=0.1, help="early-stop when smoothed loss reaches this (prevents overtraining)")
    ap.add_argument("--patience", type=int, default=80, help="early-stop if best loss hasn't improved in this many steps; 0 disables")
    ap.add_argument("--merge", action="store_true", help="save base+LoRA merged (for GGUF)")
    args = ap.parse_args()

    print(json.dumps({"event": "start", "device": DEVICE, "dtype": str(DTYPE).split(".")[-1],
                      "base": args.base, "data": os.path.basename(args.data), "steps": args.steps,
                      "lr": args.lr, "bs": args.bs, "block": args.block}), flush=True)
    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=DTYPE).to(DEVICE)
    model.config.use_cache = False  # incompatible with gradient checkpointing
    lcfg = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                                      "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lcfg)
    # Gradient checkpointing: recompute activations in the backward pass instead of
    # storing them. ~30% slower but cuts activation VRAM massively, so a 1.5B model
    # trains inside 8 GB. enable_input_require_grads() lets the recomputed graph
    # reach the LoRA adapters (needed when the frozen base inputs don't require grad).
    if DEVICE == "cuda":
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    # auto-scale batch/seq for big models so LoRA + checkpointing fit an 8GB card
    bs, block = args.bs, args.block
    if DEVICE == "cuda" and total > 2.0e9:
        bs, block = 1, min(block, 128)
        print(json.dumps({"event": "phase",
                          "phase": f"large model ({total/1e9:.1f}B params) -> bs={bs}, block={block} to fit VRAM"}), flush=True)
    blocks = text_blocks(tok, args.data, block)
    print(json.dumps({"event": "model", "trainable_params": trainable,
                      "total_params": total, "blocks": len(blocks),
                      "bs": bs, "block": block}), flush=True)

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
    model.train()
    t0 = time.time()
    prev_step, prev_time = 0, t0
    tokens_per_step = bs * block
    best, best_step, ema = float("inf"), 0, None
    stop_reason = None
    for step in range(1, args.steps + 1):
        batch = [random.choice(blocks) for _ in range(bs)]
        x = torch.tensor(batch, dtype=torch.long, device=DEVICE)
        loss = model(input_ids=x, labels=x).loss
        loss.backward()
        gnorm = torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        opt.step(); opt.zero_grad()
        lv = loss.item()
        ema = lv if ema is None else 0.15 * lv + 0.85 * ema   # smoothed loss for early-stop
        if lv < best - 1e-4:
            best, best_step = lv, step
        # early stopping: converged (smoothed loss low) OR plateaued (no improvement).
        # prevents the overtraining-into-degradation Felipe saw on tiny datasets.
        if step >= 20 and ema <= args.target_loss:
            stop_reason = f"converged: smoothed loss {ema:.3f} <= target {args.target_loss}"
        elif args.patience > 0 and step - best_step >= args.patience:
            stop_reason = f"plateau: no improvement in {args.patience} steps"
        if step % 10 == 0 or step == 1 or stop_reason:
            now = time.time()
            win_steps = step - prev_step
            win_dt = now - prev_time
            steps_s = win_steps / win_dt if win_dt > 0 else 0.0
            print(json.dumps({
                "event": "step", "step": step, "steps": args.steps,
                "loss": round(lv, 4), "best": round(best, 4), "ema": round(ema, 4),
                "grad_norm": round(float(gnorm), 3),
                "steps_s": round(steps_s, 3),
                "tok_s": round(tokens_per_step * steps_s),
                "eta": round((args.steps - step) / steps_s) if steps_s > 0 else None,
                "gpu_mb": round(torch.cuda.memory_allocated() / 1e6) if DEVICE == "cuda" else 0,
                "elapsed": round(now - t0, 1),
            }), flush=True)
            prev_step, prev_time = step, now
        if stop_reason:
            print(json.dumps({"event": "early_stop", "step": step, "reason": stop_reason,
                              "loss": round(lv, 4), "best": round(best, 4)}), flush=True)
            break

    os.makedirs(args.out, exist_ok=True)
    if args.merge:
        merged = model.merge_and_unload()
        merged.save_pretrained(args.out, safe_serialization=True)
    else:
        model.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    print(json.dumps({"event": "done", "out": args.out, "merged": args.merge}), flush=True)


if __name__ == "__main__":
    main()

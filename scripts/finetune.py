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
    ap.add_argument("--block", type=int, default=384)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--merge", action="store_true", help="save base+LoRA merged (for GGUF)")
    args = ap.parse_args()

    print(json.dumps({"event": "start", "device": DEVICE, "base": args.base}), flush=True)
    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    # 0.5B fits in fp32 on 8GB; stable for the proof. Bigger models -> fp16 + ckpt.
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.float32).to(DEVICE)
    lcfg = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                                      "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lcfg)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(json.dumps({"event": "model", "trainable_params": trainable}), flush=True)

    blocks = text_blocks(tok, args.data, args.block)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
    model.train()
    t0 = time.time()
    for step in range(1, args.steps + 1):
        batch = [random.choice(blocks) for _ in range(args.bs)]
        x = torch.tensor(batch, dtype=torch.long, device=DEVICE)
        loss = model(input_ids=x, labels=x).loss
        loss.backward()
        torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        opt.step(); opt.zero_grad()
        if step % 10 == 0 or step == 1:
            print(json.dumps({"event": "step", "step": step, "steps": args.steps,
                              "loss": round(loss.item(), 4),
                              "elapsed": round(time.time() - t0, 1)}), flush=True)

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

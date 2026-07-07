"""QLoRA (4-bit) instruction SFT — the standard way to fine-tune 4-8B on an 8GB GPU.

Loads the base model in 4-bit (NF4) so a 7B's weights drop from ~16GB to ~4GB, fitting
8GB VRAM, then trains LoRA adapters on top with loss masked to the answer. Requires a
WORKING ROCm bitsandbytes (the 1.33.7.preview wheel; the PyPI 0.49.2 has the AMD 4-bit
NaN bug). Run scripts/check_4bit.py first to confirm 4-bit works on this GPU.

  python scripts/finetune_qlora.py --base Qwen/Qwen2.5-7B-Instruct \
      --data data/sovereign_sft.jsonl --out out/m --steps 200 --merge
"""
import argparse, json, random, time, os
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training


def load_pairs(path):
    pairs = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        msgs = o.get("messages")
        if msgs:
            users = [m["content"] for m in msgs if m.get("role") == "user"]
            assistants = [m["content"] for m in msgs if m.get("role") == "assistant"]
            instr = users[-1] if users else None
            out = assistants[-1] if assistants else None
        else:
            instr = o.get("instruction") or o.get("q") or o.get("prompt")
            out = o.get("output") or o.get("answer") or o.get("a")
        if instr and out is not None:
            resp = out if isinstance(out, str) else (out[0] if isinstance(out, list) and out else json.dumps(out))
            pairs.append((str(instr), str(resp)))
    return pairs


def encode(tok, instr, resp, block):
    msgs = [{"role": "user", "content": instr}]
    prompt = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=True, return_dict=False)
    full = tok.apply_chat_template(msgs + [{"role": "assistant", "content": resp}], add_generation_prompt=False, tokenize=True, return_dict=False)
    labels = [-100] * len(prompt) + full[len(prompt):]
    return full[:block], labels[:block]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default="out/model")
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--block", type=int, default=512)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--target_loss", type=float, default=0.1)
    ap.add_argument("--patience", type=int, default=100, help="early-stop if best loss hasn't improved in this many steps; 0 disables")
    ap.add_argument("--merge", action="store_true", help="dequantize+merge to fp16 for GGUF (needs RAM ~ model fp16 size)")
    args = ap.parse_args()

    print(json.dumps({"event": "start", "device": "cuda-4bit", "dtype": "nf4", "base": args.base,
                      "steps": args.steps, "lr": args.lr, "mode": "qlora"}), flush=True)
    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                             bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.float16)
    model = AutoModelForCausalLM.from_pretrained(args.base, quantization_config=bnb, device_map={"": 0})
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    lcfg = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lcfg)
    total = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    pairs = load_pairs(args.data)
    examples = [encode(tok, i, r, args.block) for (i, r) in pairs]
    examples = [e for e in examples if any(l != -100 for l in e[1])]
    print(json.dumps({"event": "model", "trainable_params": trainable, "total_params": total,
                      "blocks": len(examples), "block": args.block,
                      "gpu_mb": round(torch.cuda.memory_allocated() / 1e6)}), flush=True)

    pad_id = tok.pad_token_id
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
    model.train()
    t0 = time.time(); prev_step, prev_time = 0, t0
    best, best_step, ema, stop_reason = float("inf"), 0, None, None
    for step in range(1, args.steps + 1):
        ids, lab = random.choice(examples)
        x = torch.tensor([ids], device="cuda:0"); y = torch.tensor([lab], device="cuda:0"); m = torch.ones_like(x)
        loss = model(input_ids=x, attention_mask=m, labels=y).loss
        loss.backward()
        gnorm = torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        opt.step(); opt.zero_grad()
        lv = loss.item(); ema = lv if ema is None else 0.15 * lv + 0.85 * ema
        if lv < best - 1e-4:
            best, best_step = lv, step
        if step >= 20 and ema <= args.target_loss:
            stop_reason = f"converged ema {ema:.3f}"
        elif args.patience > 0 and step - best_step >= args.patience:
            stop_reason = f"plateau {args.patience}"
        if step % 10 == 0 or step == 1 or stop_reason:
            now = time.time(); ss = (step - prev_step) / (now - prev_time) if now > prev_time else 0
            print(json.dumps({"event": "step", "step": step, "steps": args.steps, "loss": round(lv, 4),
                              "best": round(best, 4), "ema": round(ema, 4), "grad_norm": round(float(gnorm), 3),
                              "steps_s": round(ss, 3), "tok_s": round(args.block * ss),
                              "eta": round((args.steps - step) / ss) if ss > 0 else None,
                              "gpu_mb": round(torch.cuda.memory_allocated() / 1e6), "elapsed": round(now - t0, 1)}), flush=True)
            prev_step, prev_time = step, now
        if stop_reason:
            print(json.dumps({"event": "early_stop", "step": step, "reason": stop_reason}), flush=True)
            break

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out)   # always save the LoRA adapter
    tok.save_pretrained(args.out)
    if args.merge:
        try:
            print(json.dumps({"event": "phase", "phase": "dequantize + merge to fp16"}), flush=True)
            merged = model.merge_and_unload()
            merged.save_pretrained(args.out, safe_serialization=True)
            try:
                if not os.path.exists(os.path.join(args.out, "tokenizer.model")):
                    from huggingface_hub import hf_hub_download; import shutil
                    shutil.copy(hf_hub_download(args.base, "tokenizer.model"), os.path.join(args.out, "tokenizer.model"))
            except Exception:
                pass
        except Exception as e:
            print(json.dumps({"event": "phase", "phase": f"merge failed ({type(e).__name__}); adapter saved — convert base+adapter via llama.cpp instead"}), flush=True)
    print(json.dumps({"event": "done", "out": args.out, "merged": args.merge}), flush=True)


if __name__ == "__main__":
    main()

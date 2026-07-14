"""Instruction-format LoRA fine-tune with LOSS MASKING (proper SFT). v2.

The lesson from raw-text training: it degraded the instruct model (code 90%->60%),
because next-token loss over the whole blob teaches the model to imitate prompts too.
This trains on chat-templated conversations and masks the loss so it is computed ONLY
on assistant turns — learns the content, keeps instruction-following + coding ability.

v2 adds (all optional; v1 invocations keep working):
  --val_frac 0.1     deterministic hash-based held-out split, val loss every --val_every
  epoch shuffling    sample without replacement; {"event":"epoch","n":N} telemetry
  checkpoints        adapter saved to <out>_ckpt/{best,last}; --resume continues from last;
                     --merge merges from the BEST-VAL adapter, not the final step
  multi-turn/tools   data rows may be full {"messages":[...], "tools":[...]} conversations
                     incl. assistant tool_calls and role:"tool" results; loss is masked to
                     assistant segments only (the model learns to EMIT tool calls)

  python scripts/finetune_sft.py --base Qwen/Qwen3-4B \
      --data data/agentic_sft.jsonl --out out/m --steps 400 --val_frac 0.1 --merge

Same JSON-line telemetry + early-stopping as finetune.py.
"""
import argparse, hashlib, json, os, random, time
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32


def load_rows(path):
    """Each row -> {"messages": [...], "tools": [...]|None}. Accepts v1 shapes too."""
    rows = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        msgs = o.get("messages")
        hive_meta = o.get("_hive") if isinstance(o.get("_hive"), dict) else {}
        if msgs:
            if not any(m.get("role") == "assistant" for m in msgs):
                continue
            rows.append({"messages": msgs, "tools": o.get("tools"), "key": line,
                        "source": o.get("source", hive_meta.get("source", "unknown")),
                        "split": hive_meta.get("split"), "task_family": hive_meta.get("task_family")})
            continue
        instr = o.get("instruction") or o.get("q") or o.get("prompt") or o.get("question")
        out = o.get("output")
        if out is None:
            out = o.get("a") or o.get("answer")
        if instr is None or out is None:
            continue
        resp = out if isinstance(out, str) else (out[0] if isinstance(out, list) and out else json.dumps(out))
        rows.append({"messages": [{"role": "user", "content": str(instr)},
                                  {"role": "assistant", "content": str(resp)}],
                     "tools": None, "key": line, "source": o.get("source", hive_meta.get("source", "unknown")),
                     "split": hive_meta.get("split"), "task_family": hive_meta.get("task_family")})
    return rows


def encode_conversation(tok, msgs, tools, block):
    """Tokenize a (possibly multi-turn, possibly tool-using) conversation.

    Loss mask: only assistant turns train. The full conversation is rendered once
    and assistant spans are located by their ChatML markers (<|im_start|>assistant
    ... <|im_end|>) — prefix-diffing doesn't work for Qwen3, whose template strips
    <think> from previous turns (not prefix-stable). Unmasking every assistant span
    is what teaches tool_call emission in multi-round traces. An assistant message
    carrying "train": false stays masked — its failure observation and the
    corrective turn after it still train, which teaches recovery without teaching
    the mistake. Non-ChatML templates fall back to last-assistant-turn training
    (v1 behaviour).
    """
    kw = {"tokenize": True, "return_dict": False}
    if tools:
        kw["tools"] = tools
    ids = tok.apply_chat_template(msgs, add_generation_prompt=False, **kw)
    hdr = tok.encode("<|im_start|>assistant\n", add_special_tokens=False)
    end = tok.encode("<|im_end|>", add_special_tokens=False)
    if hdr and len(end) == 1:
        end_id = end[0]
        # nth rendered assistant span <-> nth assistant message (template renders
        # them 1:1 in order when add_generation_prompt=False)
        span_trains = [m.get("train") is not False for m in msgs if m.get("role") == "assistant"]
        labels = [-100] * len(ids)
        i, span, found = 0, 0, False
        while i <= len(ids) - len(hdr):
            if ids[i: i + len(hdr)] == hdr:
                trains = span_trains[span] if span < len(span_trains) else True
                span += 1
                j = i + len(hdr)
                while j < len(ids) and ids[j] != end_id:
                    if trains:
                        labels[j] = ids[j]
                    j += 1
                if j < len(ids) and trains:
                    labels[j] = ids[j]  # train the <|im_end|> stop too
                found = True
                i = j + 1
            else:
                i += 1
        if found:
            return ids[:block], labels[:block]
    return encode_last_turn(tok, msgs, tools, block)


def encode_last_turn(tok, msgs, tools, block):
    kw = {"tokenize": True, "return_dict": False}
    if tools:
        kw["tools"] = tools
    last_a = max(i for i, m in enumerate(msgs) if m.get("role") == "assistant")
    prompt = tok.apply_chat_template(msgs[:last_a], add_generation_prompt=True, **kw)
    full = tok.apply_chat_template(msgs[: last_a + 1], add_generation_prompt=False, **kw)
    labels = [-100] * len(prompt) + full[len(prompt):]
    return full[:block], labels[:block]


def is_val(row, val_frac):
    """Deterministic split: same row lands on the same side across runs/resumes."""
    # Provenance-rich HIVE datasets are grouped by task family before training;
    # honor that split exactly so paraphrases/repairs cannot leak across sides.
    if row.get("split") in ("train", "validation"):
        return row["split"] == "validation"
    h = int(hashlib.md5(row["key"].encode()).hexdigest(), 16)
    return (h % 10000) < int(val_frac * 10000)


@torch.no_grad()
def eval_val(model, val_examples, pad_id, cap=64):
    model.eval()
    losses = []
    for ids, lab in val_examples[:cap]:
        x = torch.tensor([ids], device=DEVICE)
        y = torch.tensor([lab], device=DEVICE)
        m = torch.ones_like(x)
        losses.append(model(input_ids=x, attention_mask=m, labels=y).loss.item())
    model.train()
    return sum(losses) / len(losses) if losses else None


def save_adapter(model, tok, path):
    os.makedirs(path, exist_ok=True)
    model.save_pretrained(path)
    tok.save_pretrained(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--data", required=True, help="JSONL: instruction/output pairs or full messages[] conversations")
    ap.add_argument("--out", default="out/model")
    ap.add_argument("--steps", type=int, default=400)
    ap.add_argument("--bs", type=int, default=1)        # bs1 keeps big-vocab logits small on 8GB
    ap.add_argument("--block", type=int, default=1024)  # long instruction responses need room
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--target_loss", type=float, default=0.2)
    ap.add_argument("--patience", type=int, default=100, help="early-stop if best loss hasn't improved in this many steps; 0 disables")
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--val_frac", type=float, default=0.0, help="held-out fraction (hash-split); 0 disables validation")
    ap.add_argument("--val_every", type=int, default=50)
    ap.add_argument("--resume", action="store_true", help="continue from <out>_ckpt/last")
    args = ap.parse_args()

    ckpt_dir = args.out.rstrip("/") + "_ckpt"
    print(json.dumps({"event": "start", "device": DEVICE, "dtype": str(DTYPE).split(".")[-1],
                      "base": args.base, "data": os.path.basename(args.data), "steps": args.steps,
                      "lr": args.lr, "mode": "sft",
                      "val_frac": args.val_frac, "resume": args.resume}), flush=True)
    # fix_mistral_regex=True: transformers itself warns Mistral-family tokenizers ship an
    # incorrect regex pattern causing real (not cosmetic) mis-tokenization; harmless no-op
    # kwarg on non-Mistral tokenizers (verified 2026-07-12), so passed unconditionally.
    tok = AutoTokenizer.from_pretrained(args.base, fix_mistral_regex=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=DTYPE).to(DEVICE)
    model.config.use_cache = False
    lcfg = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lcfg)

    start_step, resumed_best_val = 0, float("inf")
    if args.resume and os.path.exists(os.path.join(ckpt_dir, "last")):
        from peft.utils import load_peft_weights, set_peft_model_state_dict
        set_peft_model_state_dict(model, load_peft_weights(os.path.join(ckpt_dir, "last")))
        try:
            state = json.load(open(os.path.join(ckpt_dir, "state.json")))
            start_step = state["step"]
            resumed_best_val = state.get("best_val", float("inf"))
        except Exception:
            start_step = 0
        print(json.dumps({"event": "phase", "phase": f"resumed from step {start_step}"}), flush=True)

    if DEVICE == "cuda":
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    bs, block = args.bs, args.block
    if DEVICE == "cuda" and total > 2.0e9:
        bs, block = 1, min(block, 512)
        print(json.dumps({"event": "phase", "phase": f"large model ({total/1e9:.1f}B) -> bs={bs}, block={block}"}), flush=True)

    rows = load_rows(args.data)
    train_rows = [r for r in rows if not (args.val_frac > 0 and is_val(r, args.val_frac))]
    val_rows = [r for r in rows if args.val_frac > 0 and is_val(r, args.val_frac)]
    encode = lambda r: encode_conversation(tok, r["messages"], r["tools"], block)
    examples = [e for e in (encode(r) for r in train_rows) if any(l != -100 for l in e[1])]
    val_examples = [e for e in (encode(r) for r in val_rows) if any(l != -100 for l in e[1])]
    print(json.dumps({"event": "model", "trainable_params": trainable, "total_params": total,
                      "blocks": len(examples), "val_blocks": len(val_examples), "bs": bs, "block": block}), flush=True)
    if not examples:
        print(json.dumps({"event": "error", "msg": "no trainable examples after encoding"}), flush=True)
        return

    pad_id = tok.pad_token_id
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
    model.train()
    t0 = time.time(); prev_step, prev_time = 0, t0
    best, best_step, ema = float("inf"), start_step, None
    best_ema = float("inf")
    best_val = resumed_best_val
    stop_reason = None
    # epoch-shuffled sampling: draw without replacement, reshuffle when exhausted
    order, cursor, epoch = list(range(len(examples))), 0, 0
    random.shuffle(order)

    for step in range(start_step + 1, args.steps + 1):
        batch = []
        for _ in range(bs):
            if cursor >= len(order):
                random.shuffle(order); cursor = 0; epoch += 1
                print(json.dumps({"event": "epoch", "n": epoch}), flush=True)
            batch.append(examples[order[cursor]]); cursor += 1
        mx = max(len(ids) for ids, _ in batch)
        input_ids, labels, attn = [], [], []
        for ids, lab in batch:
            p = mx - len(ids)
            input_ids.append(ids + [pad_id] * p)
            labels.append(lab + [-100] * p)
            attn.append([1] * len(ids) + [0] * p)
        x = torch.tensor(input_ids, device=DEVICE)
        y = torch.tensor(labels, device=DEVICE)
        m = torch.tensor(attn, device=DEVICE)
        loss = model(input_ids=x, attention_mask=m, labels=y).loss
        loss.backward()
        gnorm = torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        opt.step(); opt.zero_grad()
        lv = loss.item()
        ema = lv if ema is None else 0.15 * lv + 0.85 * ema
        if lv < best - 1e-4:
            best = lv
        # plateau gate on SMOOTHED loss — raw bs=1 loss is too noisy to gate on;
        # one lucky near-zero example freezes "best" and patience fires early.
        if ema < best_ema - 1e-3:
            best_ema, best_step = ema, step

        if val_examples and (step % args.val_every == 0 or step == args.steps):
            vl = eval_val(model, val_examples, pad_id)
            if vl is not None:
                improved = vl < best_val - 1e-4
                if improved:
                    best_val = vl
                    best_step = step  # val improvement IS progress — don't let the train-EMA plateau gate fire past it
                    save_adapter(model, tok, os.path.join(ckpt_dir, "best"))
                print(json.dumps({"event": "val", "step": step, "val_loss": round(vl, 4),
                                  "best_val": round(best_val, 4)}), flush=True)
            save_adapter(model, tok, os.path.join(ckpt_dir, "last"))
            json.dump({"step": step, "best_val": best_val}, open(os.path.join(ckpt_dir, "state.json"), "w"))

        if step >= 20 and ema <= args.target_loss:
            stop_reason = f"converged: smoothed loss {ema:.3f} <= {args.target_loss}"
        elif args.patience > 0 and step - best_step >= args.patience:
            stop_reason = f"plateau: no improvement in {args.patience} steps"
        if step % 10 == 0 or step == 1 or stop_reason:
            now = time.time(); ws = step - prev_step; wt = now - prev_time
            ss = ws / wt if wt > 0 else 0.0
            print(json.dumps({"event": "step", "step": step, "steps": args.steps,
                              "loss": round(lv, 4), "best": round(best, 4), "ema": round(ema, 4),
                              "grad_norm": round(float(gnorm), 3), "steps_s": round(ss, 3),
                              "tok_s": round(bs * block * ss),
                              "eta": round((args.steps - step) / ss) if ss > 0 else None,
                              "gpu_mb": round(torch.cuda.memory_allocated() / 1e6) if DEVICE == "cuda" else 0,
                              "elapsed": round(now - t0, 1)}), flush=True)
            prev_step, prev_time = step, now
        if stop_reason:
            print(json.dumps({"event": "early_stop", "step": step, "reason": stop_reason,
                              "loss": round(lv, 4), "best": round(best, 4)}), flush=True)
            break

    # final checkpoint of where training ended
    save_adapter(model, tok, os.path.join(ckpt_dir, "last"))
    json.dump({"step": min(step, args.steps), "best_val": best_val}, open(os.path.join(ckpt_dir, "state.json"), "w"))

    os.makedirs(args.out, exist_ok=True)
    # merge from the best-val adapter when validation ran — the final step may be
    # past the sweet spot; best-val is the checkpoint that generalized best.
    if val_examples and os.path.exists(os.path.join(ckpt_dir, "best")):
        from peft.utils import load_peft_weights, set_peft_model_state_dict
        set_peft_model_state_dict(model, load_peft_weights(os.path.join(ckpt_dir, "best")))
        print(json.dumps({"event": "phase", "phase": f"merging best-val adapter (val {best_val:.4f})"}), flush=True)
    if args.merge:
        model.merge_and_unload().save_pretrained(args.out, safe_serialization=True)
    else:
        model.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    # Gemma's GGUF converter needs the sentencepiece tokenizer.model, which the fast
    # tokenizer doesn't re-emit. Fetch it from the base repo so conversion succeeds.
    try:
        if not os.path.exists(os.path.join(args.out, "tokenizer.model")):
            from huggingface_hub import hf_hub_download
            import shutil
            tm = hf_hub_download(args.base, "tokenizer.model")
            shutil.copy(tm, os.path.join(args.out, "tokenizer.model"))
    except Exception:
        pass  # Qwen etc. have no tokenizer.model and convert from tokenizer.json fine
    print(json.dumps({"event": "done", "out": args.out, "merged": args.merge}), flush=True)


if __name__ == "__main__":
    main()

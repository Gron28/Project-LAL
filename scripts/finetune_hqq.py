"""HQQ 4-bit instruction SFT — fine-tune 4-8B models on the 8GB AMD card. v2.

HQQ quantizes the base to 4-bit with a PURE-PYTORCH dequant path that runs on ROCm
(unlike bitsandbytes, which has no RDNA2 kernels). A 7B's weights drop ~16GB -> ~4-5GB,
fitting 8GB VRAM; LoRA adapters train on top, loss masked to the answer.

v2 (ported from finetune_sft.py — shared loader/encoder/val/ckpt logic is imported):
  --val_frac 0.1     deterministic hash-based held-out split, val loss every --val_every
  epoch shuffling    sample without replacement; {"event":"epoch","n":N} telemetry
  checkpoints        adapter saved to <out>_ckpt/{best,last}; --resume continues from last;
                     --merge merges from the BEST-VAL adapter, not the final step
  multi-turn/tools   rows may be full {"messages":[...], "tools":[...]} conversations,
                     loss-masked to assistant spans (tool_call emission trains too)

Loading (default): shard-streamed quantize. transformers 5.12's HqqConfig
quantize-on-load raises NotImplementedError (HQQ isn't ported to the new
core_model_loading path yet), and the old fallback (--legacy_load: full fp16
materialized on CPU, ~16GB for an 8B) pushed this 15GB-RAM box to 9.4/11GB swap
before finishing — one shard-load away from the OOM killer picking off unrelated
system daemons again (see HANDOFF bug #1). Instead we quantize each safetensors
shard straight onto the GPU as it streams in (HQQLinear del_orig=True frees the
CPU fp16 tensor immediately after quantizing), so peak CPU RAM is ~1 shard
(~3GB) instead of the whole model. Merge does the matching trick: LoRA deltas
are folded into the ORIGINAL fp16 shards (never the quantized copy — peft's
in-place HQQ merge leaves .W_q tensors GGUF can't read) one shard at a time.

  python scripts/finetune_hqq.py --base Qwen/Qwen3-4B \
      --data data/victory_mix1.jsonl --out out/m --steps 600 --val_frac 0.1 --merge
"""
import argparse, gc, json, math, os, random, re, shutil, time, traceback
import torch
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
from accelerate import init_empty_weights
from accelerate.utils import set_module_tensor_to_device
from huggingface_hub import snapshot_download
from safetensors import safe_open
from safetensors.torch import save_file
from peft import LoraConfig, get_peft_model
from peft.utils import load_peft_weights
from hqq.core.quantize import HQQLinear, HQQBackend, BaseQuantizeConfig
HQQLinear.set_backend(HQQBackend.PYTORCH)   # pure-torch dequant — ROCm-safe

from finetune_sft import load_rows, encode_conversation, is_val, save_adapter

LORA_TARGETS = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")
LORA_R, LORA_ALPHA = 16, 32


def _shard_files(snap_dir):
    idx_path = os.path.join(snap_dir, "model.safetensors.index.json")
    if os.path.exists(idx_path):
        weight_map = json.load(open(idx_path))["weight_map"]
        return weight_map, sorted(set(weight_map.values()))
    # single-file checkpoint
    only = "model.safetensors"
    with safe_open(os.path.join(snap_dir, only), framework="pt") as f:
        weight_map = {k: only for k in f.keys()}
    return weight_map, [only]


def stream_quantize_load(base, group_size, compute_dtype=torch.float16, quantize_cpu=False, stage_weights_cpu=False):
    """Build the model on meta, then stream shards in: LoRA-target linears get
    HQQ-quantized straight onto GPU (del_orig frees the CPU tensor); lm_head is
    quantized too but at 8-bit (it's ~1.2GB in fp16 on Qwen3's 151k vocab — the
    difference between the 8B fitting the 8GB card with training headroom or
    OOMing on backward; 8-bit keeps logit quality, and it has no LoRA on it so
    the merge still folds into the original fp16 shard). Embeddings/norms stay
    fp16. Peak CPU RAM stays ~1 shard instead of the full fp16 model."""
    snap_dir = base if os.path.isdir(base) else snapshot_download(base, allow_patterns=["*.json", "*.safetensors*", "*.model", "*.txt"])
    config = AutoConfig.from_pretrained(base)
    # Multimodal wrapper checkpoints (e.g. Ministral-3's "Mistral3ForConditionalGeneration")
    # aren't registered under AutoModelForCausalLM at all — AutoConfig.from_pretrained
    # returns the outer vision+text config, and the actual language model lives at
    # config.text_config with its own registered causal-LM architecture (confirmed live
    # 2026-07-12: Ministral-3-8B's text_config.model_type "ministral3" resolves to
    # Ministral3ForCausalLM with a fully standard module tree). The shards on disk still
    # store every tensor under a "language_model." prefix plus separate vision_tower./
    # multi_modal_projector. weights this text-only trainer has no use for — strip_prefix
    # tells the shard loop below to skip anything outside that prefix and drop it from
    # the ones it keeps, so the rest of this function (embed_tokens special-case,
    # LORA_TARGETS regex, lm_head handling) works unmodified against a plain module tree.
    text_config = getattr(config, "text_config", None)
    # Qwen3.5 stores the text tower under model.language_model.* while its
    # causal-LM class expects the plain model.* tree.  Ministral3 uses the
    # older language_model.* prefix.  Keep top-level lm_head in either case.
    strip_prefix = None
    if text_config is not None:
        strip_prefix = "model.language_model." if any(
            k.startswith("model.language_model.") for k in _shard_files(snap_dir)[0]
        ) else "language_model."
    with init_empty_weights():
        model = AutoModelForCausalLM.from_config(text_config or config, torch_dtype=compute_dtype)

    weight_map, shard_files = _shard_files(snap_dir)
    quant_cfg = BaseQuantizeConfig(nbits=4, group_size=group_size)
    target_pat = re.compile(r"\.(" + "|".join(LORA_TARGETS) + r")$")
    # lm_head stays fp16: HQQ's PYTORCH backend dequantizes the ENTIRE weight on
    # every forward (a 1.16GB transient that OOMs a near-full card), so
    # quantizing it costs more peak memory than it saves. The real logits-memory
    # fix is chunked_ce_loss below.

    quantized_modules = []

    def quantize_into(module_path, tensor, cfg):
        parent_path, _, leaf = module_path.rpartition(".")
        parent = model.get_submodule(parent_path) if parent_path else model
        tmp = torch.nn.Linear(tensor.shape[1], tensor.shape[0], bias=False)
        tmp.weight = torch.nn.Parameter(tensor, requires_grad=False)
        target_device = "cpu" if quantize_cpu else "cuda"
        quantized = HQQLinear(tmp, cfg, compute_dtype=compute_dtype, device=target_device)
        setattr(parent, leaf, quantized)
        if quantize_cpu:
            quantized_modules.append(quantized)

    for shard in shard_files:
        with safe_open(os.path.join(snap_dir, shard), framework="pt") as f:
            for raw_name in f.keys():
                if strip_prefix is not None:
                    if raw_name == "lm_head.weight":
                        name = raw_name
                    elif not raw_name.startswith(strip_prefix):
                        continue  # vision_tower.* / multi_modal_projector.* — irrelevant to a text-only specialist
                    else:
                        name = "model." + raw_name[len(strip_prefix):]
                else:
                    name = raw_name
                if name == "model.embed_tokens.weight":
                    # embeddings serve from CPU: a row-gather is trivial there, and
                    # this frees 1.2GB of VRAM (the margin between step 2 OOMing —
                    # AdamW state lands at the first opt.step() — and headroom)
                    model.model.embed_tokens = CPUEmbedding(f.get_tensor(raw_name).to(compute_dtype))
                    continue
                load_device = "cpu" if stage_weights_cpu else "cuda"
                if not name.endswith(".weight"):
                    set_module_tensor_to_device(model, name, device=load_device, value=f.get_tensor(raw_name).to(compute_dtype))
                    continue
                module_path = name[: -len(".weight")]
                if target_pat.search(module_path):
                    quantize_into(module_path, f.get_tensor(raw_name), quant_cfg)
                else:
                    set_module_tensor_to_device(model, name, device=load_device, value=f.get_tensor(raw_name).to(compute_dtype))
        gc.collect()
    if quantize_cpu:
        # HQQ's quantizer needs a temporary FP16 copy plus work buffers. Keeping
        # that workspace on CPU avoids the 9B load-time OOM on an 8GB card; only
        # the completed 4-bit modules are transferred afterward.
        for module in quantized_modules:
            module.to("cuda:0")
    elif stage_weights_cpu:
        # GPU HQQ quantization is fast, but defer ordinary FP16 weights until all
        # quantization work is complete so they do not crowd out HQQ's temporary
        # workspace. Restore the embedding table to CPU afterward.
        # Do not call model.to() here: it materializes every remaining FP16
        # tensor in one allocator burst (the 1.9GB lm_head alone can OOM the
        # nearly-full card). Transfer ordinary parameters individually.
        for name, parameter in list(model.named_parameters()):
            if name.startswith("lm_head."):
                continue  # keep the large frozen vocabulary projection on CPU
            if parameter.device.type == "cpu":
                set_module_tensor_to_device(model, name, device="cuda", value=parameter.detach())
        if hasattr(model, "lm_head") and isinstance(model.lm_head, torch.nn.Linear):
            model.lm_head = CPULinear(model.lm_head)
    # Small Qwen3 variants (0.6B/1.7B) set tie_word_embeddings=True, unlike the
    # 4B/8B this loader was built for — but their checkpoints store lm_head.weight
    # as its own real (duplicate) tensor rather than deduping it, so the shard loop
    # above already materializes both independently. Calling model.tie_weights()
    # here would try to re-derive lm_head from get_input_embeddings(), which is now
    # our CPUEmbedding (no .weight attr) -> crashes. Only do that manual re-link for
    # the genuinely-deduped case where lm_head.weight never appeared in the shards.
    lm_head_key = "lm_head.weight"
    if lm_head_key not in weight_map and hasattr(model, "lm_head"):
        lm_device = "cpu" if stage_weights_cpu else "cuda"
        set_module_tensor_to_device(model, "lm_head.weight", device=lm_device,
                                     value=model.model.embed_tokens.w.to(compute_dtype))
    return model


class CPUEmbedding(torch.nn.Module):
    """Frozen embedding table resident in CPU RAM; outputs land on GPU."""
    def __init__(self, weight):
        super().__init__()
        self.register_buffer("w", weight.cpu(), persistent=False)

    def forward(self, ids):
        return torch.nn.functional.embedding(ids.cpu(), self.w).to("cuda:0", non_blocking=True)


class CPULinear(torch.nn.Module):
    """Frozen FP32 CPU projection with differentiable GPU/CPU transfers.

    Keep its output in FP32. Casting the 248k-vocabulary logits back to FP16
    before cross-entropy preserved memory but made the Qwen3.5 backward path
    non-finite even when the LoRA weights themselves were FP32.
    """
    def __init__(self, linear):
        super().__init__()
        self.weight = torch.nn.Parameter(linear.weight.detach().cpu().float(), requires_grad=False)
        self.bias = torch.nn.Parameter(linear.bias.detach().cpu().float(), requires_grad=False) if linear.bias is not None else None

    def forward(self, x):
        out = torch.nn.functional.linear(x.float().cpu(), self.weight, self.bias)
        return out.to("cuda:0")


def chunked_ce_loss(model, x, m, y, chunk=256):
    """Causal-LM loss without materializing full-sequence logits. At block 1024
    Qwen3's 151k vocab makes the logits tensor ~1GB in fp32 (plus fp16 copies) —
    the single biggest transient on an 8GB card. Run the transformer body once,
    then apply lm_head + cross-entropy per chunk under gradient checkpointing,
    so only one chunk's logits (~150MB) exist at a time in either pass."""
    lm = model.base_model.model if hasattr(model, "base_model") else model  # peft unwrap
    hidden = lm.model(input_ids=x, attention_mask=m).last_hidden_state
    h, t = hidden[:, :-1, :], y[:, 1:]
    n_valid = (t != -100).sum().clamp(min=1)

    def chunk_loss(hc, tc):
        logits = lm.lm_head(hc).float()
        return torch.nn.functional.cross_entropy(
            logits.view(-1, logits.size(-1)), tc.reshape(-1), ignore_index=-100, reduction="sum")

    total = None
    for i in range(0, h.shape[1], chunk):
        tc = t[:, i:i + chunk]
        if not (tc != -100).any():
            continue
        part = torch.utils.checkpoint.checkpoint(chunk_loss, h[:, i:i + chunk, :], tc, use_reentrant=False)
        total = part if total is None else total + part
    return total / n_valid


@torch.no_grad()
def eval_val(model, val_examples, pad_id, cap=64):
    """finetune_sft's eval_val, but through chunked_ce_loss — full-logits val
    forwards OOM at block 1024 just like training ones."""
    model.eval()
    losses = []
    for i, (ids, lab) in enumerate(val_examples[:cap]):
        x = torch.tensor([ids], device="cuda:0")
        y = torch.tensor([lab], device="cuda:0")
        losses.append(chunked_ce_loss(model, x, torch.ones_like(x), y).item())
        # every example is a different length -> a new allocator size class each time;
        # ROCm's expandable_segments doesn't reliably coalesce these back, so fragmentation
        # compounds across the val loop and OOMs partway through on a near-full card (hit
        # live on a 1.7B run: 7.3/7.98GiB "allocated" when a 150MB request failed, three
        # times, always around this val pass). Clearing every few examples bounds it.
        if i % 8 == 7:
            torch.cuda.empty_cache()
    model.train()
    return sum(losses) / len(losses) if losses else None


_LAYER_RE = re.compile(r"layers\.(\d+)\.")


def layer_grad_norms(model):
    """Per-transformer-block L2 grad norm, read right after backward+clip (before
    zero_grad wipes .grad). Cheap: ~448 small LoRA tensors, negligible next to the
    8B forward/backward that already ran this step. Powers the block-heatmap panel
    on the training page — the closest real signal to 'which part is lighting up'."""
    sums = {}
    for name, p in model.named_parameters():
        if p.grad is None:
            continue
        m = _LAYER_RE.search(name)
        idx = int(m.group(1)) if m else -1
        if idx < 0:
            continue
        sums[idx] = sums.get(idx, 0.0) + p.grad.float().pow(2).sum().item()
    if not sums:
        return []
    n = max(sums) + 1
    return [round(sums.get(i, 0.0) ** 0.5, 4) for i in range(n)]


def make_probe(val_rows, train_rows, prompt_char_budget=2400):
    """Pick one fixed conversation to re-generate periodically so the training page
    can show 'what the model actually says' next to the gold answer, not just a
    loss number. Prefers a held-out row so the probe never leaks into training.
    Tool-call targets (specialist windows end in an assistant tool_call, often with
    empty content) show the call JSON — an empty target made the panel look dead.

    HIVE decision-window prompts run up to the full ~2048-token block budget (task
    contract + progress + last observation). Feeding that whole thing into a live
    generate() call grows the KV cache on top of the same-checkpoint eval_val +
    embed_prompts stack and OOM'd the very next training step (2026-07-11, block
    2048 coder_repairer data). The probe is a display sample, not training — cap
    each message's content to a char budget (keeping the tail: most recent/
    relevant context) so the generate() call stays cheap regardless of dataset."""
    for r in (val_rows or []) + (train_rows or []):
        msgs = r.get("messages") or []
        if msgs and msgs[-1].get("role") == "assistant":
            last = msgs[-1]
            target = str(last.get("content") or "")
            if last.get("tool_calls"):
                target = (target + "\n" if target else "") + json.dumps(last["tool_calls"], ensure_ascii=False)[:1200]
            if not target:
                continue
            prompt_msgs = []
            for m in msgs[:-1]:
                m = dict(m)
                content = m.get("content")
                if isinstance(content, str) and len(content) > prompt_char_budget:
                    m["content"] = "...[truncated for probe display]...\n" + content[-prompt_char_budget:]
                prompt_msgs.append(m)
            return {"prompt_msgs": prompt_msgs, "target": target, "tools": r.get("tools")}
    return None


@torch.no_grad()
def run_probe(model, tok, probe, max_new=100, tb_path=None):
    """Greedy re-generation of the probe prompt, plus real certitude per token:
    the softmax probability of each chosen token and the full-distribution entropy
    (nats) at that position — straight from the logits, nothing synthesized.

    The output_scores/return_dict_in_generate path is new (2026-07-11) and has
    failed silently on this quantized+LoRA model with an empty exception message
    on every attempt so far — falls back to a plain generate() (text only, no
    certitude) rather than losing the whole probe panel over an unconfirmed cause."""
    if probe is None:
        return None
    model.eval()
    kw = {"add_generation_prompt": True, "return_tensors": "pt"}
    if probe["tools"]:
        kw["tools"] = probe["tools"]
    enc = tok.apply_chat_template(probe["prompt_msgs"], **kw)
    # this transformers version returns a BatchEncoding (dict-like), not a bare
    # tensor, for return_tensors="pt" here — passing it straight to generate()
    # fails deep inside with a bare, unhelpful AttributeError (confirmed via
    # traceback capture 2026-07-11: generate() does inputs_tensor.shape[0],
    # BatchEncoding has no .shape, its __getattr__ raises AttributeError with no
    # message). Unwrap to the actual input_ids tensor either way.
    ids = (enc if torch.is_tensor(enc) else enc["input_ids"]).to("cuda:0")
    prev_cache = model.config.use_cache
    model.config.use_cache = True
    try:
        try:
            out = model.generate(ids, max_new_tokens=max_new, do_sample=False, pad_token_id=tok.pad_token_id,
                                 return_dict_in_generate=True, output_scores=True)
            seq = out.sequences[0, ids.shape[1]:]
            gen = tok.decode(seq, skip_special_tokens=True)
            tokens, probs, entropy = [], [], []
            for i, scores in enumerate(out.scores[: seq.shape[0]]):
                logp = torch.log_softmax(scores[0].float(), dim=-1)
                p = logp.exp()
                tokens.append(tok.decode([int(seq[i])]))
                probs.append(round(float(p[int(seq[i])]), 4))
                entropy.append(round(float(-(p * logp).sum()), 3))
            return {"text": gen, "tokens": tokens, "probs": probs, "entropy": entropy}
        except Exception as e:
            # a bare AttributeError() with no message (2026-07-11) is otherwise
            # undebuggable — the full traceback is the only way to find which
            # attribute lookup on which object actually failed
            def log_traceback(heading):
                if not tb_path:
                    return
                try:
                    with open(tb_path, "a") as f:
                        f.write(f"\n=== {heading} {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
                        traceback.print_exc(file=f)
                except Exception:
                    pass
            log_traceback("probe scores-path failure")
            print(json.dumps({"event": "probe_scores_fallback", "error_type": type(e).__name__,
                              "error": repr(e)[:300], "traceback_file": tb_path}), flush=True)
            try:
                out = model.generate(ids, max_new_tokens=max_new, do_sample=False, pad_token_id=tok.pad_token_id)
                gen = tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True)
                return {"text": gen, "tokens": [], "probs": [], "entropy": []}
            except Exception:
                log_traceback("probe fallback ALSO failed")
                raise
    finally:
        model.config.use_cache = prev_cache
        model.train()


def length_histogram(all_lengths, block, bins=16):
    """Distribution of raw (pre-drop) token lengths, bucketed, split kept-vs-dropped
    against --block. Answers 'how much of the mix silently didn't fit' as a shape,
    not a single dropped_overlength count."""
    if not all_lengths:
        return {"edges": [], "kept": [], "dropped": []}
    hi = max(L for L, _ in all_lengths)
    width = max(1, -(-hi // bins))
    edges = [i * width for i in range(bins + 1)]
    kept, dropped = [0] * bins, [0] * bins
    for L, ok in all_lengths:
        b = min(L // width, bins - 1)
        (kept if ok else dropped)[b] += 1
    return {"edges": edges, "kept": kept, "dropped": dropped}


# Fixed, hand-picked prompts spanning distinct topics — held out of training entirely.
# The question this answers: does fine-tuning actually pull same-topic prompts into
# tighter clusters over the run, or is "representation drift" just a story? Real
# embeddings, not a fabricated animation — see scripts/compare_adapters.py's sibling
# rationale for why a FIXED projection basis (not a per-snapshot UMAP refit) is what
# makes drift meaningful frame-to-frame instead of an artifact of re-fitting.
GALAXY_PROMPTS = [
    ("code", "Write a Python function that reverses a linked list in place."),
    ("code", "Implement binary search over a sorted array of integers."),
    ("code", "Write a function to check if a string is a valid palindrome."),
    ("math", "A train travels 60 miles in 45 minutes. What is its speed in mph?"),
    ("math", "Solve for x: 3x + 7 = 22."),
    ("math", "What is the sum of the first 50 positive integers?"),
    ("planning", "You have tasks A, B, C where B depends on A and C depends on B. What order do you run them in?"),
    ("planning", "You need to schedule 3 meetings with no room conflicts across 2 rooms. Describe your approach."),
    ("agentic", "Read the file config.json, then update the port value to 8080."),
    ("agentic", "List all files in the current directory that end in .py."),
    ("knowledge", "What causes the seasons to change on Earth?"),
    ("knowledge", "Explain why the sky appears blue during the day."),
    ("creative", "Write a two-sentence story about a lighthouse keeper."),
    ("creative", "Describe the smell of rain on hot pavement."),
    ("instruct", "Answer in exactly one word: what is the capital of France?"),
    ("instruct", "List three colors, one per line, no punctuation."),
]

_galaxy_basis = {"mean": None, "components": None}


@torch.no_grad()
def embed_prompts(model, tok, prompts):
    """Mean-pooled last-hidden-state embedding per prompt — one short forward pass
    each (no generation, no backward), cheaper than a single probe generation call."""
    lm = model.base_model.model if hasattr(model, "base_model") else model
    model.eval()
    vecs = []
    for i, (_, text) in enumerate(prompts):
        enc = tok.apply_chat_template([{"role": "user", "content": text}], add_generation_prompt=True, tokenize=True, return_tensors="pt")
        ids = (enc if torch.is_tensor(enc) else enc["input_ids"]).to("cuda:0")  # see run_probe's note — same BatchEncoding-vs-tensor mismatch
        hidden = lm.model(input_ids=ids).last_hidden_state[0]  # (seq, hidden)
        vecs.append(hidden.mean(dim=0).float().cpu())
        # same fragmentation-compounds-across-a-loop fix as eval_val: this runs right
        # after eval_val + run_probe at the same val_every checkpoint, and on a bigger
        # model (Qwen3-4B) that stacking OOM'd even with eval_val's own clearing already
        # in place (7.25/7.98GiB allocated when a 244MB request failed at step 50).
        if i % 4 == 3:
            torch.cuda.empty_cache()
    model.train()
    return torch.stack(vecs)  # (N, hidden)


def project_galaxy(vecs):
    """Fit a fixed 3-component PCA basis on the FIRST capture (pre-training embeddings)
    and reuse it for every later snapshot — a consistent frame is what lets movement
    mean something; refitting PCA/UMAP per snapshot would make 'drift' an artifact of
    the refit, not the model."""
    if _galaxy_basis["components"] is None:
        mean = vecs.mean(dim=0, keepdim=True)
        _, _, v = torch.pca_lowrank(vecs - mean, q=3, niter=4)
        _galaxy_basis["mean"] = mean
        _galaxy_basis["components"] = v[:, :3]
    proj = (vecs - _galaxy_basis["mean"]) @ _galaxy_basis["components"]
    return [[round(x, 4) for x in row] for row in proj.tolist()]


def stream_merge_and_save(base, adapter_dir, out_dir):
    """Fold the trained LoRA deltas into the ORIGINAL fp16 base shards, one
    shard at a time, and write a fresh sharded HF checkpoint. Never touches the
    quantized copy (peft's HQQ merge leaves non-GGUF-readable .W_q tensors) and
    never materializes the full 16GB model at once (adapter factors are tiny;
    only the current shard + its deltas are resident)."""
    snap_dir = snapshot_download(base, allow_patterns=["*.json", "*.safetensors*", "*.model", "*.txt"])
    weight_map, shard_files = _shard_files(snap_dir)

    adapter_sd = load_peft_weights(adapter_dir)
    scaling = LORA_ALPHA / LORA_R
    lora_map = {}
    for k, v in adapter_sd.items():
        m = re.match(r"base_model\.model\.(.+)\.lora_(A|B)\.weight$", k)
        if m:
            path, which = m.groups()
            lora_map.setdefault(path, {})[which] = v.float().cpu()

    os.makedirs(out_dir, exist_ok=True)
    new_weight_map, total_size = {}, 0
    for shard in shard_files:
        out_tensors = {}
        with safe_open(os.path.join(snap_dir, shard), framework="pt") as f:
            for name in f.keys():
                t = f.get_tensor(name)
                path = name[: -len(".weight")] if name.endswith(".weight") else None
                if path in lora_map:
                    ab = lora_map[path]
                    delta = (ab["B"] @ ab["A"]) * scaling
                    t = (t.float() + delta).to(torch.float16)
                    del delta
                out_tensors[name] = t.contiguous()
                total_size += t.numel() * t.element_size()
        save_file(out_tensors, os.path.join(out_dir, shard), metadata={"format": "pt"})
        new_weight_map.update({name: shard for name in out_tensors})
        del out_tensors; gc.collect()
    if len(shard_files) > 1:
        json.dump({"metadata": {"total_size": total_size}, "weight_map": new_weight_map},
                   open(os.path.join(out_dir, "model.safetensors.index.json"), "w"))
    for f in ("config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
              "vocab.json", "merges.txt", "special_tokens_map.json", "added_tokens.json"):
        src = os.path.join(snap_dir, f)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(out_dir, f))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default="out/model")
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--block", type=int, default=1024)  # webgen/openr1 rows run 900-1600 tokens; 512 truncated most of them
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--backward_divisor", type=float, default=1.0,
                    help="divide loss only during backward, then restore FP32 LoRA gradients; "
                         "prevents FP16 frozen-backbone gradient overflow on Qwen3.5/RDNA2")
    ap.add_argument("--grad_accum", type=int, default=1,
                    help="micro-steps accumulated per optimizer step (each micro-step is still one bs=1 row; "
                         "only LoRA grads accumulate, so VRAM cost is negligible)")
    ap.add_argument("--warmup", type=int, default=0, help="linear LR warmup over this many optimizer steps (0 disables)")
    ap.add_argument("--cosine", action="store_true", help="cosine-decay LR from --lr to 10%% of it by --steps (after warmup)")
    ap.add_argument("--balance_sources", action="store_true",
                    help="draw the source uniformly first, then a row within it — stops one giant source "
                         "from drowning the small HIVE-schema/anchor sources in a mixed dataset")
    ap.add_argument("--group_size", type=int, default=64)
    ap.add_argument("--target_loss", type=float, default=0.1)
    ap.add_argument("--patience", type=int, default=100,
                    help="early-stop after this many validation checks without improvement when validation is enabled; "
                         "otherwise counts optimizer steps; 0 disables")
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--val_frac", type=float, default=0.0, help="held-out fraction (hash-split); 0 disables validation")
    ap.add_argument("--val_every", type=int, default=50)
    ap.add_argument("--log_every", type=int, default=1,
                    help="emit a live step event every N optimizer steps")
    ap.add_argument("--snapshot_every", type=int, default=0,
                    help="save a NAMED adapter snapshot every N steps (0 disables) — lets "
                         "scripts/compare_adapters.py show how the weight delta evolved over "
                         "the run, not just its final state. Costs ~180MB/snapshot; off by "
                         "default since most runs don't need it.")
    ap.add_argument("--resume", action="store_true", help="continue from <out>_ckpt/last")
    ap.add_argument("--quantize_cpu", action="store_true", help="quantize HQQ layers on CPU before moving them to GPU (slower, lower peak VRAM)")
    ap.add_argument("--stage_weights_cpu", action="store_true", help="keep ordinary weights on CPU during GPU HQQ quantization, then move the finished model to GPU")
    ap.add_argument("--last_full_block_only", action="store_true",
                    help="train LoRA only in the final full-attention block and detach its input; "
                         "avoids Qwen3.5 linear-attention backward on unsupported FP16 ROCm GPUs")
    ap.add_argument("--no_probe_embed", action="store_true",
                    help="shorthand for --no_probe --no_embed (legacy flag, kept for old callers).")
    ap.add_argument("--no_probe", action="store_true",
                    help="skip the probe generation at each val checkpoint (the live sample-vs-target "
                         "+ per-token certitude panel). One generate() call with an autoregressive KV "
                         "cache — cheap on its own, but stacked with eval_val and embed right at the "
                         "same checkpoint it has repeatedly eaten the last headroom on a near-ceiling "
                         "Qwen3-4B run and OOM'd the next training step (hit live 2026-07-11).")
    ap.add_argument("--no_embed", action="store_true",
                    help="skip the embedding-galaxy snapshot at each val checkpoint. 16 short forward "
                         "passes — individually cheap, but the same stacking-at-the-checkpoint risk as "
                         "--no_probe applies. Prefer disabling this one first: the galaxy is a nice-to-"
                         "have, the probe/certitude panel is usually what's actually being watched.")
    args = ap.parse_args()
    if args.no_probe_embed:
        args.no_probe = args.no_embed = True

    ckpt_dir = args.out.rstrip("/") + "_ckpt"
    print(json.dumps({"event": "start", "device": "cuda-hqq4", "dtype": "hqq-nf4", "base": args.base,
                      "data": os.path.basename(args.data), "steps": args.steps, "lr": args.lr,
                      "mode": "hqq", "patience": args.patience,
                      "val_frac": args.val_frac, "val_every": args.val_every, "resume": args.resume,
                      "grad_accum": args.grad_accum, "warmup": args.warmup, "cosine": args.cosine,
                      "stage_weights_cpu": args.stage_weights_cpu, "quantize_cpu": args.quantize_cpu,
                      "last_full_block_only": args.last_full_block_only}), flush=True)
    # fix_mistral_regex=True: transformers itself warns Mistral-family tokenizers ship an
    # incorrect regex pattern causing real (not cosmetic) mis-tokenization; harmless no-op
    # kwarg on non-Mistral tokenizers (verified 2026-07-12), so passed unconditionally.
    tok = AutoTokenizer.from_pretrained(args.base, fix_mistral_regex=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    model = stream_quantize_load(args.base, args.group_size, quantize_cpu=args.quantize_cpu, stage_weights_cpu=args.stage_weights_cpu)
    model.config.use_cache = False
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    lcfg = LoraConfig(r=LORA_R, lora_alpha=LORA_ALPHA, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=list(LORA_TARGETS))
    # The fully GPU-resident path needs FP16 adapters to survive its last few MB
    # of headroom. CPU staging frees enough VRAM to keep LoRA in FP32, which is
    # materially more stable on this RDNA2/FP16 stack (the first Qwen3.5 staged
    # smoke produced NaN gradients immediately when its adapters stayed FP16).
    model = get_peft_model(model, lcfg, autocast_adapter_dtype=args.stage_weights_cpu)
    trained_layer = None
    if args.last_full_block_only:
        layer_types = list(getattr(model.config, "layer_types", []) or [])
        full_layers = [i for i, kind in enumerate(layer_types) if kind == "full_attention"]
        if not full_layers:
            raise ValueError("--last_full_block_only requires a model with a full_attention layer")
        trained_layer = full_layers[-1]
        marker = f".layers.{trained_layer}."
        for name, p in model.named_parameters():
            if p.requires_grad and marker not in name:
                p.requires_grad_(False)

        def detach_block_input(_module, args, kwargs):
            if args:
                return (args[0].detach(), *args[1:]), kwargs
            kwargs = dict(kwargs)
            kwargs["hidden_states"] = kwargs["hidden_states"].detach()
            return args, kwargs

        model.base_model.model.model.layers[trained_layer].register_forward_pre_hook(
            detach_block_input, with_kwargs=True
        )

    start_step, resumed_best_val, resumed_val_checks = 0, float("inf"), 0
    if args.resume and os.path.exists(os.path.join(ckpt_dir, "last")):
        from peft.utils import load_peft_weights, set_peft_model_state_dict
        set_peft_model_state_dict(model, load_peft_weights(os.path.join(ckpt_dir, "last")))
        try:
            state = json.load(open(os.path.join(ckpt_dir, "state.json")))
            start_step = state["step"]
            resumed_best_val = state.get("best_val", float("inf"))
            resumed_val_checks = state.get("val_checks_since_best", 0)
        except Exception:
            start_step = 0
        print(json.dumps({"event": "phase", "phase": f"resumed from step {start_step}"}), flush=True)

    total = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)

    rows = load_rows(args.data)
    train_rows = [r for r in rows if not (args.val_frac > 0 and is_val(r, args.val_frac))]
    val_rows = [r for r in rows if args.val_frac > 0 and is_val(r, args.val_frac)]
    # drop-don't-truncate: encode unbounded, discard rows that exceed --block.
    # A truncated row trains the model to stop mid-answer — the exact webgen
    # failure mode this run is meant to fix. Dropping loses the row; truncating
    # poisons the rest.
    def encode_row(r):
        ids, lab = encode_conversation(tok, r["messages"], r["tools"], 10 ** 9)
        return ids, lab, r.get("source", "unknown")

    def keeps(ids, lab):
        return len(ids) <= args.block and any(l != -100 for l in lab)

    train_enc = [encode_row(r) for r in train_rows]
    val_enc = [encode_row(r) for r in val_rows]
    examples = [(ids, lab) for ids, lab, _ in train_enc if keeps(ids, lab)]
    sources = [src for ids, lab, src in train_enc if keeps(ids, lab)]
    val_examples = [(ids, lab) for ids, lab, _ in val_enc if keeps(ids, lab)]
    dropped = len(train_enc) + len(val_enc) - len(examples) - len(val_examples)
    length_hist = length_histogram(
        [(len(ids), keeps(ids, lab)) for ids, lab, _ in train_enc + val_enc], args.block)
    adapter_dtypes = sorted({str(p.dtype).replace("torch.", "") for p in model.parameters() if p.requires_grad})
    print(json.dumps({"event": "model", "trainable_params": trainable, "total_params": total,
                      "adapter_dtypes": adapter_dtypes,
                      "trained_layer": trained_layer,
                      "blocks": len(examples), "val_blocks": len(val_examples), "block": args.block,
                      "dropped_overlength": dropped, "length_hist": length_hist,
                      "gpu_mb": round(torch.cuda.memory_allocated() / 1e6)}), flush=True)
    if not examples:
        print(json.dumps({"event": "error", "msg": "no trainable examples after encoding"}), flush=True)
        return

    probe = make_probe(val_rows, train_rows)
    print(json.dumps({"event": "embed_meta", "labels": [p[1][:60] for p in GALAXY_PROMPTS],
                      "categories": [p[0] for p in GALAXY_PROMPTS]}), flush=True)

    pad_id = tok.pad_token_id
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
    model.train()
    detect_anomaly = os.environ.get("HQQ_DETECT_ANOMALY") == "1"
    t0 = time.time(); prev_step, prev_time = 0, t0
    best, best_step, ema = float("inf"), start_step, None
    best_ema = float("inf")
    best_val = resumed_best_val
    val_checks_since_best = resumed_val_checks
    stop_reason = None
    seen_count = [0] * len(examples)  # per-example draw count, across epochs — memorization tell
    epoch = 0
    if args.balance_sources:
        # uniform over sources, then epoch-shuffled without replacement inside each
        by_src: dict = {}
        for i, s in enumerate(sources):
            by_src.setdefault(s, []).append(i)
        src_names = sorted(by_src)
        src_orders = {s: random.sample(v, len(v)) for s, v in by_src.items()}
        src_cursors = {s: 0 for s in src_names}
        draws = 0

        def next_index():
            nonlocal draws, epoch
            s = random.choice(src_names)
            if src_cursors[s] >= len(src_orders[s]):
                random.shuffle(src_orders[s]); src_cursors[s] = 0
            i = src_orders[s][src_cursors[s]]; src_cursors[s] += 1
            draws += 1
            if draws // len(examples) > epoch:
                epoch = draws // len(examples)
                print(json.dumps({"event": "epoch", "n": epoch}), flush=True)
            return i
    else:
        # epoch-shuffled sampling: draw without replacement, reshuffle when exhausted
        order, cursor = list(range(len(examples))), 0
        random.shuffle(order)

        def next_index():
            nonlocal cursor, epoch
            if cursor >= len(order):
                random.shuffle(order); cursor = 0; epoch += 1
                print(json.dumps({"event": "epoch", "n": epoch}), flush=True)
            i = order[cursor]; cursor += 1
            return i

    def lr_at(s):
        if args.warmup > 0 and s <= args.warmup:
            return args.lr * s / args.warmup
        if args.cosine:
            t = min(1.0, (s - args.warmup) / max(1, args.steps - args.warmup))
            return args.lr * (0.1 + 0.45 * (1.0 + math.cos(math.pi * t)))  # 1.0x -> 0.1x
        return args.lr

    accum = max(1, args.grad_accum)
    backward_divisor = max(1.0, args.backward_divisor)
    for step in range(start_step + 1, args.steps + 1):
        for group in opt.param_groups:
            group["lr"] = lr_at(step)
        lv = 0.0
        for _ in range(accum):
            idx = next_index()
            ids, lab = examples[idx]
            seen_count[idx] += 1
            src = sources[idx] if idx < len(sources) else "unknown"
            x = torch.tensor([ids], device="cuda:0"); y = torch.tensor([lab], device="cuda:0"); m = torch.ones_like(x)
            if detect_anomaly:
                with torch.autograd.detect_anomaly(check_nan=True):
                    loss = chunked_ce_loss(model, x, m, y) / accum
                    (loss / backward_divisor).backward()
            else:
                loss = chunked_ce_loss(model, x, m, y) / accum
                (loss / backward_divisor).backward()
            lv += loss.item()  # each term is already /accum, so the sum is the mean raw loss
        if backward_divisor != 1.0:
            # LoRA parameters are FP32 on the staged path. Restore the mathematically
            # correct gradient magnitude only after gradients have safely traversed
            # the frozen FP16 backbone; doing this earlier would recreate the overflow.
            for p in model.parameters():
                if p.requires_grad and p.grad is not None:
                    p.grad.mul_(backward_divisor)
        gnorm = torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        layer_gnorm = layer_grad_norms(model)
        if not math.isfinite(lv) or not math.isfinite(float(gnorm)):
            opt.zero_grad(set_to_none=True)
            print(json.dumps({"event": "error", "step": step,
                              "msg": "non-finite loss or gradient; optimizer step refused",
                              "loss": lv, "grad_norm": float(gnorm)}), flush=True)
            raise FloatingPointError(f"non-finite training signal at step {step}")
        opt.step(); opt.zero_grad()
        ema = lv if ema is None else 0.15 * lv + 0.85 * ema
        if lv < best - 1e-4:
            best = lv
        # plateau gate on SMOOTHED loss: with bs=1 a single lucky near-zero example
        # freezes a raw-loss best forever and patience fires while val is still
        # improving (run 1 stopped at 49% of budget this way).
        # When a val split exists, val improvement is the ONLY thing that resets
        # the patience clock: train-EMA new-lows in epoch 2+ are memorization of
        # repeated rows and masked a 0.17->0.25 val regression for ~1400 steps
        # (victory4-8b). EMA gating remains the fallback for val_frac=0 runs.
        if ema < best_ema - 1e-3:
            best_ema = ema
            if not val_examples:
                best_step = step

        if val_examples and (step % args.val_every == 0 or step == args.steps):
            vl = eval_val(model, val_examples, pad_id)
            gc.collect(); torch.cuda.empty_cache()  # val forward + probe + embed stack up right at this
            # checkpoint (all three ride the same val_every cadence) — on a small model
            # near the card's ceiling that's enough to OOM without releasing cached blocks
            # back between them (hit live: 1.7B run OOM'd here at step 100, 7.33/7.98GiB;
            # coder_repairer/block-2048 run OOM'd the SAME way at step 50, 2026-07-11).
            if vl is not None:
                if vl < best_val - 1e-4:
                    best_val = vl
                    best_step = step  # val improvement IS progress — don't let the train-EMA plateau gate fire past it
                    val_checks_since_best = 0
                    save_adapter(model, tok, os.path.join(ckpt_dir, "best"))
                else:
                    val_checks_since_best += 1
                print(json.dumps({"event": "val", "step": step, "val_loss": round(vl, 4),
                                  "best_val": round(best_val, 4),
                                  "patience_used": val_checks_since_best}), flush=True)
            save_adapter(model, tok, os.path.join(ckpt_dir, "last"))
            json.dump({"step": step, "best_val": best_val,
                       "val_checks_since_best": val_checks_since_best},
                      open(os.path.join(ckpt_dir, "state.json"), "w"))

        if args.snapshot_every > 0 and (step % args.snapshot_every == 0 or step == args.steps):
            save_adapter(model, tok, os.path.join(ckpt_dir, f"step_{step}"))
            print(json.dumps({"event": "snapshot", "step": step}), flush=True)

        if not args.no_probe and probe and (step % args.val_every == 0 or step == args.steps):
            # best-effort: a probe failure (e.g. generate() choking on the custom
            # quantized/CPU-embedding model) must never take down an hours-long run
            try:
                gen = run_probe(model, tok, probe, max_new=48, tb_path=os.path.join(ckpt_dir, "probe_error_traceback.txt"))
            except Exception as e:
                gen = None
                print(json.dumps({"event": "probe", "step": step, "error": f"{type(e).__name__}: {e!r}"[:300]}), flush=True)
            if gen is not None:
                print(json.dumps({"event": "probe", "step": step,
                                  "prompt": (probe["prompt_msgs"][-1].get("content") or "")[:300],
                                  "target": probe["target"][:400], "generated": gen["text"][:400],
                                  "tokens": gen["tokens"][:120], "probs": gen["probs"][:120],
                                  "entropy": gen["entropy"][:120]}), flush=True)
            gc.collect(); torch.cuda.empty_cache()  # release the generate() KV cache before embed_prompts runs — gc first: a
            # Python-held reference (e.g. the `out` GenerateOutput) keeps its tensors out of
            # the allocator's free pool even after empty_cache() until refcounted away

        if not args.no_embed and (step % args.val_every == 0 or step == args.steps):
            # best-effort, same reasoning as the probe: cheaper than one generation call
            # (short forward passes, no decoding loop), but must never take the run down
            try:
                points = project_galaxy(embed_prompts(model, tok, GALAXY_PROMPTS))
                print(json.dumps({"event": "embed", "step": step, "points": points}), flush=True)
            except Exception as e:
                print(json.dumps({"event": "embed", "step": step, "error": f"{type(e).__name__}: {e!r}"[:300]}), flush=True)
            gc.collect(); torch.cuda.empty_cache()

        # converged gate is val-gated when a val split exists — the EMA form of
        # this gate falsely fired at step 173/2500 on a lucky bs=1 streak (run 1)
        if val_examples:
            if args.target_loss > 0 and best_val <= args.target_loss:
                stop_reason = f"converged val {best_val:.3f}"
        elif step >= 20 and ema <= args.target_loss:
            stop_reason = f"converged ema {ema:.3f}"
        if not stop_reason and args.patience > 0:
            if val_examples and val_checks_since_best >= args.patience:
                stop_reason = f"plateau {args.patience} validation checks"
            elif not val_examples and step - best_step >= args.patience:
                stop_reason = f"plateau {args.patience} steps"
        if step % 10 == 0:
            # ROCm/HIP's expandable_segments doesn't defragment as reliably as it does on
            # CUDA — bs=1 with highly variable sequence lengths (this dataset spans
            # ~250-860 tokens) creates a new block size class almost every step, and the
            # allocator's "reserved but unallocated" footprint crept up until a 150MB
            # request failed with 7.3/7.98GiB already claimed (hit live at steps 100 and
            # ~141 on the Qwen3-1.7B run before this fix). Cheap relative to a whole step.
            torch.cuda.empty_cache()
        # A small JSON event per optimizer step is cheap and makes the managed UI
        # genuinely live. Older versions only emitted every tenth step, which made
        # healthy 20-30 second updates look stalled even while the GPU was working.
        if step % max(1, args.log_every) == 0 or step == 1 or stop_reason:
            now = time.time(); ss = (step - prev_step) / (now - prev_time) if now > prev_time else 0
            print(json.dumps({"event": "step", "step": step, "steps": args.steps, "loss": round(lv, 4),
                              "best": round(best, 4), "ema": round(ema, 4),
                              "best_step": best_step, "gate": "val" if val_examples else "ema",
                              "patience_used": val_checks_since_best if val_examples else step - best_step,
                              "patience_unit": "val checks" if val_examples else "steps",
                              "lr": round(lr_at(step), 8), "grad_accum": accum,
                              "grad_norm": round(float(gnorm), 3), "layer_gnorm": layer_gnorm,
                              "source": src, "epoch": epoch, "repeat_n": seen_count[idx],
                              "steps_s": round(ss, 3), "sec_per_step": round(1 / ss, 1) if ss > 0 else None,
                              "eta": round((args.steps - step) / ss) if ss > 0 else None,
                              "gpu_mb": round(torch.cuda.memory_allocated() / 1e6), "elapsed": round(now - t0, 1)}), flush=True)
            prev_step, prev_time = step, now
        if stop_reason:
            print(json.dumps({"event": "early_stop", "step": step, "reason": stop_reason}), flush=True)
            break

    # final checkpoint of where training ended
    save_adapter(model, tok, os.path.join(ckpt_dir, "last"))
    json.dump({"step": min(step, args.steps), "best_val": best_val,
               "val_checks_since_best": val_checks_since_best},
              open(os.path.join(ckpt_dir, "state.json"), "w"))

    os.makedirs(args.out, exist_ok=True)
    tok.save_pretrained(args.out)
    adapter_dir = args.out + "_adapter"
    model.save_pretrained(adapter_dir)   # always keep the final LoRA adapter
    # merge from the best-val adapter when validation ran — the final step may be
    # past the sweet spot; best-val is the checkpoint that generalized best.
    merge_src = adapter_dir
    if val_examples and os.path.exists(os.path.join(ckpt_dir, "best")):
        merge_src = os.path.join(ckpt_dir, "best")
        action = "merging" if args.merge else "publishing"
        print(json.dumps({"event": "phase", "phase": f"{action} best-val adapter (val {best_val:.4f})"}), flush=True)
        if not args.merge:
            # Adapter-only is a first-class output mode, not a side effect of
            # skipping merge. Publish the checkpoint that actually generalized
            # best, just as the merged-model path does.
            shutil.rmtree(adapter_dir, ignore_errors=True)
            shutil.copytree(merge_src, adapter_dir)
    merged_ok = False
    if args.merge:
        try:
            del model; gc.collect(); torch.cuda.empty_cache()
            print(json.dumps({"event": "phase", "phase": "shard-streaming merge into original fp16 base"}), flush=True)
            stream_merge_and_save(args.base, merge_src, args.out)
            shutil.rmtree(adapter_dir, ignore_errors=True)
            merged_ok = True
        except Exception as e:
            print(json.dumps({"event": "phase", "phase": f"merge failed ({type(e).__name__}: {str(e)[:80]}); adapter kept in {os.path.basename(adapter_dir)}"}), flush=True)
    if not merged_ok:
        for f in os.listdir(adapter_dir):
            try: shutil.copy(os.path.join(adapter_dir, f), os.path.join(args.out, f))
            except Exception: pass
    print(json.dumps({"event": "done", "out": args.out, "merged": merged_ok}), flush=True)


if __name__ == "__main__":
    main()

"""Offline logit-lens — projects every transformer layer's hidden state through the
model's own lm_head (unembedding) to see which tokens are "active" at each layer,
for a given prompt. This is the concrete mechanism behind Anthropic's J-lens/J-space
finding (see https://www.anthropic.com/research/global-workspace), applied here to
whatever local model this lab is inspecting, rather than to Claude.

Deliberately NOT usable live during chat: it needs the whole 8GB card to itself
(same HQQ 4-bit loader finetune_hqq.py uses to fit an 8B for training), so the
caller (web/src/lib/lab.ts) stops llama-server/Ollama first and treats this like a
training run for single-tenancy purposes — see runLensScript there.

Loading is a slimmed-down copy of finetune_hqq.py's stream_quantize_load (kept
independent rather than imported: this script has none of that file's
training-only dependencies — no peft, no optimizer, no LoRA), extended to accept
either a HF hub id or one of this lab's own local out/<name> merged checkpoints.

  python scripts/lens.py --model out/victory9-8b \
      --messages '[{"role":"user","content":"why is the sky blue?"}]' --top_k 5
"""
import argparse, gc, json, os, re, sys
import torch
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
from accelerate import init_empty_weights
from accelerate.utils import set_module_tensor_to_device
from huggingface_hub import snapshot_download
from safetensors import safe_open
from hqq.core.quantize import HQQLinear, HQQBackend, BaseQuantizeConfig
HQQLinear.set_backend(HQQBackend.PYTORCH)   # pure-torch dequant — ROCm-safe

LORA_TARGETS = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")


def _shard_files(snap_dir):
    idx_path = os.path.join(snap_dir, "model.safetensors.index.json")
    if os.path.exists(idx_path):
        weight_map = json.load(open(idx_path))["weight_map"]
        return weight_map, sorted(set(weight_map.values()))
    only = "model.safetensors"
    with safe_open(os.path.join(snap_dir, only), framework="pt") as f:
        weight_map = {k: only for k in f.keys()}
    return weight_map, [only]


class CPUEmbedding(torch.nn.Module):
    """Frozen embedding table resident in CPU RAM; outputs land on GPU — same trick
    finetune_hqq.py uses, freeing ~1.2GB of VRAM an 8B's embed table would otherwise hold."""
    def __init__(self, weight):
        super().__init__()
        self.register_buffer("w", weight.cpu(), persistent=False)

    def forward(self, ids):
        return torch.nn.functional.embedding(ids.cpu(), self.w).to("cuda:0", non_blocking=True)


def stream_quantize_load(base, group_size, compute_dtype=torch.float16):
    """Stream shards in: LoRA-target linears get HQQ 4-bit quantized straight onto
    GPU (fits an 8B in ~4-5GB); lm_head/embeddings/norms stay fp16 so unembedding
    quality is untouched (lm_head is what THIS script actually reads out of)."""
    snap_dir = base if os.path.isdir(base) else snapshot_download(base, allow_patterns=["*.json", "*.safetensors*", "*.model", "*.txt"])
    config = AutoConfig.from_pretrained(snap_dir)
    with init_empty_weights():
        model = AutoModelForCausalLM.from_config(config, torch_dtype=compute_dtype)

    weight_map, shard_files = _shard_files(snap_dir)
    quant_cfg = BaseQuantizeConfig(nbits=4, group_size=group_size)
    target_pat = re.compile(r"\.(" + "|".join(LORA_TARGETS) + r")$")

    def quantize_into(module_path, tensor, cfg):
        parent_path, _, leaf = module_path.rpartition(".")
        parent = model.get_submodule(parent_path) if parent_path else model
        tmp = torch.nn.Linear(tensor.shape[1], tensor.shape[0], bias=False)
        tmp.weight = torch.nn.Parameter(tensor, requires_grad=False)
        setattr(parent, leaf, HQQLinear(tmp, cfg, compute_dtype=compute_dtype, device="cuda"))

    for shard in shard_files:
        with safe_open(os.path.join(snap_dir, shard), framework="pt") as f:
            for name in f.keys():
                if name == "model.embed_tokens.weight":
                    model.model.embed_tokens = CPUEmbedding(f.get_tensor(name).to(compute_dtype))
                    continue
                if not name.endswith(".weight"):
                    set_module_tensor_to_device(model, name, device="cuda", value=f.get_tensor(name).to(compute_dtype))
                    continue
                module_path = name[: -len(".weight")]
                if target_pat.search(module_path):
                    quantize_into(module_path, f.get_tensor(name), quant_cfg)
                else:
                    set_module_tensor_to_device(model, name, device="cuda", value=f.get_tensor(name).to(compute_dtype))
        gc.collect()
    if "lm_head.weight" not in weight_map and hasattr(model, "lm_head"):
        set_module_tensor_to_device(model, "lm_head.weight", device="cuda",
                                     value=model.model.embed_tokens.w.to(compute_dtype))
    model.eval()
    return model, snap_dir


@torch.no_grad()
def run_lens(model, tok, messages, top_k, max_prompt_tokens):
    # return_dict=True is explicit rather than relied-on-default: this transformers
    # version hands back a BatchEncoding (dict-like, no .shape) instead of a bare
    # tensor unless asked for the dict and unwrapped ourselves.
    ids = tok.apply_chat_template(messages, add_generation_prompt=True, return_tensors="pt", return_dict=True)["input_ids"]
    if ids.shape[1] > max_prompt_tokens:
        ids = ids[:, -max_prompt_tokens:]  # keep the most recent context
    ids = ids.to("cuda:0")
    input_tokens = [tok.decode([t]) for t in ids[0].tolist()]

    out = model.model(input_ids=ids, attention_mask=torch.ones_like(ids), output_hidden_states=True)
    hidden_states = out.hidden_states  # embeddings, then one per transformer block
    num_layers = len(hidden_states)

    grid = []  # grid[layer][position] -> top_k [{token, prob}]
    for layer_idx, h in enumerate(hidden_states):
        logits = model.lm_head(h[0]).float()
        probs = torch.softmax(logits, dim=-1)
        top = torch.topk(probs, top_k, dim=-1)
        row = [
            [{"token": tok.decode([tid]), "prob": round(p, 4)}
             for tid, p in zip(top.indices[pos].tolist(), top.values[pos].tolist())]
            for pos in range(top.indices.shape[0])
        ]
        grid.append(row)
        print(json.dumps({"event": "layer", "layer": layer_idx, "of": num_layers}), flush=True)
        if layer_idx % 4 == 3:
            torch.cuda.empty_cache()  # this card fragments across differently-sized transients (see finetune_hqq.py's eval_val)

    return {"inputTokens": input_tokens, "numLayers": num_layers, "grid": grid}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="HF hub id or a local checkpoint dir (e.g. out/victory9-8b)")
    ap.add_argument("--messages", required=True, help="JSON array of {role, content} chat messages")
    ap.add_argument("--group_size", type=int, default=64)
    ap.add_argument("--top_k", type=int, default=6)
    ap.add_argument("--max_prompt_tokens", type=int, default=512)
    args = ap.parse_args()

    print(json.dumps({"event": "start", "model": args.model}), flush=True)
    try:
        messages = json.loads(args.messages)
        tok = AutoTokenizer.from_pretrained(args.model)
        model, snap_dir = stream_quantize_load(args.model, args.group_size)
        print(json.dumps({"event": "loaded", "snap_dir": snap_dir}), flush=True)
        result = run_lens(model, tok, messages, args.top_k, args.max_prompt_tokens)
        print(json.dumps({"event": "done", "result": result}), flush=True)
    except Exception as e:
        import traceback
        # str(e) can be empty for some CUDA/HIP-originated exceptions — the type
        # name + full traceback (stderr) is what actually carries the signal.
        print(json.dumps({"event": "error", "msg": f"{type(e).__name__}: {e}"}), flush=True)
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

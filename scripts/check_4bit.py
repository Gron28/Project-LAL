"""Confirm 4-bit (QLoRA) works on THIS GPU. Run after installing the ROCm bitsandbytes
wheel. If this passes, scripts/finetune_qlora.py can fine-tune 4-8B models on the 8GB card."""
import torch

print("torch", torch.__version__, "| GPU", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none")
try:
    import bitsandbytes as bnb
    import bitsandbytes.functional as F
    print("bitsandbytes", bnb.__version__)
    x = torch.randn(256, 256, device="cuda", dtype=torch.float16)
    q, s = F.quantize_4bit(x)
    dq = F.dequantize_4bit(q, s)
    err = float((x - dq).abs().mean())
    nan = bool(torch.isnan(dq).any())
    print(f"quantize/dequantize 4-bit: OK  mean_err={err:.4f}  has_nan={nan}")
    lin = bnb.nn.Linear4bit(256, 256, bias=False).cuda().half()
    y = lin(x)
    print(f"Linear4bit forward: OK  out={tuple(y.shape)}  has_nan={bool(torch.isnan(y).any())}")
    print("VERDICT:", "WORKS — QLoRA 7B is possible on this GPU" if (not nan and not torch.isnan(y).any()) else "BROKEN (NaN) — wheel too old")
except Exception as e:
    import traceback; traceback.print_exc()
    print("VERDICT: 4-bit FAILED ->", type(e).__name__, str(e)[:160])

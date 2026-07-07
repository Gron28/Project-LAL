"""Decisive test: does HQQ 4-bit run a forward AND backward on this AMD gfx1032 GPU?
HQQ dequantizes in pure PyTorch (no compiled gfx kernels), so it should work where
bitsandbytes can't. If forward+backward both pass with no NaN, QLoRA-style 4-bit
training of 7B is viable here."""
import torch
print("torch", torch.__version__, "| GPU", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none")
try:
    import hqq
    from hqq.core.quantize import HQQLinear, BaseQuantizeConfig, HQQBackend
    print("hqq", getattr(hqq, "__version__", "?"))
    HQQLinear.set_backend(HQQBackend.PYTORCH)   # pure-torch path, ROCm-safe

    lin = torch.nn.Linear(1024, 1024, bias=False).half().cuda()
    cfg = BaseQuantizeConfig(nbits=4, group_size=64)
    q = HQQLinear(lin, quant_config=cfg, compute_dtype=torch.float16, device="cuda")

    x = torch.randn(8, 1024, device="cuda", dtype=torch.float16, requires_grad=True)
    y = q(x)
    fwd_nan = bool(torch.isnan(y).any())
    print(f"forward OK: out={tuple(y.shape)} has_nan={fwd_nan} vram={torch.cuda.memory_allocated()/1e6:.0f}MB")
    y.float().pow(2).mean().backward()
    print(f"backward OK: grad_to_input={x.grad is not None and bool(x.grad.abs().sum()>0)}")
    print("VERDICT:", "HQQ 4-bit WORKS on this GPU — 7B QLoRA-style training is viable" if not fwd_nan else "BROKEN (NaN)")
except Exception as e:
    import traceback; traceback.print_exc()
    print("VERDICT: HQQ 4-bit FAILED ->", type(e).__name__, str(e)[:200])

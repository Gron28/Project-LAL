"""Import short, verified R1-style math think-traces from open-r1/OpenR1-Math-220k.

Purpose in the mix: protect (and try to convert) the gsm8k tie with think-formatted math
whose reasoning is NATIVE deep deliberation, not dataset CoT wrapped in tags — the
think-displacement lesson says the mix's think-format majority decides whether the model
keeps deliberating. R1 traces are usually huge (4k-50k chars); this importer keeps only
the short tail that fully fits the trainer block when rendered by the Qwen3 template
(drop, never truncate). Each kept generation is one the dataset's Math-Verify pass
confirmed correct (stronger than our lastNumber grader on LaTeX answers).

Usage: .venv/bin/python scripts/import_openr1_math.py [--n 300] [--block 1024]
"""
import argparse, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--block", type=int, default=1024)
    ap.add_argument("--scan", type=int, default=200000)
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "openr1_math_short.jsonl"))
    args = ap.parse_args()

    from datasets import load_dataset
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.tokenizer)

    suite_prompts = []
    for sp in [os.path.join(ROOT, "web", ".data", "suites", "gsm8k.json")]:
        try:
            with open(sp) as f:
                for it in json.load(f).get("items", []):
                    if it.get("q"):
                        suite_prompts.append(norm(it["q"]))
        except FileNotFoundError:
            pass

    ds = load_dataset("open-r1/OpenR1-Math-220k", "default", split="train", streaming=True)
    kept, seen = [], set()
    drops = {"unverified": 0, "too_long": 0, "dup": 0, "suite_overlap": 0, "format": 0}
    scanned = 0
    # cheap char pre-filter: ~3 chars/token lower bound means > block*5 chars can never fit
    char_cap = args.block * 5
    for row in ds:
        scanned += 1
        if scanned > args.scan or len(kept) >= args.n:
            break
        gens = row.get("generations") or []
        oks = row.get("correctness_math_verify") or []
        cands = [g for g, ok in zip(gens, oks) if ok and len(g) <= char_cap and "</think>" in g]
        if not cands:
            drops["unverified" if not any(oks) else "too_long"] += 1; continue
        g = min(cands, key=len)
        problem = (row.get("problem") or "").strip()
        if not problem or not g.lstrip().startswith("<think>"):
            drops["format"] += 1; continue
        msgs = [{"role": "user", "content": problem}, {"role": "assistant", "content": g.strip()}]
        ids = tok.apply_chat_template(msgs, add_generation_prompt=False, tokenize=True)
        if len(ids) > args.block:
            drops["too_long"] += 1; continue
        nu = norm(problem)
        if nu in seen:
            drops["dup"] += 1; continue
        if any(jaccard(nu, sp) >= 0.5 for sp in suite_prompts):
            drops["suite_overlap"] += 1; continue
        seen.add(nu)
        kept.append({"messages": msgs})
        if len(kept) % 50 == 0:
            print(json.dumps({"kept": len(kept), "scanned": scanned}), flush=True)

    with open(args.out, "w") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(kept), "scanned": scanned, "drops": drops, "out": args.out}, indent=2), flush=True)


if __name__ == "__main__":
    main()

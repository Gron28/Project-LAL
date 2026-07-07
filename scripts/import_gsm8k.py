"""Import GSM8K TRAIN split as math regression-insurance SFT data.

Train-on-train (never the test split the bench samples from), but rows are still
deduped against the live gsm8k bench suite as a hard guarantee. Solutions are the
dataset's gold chain-of-thought; the "#### N" marker is rewritten into a natural
closing sentence. Rows that would overflow the 4B trainer's 512-token block are
dropped rather than truncated (a truncated solution teaches wrong stopping).

Usage: .venv/bin/python scripts/import_gsm8k.py [--n 600] [--out data/gsm8k_train.jsonl]
"""
import argparse, json, os, random, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# live (file-backed) suite first — gsm8k/capability only exist there, not in seed-suites
_CANDIDATES = [os.path.join(ROOT, "web", ".data", "suites", "gsm8k.json"),
               os.path.join(ROOT, "web", "src", "lib", "seed-suites", "gsm8k.json")]
SUITE = next(p for p in _CANDIDATES if os.path.exists(p))


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=600)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "gsm8k_train.jsonl"))
    ap.add_argument("--max_chars", type=int, default=1500)
    ap.add_argument("--seed", type=int, default=23)
    args = ap.parse_args()

    from datasets import load_dataset
    ds = load_dataset("openai/gsm8k", "main", split="train")
    print(f"[gsm8k] loaded {len(ds)} train rows", flush=True)

    suite_prompts = []
    with open(SUITE) as f:
        for it in json.load(f).get("items", []):
            if it.get("q"):
                suite_prompts.append(norm(it["q"]))

    drops = {"too_long": 0, "suite_overlap": 0, "bad_format": 0}
    rows = []
    for r in ds:
        q, a = r["question"].strip(), r["answer"].strip()
        m = re.search(r"####\s*([\-0-9,.]+)\s*$", a)
        if not m:
            drops["bad_format"] += 1; continue
        final = m.group(1).replace(",", "")
        sol = a[: m.start()].strip()
        sol = re.sub(r"<<[^>]*>>", "", sol)  # strip calculator annotations
        # The gsm8k bench runs with thinking ENABLED (Qwen3 default). Training bare
        # short-CoT displaced the model's native <think> reasoning and cost ~9 points
        # (victory1/2 lesson). Put the reasoning INSIDE the think block so training
        # reinforces the inference-time format instead of fighting it.
        resp = f"<think>\n{sol}\n</think>\n\nThe answer is {final}."
        if len(q) + len(resp) > args.max_chars:
            drops["too_long"] += 1; continue
        nq = norm(q)
        if any(jaccard(nq, sp) >= 0.5 for sp in suite_prompts):
            drops["suite_overlap"] += 1; continue
        rows.append({"messages": [{"role": "user", "content": q}, {"role": "assistant", "content": resp}]})

    rng = random.Random(args.seed)
    rng.shuffle(rows)
    rows = rows[: args.n]
    with open(args.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(rows), "drops": drops, "out": args.out}, indent=2), flush=True)


if __name__ == "__main__":
    main()

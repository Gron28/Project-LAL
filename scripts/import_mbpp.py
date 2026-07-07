"""Import MBPP (train+validation splits) as exec-verified coding SFT data.

Every reference solution is EXECUTED against the row's own test_list in a sandboxed
subprocess before inclusion — same zero-trust rule as all other sources. The prompt
includes one example assert (standard MBPP convention, and it teaches reading a spec
plus a concrete test). Deduped against the coding bench suite.

Usage: .venv/bin/python scripts/import_mbpp.py [--n 300] [--out data/mbpp_verified.jsonl]
"""
import argparse, json, os, random, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUITE = os.path.join(ROOT, "web", "src", "lib", "seed-suites", "coding.json")


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def run_code(code, tests):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "sol.py")
        open(p, "w").write(code + "\n\n" + "\n".join(tests))
        try:
            r = subprocess.run(["python3", p], capture_output=True, timeout=10, cwd=d)
            return r.returncode == 0
        except Exception:
            return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "mbpp_verified.jsonl"))
    ap.add_argument("--max_chars", type=int, default=1500)
    ap.add_argument("--seed", type=int, default=29)
    args = ap.parse_args()

    from datasets import load_dataset
    parts = []
    for split in ("train", "validation"):
        parts.extend(load_dataset("google-research-datasets/mbpp", "full", split=split))
    print(f"[mbpp] loaded {len(parts)} rows", flush=True)

    suite_prompts = []
    with open(SUITE) as f:
        for it in json.load(f).get("items", []):
            if it.get("q"):
                suite_prompts.append(norm(it["q"]))

    rng = random.Random(args.seed)
    rng.shuffle(parts)

    drops = {"exec_fail": 0, "too_long": 0, "suite_overlap": 0}
    rows = []
    for r in parts:
        if len(rows) >= args.n:
            break
        text, code, tests = r["text"].strip(), r["code"].strip(), r["test_list"]
        if not tests:
            continue
        prompt = f"{text}\nYour code should pass this test:\n{tests[0]}"
        answer = f"```python\n{code}\n```"
        if len(prompt) + len(answer) > args.max_chars:
            drops["too_long"] += 1; continue
        nq = norm(prompt)
        if any(jaccard(nq, sp) >= 0.5 for sp in suite_prompts):
            drops["suite_overlap"] += 1; continue
        if not run_code(code, tests):
            drops["exec_fail"] += 1; continue
        rows.append({"messages": [{"role": "user", "content": prompt}, {"role": "assistant", "content": answer}]})

    with open(args.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(rows), "drops": drops, "out": args.out}, indent=2), flush=True)


if __name__ == "__main__":
    main()

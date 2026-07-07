"""Import an instruction-following SFT dataset from HuggingFace, filtered by our own grader logic.

Default source: allenai/tulu-3-sft-personas-instruction-following (~30k IFEval-taxonomy rows).
Pipeline: load -> extract single-turn user/assistant -> sanity filters (empty/refusal/too long
for the 4B trainer's 512-token block) -> detect machine-checkable constraints in the prompt and
verify the response with run_checks (same logic the benchmark uses) -> dedupe against the
instruct bench suite (no train-on-test) and existing distilled data -> subsample, verified rows
first -> write Qwen3 messages[] JSONL.

Usage: .venv/bin/python scripts/import_hf_data.py [--n 1200] [--out data/hf_instruct_filtered.jsonl]
"""
import argparse, json, os, random, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from distill_gemma import run_checks  # the battery's checks logic, mirrored

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUITE = os.path.join(ROOT, "web", "src", "lib", "seed-suites", "instruct.json")
DISTILLED = os.path.join(ROOT, "data", "distill_instruct.jsonl")

REFUSAL = re.compile(r"\b(i can'?not|i can'?t (?:help|assist|do|comply|provide)|i'?m sorry,? but|as an ai\b|i am sorry,? but)", re.I)


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


# ---------- constraint detectors: prompt text -> checks for run_checks (+ custom counters) ----------
def detect_checks(prompt):
    """Return (checks, custom) detected with high confidence, else ([], []). Conservative on purpose."""
    p = prompt.lower()
    checks, custom = [], []
    m = re.search(r"at least (\d+) words", p)
    if m and int(m.group(1)) <= 150:  # longer can't fit the 512-token training block anyway
        checks.append({"type": "min_words", "n": int(m.group(1))})
    m = re.search(r"(?:at most|fewer than|less than|no more than) (\d+) words", p)
    if m:
        checks.append({"type": "max_words", "n": int(m.group(1))})
    if re.search(r"all capital letters|capital letters only|entire response .{0,30}uppercase", p):
        checks.append({"type": "not_regex", "pattern": "[a-z]"})
    if re.search(r"all lowercase|no capital letters", p):
        checks.append({"type": "not_regex", "pattern": "[A-Z]"})
    m = re.search(r"(?:start|begin) your (?:response|answer|reply) with (?:the )?(?:word |phrase |exact phrase )?[\"“']([^\"”'\n]{1,60})[\"”']", prompt, re.I)
    if m:
        checks.append({"type": "starts_with", "s": m.group(1)})
    m = re.search(r"(?:finish|end) your (?:response|answer|reply) with (?:this |the )?(?:exact )?(?:phrase )?[\"“']([^\"”'\n]{1,80})[\"”']", prompt, re.I)
    if m:
        checks.append({"type": "regex", "pattern": re.escape(m.group(1)) + r"\W*$"})
    m = re.search(r"(?:do not|don'?t|without) (?:us(?:e|ing)|includ(?:e|ing)|say(?:ing)?) the words? [\"“']([\w' -]{1,30})[\"”']", prompt, re.I)
    if m:
        checks.append({"type": "not_regex", "pattern": r"\b" + re.escape(m.group(1)) + r"\b", "flags": "i"})
    if re.search(r"wrap your entire response (?:with|in) double quot", p):
        checks.append({"type": "starts_with", "s": '"'})
        checks.append({"type": "regex", "pattern": r'"\s*$'})
    if re.search(r"title .{0,40}double angular brackets", p):
        checks.append({"type": "regex", "pattern": r"<<[^>]+>>"})
    if re.search(r"postscript starting with p\.?\s?s", p):
        checks.append({"type": "regex", "pattern": r"P\.?\s?S\.?"})
    if re.search(r"(?:valid json|entire (?:response|output) .{0,30}json format)", p):
        checks.append({"type": "json_valid"})  # raw parse — fenced JSON rows get dropped, matching our bench items
    m = re.search(r"exactly (\d+) bullet points", p)
    if m:
        custom.append(("bullets_eq", int(m.group(1))))
    m = re.search(r"word [\"“'](\w+)[\"”'] should appear (?:at least )?(\d+) times", prompt, re.I)
    if m:
        custom.append(("word_freq", (m.group(1), int(m.group(2)))))
    return checks, custom


def run_custom(got, custom):
    for kind, arg in custom:
        if kind == "bullets_eq":
            if len(re.findall(r"^\s*[*-] ", got, re.M)) != arg: return False
        elif kind == "word_freq":
            word, n = arg
            if len(re.findall(r"\b" + re.escape(word) + r"\b", got, re.I)) < n: return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="allenai/tulu-3-sft-personas-instruction-following")
    ap.add_argument("--split", default="train")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "hf_instruct_filtered.jsonl"))
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--max_chars", type=int, default=1500, help="user+assistant char cap (512-token training block)")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    from datasets import load_dataset
    ds = load_dataset(args.dataset, split=args.split)
    print(f"[import] loaded {len(ds)} rows from {args.dataset}", flush=True)

    suite_prompts = []
    with open(SUITE) as f:
        for it in json.load(f)["items"]:
            suite_prompts.append(norm(it["q"]))
    seen = set()
    if os.path.exists(DISTILLED):
        with open(DISTILLED) as f:
            for line in f:
                try:
                    seen.add(norm(json.loads(line)["messages"][0]["content"]))
                except Exception:
                    pass

    drops = {"shape": 0, "empty": 0, "refusal": 0, "too_long": 0, "dup": 0, "suite_overlap": 0, "check_fail": 0}
    verified, unverified = [], []
    for row in ds:
        msgs = row.get("messages") or []
        if len(msgs) < 2 or msgs[0].get("role") != "user" or msgs[-1].get("role") != "assistant":
            drops["shape"] += 1; continue
        user, asst = msgs[0]["content"].strip(), msgs[-1]["content"].strip()
        if not user or not asst:
            drops["empty"] += 1; continue
        if REFUSAL.search(asst):
            drops["refusal"] += 1; continue
        if len(user) + len(asst) > args.max_chars:
            drops["too_long"] += 1; continue
        nu = norm(user)
        if nu in seen:
            drops["dup"] += 1; continue
        if any(jaccard(nu, sp) >= 0.5 for sp in suite_prompts):
            drops["suite_overlap"] += 1; continue
        checks, custom = detect_checks(user)
        if checks or custom:
            if not (run_checks(asst, checks) and run_custom(asst, custom)):
                drops["check_fail"] += 1; continue
            verified.append({"messages": [{"role": "user", "content": user}, {"role": "assistant", "content": asst}]})
        else:
            unverified.append({"messages": [{"role": "user", "content": user}, {"role": "assistant", "content": asst}]})
        seen.add(nu)

    rng = random.Random(args.seed)
    rng.shuffle(verified); rng.shuffle(unverified)
    out_rows = (verified + unverified)[: args.n]
    rng.shuffle(out_rows)
    with open(args.out, "w") as f:
        for r in out_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(json.dumps({"kept": len(out_rows), "verified_pool": len(verified), "unverified_pool": len(unverified),
                      "drops": drops, "out": args.out}, indent=2), flush=True)


if __name__ == "__main__":
    main()

"""Compose a training mix from verified SFT sources, with a train-on-test guard.

Concatenates JSONL files (optionally capped per file), normalizes rows to the trainer's
messages[] shape, drops any row whose first user turn overlaps a bench-suite item
(Jaccard >= 0.5 on normalized words — same guard as import_hf_data.py), dedupes exact
prompts across sources, shuffles deterministically, writes the mix + a composition report.

Usage:
  python3 scripts/build_mix.py --out data/victory_mix1.jsonl \
      data/hf_instruct_filtered.jsonl data/claude_instruct_hard.jsonl \
      data/distill_instruct.jsonl data/agentic_sft.jsonl data/distill_coding.jsonl
A source may be given as path:CAP (e.g. data/foo.jsonl:200) to subsample it.
"""
import argparse, glob, json, os, random, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# BOTH suite stores: seed files AND the live file-backed suites (gsm8k/capability only
# exist in the latter; others may have live edits) — guard against all of them.
SUITES = (glob.glob(os.path.join(ROOT, "web", "src", "lib", "seed-suites", "*.json"))
          + glob.glob(os.path.join(ROOT, "web", ".data", "suites", "*.json")))


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+", help="JSONL paths, optionally path:CAP")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "victory_mix1.jsonl"))
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--key", choices=["prompt", "prompt+answer"], default="prompt",
                    help="dedupe key; prompt+answer keeps multiple verified answers to the "
                         "same prompt (e.g. exemplar + teacher rows for one webgen task)")
    ap.add_argument("--block", type=int, default=0,
                    help="if set, drop rows whose chat-template token count exceeds this — "
                         "otherwise the trainer drops them silently at train time and the "
                         "mix's intended ratios never actually exist (victory6 lost 99%% of "
                         "its openhands slice and 40-56%% of three others exactly this way)")
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    tok = None
    if args.block:
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(args.tokenizer)

    def fits(o):
        if not tok:
            return True
        try:
            enc = tok.apply_chat_template(o["messages"], tools=o.get("tools"),
                                          add_generation_prompt=False, tokenize=True)
            # apply_chat_template returns a BatchEncoding here, not a list — len() on it
            # counts dict keys (always 2), which is how the silent over-block loss happened
            ids = enc["input_ids"] if not isinstance(enc, list) else enc
            return len(ids) <= args.block
        except Exception:
            return False

    suite_prompts = []
    for sp in SUITES:
        with open(sp) as f:
            for it in json.load(f).get("items", []):
                if it.get("q"):
                    suite_prompts.append(norm(it["q"]))

    mix, seen = [], set()
    report, leaks = {}, []
    overs = {}
    for src in args.sources:
        path, cap = (src.rsplit(":", 1) if re.search(r":\d+$", src) else (src, None))
        cap = int(cap) if cap else None
        rows = []
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                o = json.loads(line)
                msgs = o.get("messages")
                if not msgs:  # v1 {instruction, output} shape
                    msgs = [{"role": "user", "content": str(o.get("instruction", ""))},
                            {"role": "assistant", "content": str(o.get("output", ""))}]
                    o = {"messages": msgs}
                first_user = next((m["content"] for m in msgs if m.get("role") == "user"), "")
                nu = norm(first_user)
                key = nu
                if args.key == "prompt+answer":
                    first_asst = next((m.get("content") or "" for m in msgs if m.get("role") == "assistant"), "")
                    key = nu + "\x00" + norm(str(first_asst))[:300]
                if not nu or key in seen:
                    continue
                if any(jaccard(nu, sp) >= 0.5 for sp in suite_prompts):
                    leaks.append((os.path.basename(path), first_user[:80]))
                    continue
                if not fits(o):
                    overs[os.path.basename(path)] = overs.get(os.path.basename(path), 0) + 1
                    continue
                seen.add(key)
                rows.append(o)
        if cap and len(rows) > cap:
            rng.shuffle(rows)
            rows = rows[:cap]
        report[os.path.basename(path)] = len(rows)
        mix.extend(rows)

    rng.shuffle(mix)
    with open(args.out, "w") as f:
        for r in mix:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    for src, q in leaks[:10]:
        print(f"  LEAK dropped [{src}]: {q}")
    print(json.dumps({"total": len(mix), "sources": report, "suite_leaks_dropped": len(leaks),
                      "over_block_dropped": overs, "out": args.out}, indent=2))


if __name__ == "__main__":
    main()

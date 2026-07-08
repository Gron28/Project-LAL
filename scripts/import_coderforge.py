"""Import verified-successful trajectories from togethercomputer/CoderForge-Preview
(Apache-2.0, 258k test-verified SWE trajectories across R2E_Gym/SWE_Rebench/SWE_Smith/
filtered_reward1, avg 104 messages/51 assistant turns, long tail past 200 turns —
https://huggingface.co/datasets/togethercomputer/CoderForge-Preview). Already in
standard {messages, tools} shape (no bespoke format to parse, unlike OpenHands' XML
CodeAct syntax) — filtered here to reward>0 ("test-verified" per the dataset's own
claim) and trimmed to the longest block-fitting prefix, same policy as
import_openhands.py (reused directly rather than re-derived).

Real message content in this dataset runs long (median ~2000 chars/message — file
views, diffs, test output), so like OpenHands most trajectories still only fit a few
rounds at block=1536 despite being long in their raw form; still real, verified,
larger-scale, more diverse data than the existing openhands_swe.jsonl slice.

MEASURED 2026-07-07: at block=1536 this yields ZERO usable rows, not just a few —
R2E_Gym's very first checkpoint (one assistant-tool_calls + tool-result pair) alone
costs ~3549 tokens, over 2x the whole budget, because the initial task/issue
description plus this harness's own (verbose) tool-schema definitions are already
large before any real work happens. This isn't a bug in the trimming logic; it's a
genuine mismatch between this dataset's baseline verbosity and this project's
block-1536 recipe. Worth revisiting with a real block-size-scaling experiment (and
the VRAM/compute cost that implies) rather than block=1536 as currently invoked.

Usage: .venv/bin/python scripts/import_coderforge.py [--shards-per-source 3] [--cap 300] [--block 1536]
"""
import argparse, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_openhands import norm, jaccard, longest_fitting_prefix  # reuse, don't re-derive

REPO = "togethercomputer/CoderForge-Preview"
SOURCES = ["R2E_Gym", "SWE_Rebench", "SWE_Smith", "filtered_reward1"]


def build_checkpoints(messages):
    """Safe truncation points: right after a complete (assistant-tool_calls, tool)
    pair, or after a final plain-text assistant reply — mirrors import_openhands'
    convert()'s checkpoint policy, adapted for data already in {messages,tool_calls}
    shape (no XML parsing needed here)."""
    checkpoints = []
    i = 0
    n = len(messages)
    while i < n:
        m = messages[i]
        if m.get("role") == "assistant" and m.get("tool_calls"):
            i += 1
            if i < n and messages[i].get("role") == "tool":
                i += 1
            checkpoints.append(i)
        elif m.get("role") == "assistant":
            i += 1
            checkpoints.append(i)
        else:
            i += 1
    return checkpoints


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards-per-source", type=int, default=3)
    ap.add_argument("--cap", type=int, default=300)
    ap.add_argument("--block", type=int, default=1536)
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "coderforge_swe.jsonl"))
    args = ap.parse_args()

    import pandas as pd
    from huggingface_hub import hf_hub_download
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.tokenizer)

    suite_prompts = []
    for name in ("agentic.json", "coding.json", "planning.json"):
        for sp in (os.path.join(ROOT, "web", "src", "lib", "seed-suites", name),
                   os.path.join(ROOT, "web", ".data", "suites", name)):
            try:
                with open(sp) as f:
                    for it in json.load(f).get("items", []):
                        if it.get("q"):
                            suite_prompts.append(norm(it["q"]))
            except FileNotFoundError:
                pass

    from huggingface_hub import list_repo_files
    all_files = list_repo_files(REPO, repo_type="dataset")

    kept = []
    seen = set()
    drops = {"not_success": 0, "no_fit": 0, "dup": 0, "suite_overlap": 0, "snake": 0}
    for source in SOURCES:
        matches = sorted(f for f in all_files if f.startswith(f"trajectories/{source}-") and f.endswith(".parquet"))
        for shard in range(min(args.shards_per_source, len(matches))):
            try:
                path = hf_hub_download(repo_id=REPO, filename=matches[shard], repo_type="dataset")
            except Exception as e:
                print(json.dumps({"event": "shard_error", "source": source, "shard": shard, "error": str(e)}), flush=True)
                continue
            df = pd.read_parquet(path)
            print(json.dumps({"event": "loaded_shard", "source": source, "shard": shard, "rows": len(df)}), flush=True)
            for _, row in df.iterrows():
                if len(kept) >= args.cap:
                    break
                if row.get("reward", 0) is None or float(row["reward"]) <= 0:
                    drops["not_success"] += 1
                    continue
                messages = row["messages"]
                if isinstance(messages, str):
                    messages = json.loads(messages)
                messages = list(messages)
                if not messages or messages[0].get("role") != "system":
                    continue
                messages = messages[1:]  # drop the harness system prompt, same convention as import_openhands
                if not messages or messages[0].get("role") != "user":
                    continue
                tools = row["tools"]
                if isinstance(tools, str):
                    tools = json.loads(tools)
                tools = list(tools)
                checkpoints = build_checkpoints(messages)
                if not checkpoints:
                    continue
                prefix = longest_fitting_prefix(messages, checkpoints, tools, tok, args.block)
                if not prefix:
                    drops["no_fit"] += 1
                    continue
                blob = norm(json.dumps(prefix))
                if "snake game" in blob:
                    drops["snake"] += 1
                    continue
                nu = norm(str(prefix[0].get("content", ""))[:400])
                if not nu or nu in seen:
                    drops["dup"] += 1
                    continue
                if any(jaccard(nu, sp) >= 0.5 for sp in suite_prompts):
                    drops["suite_overlap"] += 1
                    continue
                seen.add(nu)
                kept.append({"messages": prefix, "tools": tools})
            if len(kept) >= args.cap:
                break
        if len(kept) >= args.cap:
            break

    with open(args.out, "w") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(kept), "drops": drops, "out": args.out}, indent=2), flush=True)


if __name__ == "__main__":
    main()

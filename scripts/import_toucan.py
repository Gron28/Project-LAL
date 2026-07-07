"""Import tool-agentic SFT traces from Toucan-1.5M (Qwen3-32B-generated subset).

Toucan (Agent-Ark/Toucan-1.5M, Apache-2.0): 1.5M multi-turn tool-call trajectories from
real MCP servers, with per-row LLM-judge quality assessments. This importer streams the
Qwen3 config and keeps only rows that:
  - the judge scored well (question & response overall >= 4) AND used all desired tools
    in the correct order (the dataset's own verification fields),
  - are single-user-turn traces with 1-4 tool calls (matches our agentic suite's shape),
  - fully fit the trainer block when rendered by the real Qwen3 chat template with tools
    (drop, never truncate — a cut-off trace trains a broken pattern),
  - don't overlap the agentic bench suite (Jaccard guard, same as the other importers).
Rows are converted from legacy function_call format to our {messages, tools} shape
(OpenAI-style tool_calls + role:"tool" results) that encode_conversation() renders.

Usage: .venv/bin/python scripts/import_toucan.py [--n 300] [--block 512]
"""
import argparse, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def convert(msgs, start=0):
    """Toucan legacy format -> OpenAI-style tool_calls / tool-role messages, or None.

    `start` offsets the call counter so IDs stay unique ACROSS THE WHOLE OUTPUT FILE, not
    just within one conversation. Resetting to 0 per-row (the original bug) meant every
    single-tool-call row — the large majority — collapsed onto the identical id "call_0";
    the fine-tuned model learned that literal string as if it were fixed boilerplate rather
    than something to vary, and reproduced it verbatim in live use.
    """
    out, call_n = [], start
    for m in msgs:
        role, content = m.get("role"), m.get("content") or ""
        if role == "system":
            continue  # tools are passed via tools=[]; Qwen3's template renders them
        if role == "user":
            out.append({"role": "user", "content": content})
        elif role == "assistant":
            fc = m.get("function_call")
            if fc and fc.get("name"):
                out.append({"role": "assistant", "content": None, "tool_calls": [{
                    "id": f"call_{call_n}", "type": "function",
                    "function": {"name": fc["name"], "arguments": fc.get("arguments") or "{}"}}]})
                call_n += 1
            elif content.strip():
                out.append({"role": "assistant", "content": content})
            else:
                return None, call_n  # empty assistant turn with no call — malformed
        elif role == "function":
            if call_n == start:
                return None, call_n  # result before any call
            out.append({"role": "tool", "tool_call_id": f"call_{call_n - 1}",
                        "name": m.get("name") or "", "content": content})
        else:
            return None, call_n
    return (out if call_n > start else None), call_n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--block", type=int, default=512, help="trainer block; rows that render longer are dropped")
    ap.add_argument("--max_calls", type=int, default=4)
    ap.add_argument("--min_q", type=float, default=4.0)
    ap.add_argument("--min_r", type=float, default=4.0)
    ap.add_argument("--scan", type=int, default=120000, help="max source rows to stream before stopping")
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "toucan_agentic.jsonl"))
    args = ap.parse_args()

    from datasets import load_dataset
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.tokenizer)

    suite_prompts = []
    for sp in [os.path.join(ROOT, "web", "src", "lib", "seed-suites", "agentic.json"),
               os.path.join(ROOT, "web", ".data", "suites", "agentic.json")]:
        try:
            with open(sp) as f:
                for it in json.load(f).get("items", []):
                    if it.get("q"):
                        suite_prompts.append(norm(it["q"]))
        except FileNotFoundError:
            pass

    ds = load_dataset("Agent-Ark/Toucan-1.5M", "Qwen3", split="train", streaming=True)
    kept, seen = [], set()
    drops = {"judge": 0, "shape": 0, "calls": 0, "too_long": 0, "dup": 0, "suite_overlap": 0, "encode_err": 0}
    scanned = 0
    call_ctr = 0  # global across the whole output file — see convert()'s docstring
    for row in ds:
        scanned += 1
        if scanned > args.scan or len(kept) >= args.n:
            break
        try:
            qa = json.loads(row["question_quality_assessment"])
            ra = json.loads(row["response_quality_assessment"])
            if (qa.get("overall_score", 0) < args.min_q or ra.get("overall_score", 0) < args.min_r
                    or ra.get("desired_tools_used_percentage", 0) < 1.0
                    or ra.get("order_correctness") is not True):
                drops["judge"] += 1; continue
        except Exception:
            drops["judge"] += 1; continue

        msgs = row["messages"]
        if isinstance(msgs, str):
            msgs = json.loads(msgs)
        if sum(1 for m in msgs if m.get("role") == "user") != 1 or msgs[-1].get("role") != "assistant":
            drops["shape"] += 1; continue
        conv, next_ctr = convert(msgs, start=call_ctr)
        if not conv:
            drops["shape"] += 1; continue
        n_calls = sum(1 for m in conv if m.get("tool_calls"))
        if not (1 <= n_calls <= args.max_calls):
            drops["calls"] += 1; continue
        call_ctr = next_ctr  # only advance the counter for rows actually kept below

        try:
            tools = json.loads(row["available_tools"])
            ids = tok.apply_chat_template(conv, tools=tools, add_generation_prompt=False, tokenize=True)
        except Exception:
            drops["encode_err"] += 1; continue
        if len(ids) > args.block:
            drops["too_long"] += 1; continue

        nu = norm(next(m["content"] for m in conv if m["role"] == "user"))
        if nu in seen:
            drops["dup"] += 1; continue
        if any(jaccard(nu, sp) >= 0.5 for sp in suite_prompts):
            drops["suite_overlap"] += 1; continue
        seen.add(nu)
        kept.append({"messages": conv, "tools": tools})
        if len(kept) % 50 == 0:
            print(json.dumps({"kept": len(kept), "scanned": scanned}), flush=True)

    with open(args.out, "w") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(kept), "scanned": scanned, "drops": drops, "out": args.out}, indent=2), flush=True)


if __name__ == "__main__":
    main()

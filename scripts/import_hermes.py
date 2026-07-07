"""Import function-calling SFT traces from NousResearch/hermes-function-calling-v1
(Apache-2.0). Uses the SAME <tool_call>/<tool_response> XML-tag convention Qwen3 already
speaks natively, and its `tools` field is already JSON in this project's exact
{"type":"function","function":{...}} shape — the best-aligned external source found.

Assigns tool_call ids from a GLOBAL counter across the whole output file (same fix as
import_toucan.py / import_toolace.py — a reused/fixed id across most rows teaches the
fine-tuned model to reproduce one literal string instead of varying it per call).

Usage: .venv/bin/python scripts/import_hermes.py [--n 300] [--block 1024]
"""
import argparse, json, os, re, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["func-calling.json", "func-calling-singleturn.json"]
BASE = "https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1/resolve/main/"

TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S)
TOOL_RESP_RE = re.compile(r"<tool_response>\s*(\{.*?\})\s*</tool_response>", re.S)


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def convert(conversations, start=0):
    out, call_n, pending = [], start, []
    for t in conversations:
        role, val = t.get("from"), t.get("value") or ""
        if role == "system":
            continue  # tools passed via tools=[]; redundant with the embedded <tools> block
        if role == "human":
            out.append({"role": "user", "content": val})
        elif role == "gpt":
            calls = [json.loads(m.group(1)) for m in TOOL_CALL_RE.finditer(val)]
            calls = [c for c in calls if isinstance(c, dict) and c.get("name")]
            if calls:
                tcs = []
                for c in calls:
                    tcs.append({"id": f"call_{call_n}", "type": "function",
                                "function": {"name": c["name"], "arguments": json.dumps(c.get("arguments", {}))}})
                    call_n += 1
                out.append({"role": "assistant", "content": None, "tool_calls": tcs})
                pending = [tc["function"]["name"] for tc in tcs]
            elif val.strip():
                out.append({"role": "assistant", "content": val})
                pending = []
            else:
                return None, start
        elif role == "tool":
            resps = [json.loads(m.group(1)) for m in TOOL_RESP_RE.finditer(val)]
            if not resps or len(resps) != len(pending):
                return None, start  # can't reliably pair — drop rather than guess
            base = call_n - len(pending)
            for i, r in enumerate(resps):
                out.append({"role": "tool", "tool_call_id": f"call_{base + i}",
                            "name": r.get("name", pending[i]), "content": json.dumps(r.get("content", r))})
            pending = []
        else:
            return None, start
    return (out if call_n > start else None), call_n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--block", type=int, default=1024)
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "hermes_agentic.jsonl"))
    args = ap.parse_args()

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.tokenizer)

    suite_prompts = []
    for name in ("agentic.json", "instruct.json", "planning.json"):
        for sp in (os.path.join(ROOT, "web", "src", "lib", "seed-suites", name),
                   os.path.join(ROOT, "web", ".data", "suites", name)):
            try:
                with open(sp) as f:
                    for it in json.load(f).get("items", []):
                        if it.get("q"):
                            suite_prompts.append(norm(it["q"]))
            except FileNotFoundError:
                pass

    rows = []
    for fname in FILES:
        url = BASE + fname
        print(json.dumps({"event": "fetching", "url": url}), flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            part = json.load(r)
        print(json.dumps({"event": "fetched", "file": fname, "rows": len(part)}), flush=True)
        rows.extend(part)

    kept, seen = [], set()
    drops = {"no_tools": 0, "shape": 0, "no_call": 0, "too_long": 0, "dup": 0, "suite_overlap": 0, "snake": 0}
    call_ctr = 0
    for row in rows:
        if len(kept) >= args.n:
            break
        try:
            tools = json.loads(row["tools"]) if isinstance(row["tools"], str) else row["tools"]
        except Exception:
            tools = None
        if not tools:
            drops["no_tools"] += 1; continue

        conv, next_ctr = convert(row.get("conversations", []), start=call_ctr)
        if not conv:
            drops["shape"] += 1; continue
        if not any(m.get("tool_calls") for m in conv):
            drops["no_call"] += 1; continue
        call_ctr = next_ctr

        blob = norm(json.dumps(conv))
        if "snake" in blob:
            drops["snake"] += 1; continue

        try:
            ids = tok.apply_chat_template(conv, tools=tools, add_generation_prompt=False, tokenize=True)
        except Exception:
            drops["shape"] += 1; continue
        if len(ids) > args.block:
            drops["too_long"] += 1; continue

        nu = norm(next((m["content"] for m in conv if m["role"] == "user" and m.get("content")), ""))
        if not nu or nu in seen:
            drops["dup"] += 1; continue
        if any(jaccard(nu, sp) >= 0.5 for sp in suite_prompts):
            drops["suite_overlap"] += 1; continue
        seen.add(nu)
        kept.append({"messages": conv, "tools": tools})
        if len(kept) % 50 == 0:
            print(json.dumps({"kept": len(kept)}), flush=True)

    with open(args.out, "w") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(kept), "drops": drops, "out": args.out}, indent=2), flush=True)


if __name__ == "__main__":
    main()

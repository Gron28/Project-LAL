"""Import function-calling SFT traces from Team-ACE/ToolACE (Apache-2.0, 11.3k rows).

ToolACE encodes tool calls as Python-call-literal text (e.g. `[Foo(a="x"), Bar(b=1)]`)
inside a plain assistant message, and tool definitions as a JSON array embedded in the
system prompt — neither matches this project's OpenAI-style {tools, tool_calls} shape.
This importer: extracts the embedded tool-schema JSON (bracket-matched, not regex-only,
since the array can nest brackets), normalizes `"type": "dict"` -> `"type": "object"` and
wraps each into {"type":"function","function":{...}}, parses each call-list turn via
Python's `ast` module (safe: it's read-only literal/call-expression parsing, not eval),
and assigns tool_call ids from a GLOBAL counter across the whole output file — the same
bug class just fixed in import_toucan.py (a fixed/reused id per row taught the fine-tuned
model to reproduce one literal id string instead of varying it).

Usage: .venv/bin/python scripts/import_toolace.py [--n 300] [--block 1024]
"""
import argparse, ast, json, os, re, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://huggingface.co/datasets/Team-ACE/ToolACE/resolve/main/data.json"


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def extract_tools(sys_text):
    """Bracket-matched (not regex-`.*`) so nested [] inside enum/default values can't
    truncate the match early — the failure mode a naive non-greedy regex would hit."""
    m = re.search(r"invoke:\s*\n", sys_text)
    if not m:
        return None
    start = sys_text.find("[", m.end())
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(sys_text)):
        if sys_text[i] == "[":
            depth += 1
        elif sys_text[i] == "]":
            depth -= 1
            if depth == 0:
                try:
                    raw = json.loads(sys_text[start:i + 1])
                except Exception:
                    return None
                out = []
                for t in raw:
                    params = dict(t.get("parameters") or {})
                    if params.get("type") == "dict":
                        params["type"] = "object"
                    out.append({"type": "function", "function": {
                        "name": t.get("name", ""), "description": t.get("description", ""),
                        "parameters": params,
                    }})
                return out
    return None


def parse_calls(text):
    """`[Foo(a="x", b=1), Bar()]` -> [{"name": "Foo", "arguments": {...}}, ...], or None
    if the text isn't call-list syntax (plain conversational replies are common too)."""
    text = text.strip()
    if not (text.startswith("[") and text.endswith("]")):
        return None
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError:
        return None
    if not isinstance(tree.body, ast.List):
        return None
    calls = []
    for elt in tree.body.elts:
        if not isinstance(elt, ast.Call) or not isinstance(elt.func, ast.Name):
            return None
        try:
            args = {kw.arg: ast.literal_eval(kw.value) for kw in elt.keywords if kw.arg}
        except Exception:
            return None
        calls.append({"name": elt.func.id, "arguments": args})
    return calls if calls else None


def convert(conversations, start=0):
    """ToolACE ShareGPT-style turns -> our {messages} shape, or (None, start) if malformed."""
    out, call_n, pending_names = [], start, []
    for t in conversations:
        role, val = t.get("from"), t.get("value") or ""
        if role == "system":
            continue
        if role == "user":
            out.append({"role": "user", "content": val})
        elif role == "assistant":
            calls = parse_calls(val)
            if calls:
                tcs = []
                for c in calls:
                    tcs.append({"id": f"call_{call_n}", "type": "function",
                                "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}})
                    call_n += 1
                out.append({"role": "assistant", "content": None, "tool_calls": tcs})
                pending_names = [tc["function"]["name"] for tc in tcs]
            elif val.strip():
                out.append({"role": "assistant", "content": val})
                pending_names = []
            else:
                return None, start
        elif role == "tool":
            try:
                results = json.loads(val)
            except Exception:
                return None, start
            if not isinstance(results, list) or len(results) != len(pending_names):
                return None, start  # can't reliably pair results to calls — drop rather than guess
            base = call_n - len(pending_names)
            for i, r in enumerate(results):
                out.append({"role": "tool", "tool_call_id": f"call_{base + i}",
                            "name": r.get("name", pending_names[i]),
                            "content": json.dumps(r.get("results", r.get("error", r)))})
            pending_names = []
        else:
            return None, start
    return (out if call_n > start else None), call_n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--block", type=int, default=1024)
    ap.add_argument("--max_calls", type=int, default=4)
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "toolace_agentic.jsonl"))
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

    print(json.dumps({"event": "fetching", "url": URL}), flush=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        rows = json.load(r)
    print(json.dumps({"event": "fetched", "total_rows": len(rows)}), flush=True)

    kept, seen = [], set()
    drops = {"no_tools": 0, "shape": 0, "calls": 0, "too_long": 0, "dup": 0, "suite_overlap": 0,
             "no_call_at_all": 0, "snake": 0}
    call_ctr = 0
    for row in rows:
        if len(kept) >= args.n:
            break
        tools = extract_tools(row.get("system", ""))
        if not tools:
            drops["no_tools"] += 1; continue

        conv, next_ctr = convert(row.get("conversations", []), start=call_ctr)
        if not conv:
            drops["shape"] += 1; continue
        n_calls = sum(len(m["tool_calls"]) for m in conv if m.get("tool_calls"))
        if n_calls == 0:
            drops["no_call_at_all"] += 1; continue
        if n_calls > args.max_calls * 3:  # ToolACE rows can have several call rounds; keep it sane
            drops["calls"] += 1; continue
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

"""Import Claude-3.7-Sonnet SWE-agent trajectories from SWE-bench/SWE-smith-trajectories
(MIT). These are the trajectories that trained SWE-agent-LM-32B (40.2% on SWE-bench
Verified) — the highest-quality "act, don't narrate" data available: every single
assistant turn couples a short statement of intent with an immediate tool call in the
SAME message. That coupling is exactly the failure mode victory6 showed live (narrating
a plan in text and never calling a tool), so unlike import_openhands.py this importer
KEEPS the assistant text alongside each tool call instead of nulling it out.

Rows are huge (min ~31k chars ≈ 9k tokens — nothing fits a 1536 block whole), so this
harvests longest-fitting PREFIXES like import_openhands.py: cut only at clean
call+result boundaries, never mid-message. The verification-tail behavior these
trajectories end with can't survive prefix-fitting; data/followthrough_sft.jsonl
(Claude-authored, short enough to fit whole) carries that signal instead.

Native OpenAI-style tool_calls format (not CodeAct XML): assistant.tool_calls with
toolu_* ids remapped to our global call_N convention; user/tool content arrives as
[{type:"text",text:...}] block lists that need flattening. Only resolved=True rows.

Usage: .venv/bin/python scripts/import_swesmith.py [--n 250] [--block 1536]
"""
import argparse, json, os, re
from huggingface_hub import hf_hub_download

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "SWE-bench/SWE-smith-trajectories"
# 2 of 8 shards ≈ several thousand rows — plenty to harvest --n resolved prefixes
FILES = ["data/tool-00000-of-00008.parquet", "data/tool-00001-of-00008.parquet"]

# SWE-agent's own 3-function toolset (constant across the dataset — verified by scanning
# tool_calls names over a 30-row sample: only bash/str_replace_editor/submit appear).
TOOLS = [
    {"type": "function", "function": {
        "name": "bash",
        "description": "Execute a bash command in the terminal.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "The bash command to execute."},
        }, "required": ["command"]},
    }},
    {"type": "function", "function": {
        "name": "str_replace_editor",
        "description": "Custom editing tool for viewing, creating and editing files. State is persistent across calls.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "enum": ["view", "create", "str_replace", "insert", "undo_edit"]},
            "path": {"type": "string", "description": "Absolute path to file or directory."},
            "file_text": {"type": "string", "description": "Content for the create command."},
            "old_str": {"type": "string", "description": "Exact text to replace for str_replace."},
            "new_str": {"type": "string", "description": "Replacement text for str_replace/insert."},
            "insert_line": {"type": "integer", "description": "Line after which to insert for the insert command."},
            "view_range": {"type": "array", "items": {"type": "integer"}, "description": "[start, end] line range for view."},
        }, "required": ["command", "path"]},
    }},
    {"type": "function", "function": {
        "name": "submit",
        "description": "Submit the current change as the final answer when the task is complete.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
]


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def flatten(content):
    """user/tool content arrives as [{'type':'text','text':...}] block lists."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict))
    return str(content or "")


def convert(raw_msgs, start=0):
    """-> (messages, checkpoints, next_call_ctr). Checkpoints = safe cut indices
    (after a complete call(s)+result(s) group). Assistant text is KEPT next to its
    tool_calls — see module docstring for why that differs from import_openhands."""
    out, checkpoints, call_n = [], [], start
    if not raw_msgs or raw_msgs[0].get("role") != "system":
        return None, [], start
    i = 1
    if i >= len(raw_msgs) or raw_msgs[i].get("role") != "user":
        return None, [], start
    out.append({"role": "user", "content": flatten(raw_msgs[i].get("content"))})
    i += 1
    n = len(raw_msgs)
    while i < n:
        m = raw_msgs[i]
        if m.get("role") != "assistant":
            break  # malformed continuation — keep what we have
        raw_calls = m.get("tool_calls") or []
        text = flatten(m.get("content")).strip()
        if not raw_calls:
            out.append({"role": "assistant", "content": text})
            checkpoints.append(len(out))
            i += 1
            break  # plain-text terminal reply
        id_map = {}
        calls = []
        for tc in raw_calls:
            fn = tc.get("function") or {}
            cid = f"call_{call_n}"
            id_map[tc.get("id")] = cid
            call_n += 1
            args = fn.get("arguments") or "{}"
            if not isinstance(args, str):
                args = json.dumps(args)
            calls.append({"id": cid, "type": "function",
                          "function": {"name": fn.get("name", ""), "arguments": args}})
        out.append({"role": "assistant", "content": text or None, "tool_calls": calls})
        i += 1
        # collect the paired tool result message(s) that follow
        got_result = False
        while i < n and raw_msgs[i].get("role") == "tool":
            tm = raw_msgs[i]
            content = flatten(tm.get("content"))
            content = re.sub(r"^OBSERVATION:\n", "", content)
            cid = id_map.get(tm.get("tool_call_id"), calls[0]["id"])
            name = tm.get("name") or calls[0]["function"]["name"]
            out.append({"role": "tool", "tool_call_id": cid, "name": name, "content": content})
            got_result = True
            i += 1
        checkpoints.append(len(out))
        if not got_result and calls[0]["function"]["name"] != "submit":
            break  # call without a result and not terminal — stop at this checkpoint
    return out, checkpoints, call_n


def longest_fitting_prefix(messages, checkpoints, tools, tok, block):
    # Walk checkpoints shortest-first and stop at the first overflow (token count is
    # monotonic in prefix length) — cheaper than longest-first, which re-tokenizes
    # near-full multi-10k-token trajectories over and over.
    # NOTE: apply_chat_template(tokenize=True) returns a BatchEncoding in current
    # transformers, so len() on it counts dict KEYS (always 2) — the bug that silently
    # made victory6's openhands slice 99% over-block and trainer-dropped. Unwrap it.
    best = None
    for end in checkpoints:
        prefix = messages[:end]
        if not prefix or not any(x.get("tool_calls") for x in prefix):
            continue
        try:
            ids = tok.apply_chat_template(prefix, tools=tools, add_generation_prompt=False, tokenize=True)
            if not isinstance(ids, list):
                ids = ids["input_ids"]
        except Exception:
            continue
        if len(ids) > block:
            break
        best = prefix
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=250)
    ap.add_argument("--block", type=int, default=1536)
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "swesmith_swe.jsonl"))
    args = ap.parse_args()

    import pandas as pd
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

    kept, seen = [], set()
    drops = {"unresolved": 0, "shape": 0, "no_fit": 0, "dup": 0, "suite_overlap": 0, "snake": 0}
    call_ctr = 0
    for fname in FILES:
        if len(kept) >= args.n:
            break
        path = hf_hub_download(repo_id=REPO, filename=fname, repo_type="dataset")
        df = pd.read_parquet(path)
        print(json.dumps({"event": "loaded", "file": fname, "rows": len(df)}), flush=True)
        for i in range(len(df)):
            if len(kept) >= args.n:
                break
            row = df.iloc[i]
            if not bool(row["resolved"]):
                drops["unresolved"] += 1; continue
            try:
                raw = json.loads(row["messages"])
            except Exception:
                drops["shape"] += 1; continue
            conv, checkpoints, next_ctr = convert(raw, start=call_ctr)
            if not conv or not checkpoints:
                drops["shape"] += 1; continue
            prefix = longest_fitting_prefix(conv, checkpoints, TOOLS, tok, args.block)
            if not prefix:
                drops["no_fit"] += 1; continue
            call_ctr = next_ctr

            blob = norm(json.dumps(prefix))
            if "snake game" in blob:
                drops["snake"] += 1; continue
            nu = norm(prefix[0].get("content", "")[:400])
            if not nu or nu in seen:
                drops["dup"] += 1; continue
            if any(jaccard(nu, sp) >= 0.5 for sp in suite_prompts):
                drops["suite_overlap"] += 1; continue
            seen.add(nu)
            kept.append({"messages": prefix, "tools": TOOLS})
            if len(kept) % 50 == 0:
                print(json.dumps({"kept": len(kept)}), flush=True)

    with open(args.out, "w") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(kept), "drops": drops, "out": args.out}, indent=2), flush=True)


if __name__ == "__main__":
    main()

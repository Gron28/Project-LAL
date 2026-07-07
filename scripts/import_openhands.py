"""Import real existing-codebase-iteration trajectories from
SWE-Gym/OpenHands-SFT-Trajectories (MIT, 491 successful SWE-bench-style sessions).

This is the gap the victory6 research flagged: nothing in the current mix teaches
modifying an existing multi-file codebase — everything is either greenfield webgen or
short single-turn tool traces. These trajectories are the real thing (a PR description,
then real file exploration + edits against an actual repo until the task is solved).

Format is OpenHands' bespoke CodeAct XML action syntax, not OpenAI tool_calls:
  assistant: <function=NAME>\\n<parameter=KEY>VALUE</parameter>...\\n</function>
  result:    a "user"-role message starting "EXECUTION RESULT of [NAME]:"
All 491 rows use exactly the same 3-function tool set (verified across the whole
dataset before writing this), so the JSON schema below is hand-written from the
dataset's own system prompt rather than parsed — more reliable than parsing prose.

Trajectories are LONG (median 33 messages, max 101) — far past any reasonable block
size whole. Rather than the drop-whole-row-if-too-long policy every other importer
uses (which would discard nearly all of this dataset's value), this one trims each
trajectory to the LONGEST prefix that (a) ends on a clean turn boundary — never
mid-message — and (b) fits the tokenizer block budget. Still drop-don't-truncate at
the MESSAGE level; only ever cuts between messages, never inside one.

Usage: .venv/bin/python scripts/import_openhands.py [--n 300] [--block 1536]
"""
import argparse, json, os, re
from huggingface_hub import hf_hub_download

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "SWE-Gym/OpenHands-SFT-Trajectories"
FILE = "data/train.success.oss-00000-of-00001.parquet"

TOOLS = [
    {"type": "function", "function": {
        "name": "execute_bash",
        "description": "Execute a bash command in the terminal. Long-running commands should redirect output to a file and background themselves.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "The bash command to execute. Can be empty to view additional logs when the previous exit code was -1."},
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
        "name": "finish",
        "description": "Finish the interaction when the task is complete or cannot proceed further.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
]

FUNC_RE = re.compile(r"<function=(\w+)>\s*(.*?)\s*</function>", re.S)
PARAM_RE = re.compile(r"<parameter=(\w+)>(.*?)</parameter>", re.S)


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def parse_function_call(text):
    m = FUNC_RE.search(text)
    if not m:
        return None
    name, body = m.group(1), m.group(2)
    args = {}
    for pm in PARAM_RE.finditer(body):
        key, val = pm.group(1), pm.group(2)
        if key == "view_range":
            try:
                args[key] = json.loads(val)
            except Exception:
                args[key] = val
        elif key == "insert_line":
            try:
                args[key] = int(val.strip())
            except Exception:
                args[key] = val
        else:
            args[key] = val
    return {"name": name, "arguments": args}


def convert(raw_msgs, start=0):
    """-> (messages, checkpoints, next_call_ctr). `checkpoints` are indices into
    `messages` that are safe truncation points (right after a complete tool_call+
    result pair, or after a plain-text final assistant reply — never mid-pair)."""
    out, checkpoints, call_n = [], [], start
    i = 1  # skip the system message (tools passed via tools=[])
    n = len(raw_msgs)
    if n < 2 or raw_msgs[0].get("role") != "system":
        return None, [], start
    out.append({"role": "user", "content": raw_msgs[1].get("content", "")})
    i = 2
    while i < n:
        m = raw_msgs[i]
        if m.get("role") != "assistant":
            return out, checkpoints, call_n  # malformed continuation — stop here, keep what we have
        call = parse_function_call(m.get("content") or "")
        if call:
            cid = f"call_{call_n}"
            out.append({"role": "assistant", "content": None, "tool_calls": [{
                "id": cid, "type": "function",
                "function": {"name": call["name"], "arguments": json.dumps(call["arguments"])},
            }]})
            call_n += 1
            i += 1
            if call["name"] == "finish" or i >= n:
                checkpoints.append(len(out))
                break
            nxt = raw_msgs[i]
            content = nxt.get("content", "") or ""
            if nxt.get("role") != "user" or not content.startswith("EXECUTION RESULT"):
                checkpoints.append(len(out))  # keep the call itself as a valid cut point even without a paired result
                break
            out.append({"role": "tool", "tool_call_id": cid, "name": call["name"], "content": content})
            i += 1
            checkpoints.append(len(out))
        else:
            # plain-text final reply, no function call — valid terminal checkpoint
            out.append({"role": "assistant", "content": m.get("content") or ""})
            checkpoints.append(len(out))
            i += 1
            break
    return out, checkpoints, call_n


def longest_fitting_prefix(messages, checkpoints, tools, tok, block):
    # Shortest-first with early break — see import_swesmith.py for why, including the
    # BatchEncoding len()-counts-keys bug (this importer's original longest-first
    # version had it: len() counted 2 dict keys, every candidate "fit", and 99% of
    # victory6's openhands slice ended up over-block and silently trainer-dropped).
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
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--block", type=int, default=1536)
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "openhands_swe.jsonl"))
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

    path = hf_hub_download(repo_id=REPO, filename=FILE, repo_type="dataset")
    df = pd.read_parquet(path)
    print(json.dumps({"event": "loaded", "rows": len(df)}), flush=True)

    kept, seen = [], set()
    drops = {"shape": 0, "no_fit": 0, "dup": 0, "suite_overlap": 0, "snake": 0}
    call_ctr = 0
    for i in range(len(df)):
        if len(kept) >= args.n:
            break
        raw = list(df.iloc[i]["messages"])
        conv, checkpoints, next_ctr = convert(raw, start=call_ctr)
        if not conv or not checkpoints:
            drops["shape"] += 1; continue

        prefix = longest_fitting_prefix(conv, checkpoints, TOOLS, tok, args.block)
        if not prefix:
            drops["no_fit"] += 1; continue
        call_ctr = next_ctr  # advance globally regardless of which prefix was kept — still monotonic/unique

        blob = norm(json.dumps(prefix))
        if "snake game" in blob:  # bare "snake" false-positives on snake_case/to_snake in real code
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

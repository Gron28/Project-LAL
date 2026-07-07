"""Import execution-grounded SWE trajectories from TIGER-Lab/SWE-Next-SFT-Trajectories
(MIT, 3693 rows). Tasks are mined from real merged PRs and kept only when the final
test verification strictly passes — including "recovery" trajectories (test fails →
debug → fix → re-verify), the exact verify-before-claiming-done behavior victory6
lacked. Like every real SWE dataset, rows are too long for a 1536 block whole (min
~9.8k chars — verified by a full scan), so this harvests longest-fitting prefixes; the
complete verify-tail signal lives in data/followthrough_sft.jsonl instead.

Format: CodeAct XML in assistant text (like import_openhands.py) but with tool-role
result messages ("Exit code: N\\nExecution output of [NAME]:...") and a different
4-function set — file_editor / search / execute_bash (param `cmd`, not `command`) /
finish. Schemas below are hand-written from a full-dataset parameter-frequency scan
(46k file_editor, 28k search, 23k execute_bash, 2.8k finish calls; long-tail param
typos by the generating model are passed through as-is, they're <0.1%).

Assistant text before the XML call is KEPT next to the tool call (see
import_swesmith.py's docstring for why). Rows are processed shortest-first so prefixes
cover the largest possible fraction of each kept trajectory.

Usage: .venv/bin/python scripts/import_swenext.py [--n 200] [--block 1536]
"""
import argparse, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "TIGER-Lab/SWE-Next-SFT-Trajectories"

TOOLS = [
    {"type": "function", "function": {
        "name": "file_editor",
        "description": "View, create and edit files. State is persistent across calls.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "enum": ["view", "create", "str_replace", "insert", "undo_edit"]},
            "path": {"type": "string", "description": "Absolute path to file or directory."},
            "file_text": {"type": "string", "description": "Content for the create command."},
            "old_str": {"type": "string", "description": "Exact text to replace for str_replace."},
            "new_str": {"type": "string", "description": "Replacement text for str_replace/insert."},
            "insert_line": {"type": "integer", "description": "Line after which to insert for the insert command."},
            "view_range": {"type": "array", "items": {"type": "integer"}, "description": "[start, end] line range for view."},
            "concise": {"type": "boolean", "description": "Show a concise directory listing for view."},
        }, "required": ["command", "path"]},
    }},
    {"type": "function", "function": {
        "name": "search",
        "description": "Search for a term in files under a directory.",
        "parameters": {"type": "object", "properties": {
            "search_term": {"type": "string"},
            "path": {"type": "string", "description": "Directory or file to search in."},
            "max_results": {"type": "integer"},
        }, "required": ["search_term"]},
    }},
    {"type": "function", "function": {
        "name": "execute_bash",
        "description": "Execute a bash command in the terminal.",
        "parameters": {"type": "object", "properties": {
            "cmd": {"type": "string", "description": "The bash command to execute."},
            "timeout": {"type": "integer", "description": "Seconds before the command is killed."},
        }, "required": ["cmd"]},
    }},
    {"type": "function", "function": {
        "name": "finish",
        "description": "Finish the task and submit the result when complete and verified.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "enum": ["submit"]},
            "result": {"type": "string", "description": "Summary of what was done."},
        }, "required": ["command"]},
    }},
]

FUNC_RE = re.compile(r"<function=(\w+)>\s*(.*?)\s*</function>", re.S)
PARAM_RE = re.compile(r"<parameter=(\w+)>(.*?)</parameter>", re.S)
INT_PARAMS = {"insert_line", "max_results", "timeout"}


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def jaccard(a, b):
    wa, wb = set(a.split()), set(b.split())
    return len(wa & wb) / max(1, len(wa | wb))


def parse_call(text):
    """-> (call|None, remaining_text). Takes the FIRST function block; text outside
    it (the model's brief intent statement) is returned to keep next to the call."""
    m = FUNC_RE.search(text)
    if not m:
        return None, text
    name, body = m.group(1), m.group(2)
    args = {}
    for pm in PARAM_RE.finditer(body):
        key, val = pm.group(1), pm.group(2)
        if key == "view_range":
            try:
                args[key] = json.loads(val)
            except Exception:
                args[key] = val
        elif key in INT_PARAMS:
            try:
                args[key] = int(val.strip())
            except Exception:
                args[key] = val
        elif key == "concise":
            args[key] = val.strip().lower() == "true"
        else:
            args[key] = val
    remaining = (text[:m.start()] + text[m.end():]).strip()
    return {"name": name, "arguments": args}, remaining


def convert(raw_msgs, start=0):
    """-> (messages, checkpoints, next_call_ctr)."""
    out, checkpoints, call_n = [], [], start
    if len(raw_msgs) < 3 or raw_msgs[0].get("role") != "system" or raw_msgs[1].get("role") != "user":
        return None, [], start
    out.append({"role": "user", "content": raw_msgs[1].get("content") or ""})
    i = 2
    n = len(raw_msgs)
    while i < n:
        m = raw_msgs[i]
        if m.get("role") != "assistant":
            break
        call, text = parse_call(m.get("content") or "")
        if not call:
            out.append({"role": "assistant", "content": text})
            checkpoints.append(len(out))
            i += 1
            break
        cid = f"call_{call_n}"
        call_n += 1
        out.append({"role": "assistant", "content": text or None, "tool_calls": [{
            "id": cid, "type": "function",
            "function": {"name": call["name"], "arguments": json.dumps(call["arguments"])},
        }]})
        i += 1
        if call["name"] == "finish" or i >= n:
            checkpoints.append(len(out))
            break
        nxt = raw_msgs[i]
        if nxt.get("role") != "tool":
            checkpoints.append(len(out))
            break
        out.append({"role": "tool", "tool_call_id": cid, "name": call["name"],
                    "content": nxt.get("content") or ""})
        i += 1
        checkpoints.append(len(out))
    return out, checkpoints, call_n


def longest_fitting_prefix(messages, checkpoints, tools, tok, block):
    # Shortest-first with early break — see import_swesmith.py for why, including the
    # BatchEncoding len()-counts-keys bug that must be unwrapped here.
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
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--block", type=int, default=1536)
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-8B")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "swenext_swe.jsonl"))
    args = ap.parse_args()

    from datasets import load_dataset
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

    ds = load_dataset(REPO, split="train")
    print(json.dumps({"event": "loaded", "rows": len(ds)}), flush=True)
    # shortest-first: prefixes then cover the largest fraction of each trajectory
    order = sorted(range(len(ds)), key=lambda i: sum(len(str(m.get("content") or "")) for m in ds[i]["messages"]))

    kept, seen = [], set()
    drops = {"shape": 0, "no_fit": 0, "dup": 0, "suite_overlap": 0, "snake": 0}
    call_ctr = 0
    for idx in order:
        if len(kept) >= args.n:
            break
        raw = ds[idx]["messages"]
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

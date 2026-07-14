#!/usr/bin/env python3
"""Convert Open-SWE-Traces trajectories into bounded HIVE coder_repairer windows.

A window is one supervised decision: compact task/progress context in, one
productive next action out. Long trajectories are never truncated blindly —
observations are elided around a head/tail, and any window that still exceeds
the token budget is dropped whole.

Window kinds per trajectory (max --max-windows total, first match wins per kind):
  first_mutation   context before the first write/edit, target = that mutation
  repair           a failing observation (error/traceback/FAILED), target = the
                   next corrective action
  verification     last passing check, target = truthful completion statement

Source rows must have resolved == 1 and a permissive license. Output rows carry
_hive metadata (task_family = repo so siblings never straddle splits) and are
meant to be fed to build_hive_role_dataset.py via a spec with kind "public".
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PERMISSIVE = {"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "0BSD"}
FAIL_RE = re.compile(r"Traceback \(most recent call last\)|\bFAILED\b|\bAssertionError\b|\bSyntaxError\b|\bError:|\berror\[|\bpanic:|\bfatal:|\d+ failed", re.I)
PASS_RE = re.compile(r"\b(\d+) passed\b|\ball tests? pass|\bOK\b$|\bok\b \(\d", re.M)

HIVE_TOOLS = {
    "list_files": {"type": "function", "function": {"name": "list_files", "description": "List files and directories under a path relative to the workspace root.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}},
    "read_file": {"type": "function", "function": {"name": "read_file", "description": "Read a text file in the workspace.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    "read_file_outline": {"type": "function", "function": {"name": "read_file_outline", "description": "Read a compact structural outline of a source file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    "grep": {"type": "function", "function": {"name": "grep", "description": "Search workspace text with a regular expression.", "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"]}}},
    "write_file": {"type": "function", "function": {"name": "write_file", "description": "Create or overwrite a workspace text file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    "edit_file": {"type": "function", "function": {"name": "edit_file", "description": "Replace the first exact occurrence in a workspace file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "search": {"type": "string"}, "replace": {"type": "string"}}, "required": ["path", "search", "replace"]}}},
    "run_shell": {"type": "function", "function": {"name": "run_shell", "description": "Run a command in the workspace sandbox.", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
}
ROLE_PROMPT = (
    "Own implementation and repair only. Inspect before editing, make real scoped "
    "mutations, run the package's mechanical check after the final mutation, and use "
    "exact failure output rather than guesses. Delete or rewrite incorrect prior work "
    "when evidence requires it. Never claim success without a fresh passing check and "
    "never perform research or delegation."
)


def relpath(p: str) -> str:
    return re.sub(r"^/testbed/?", "", p or "") or "."


def elide(text: str, head: int, tail: int) -> str:
    text = str(text or "")
    if len(text) <= head + tail + 40:
        return text
    return text[:head] + f"\n... [{len(text) - head - tail} chars elided] ...\n" + text[-tail:]


def map_call(call: dict) -> dict | None:
    """sweagent tool call -> HIVE tool call dict, or None if unmappable."""
    fn = (call or {}).get("function") or {}
    name = fn.get("name")
    try:
        args = fn.get("arguments")
        args = json.loads(args) if isinstance(args, str) else dict(args or {})
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if name == "bash":
        cmd = args.get("command")
        if not cmd:
            return None
        return {"name": "run_shell", "arguments": {"command": re.sub(r"/testbed/?", "", cmd)}}
    if name == "str_replace_editor":
        sub, path = args.get("command"), relpath(args.get("path", ""))
        if sub == "view":
            return {"name": "read_file", "arguments": {"path": path}}
        if sub == "create" and args.get("file_text") is not None:
            return {"name": "write_file", "arguments": {"path": path, "content": args["file_text"]}}
        if sub == "str_replace" and args.get("old_str"):
            return {"name": "edit_file", "arguments": {"path": path, "search": args["old_str"], "replace": args.get("new_str", "")}}
    return None  # submit / insert / unknown


def tool_call_msg(mapped: dict, commentary: str) -> dict:
    return {
        "role": "assistant",
        "content": (commentary or "").strip()[:400],
        "tool_calls": [{"type": "function", "function": {"name": mapped["name"], "arguments": json.dumps(mapped["arguments"], ensure_ascii=False)}}],
    }


def progress_summary(traj: list[dict], upto: int, limit: int = 5) -> str:
    """Compact one-line-per-action history of the last `limit` actions before traj[upto]."""
    lines = []
    for m in traj[:upto]:
        if m.get("role") != "assistant":
            continue
        for c in m.get("tool_calls") or []:
            mapped = map_call(c)
            if not mapped:
                continue
            a = mapped["arguments"]
            detail = a.get("path") or a.get("command", "")
            lines.append(f"- {mapped['name']}: {str(detail)[:110]}")
    if not lines:
        return "- (no actions yet)"
    if len(lines) > limit:
        lines = [f"- ... {len(lines) - limit} earlier actions elided ..."] + lines[-limit:]
    return "\n".join(lines)


def window_messages(task: str, traj: list[dict], target_idx: int, instruction: str, target_msg: dict, obs_budget: tuple[int, int]) -> list[dict]:
    last_obs = ""
    for m in reversed(traj[:target_idx]):
        if m.get("role") == "tool":
            last_obs = str(m.get("content") or "")
            break
    user = (
        f"Task contract:\n{elide(task, 1100, 300)}\n\n"
        f"Progress so far:\n{progress_summary(traj, target_idx)}\n\n"
        f"Last observation:\n{elide(last_obs, *obs_budget) or '(none)'}\n\n"
        f"{instruction}"
    )
    return [{"role": "system", "content": ROLE_PROMPT}, {"role": "user", "content": user}, target_msg]


def carve(row: dict, max_windows: int) -> list[dict]:
    traj = row["trajectory"]
    task = ""
    for m in traj:
        if m.get("role") == "user":
            task = str(m.get("content") or "")
            break
    pr = re.search(r"<pr_description>\s*(.*?)\s*</pr_description>", task, re.S)
    task = pr.group(1) if pr else task
    if not task or len(traj) < 4:
        return []

    out: list[dict] = []

    def emit(kind: str, target_idx: int, instruction: str, target_msg: dict, obs_budget=(700, 500)) -> None:
        out.append({
            "messages": window_messages(task, traj, target_idx, instruction, target_msg, obs_budget),
            "tools": list(HIVE_TOOLS.values()),
            "_hive": {"task_family": row["repo"], "parent_ids": [row["instance_id"]], "window_kind": kind},
        })

    # first mutation
    for i, m in enumerate(traj):
        if m.get("role") != "assistant":
            continue
        mapped = next((mc for mc in map(map_call, m.get("tool_calls") or []) if mc), None)
        if mapped and mapped["name"] in ("write_file", "edit_file"):
            emit("first_mutation", i, "Decide and perform the single most productive next action.", tool_call_msg(mapped, m.get("content") or ""))
            break

    # repair transitions: failing observation -> next mapped action
    repairs = 0
    for i, m in enumerate(traj):
        if repairs >= 2 or m.get("role") != "tool" or not FAIL_RE.search(str(m.get("content") or "")):
            continue
        nxt = next((traj[j] for j in range(i + 1, min(i + 3, len(traj))) if traj[j].get("role") == "assistant"), None)
        if not nxt:
            continue
        mapped = next((mc for mc in map(map_call, nxt.get("tool_calls") or []) if mc), None)
        if mapped:
            emit("repair", traj.index(nxt), "The last check failed. Diagnose from the exact failure output and perform the corrective action.", tool_call_msg(mapped, nxt.get("content") or ""), obs_budget=(900, 700))
            repairs += 1

    # truthful completion after the last passing check
    for i in range(len(traj) - 1, -1, -1):
        m = traj[i]
        if m.get("role") == "tool" and PASS_RE.search(str(m.get("content") or "")) and not FAIL_RE.search(str(m.get("content") or "")):
            final = ("The mechanical check passed on the current workspace state (see last observation). "
                     "The scoped change is implemented; no unverified claims are made beyond this check output.")
            emit("verification", i + 1, "State truthfully, based only on the last observation, whether the package's check passed and what was verified.", {"role": "assistant", "content": final})
            break

    return out[:max_windows]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="sweagent")
    ap.add_argument("--split", default="qwen35_122b")
    ap.add_argument("--languages", default="python,typescript,javascript,go")
    ap.add_argument("--target-windows", type=int, default=3000)
    ap.add_argument("--max-windows", type=int, default=4, help="per trajectory")
    ap.add_argument("--block", type=int, default=2048)
    ap.add_argument("--tokenizer", default="Qwen/Qwen3-4B")
    ap.add_argument("--out", required=True)
    ap.add_argument("--input-json", help="offline fixture: datasets-server rows JSON instead of streaming")
    args = ap.parse_args()

    langs = {x.strip() for x in args.languages.split(",") if x.strip()}
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.tokenizer)

    def rows():
        if args.input_json:
            for r in json.load(open(args.input_json))["rows"]:
                yield r["row"]
            return
        from datasets import load_dataset
        yield from load_dataset("nvidia/Open-SWE-Traces", args.config, split=args.split, streaming=True)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    kept = 0
    stats = {"rows_seen": 0, "rows_used": 0, "over_budget": 0, "windows": {}}
    with out_path.open("w", encoding="utf-8") as f:
        for row in rows():
            if kept >= args.target_windows:
                break
            stats["rows_seen"] += 1
            if row.get("resolved") != 1 or row.get("license") not in PERMISSIVE or row.get("language") not in langs:
                continue
            if isinstance(row.get("trajectory"), str):
                row["trajectory"] = json.loads(row["trajectory"])
            used = False
            for w in carve(row, args.max_windows):
                ids = tok.apply_chat_template(w["messages"], tools=w["tools"], add_generation_prompt=False, tokenize=True)
                if not isinstance(ids, list):
                    ids = ids["input_ids"]
                if len(ids) > args.block:
                    stats["over_budget"] += 1
                    continue
                w["_hive"]["license"] = row["license"]
                w["_hive"]["source_row"] = row["trajectory_id"]
                f.write(json.dumps(w, ensure_ascii=False) + "\n")
                kept += 1
                used = True
                k = w["_hive"]["window_kind"]
                stats["windows"][k] = stats["windows"].get(k, 0) + 1
            stats["rows_used"] += used
            if stats["rows_seen"] % 200 == 0:
                print(json.dumps({"progress": stats, "kept": kept}), file=sys.stderr, flush=True)
    print(json.dumps({"ok": True, "kept": kept, **stats}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

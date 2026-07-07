"""Synthetic agentic tool-call traces, verified by construction.

Generates multi-turn conversations in the EXACT wire format the lab's tool loop
uses at inference (OpenAI-style tool_calls on assistant turns, role:"tool" results)
so finetune_sft.py v2 can train Qwen3 on emitting correct tool calls. No teacher —
each trace is built from a synthetic workspace state, so tool arguments and results
are correct by construction (pattern: gen_fractal_data.py).

Tool schemas mirror web/src/lib/tools.ts TOOL_DEFS. Task/file-name pools are
randomized and disjoint from the agentic bench suite scenarios.

  python scripts/gen_agentic_data.py --n 400 --out data/agentic_sft.jsonl
"""
import argparse, json, random

TOOLS = [
    {"type": "function", "function": {"name": "read_file", "description": "Read a file's contents",
        "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "relative path"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "write_file", "description": "Create or overwrite a file",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {"name": "list_files", "description": "List files in a directory",
        "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "relative dir, '' for root"}}, "required": []}}},
    {"type": "function", "function": {"name": "edit_file", "description": "Replace an exact string in a file",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}}, "required": ["path", "old", "new"]}}},
]

_NAMES = ["notes", "report", "summary", "draft", "config", "readme", "log", "todo", "index", "main",
          "data", "recipe", "plan", "inventory", "journal", "manifest", "outline", "roster", "budget"]
_EXTS = [".txt", ".md", ".csv", ".cfg", ".py"]
_WORDS = ["harbor", "violet", "ember", "quartz", "meadow", "falcon", "cedar", "prism", "willow",
          "canyon", "beacon", "juniper", "onyx", "tundra", "sable", "marble", "lantern", "grove"]


def call(idx, name, args):
    return {"id": f"call_{idx}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}}


def tool_result(idx, name, content):
    return {"role": "tool", "tool_call_id": f"call_{idx}", "name": name, "content": content}


def fname(rng):
    return rng.choice(_NAMES) + rng.choice(_EXTS)


def gen_read(rng, i):
    f, w = fname(rng), " ".join(rng.sample(_WORDS, 3))
    return [
        {"role": "user", "content": f"What does {f} contain?"},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "read_file", {"path": f})]},
        tool_result(i, "read_file", w),
        {"role": "assistant", "content": f"{f} contains: {w}"},
    ]


def gen_write(rng, i):
    f = fname(rng)
    text = " ".join(rng.sample(_WORDS, rng.randint(2, 4)))
    return [
        {"role": "user", "content": f"Create a file called {f} containing exactly: {text}"},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "write_file", {"path": f, "content": text})]},
        tool_result(i, "write_file", "ok: wrote " + f),
        {"role": "assistant", "content": f"Done — {f} created with the requested content."},
    ]


def gen_list_then_read(rng, i):
    files = sorted({fname(rng) for _ in range(3)})
    target = rng.choice(files)
    w = " ".join(rng.sample(_WORDS, 3))
    return [
        {"role": "user", "content": f"Look at what files exist, then tell me what {target} says."},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "list_files", {"path": ""})]},
        tool_result(i, "list_files", "\n".join(files)),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 1, "read_file", {"path": target})]},
        tool_result(i + 1, "read_file", w),
        {"role": "assistant", "content": f"The directory has {len(files)} files. {target} says: {w}"},
    ]


def gen_edit(rng, i):
    f = fname(rng)
    old, new = rng.sample(_WORDS, 2)
    line = f"status: {old}"
    return [
        {"role": "user", "content": f"In {f}, change '{old}' to '{new}'."},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "read_file", {"path": f})]},
        tool_result(i, "read_file", line),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 1, "edit_file", {"path": f, "old": old, "new": new})]},
        tool_result(i + 1, "edit_file", "ok: replaced 1 occurrence"),
        {"role": "assistant", "content": f"Replaced '{old}' with '{new}' in {f}."},
    ]


def gen_read_then_write(rng, i):
    src, dst = fname(rng), fname(rng)
    while dst == src:
        dst = fname(rng)
    w = " ".join(rng.sample(_WORDS, 3))
    up = w.upper()
    return [
        {"role": "user", "content": f"Read {src} and write an uppercase copy of its contents to {dst}."},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "read_file", {"path": src})]},
        tool_result(i, "read_file", w),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 1, "write_file", {"path": dst, "content": up})]},
        tool_result(i + 1, "write_file", "ok: wrote " + dst),
        {"role": "assistant", "content": f"Copied {src} to {dst} in uppercase."},
    ]


def gen_no_tool(rng, i):
    a, b = rng.randint(10, 60), rng.randint(10, 60)
    return [
        {"role": "user", "content": f"No files needed for this one: what is {a} + {b}?"},
        {"role": "assistant", "content": str(a + b)},
    ]


GENS = [gen_read, gen_write, gen_list_then_read, gen_edit, gen_read_then_write, gen_no_tool]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=400)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    rng = random.Random(args.seed or None)
    with open(args.out, "w", encoding="utf-8") as f:
        for k in range(args.n):
            gen = rng.choice(GENS)
            msgs = gen(rng, k * 10)
            f.write(json.dumps({"messages": msgs, "tools": TOOLS}) + "\n")
    print(f"wrote {args.n} traces to {args.out}")


if __name__ == "__main__":
    main()

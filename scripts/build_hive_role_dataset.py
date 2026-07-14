#!/usr/bin/env python3
"""Build one immutable, provenance-rich HIVE specialist SFT dataset.

Input is a JSON spec so every source carries its own license and quality policy::

  {
    "sources": [{
      "path": "data/agentic_sft.jsonl",
      "source": "local-ai-lab-agentic",
      "kind": "verified_local",
      "license": "project-authored",
      "checks": ["generator_assertions"]
    }]
  }

Generated/local rows are rejected unless deterministic checks are recorded either
on the source or in row._hive.checks. Public rows require an explicit license.
The resulting JSONL retains `_hive.split`, which the trainers honor directly so
task-family siblings cannot straddle train and validation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
ROLES = {"coordinator_planner", "coder_repairer", "verifier", "open_inquirer"}
SOURCE_KINDS = {"public", "verified_local", "generated"}
BLIND_PATTERNS = [
    re.compile(r"\broguelike\s+snake\b|\bsnake\s+game\b", re.I),
    re.compile(r"crash[- ]recoverable.*\bdag\b|\bdurable[- ]dag\b.*adversarial", re.I | re.S),
]

ROLE_TOOL_POLICY = {
    "coordinator_planner": set(),
    "coder_repairer": {"list_files", "read_file", "read_file_outline", "grep", "write_file", "edit_file", "run_shell"},
    "verifier": {"list_files", "read_file", "read_file_outline", "grep", "run_shell"},
    # open_inquirer (open-inquiry-protocol.md Layer B): research-only, no mutation tools —
    # matches AGENT_TOOL_DEFS' web_search/web_fetch in web/src/lib/agent-tools.ts.
    "open_inquirer": {"web_search", "web_fetch"},
}

# open-inquiry-protocol.md Section 4, check 1 — trace length/complexity cap. The
# "small model learnability gap" (arXiv 2502.12143) and SCoTD (arXiv 2306.14050) findings
# cited in the design doc show sub-3B models need short, distilled, complexity-matched
# traces, never verbatim long teacher rationales — this is a token-free char-length proxy
# so it holds even when no tokenizer is loaded (unlike the existing --block/token_length
# check below, which only runs when a tokenizer is passed in). Scoped to open_inquirer
# only: the other roles' traces (tool-call transcripts, diffs) are already bounded by that
# tokenizer-based check and have no learnability-gap rationale for a second, tighter cap.
ROLE_TRACE_CHAR_CAP = {
    "open_inquirer": 6000,
}

CANONICAL_TOOLS = {
    "list_files": {"type": "function", "function": {"name": "list_files", "description": "List files and directories under a path relative to the workspace root.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}},
    "read_file": {"type": "function", "function": {"name": "read_file", "description": "Read a text file in the workspace.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    "read_file_outline": {"type": "function", "function": {"name": "read_file_outline", "description": "Read a compact structural outline of a source file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    "grep": {"type": "function", "function": {"name": "grep", "description": "Search workspace text with a regular expression.", "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"]}}},
    "write_file": {"type": "function", "function": {"name": "write_file", "description": "Create or overwrite a workspace text file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    "edit_file": {"type": "function", "function": {"name": "edit_file", "description": "Replace the first exact occurrence in a workspace file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "search": {"type": "string"}, "replace": {"type": "string"}}, "required": ["path", "search", "replace"]}}},
    "run_shell": {"type": "function", "function": {"name": "run_shell", "description": "Run a command in the workspace sandbox.", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
    # Mirrors AGENT_TOOL_DEFS in web/src/lib/agent-tools.ts verbatim (name + required args).
    "web_search": {"type": "function", "function": {"name": "web_search", "description": "Search the web (DuckDuckGo). Returns the top results with titles, snippets and URLs.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    "web_fetch": {"type": "function", "function": {"name": "web_fetch", "description": "Fetch a URL and return its readable text content (HTML stripped, capped).", "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
}
REQUIRED_ARGS = {name: set(tool["function"]["parameters"].get("required", [])) for name, tool in CANONICAL_TOOLS.items()}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value: str | bytes) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def norm(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", value.lower()).split())


def jaccard(a: str, b: str) -> float:
    aa, bb = set(a.split()), set(b.split())
    return len(aa & bb) / max(1, len(aa | bb))


def first_user(row: dict[str, Any]) -> str:
    for message in row.get("messages") or []:
        if message.get("role") == "user":
            return str(message.get("content") or "")
    return str(row.get("instruction") or row.get("prompt") or row.get("question") or row.get("q") or "")


def normalize_row(raw: dict[str, Any]) -> dict[str, Any] | None:
    messages = raw.get("messages")
    if not messages:
        prompt = raw.get("instruction") or raw.get("prompt") or raw.get("question") or raw.get("q")
        answer = raw.get("output")
        if answer is None:
            answer = raw.get("answer") or raw.get("a")
        if prompt is None or answer is None:
            return None
        messages = [{"role": "user", "content": str(prompt)}, {"role": "assistant", "content": str(answer)}]
    if not isinstance(messages, list) or not any(isinstance(message, dict) and message.get("role") == "assistant" for message in messages):
        return None
    out = {"messages": messages}
    if isinstance(raw.get("tools"), list):
        out["tools"] = raw["tools"]
    return out


def called_tools(row: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for message in row.get("messages") or []:
        for call in message.get("tool_calls") or []:
            name = ((call or {}).get("function") or {}).get("name")
            if name:
                names.add(str(name))
    return names


def normalize_production_tools(row: dict[str, Any], role: str) -> bool:
    aliases = {
        "path": ["filename", "file", "file_path", "filepath"],
        "content": ["contents", "text", "body", "code", "data"],
        "search": ["find", "old", "old_string"],
        "replace": ["replacement", "new", "new_string"],
        "command": ["cmd", "shell_command", "script"],
        "query": ["q", "search_query", "term"],
        "url": ["link", "href", "uri"],
    }
    for message in row.get("messages") or []:
        for call in message.get("tool_calls") or []:
            function = (call or {}).get("function") or {}
            name = str(function.get("name") or "")
            if name not in ROLE_TOOL_POLICY[role]:
                continue
            arguments = function.get("arguments") or "{}"
            try:
                arguments = json.loads(arguments) if isinstance(arguments, str) else dict(arguments)
            except (json.JSONDecodeError, TypeError, ValueError):
                return False
            for canonical, candidates in aliases.items():
                if canonical not in arguments:
                    for candidate in candidates:
                        if candidate in arguments:
                            arguments[canonical] = arguments.pop(candidate)
                            break
            if not REQUIRED_ARGS[name].issubset(arguments):
                return False
            function["arguments"] = canonical_json(arguments)
            function["name"] = name
    allowed = ROLE_TOOL_POLICY[role]
    if allowed:
        row["tools"] = [CANONICAL_TOOLS[name] for name in CANONICAL_TOOLS if name in allowed]
    else:
        row.pop("tools", None)
    return True


def load_suite_prompts() -> list[str]:
    prompts: list[str] = []
    roots = [ROOT / "web" / "src" / "lib" / "seed-suites", ROOT / "web" / ".data" / "suites"]
    for directory in roots:
        if not directory.exists():
            continue
        for file in directory.glob("*.json"):
            try:
                for item in json.loads(file.read_text(encoding="utf-8")).get("items", []):
                    if item.get("q"):
                        prompts.append(norm(str(item["q"])))
            except (OSError, json.JSONDecodeError):
                continue
    return prompts


def checks_pass(checks: Any) -> tuple[bool, list[str]]:
    if not isinstance(checks, list) or not checks:
        return False, []
    labels: list[str] = []
    for check in checks:
        if isinstance(check, str) and check.strip():
            labels.append(check.strip())
        elif isinstance(check, dict) and check.get("passed") is True and check.get("code"):
            labels.append(str(check["code"]))
        else:
            return False, []
    return True, labels


# open-inquiry-protocol.md Section 4, check 2 — no-think format enforcement. Qwen3
# think-displacement lesson (memory: SFT without think blocks lobotomizes reasoning, but
# training a "no-think" specialist ON think-formatted traces teaches the wrong format
# outright) — a hard compiler check, not a training-time flag, so a bad row can never
# silently slip through.
THINK_BLOCK_PATTERN = re.compile(r"<think>|</think>", re.I)


def has_think_block(row: dict[str, Any]) -> bool:
    for message in row.get("messages") or []:
        content = message.get("content")
        if isinstance(content, str) and THINK_BLOCK_PATTERN.search(content):
            return True
    return False


def trace_char_length(row: dict[str, Any]) -> int:
    total = 0
    for message in row.get("messages") or []:
        content = message.get("content")
        if isinstance(content, str):
            total += len(content)
        for call in message.get("tool_calls") or []:
            total += len(str(((call or {}).get("function") or {}).get("arguments") or ""))
    return total


def token_length(tokenizer: Any, row: dict[str, Any]) -> int:
    value = tokenizer.apply_chat_template(
        row["messages"], tools=row.get("tools"), add_generation_prompt=False, tokenize=True
    )
    if not isinstance(value, list):
        value = value["input_ids"]
    return len(value)


def build_dataset(
    role: str,
    spec: dict[str, Any],
    val_frac: float,
    suite_prompts: list[str],
    tokenizer: Any = None,
    block: int = 0,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if role not in ROLES:
        raise ValueError(f"unknown role: {role}")
    if not 0 < val_frac < 0.5:
        raise ValueError("val_frac must be greater than 0 and less than 0.5")
    sources = spec.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("spec.sources must be a non-empty array")

    kept: list[dict[str, Any]] = []
    seen_prompts: set[str] = set()
    drops: dict[str, int] = {}
    composition: dict[str, int] = {}

    def drop(reason: str) -> None:
        drops[reason] = drops.get(reason, 0) + 1

    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("every source must be an object")
        source_path = Path(str(source.get("path") or ""))
        if not source_path.is_absolute():
            source_path = ROOT / source_path
        source_name = str(source.get("source") or "").strip()
        source_kind = str(source.get("kind") or "").strip()
        license_name = str(source.get("license") or "").strip()
        if not source_path.is_file() or not source_name or source_kind not in SOURCE_KINDS:
            raise ValueError(f"invalid source declaration: {source}")
        if source_kind == "public" and not license_name:
            raise ValueError(f"public source {source_name} requires an explicit license")
        source_checks_ok, source_checks = checks_pass(source.get("checks"))

        for line_no, line in enumerate(source_path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                drop("invalid_json")
                continue
            row = normalize_row(raw)
            if row is None:
                drop("invalid_conversation")
                continue
            if not normalize_production_tools(row, role):
                drop("malformed_tool_call")
                continue
            if has_think_block(row):
                drop("think_format")
                continue
            trace_cap = ROLE_TRACE_CHAR_CAP.get(role)
            if trace_cap and trace_char_length(row) > trace_cap:
                drop("trace_too_long")
                continue
            prompt = first_user(row)
            normalized_prompt = norm(prompt)
            if not normalized_prompt:
                drop("missing_prompt")
                continue
            if normalized_prompt in seen_prompts:
                drop("duplicate_prompt")
                continue
            full_text = canonical_json(row)
            if any(pattern.search(full_text) for pattern in BLIND_PATTERNS):
                drop("permanent_blind_probe")
                continue
            if any(jaccard(normalized_prompt, suite_prompt) >= 0.5 for suite_prompt in suite_prompts):
                drop("benchmark_overlap")
                continue
            disallowed = called_tools(row) - ROLE_TOOL_POLICY[role]
            if disallowed:
                drop("role_tool_violation")
                continue
            row_meta = raw.get("_hive") if isinstance(raw.get("_hive"), dict) else {}
            row_checks_ok, row_checks = checks_pass(row_meta.get("checks"))
            if source_kind != "public" and not (row_checks_ok or source_checks_ok):
                drop("unverified_local_or_generated")
                continue
            if tokenizer is not None and block and token_length(tokenizer, row) > block:
                drop("over_context")
                continue

            parents = [str(value) for value in row_meta.get("parent_ids", []) if str(value)] if isinstance(row_meta.get("parent_ids"), list) else []
            family = str(row_meta.get("task_family") or (parents[0] if parents else f"{source_name}:{' '.join(normalized_prompt.split()[:12])}"))
            bucket = int(sha(family)[:12], 16) / float(0xFFFFFFFFFFFF)
            split = "validation" if bucket < val_frac else "train"
            content_hash = sha(canonical_json(row))
            example_id = f"hive-{role}-{sha(f'{source_name}:{content_hash}')[:24]}"
            checks = row_checks if row_checks_ok else source_checks
            row["_hive"] = {
                "id": example_id,
                "content_hash": content_hash,
                "source": source_name,
                "source_kind": source_kind,
                "source_line": line_no,
                "license": license_name or None,
                "generator": row_meta.get("generator") or source.get("generator"),
                "parent_ids": parents,
                "role": role,
                "task_family": family,
                "checks": checks,
                "split": split,
            }
            kept.append(row)
            seen_prompts.add(normalized_prompt)
            composition[source_name] = composition.get(source_name, 0) + 1

    kept.sort(key=lambda row: row["_hive"]["id"])
    dataset_hash = sha("\n".join(canonical_json(row) for row in kept) + ("\n" if kept else ""))
    manifest_core = {
        "version": 1,
        "role": role,
        "dataset_hash": dataset_hash,
        "ordered_example_ids": [row["_hive"]["id"] for row in kept],
        "examples": [row["_hive"] for row in kept],
        "composition": composition,
        "drops": drops,
        "split": {
            "strategy": "sha256(task_family)",
            "validation_fraction": val_frac,
            "train": sum(row["_hive"]["split"] == "train" for row in kept),
            "validation": sum(row["_hive"]["split"] == "validation" for row in kept),
        },
        "permanent_blind_policy": [pattern.pattern for pattern in BLIND_PATTERNS],
    }
    manifest = {**manifest_core, "manifest_hash": sha(canonical_json(manifest_core)), "generated_at": int(time.time() * 1000)}
    return kept, manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", required=True, choices=sorted(ROLES))
    parser.add_argument("--spec", required=True, help="JSON source/provenance specification")
    parser.add_argument("--out", required=True, help="output JSONL under data/")
    parser.add_argument("--manifest-out", help="default: <out>.manifest.json")
    parser.add_argument("--val-frac", type=float, default=0.1)
    parser.add_argument("--block", type=int, default=1024)
    parser.add_argument("--tokenizer", default="Qwen/Qwen3-4B")
    args = parser.parse_args()

    try:
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        tokenizer = None
        if args.block:
            from transformers import AutoTokenizer
            tokenizer = AutoTokenizer.from_pretrained(args.tokenizer)
        rows, manifest = build_dataset(args.role, spec, args.val_frac, load_suite_prompts(), tokenizer, args.block)
        if not rows:
            raise ValueError("all examples were rejected; inspect manifest/drop policy inputs")
        if manifest["split"]["validation"] == 0:
            raise ValueError("dataset has no validation task family; add more diverse examples or adjust val_frac")
        out = Path(args.out)
        if not out.is_absolute():
            out = ROOT / out
        manifest_out = Path(args.manifest_out) if args.manifest_out else Path(str(out) + ".manifest.json")
        if not manifest_out.is_absolute():
            manifest_out = ROOT / manifest_out
        out.parent.mkdir(parents=True, exist_ok=True)
        manifest_out.parent.mkdir(parents=True, exist_ok=True)
        serialized = "".join(canonical_json(row) + "\n" for row in rows)
        if out.exists() and out.read_text(encoding="utf-8") != serialized:
            raise ValueError(f"refusing to overwrite different immutable dataset: {out}")
        if not out.exists():
            out.write_text(serialized, encoding="utf-8")
        manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        if manifest_out.exists():
            existing = json.loads(manifest_out.read_text(encoding="utf-8"))
            if existing.get("manifest_hash") != manifest["manifest_hash"]:
                raise ValueError(f"refusing to overwrite different immutable manifest: {manifest_out}")
        else:
            manifest_out.write_text(manifest_text, encoding="utf-8")
        print(json.dumps({"ok": True, "out": str(out), "manifest": str(manifest_out), "role": args.role, "rows": len(rows), "hash": manifest["dataset_hash"], "split": manifest["split"], "drops": manifest["drops"]}, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

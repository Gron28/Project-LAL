#!/usr/bin/env python3
import json
from pathlib import Path
import tempfile
import unittest

from build_hive_role_dataset import build_dataset


def row(prompt, answer="ok", tool=None, family=None):
    messages = [{"role": "user", "content": prompt}]
    if tool:
        messages.extend([
            {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": tool, "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call_1", "name": tool, "content": "ok"},
        ])
    messages.append({"role": "assistant", "content": answer})
    value = {"messages": messages}
    if family:
        value["_hive"] = {"task_family": family}
    return value


class RoleDatasetTests(unittest.TestCase):
    def build(self, role, values, suite_prompts=None):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rows.jsonl"
            source.write_text("".join(json.dumps(value) + "\n" for value in values), encoding="utf-8")
            spec = {"sources": [{"path": str(source), "source": "unit", "kind": "generated", "license": "project-authored", "checks": ["unit_verified"]}]}
            return build_dataset(role, spec, .1, suite_prompts or [])

    def test_role_tool_isolation(self):
        values = [row("Plan a bounded package", tool="write_file"), row("Plan without tools")]
        rows, manifest = self.build("coordinator_planner", values)
        self.assertEqual(1, len(rows))
        self.assertEqual(1, manifest["drops"]["role_tool_violation"])

    def test_family_split_is_stable(self):
        rows, _ = self.build("coder_repairer", [row("Repair alpha", family="same-family"), row("Repair beta", family="same-family")])
        self.assertEqual(rows[0]["_hive"]["split"], rows[1]["_hive"]["split"])

    def test_blind_and_benchmark_probes_are_removed(self):
        values = [row("Build a roguelike snake game"), row("Implement exact hidden benchmark words"), row("Implement an unrelated parser")]
        rows, manifest = self.build("coder_repairer", values, ["implement exact hidden benchmark words"])
        self.assertEqual(1, len(rows))
        self.assertEqual(1, manifest["drops"]["permanent_blind_probe"])
        self.assertEqual(1, manifest["drops"]["benchmark_overlap"])

    def test_manifest_and_example_hashes_are_reproducible(self):
        first_rows, first_manifest = self.build("verifier", [row("Audit requirement one"), row("Audit requirement two")])
        second_rows, second_manifest = self.build("verifier", [row("Audit requirement one"), row("Audit requirement two")])
        self.assertEqual(first_manifest["manifest_hash"], second_manifest["manifest_hash"])
        self.assertEqual(first_rows[0]["_hive"]["id"], second_rows[0]["_hive"]["id"])

    def test_tool_arguments_and_schema_match_production(self):
        value = row("Change the exact old value", tool="edit_file")
        value["messages"][1]["tool_calls"][0]["function"]["arguments"] = json.dumps({"path": "a.txt", "old": "a", "new": "b"})
        rows, _ = self.build("coder_repairer", [value])
        arguments = json.loads(rows[0]["messages"][1]["tool_calls"][0]["function"]["arguments"])
        self.assertEqual({"path": "a.txt", "search": "a", "replace": "b"}, arguments)
        edit = next(tool for tool in rows[0]["tools"] if tool["function"]["name"] == "edit_file")
        self.assertEqual(["path", "search", "replace"], edit["function"]["parameters"]["required"])

    def test_open_inquirer_valid_row_passes(self):
        value = row("Research whether local air quality affects sleep quality", answer="Evidence suggests a link; CONFIDENCE: 62 — moderate observational support.", tool="web_search")
        value["messages"][1]["tool_calls"][0]["function"]["arguments"] = json.dumps({"q": "air quality sleep quality studies"})
        rows, manifest = self.build("open_inquirer", [value])
        self.assertEqual(1, len(rows))
        arguments = json.loads(rows[0]["messages"][1]["tool_calls"][0]["function"]["arguments"])
        self.assertEqual({"query": "air quality sleep quality studies"}, arguments)
        tool_names = {tool["function"]["name"] for tool in rows[0]["tools"]}
        self.assertEqual({"web_search", "web_fetch"}, tool_names)
        self.assertEqual({}, manifest["drops"])

    def test_open_inquirer_rejects_think_formatted_row(self):
        values = [row("Research a benign but sensitive topic", answer="<think>reasoning here</think>Final answer.")]
        rows, manifest = self.build("open_inquirer", values)
        self.assertEqual(0, len(rows))
        self.assertEqual(1, manifest["drops"]["think_format"])

    def test_open_inquirer_rejects_deliberately_long_trace(self):
        long_answer = "x" * 6001
        values = [
            row("Research a question with a short trace", answer="short and within cap"),
            row("Research a question with a very long trace", answer=long_answer),
        ]
        rows, manifest = self.build("open_inquirer", values)
        self.assertEqual(1, len(rows))
        self.assertEqual(1, manifest["drops"]["trace_too_long"])

    def test_trace_char_cap_does_not_apply_to_other_roles(self):
        # The learnability-gap cap is open_inquirer-specific; a long coder_repairer
        # trace (e.g. a large diff) must not be rejected by it.
        long_answer = "x" * 6001
        rows, manifest = self.build("coder_repairer", [row("Repair a large file", answer=long_answer)])
        self.assertEqual(1, len(rows))
        self.assertNotIn("trace_too_long", manifest["drops"])


if __name__ == "__main__":
    unittest.main()

"""Re-verify SFT JSONL files whose rows carry a "checks" field (battery grader logic).

Rows without "checks" are counted as unchecked, not failed. Exits 1 if any checked row fails —
safe to use as a gate before composing a training mix.

Usage: python3 scripts/verify_sft.py data/claude_instruct_hard.jsonl [more.jsonl ...]
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from distill_gemma import run_checks


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    bad = 0
    for path in sys.argv[1:]:
        passed, unchecked, cats = 0, 0, {}
        failures = []
        with open(path) as f:
            for i, line in enumerate(f, 1):
                row = json.loads(line)
                checks = row.get("checks")
                if not checks:
                    unchecked += 1; continue
                got = row["messages"][-1]["content"]
                if run_checks(got, checks):
                    passed += 1
                    c = row.get("cat", "?"); cats[c] = cats.get(c, 0) + 1
                else:
                    failures.append((i, row["messages"][0]["content"][:80]))
        for i, q in failures[:10]:
            print(f"  FAIL line {i}: {q}")
        bad += len(failures)
        print(json.dumps({"file": os.path.basename(path), "passed": passed, "failed": len(failures),
                          "unchecked": unchecked, "cats": cats}))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

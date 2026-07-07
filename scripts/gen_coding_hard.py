"""Coding SFT data v3 — bench-style prompts, verified by construction, no teacher.

The victory2 lesson: 300 MBPP rows (terse untyped 2012-era style) made coding WORSE.
The bench asks for typed-signature functions ("Write a Python function `def f(x: int)
-> int` that ...") and grades by execution — so the training data now mirrors that
style exactly. 16 task families, all function names disjoint from coding.json items,
3 phrasings each, optionally carrying a randomized example assert (teaches reading a
spec plus a concrete test). Every solution is executed against its asserts before
inclusion.

Usage: python3 scripts/gen_coding_hard.py [--n 200] [--out data/coding_hard.jsonl]
"""
import argparse, json, os, random, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_code(code, tests):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "sol.py")
        open(p, "w").write(code + "\n\n" + "\n".join(tests))
        try:
            r = subprocess.run(["python3", p], capture_output=True, timeout=10, cwd=d)
            return r.returncode == 0
        except Exception:
            return False


def F(sig, descs, code, tests):
    return {"sig": sig, "descs": descs, "code": code, "tests": tests}


FAMILIES = [
    F("def rotate_left(nums: list[int], k: int) -> list[int]",
      ["that rotates a list left by k positions, wrapping around.",
       "returning nums shifted k places to the left (elements wrap to the end).",
       "that moves the first k elements to the end of the list."],
      "def rotate_left(nums: list[int], k: int) -> list[int]:\n    k %= len(nums) if nums else 1\n    return nums[k:] + nums[:k]",
      lambda rng: (lambda xs, k: [f"assert rotate_left({xs}, {k}) == {xs[k:] + xs[:k]}",
                                  "assert rotate_left([1, 2, 3], 0) == [1, 2, 3]"])(
          [rng.randint(1, 30) for _ in range(rng.randint(4, 7))], rng.randint(1, 3))),
    F("def is_ascending(nums: list[int]) -> bool",
      ["that returns True iff the list is sorted in non-decreasing order.",
       "that checks whether the list is already sorted from smallest to largest.",
       "returning True only if each element is <= the next one."],
      "def is_ascending(nums: list[int]) -> bool:\n    return all(nums[i] <= nums[i + 1] for i in range(len(nums) - 1))",
      lambda rng: (lambda xs: (lambda ys: [f"assert is_ascending({xs}) == True",
                                           f"assert is_ascending({ys}) == False",
                                           "assert is_ascending([]) == True"])(
          (xs[::-1])))(sorted(rng.sample(range(1, 40), 5)))),
    F("def chunk_list(nums: list[int], size: int) -> list[list[int]]",
      ["that splits the list into consecutive sublists of the given size (last chunk may be shorter).",
       "breaking the list into groups of `size` elements each, in order.",
       "that partitions the list into fixed-size consecutive chunks."],
      "def chunk_list(nums: list[int], size: int) -> list[list[int]]:\n    return [nums[i:i + size] for i in range(0, len(nums), size)]",
      lambda rng: (lambda xs, n: [f"assert chunk_list({xs}, {n}) == {[xs[i:i + n] for i in range(0, len(xs), n)]}"])(
          [rng.randint(1, 9) for _ in range(rng.randint(5, 9))], rng.randint(2, 3))),
    F("def title_case(s: str) -> str",
      ["that capitalizes the first letter of every space-separated word, lowercasing the rest.",
       "converting each word in the string to Capitalized form.",
       "that uppercases each word's first letter and lowercases the remainder."],
      "def title_case(s: str) -> str:\n    return ' '.join(w.capitalize() for w in s.split(' '))",
      lambda rng: (lambda ws: [f"assert title_case({' '.join(ws)!r}) == {' '.join(w.capitalize() for w in ws)!r}",
                               "assert title_case('a') == 'A'"])(
          rng.sample(["copper", "willow", "harbor", "quartz", "cinder", "marble", "meadow", "ember"], 3))),
    F("def unique_chars(s: str) -> list[str]",
      ["that returns a sorted list of the distinct characters in the string.",
       "returning every distinct character of s, sorted alphabetically.",
       "that collects the unique characters of a string into a sorted list."],
      "def unique_chars(s: str) -> list[str]:\n    return sorted(set(s))",
      lambda rng: (lambda s: [f"assert unique_chars({s!r}) == {sorted(set(s))!r}",
                              "assert unique_chars('') == []"])("".join(rng.choices("abcdefg", k=10)))),
    F("def product(nums: list[int]) -> int",
      ["that returns the product of all numbers in the list (1 for an empty list).",
       "multiplying every number in the list together; an empty list gives 1.",
       "returning the running product of all elements, with 1 as the empty product."],
      "def product(nums: list[int]) -> int:\n    p = 1\n    for x in nums:\n        p *= x\n    return p",
      lambda rng: (lambda xs: [f"assert product({xs}) == {__import__('math').prod(xs)}",
                               "assert product([]) == 1"])([rng.randint(1, 6) for _ in range(rng.randint(3, 5))])),
    F("def max_gap(nums: list[int]) -> int",
      ["that returns the largest difference between consecutive elements of a sorted list.",
       "finding the biggest jump between neighboring values in a sorted list.",
       "that, given a sorted list, returns the largest consecutive-element difference."],
      "def max_gap(nums: list[int]) -> int:\n    return max(nums[i + 1] - nums[i] for i in range(len(nums) - 1))",
      lambda rng: (lambda xs: [f"assert max_gap({xs}) == {max(xs[i + 1] - xs[i] for i in range(len(xs) - 1))}"])(
          sorted(rng.sample(range(1, 50), 5)))),
    F("def is_pangram(s: str) -> bool",
      ["that returns True iff the string uses all 26 letters of the alphabet (case-insensitive).",
       "checking whether the string contains every letter of the alphabet at least once.",
       "returning True only if all 26 letters appear somewhere in the string, ignoring case."],
      "def is_pangram(s: str) -> bool:\n    return set('abcdefghijklmnopqrstuvwxyz') <= set(s.lower())",
      lambda rng: (lambda words: [f"assert is_pangram('the quick brown fox jumps over lazy dog') == True",
                                  f"assert is_pangram({' '.join(words)!r}) == False"])(
          rng.sample("the quick brown fox jumps over lazy dog".split(), 6))),
    F("def clamp(value: int, lo: int, hi: int) -> int",
      ["that limits value to the inclusive range [lo, hi].",
       "returning lo if value is below lo, hi if above hi, otherwise value itself.",
       "that clips the value so it never falls outside the given bounds."],
      "def clamp(value: int, lo: int, hi: int) -> int:\n    return max(lo, min(hi, value))",
      lambda rng: (lambda lo, hi: [f"assert clamp({hi + rng.randint(1, 9)}, {lo}, {hi}) == {hi}",
                                   f"assert clamp({lo - rng.randint(1, 9)}, {lo}, {hi}) == {lo}",
                                   f"assert clamp({lo + 1}, {lo}, {hi}) == {lo + 1}"])(
          rng.randint(0, 10), rng.randint(15, 30))),
    F("def interleave(a: list[int], b: list[int]) -> list[int]",
      ["that alternates elements from a and b; leftover elements of the longer list go at the end.",
       "merging two lists by taking elements alternately, appending any remainder.",
       "that zips the two lists element-by-element into one list, tail of the longer list last."],
      "def interleave(a: list[int], b: list[int]) -> list[int]:\n    out = []\n    for i in range(max(len(a), len(b))):\n        if i < len(a):\n            out.append(a[i])\n        if i < len(b):\n            out.append(b[i])\n    return out",
      lambda rng: (lambda a, b: (lambda gold: [f"assert interleave({a}, {b}) == {gold}"])(
          [x for i in range(max(len(a), len(b))) for x in ([a[i]] if i < len(a) else []) + ([b[i]] if i < len(b) else [])]))(
          [rng.randint(1, 9) for _ in range(rng.randint(2, 4))], [rng.randint(10, 19) for _ in range(rng.randint(2, 4))])),
    F("def second_largest(nums: list[int]) -> int",
      ["that returns the second-largest distinct value in the list.",
       "finding the second-biggest unique number in the list.",
       "returning the largest value smaller than the maximum (distinct values assumed)."],
      "def second_largest(nums: list[int]) -> int:\n    return sorted(set(nums))[-2]",
      lambda rng: (lambda xs: [f"assert second_largest({xs}) == {sorted(set(xs))[-2]}"])(
          rng.sample(range(1, 60), 6))),
    F("def running_sum(nums: list[int]) -> list[int]",
      ["that returns the list of prefix sums (element i is the sum of nums[0..i]).",
       "computing the cumulative sums of the list.",
       "where each output element is the total of all input elements up to that position."],
      "def running_sum(nums: list[int]) -> list[int]:\n    out, t = [], 0\n    for x in nums:\n        t += x\n        out.append(t)\n    return out",
      lambda rng: (lambda xs: (lambda gold: [f"assert running_sum({xs}) == {gold}",
                                             "assert running_sum([]) == []"])(
          [sum(xs[: i + 1]) for i in range(len(xs))]))([rng.randint(1, 9) for _ in range(rng.randint(4, 6))])),
    F("def median_of(nums: list[int]) -> float",
      ["that returns the median; for an even count, the average of the two middle values.",
       "computing the statistical median of the list (mean of middle pair when the length is even).",
       "returning the middle value of the sorted list, averaging the central two if needed."],
      "def median_of(nums: list[int]) -> float:\n    s = sorted(nums)\n    n = len(s)\n    m = n // 2\n    return float(s[m]) if n % 2 else (s[m - 1] + s[m]) / 2",
      lambda rng: (lambda xs: (lambda s, n: [f"assert median_of({xs}) == {float(s[n // 2]) if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2}"])(
          sorted(xs), len(xs)))(rng.sample(range(1, 40), rng.choice([5, 6])))),
    F("def hamming(a: str, b: str) -> int",
      ["that counts the positions where two equal-length strings differ.",
       "returning the Hamming distance between two strings of the same length.",
       "counting how many characters differ position-by-position between a and b."],
      "def hamming(a: str, b: str) -> int:\n    return sum(1 for x, y in zip(a, b) if x != y)",
      lambda rng: (lambda a, b: [f"assert hamming({a!r}, {b!r}) == {sum(1 for x, y in zip(a, b) if x != y)}",
                                 "assert hamming('abc', 'abc') == 0"])(
          "".join(rng.choices("abcd", k=6)), "".join(rng.choices("abcd", k=6)))),
    F("def strip_digits(s: str) -> str",
      ["that removes every digit character from the string.",
       "returning the string with all digits 0-9 deleted.",
       "that filters out numeric characters, keeping everything else in order."],
      "def strip_digits(s: str) -> str:\n    return ''.join(c for c in s if not c.isdigit())",
      lambda rng: (lambda s: [f"assert strip_digits({s!r}) == {''.join(c for c in s if not c.isdigit())!r}",
                              "assert strip_digits('123') == ''"])(
          "".join(rng.choices("ab7c1d9e", k=9)))),
    F("def longest_word(words: list[str]) -> str",
      ["that returns the longest string in the list (first one on ties).",
       "finding the word with the most characters; earlier wins a tie.",
       "returning the first string of maximal length from the list."],
      "def longest_word(words: list[str]) -> str:\n    return max(words, key=len)",
      lambda rng: (lambda ws: [f"assert longest_word({ws!r}) == {max(ws, key=len)!r}"])(
          rng.sample(["fig", "plum", "cherry", "apricot", "kiwi", "nectarine", "date", "mulberry"], 4))),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "coding_hard.jsonl"))
    ap.add_argument("--seed", type=int, default=17)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    rows, seen, fails, stale = [], set(), 0, 0
    while len(rows) < args.n and stale < 3000:
        fam = rng.choice(FAMILIES)
        desc = rng.choice(fam["descs"])
        tests = fam["tests"](rng)
        prompt = f"Write a Python function `{fam['sig']}` {desc}"
        if rng.random() < 0.6:  # most rows carry a concrete example test (spec-reading signal)
            prompt += f"\nIt should satisfy: {tests[0]}"
        key = (prompt, tuple(tests))
        if key in seen:
            stale += 1
            continue
        stale = 0
        if not run_code(fam["code"], tests):
            fails += 1
            if fails > args.n:
                raise RuntimeError(f"solution failed its own tests: {prompt[:80]!r}")
            continue
        seen.add(key)
        rows.append({"messages": [{"role": "user", "content": prompt},
                                  {"role": "assistant", "content": f"```python\n{fam['code']}\n```"}]})

    with open(args.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(rows), "families": len(FAMILIES), "self_check_fails": fails, "out": args.out}, indent=2))


if __name__ == "__main__":
    main()

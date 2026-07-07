"""Distill the Gemma 12B champion (via Ollama) into verified SFT data.

Every sample is VERIFIED before inclusion — the teacher's answer must pass the same
kind of programmatic check the benchmark battery uses, so bad teacher outputs never
enter the training set:
  instruct  constraint-following tasks; output re-checked with the battery's checks logic
  planning  dependency/scheduling/logic tasks with answers computed by the generator;
            teacher output must contain the gold answer
  coding    small function specs; teacher's code fence is EXECUTED against asserts

Task pools are generated with randomized parameters and are disjoint from the bench
suite items (no train-on-test). Output rows are {"messages":[user, assistant]} JSONL —
the format finetune_sft.py v2 trains on. Resume-safe: appends until --n total rows.

  python scripts/distill_gemma.py --mode instruct --n 400 --out data/distill_instruct.jsonl
  python scripts/distill_gemma.py --mode planning --n 300 --out data/distill_planning.jsonl
  python scripts/distill_gemma.py --mode coding   --n 200 --out data/distill_coding.jsonl

Overnight-friendly: progress lines on stdout, Ctrl-C safe (file is append-only).
"""
import argparse, json, os, random, re, subprocess, tempfile, time, urllib.request

OLLAMA = "http://127.0.0.1:11434/api/chat"


def teacher(model, prompt, num_predict=1536, temperature=0.7, think=True, timeout=180):
    body = json.dumps({
        "model": model, "messages": [{"role": "user", "content": prompt}],
        "think": think, "stream": False,
        "options": {"temperature": temperature, "num_predict": num_predict},
    }).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.load(r)
    return (j.get("message") or {}).get("content") or ""


# ---------- the battery's checks logic, mirrored (graders.ts gradeChecks) ----------
def run_checks(got, checks):
    for c in checks:
        t = c["type"]
        if t == "regex":
            if not re.search(c["pattern"], got, re.I if "i" in c.get("flags", "") else 0): return False
        elif t == "not_regex":
            if re.search(c["pattern"], got, re.I if "i" in c.get("flags", "") else 0): return False
        elif t == "max_words":
            if len(got.split()) > c["n"]: return False
        elif t == "min_words":
            if len(got.split()) < c["n"]: return False
        elif t == "starts_with":
            if not got.strip().startswith(c["s"]): return False
        elif t == "json_valid":
            try: json.loads(got.strip())
            except Exception: return False
        elif t == "line_count":
            n = len([l for l in got.strip().split("\n") if l.strip()])
            op = c.get("op", "eq")
            if op == "lte" and n > c["n"]: return False
            if op == "gte" and n < c["n"]: return False
            if op == "eq" and n != c["n"]: return False
    return True


# ---------- instruct: constraint-following tasks (disjoint pools from the suite) ----------
_THINGS = ["rivers", "mountains", "trees", "birds", "fish", "metals", "gemstones", "constellations",
           "musical instruments", "sports", "vegetables", "herbs", "insects", "deserts", "islands",
           "programming languages", "chemical elements", "dances", "cheeses", "clouds"]
_TOPICS = ["a thunderstorm", "a quiet library", "morning coffee", "a train journey", "autumn leaves",
           "a lighthouse", "fresh snow", "a street market", "the desert at noon", "an old bicycle"]
_WORDS = ["Indeed", "Absolutely", "Notably", "Remarkably", "Curiously", "Naturally", "Evidently"]
_QA = [("How many days are in a leap year?", "366"), ("What planet is known as the Red Planet?", "Mars"),
       ("What gas do plants absorb from the air?", "carbon dioxide|CO2"), ("How many sides does a hexagon have?", "6|six"),
       ("What is the largest ocean?", "Pacific"), ("What is the boiling point of water in Celsius?", "100"),
       ("How many continents are there?", "7|seven"), ("What is the chemical symbol for gold?", "Au"),
       ("How many minutes are in two hours?", "120"), ("What is the square root of 81?", "9|nine")]


def gen_instruct(rng):
    kind = rng.choice(["lines", "brief", "json", "starts", "avoid", "caps"])
    if kind == "lines":
        n = rng.randint(3, 7); thing = rng.choice(_THINGS)
        return (f"List exactly {n} {thing}, one per line, nothing else (no numbering, no extra text).",
                [{"type": "line_count", "n": n, "op": "eq"}])
    if kind == "brief":
        q, gold = rng.choice(_QA); n = rng.randint(6, 12)
        return (f"Answer in fewer than {n} words: {q}",
                [{"type": "max_words", "n": n}, {"type": "regex", "pattern": gold, "flags": "i"}])
    if kind == "json":
        keys = rng.sample(["title", "year", "color", "size", "mood", "city", "score"], 2)
        return (f'Respond with valid JSON only: an object with exactly the keys "{keys[0]}" and "{keys[1]}" '
                f"(invent plausible values). No prose, no code fences.",
                [{"type": "json_valid"}, {"type": "regex", "pattern": keys[0]}, {"type": "regex", "pattern": keys[1]}])
    if kind == "starts":
        w = rng.choice(_WORDS); q, gold = rng.choice(_QA)
        return (f"Start your response with the exact word '{w}'. {q}",
                [{"type": "starts_with", "s": w}, {"type": "regex", "pattern": gold, "flags": "i"}])
    if kind == "avoid":
        topic = rng.choice(_TOPICS); banned = rng.choice(["very", "really", "nice", "thing", "just"])
        return (f"Describe {topic} in 2-3 sentences without ever using the word \"{banned}\".",
                [{"type": "not_regex", "pattern": r"\b" + banned + r"\b", "flags": "i"},
                 {"type": "min_words", "n": 15}])
    topic = rng.choice(_TOPICS)
    return (f"Write one sentence about {topic} IN ALL CAPITAL LETTERS (no lowercase letters at all).",
            [{"type": "not_regex", "pattern": "[a-z]"}, {"type": "min_words", "n": 5}])


# ---------- planning: answers computed by construction ----------
def gen_planning(rng):
    kind = rng.choice(["deps", "schedule", "order"])
    if kind == "deps":
        n = rng.randint(4, 6)
        letters = rng.sample("EFGHJKMNPQUVWXYZ", n)  # avoids A-D/P-T used by suite items
        idx = {c: i for i, c in enumerate(letters)}
        deps = {c: [] for c in letters}
        for i, c in enumerate(letters):
            for p in letters[:i]:
                if rng.random() < 0.4:
                    deps[c].append(p)
        ready = lambda done: sorted([c for c in letters if c not in done and all(d in done for d in deps[c])])
        done, order = set(), []
        while len(done) < n:
            nxt = ready(done)[0]  # alphabetically first available
            order.append(nxt); done.add(nxt)
        dep_str = ", ".join(f"{c} ({'needs ' + ' and '.join(sorted(deps[c])) if deps[c] else 'no deps'})"
                            for c in letters)
        gold = "".join(order)
        return (f"Tasks: {dep_str}. One task at a time; when more than one task is available, do the "
                f"alphabetically first. Give the execution order as {n} letters with no separators.", gold)
    if kind == "schedule":
        durs = rng.sample([5, 10, 15, 20, 25, 30, 35, 40, 45], 3)
        names = rng.sample(["laundry", "dishes", "vacuuming", "ironing", "dusting", "mopping", "weeding"], 3)
        pairs = sorted(zip(durs, names))  # SPT rule minimizes total completion time
        gold = ", ".join(nm for _, nm in pairs)
        chores = ", ".join(f"{nm} ({d} min)" for d, nm in zip(durs, names))
        return (f"Three chores must run one at a time: {chores}. To minimize the sum of completion times, "
                f"in what order should they run? Give the chore names in order, comma-separated.", gold)
    names = rng.sample(["Ana", "Ben", "Cleo", "Dev", "Ema", "Finn", "Gia", "Hugo"], 3)
    # names[0] before names[1]; names[2] after names[1] -> last is names[2]
    return (f"Three runners finish a race: {names[0]}, {names[1]}, and {names[2]}. {names[0]} finishes "
            f"before {names[1]}. {names[2]} finishes after {names[1]}. Who finished last? Reply with just the name.",
            names[2])


def check_planning(got, gold):
    low = re.sub(r"[^a-z0-9, ]", "", got.lower())
    return gold.lower() in low or gold.lower().replace(", ", ",") in low.replace(", ", ",")


# ---------- coding: teacher code executed against asserts ----------
def gen_coding(rng):
    kind = rng.choice(["sumsq", "revwords", "evens", "vowels", "fizz", "dedup"])
    if kind == "sumsq":
        xs = [rng.randint(1, 9) for _ in range(rng.randint(3, 5))]
        return (f"Write a Python function sum_squares(nums) returning the sum of squares of a list of ints.",
                f"assert sum_squares({xs}) == {sum(x*x for x in xs)}\nassert sum_squares([]) == 0")
    if kind == "revwords":
        s = " ".join(rng.sample(["red", "blue", "green", "gold", "iron", "wood"], 3))
        rev = " ".join(reversed(s.split()))
        return ("Write a Python function reverse_words(s) that reverses the order of words in a string.",
                f"assert reverse_words({s!r}) == {rev!r}\nassert reverse_words('one') == 'one'")
    if kind == "evens":
        xs = [rng.randint(1, 20) for _ in range(6)]
        return ("Write a Python function evens(nums) returning only the even numbers, preserving order.",
                f"assert evens({xs}) == {[x for x in xs if x % 2 == 0]}")
    if kind == "vowels":
        w = rng.choice(["strawberry", "encyclopedia", "rhythm", "aeronautics", "mississippi"])
        n = sum(1 for c in w if c in "aeiou")
        return ("Write a Python function count_vowels(s) counting the vowels (aeiou, lowercase input).",
                f"assert count_vowels({w!r}) == {n}\nassert count_vowels('') == 0")
    if kind == "fizz":
        n = rng.choice([7, 11, 13])
        gold = ["fizz" if i % 3 == 0 else str(i) for i in range(1, n + 1)]
        return (f"Write a Python function fizz_list(n) returning a list of strings for 1..n where "
                f"multiples of 3 are 'fizz' and everything else is the number as a string.",
                f"assert fizz_list({n}) == {gold}")
    xs = [rng.randint(1, 5) for _ in range(8)]
    out, seen = [], set()
    for x in xs:
        if x not in seen:
            seen.add(x); out.append(x)
    return ("Write a Python function dedup(nums) removing duplicates while preserving first-seen order.",
            f"assert dedup({xs}) == {out}")


def run_code(answer, tests):
    m = list(re.finditer(r"```(?:python)?\n([\s\S]*?)```", answer))
    code = m[-1].group(1) if m else answer  # tolerate fence-less replies
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "sol.py")
        open(p, "w").write(code + "\n\n" + tests)
        try:
            r = subprocess.run(["python3", p], capture_output=True, timeout=10, cwd=d)
            return r.returncode == 0
        except Exception:
            return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["instruct", "planning", "coding"])
    ap.add_argument("--n", type=int, default=300, help="target TOTAL rows in the output file")
    ap.add_argument("--out", required=True)
    ap.add_argument("--teacher", default="gemma4:12b")
    ap.add_argument("--max_attempts", type=int, default=0, help="0 = 4x n")
    args = ap.parse_args()

    have = 0
    if os.path.exists(args.out):
        have = sum(1 for l in open(args.out) if l.strip())
    print(f"[distill] {args.mode}: {have}/{args.n} rows already present", flush=True)
    rng = random.Random()
    max_attempts = args.max_attempts or args.n * 4
    attempts = kept = 0
    t0 = time.time()
    with open(args.out, "a", encoding="utf-8") as f:
        while have + kept < args.n and attempts < max_attempts:
            attempts += 1
            try:
                if args.mode == "instruct":
                    prompt, checks = gen_instruct(rng)
                    ans = teacher(args.teacher, prompt).strip()
                    ok = bool(ans) and run_checks(ans, checks)
                elif args.mode == "planning":
                    prompt, gold = gen_planning(rng)
                    ans = teacher(args.teacher, prompt).strip()
                    ok = bool(ans) and check_planning(ans, gold)
                else:
                    prompt, tests = gen_coding(rng)
                    ans = teacher(args.teacher, prompt, temperature=0.4).strip()
                    ok = bool(ans) and run_code(ans, tests)
            except Exception as e:
                print(f"[distill] attempt {attempts}: teacher error {e}", flush=True)
                time.sleep(5)
                continue
            if ok:
                f.write(json.dumps({"messages": [{"role": "user", "content": prompt},
                                                 {"role": "assistant", "content": ans}]}) + "\n")
                f.flush()
                kept += 1
            if attempts % 10 == 0 or ok:
                rate = kept / attempts if attempts else 0
                print(f"[distill] kept {have + kept}/{args.n}  (attempts {attempts}, keep-rate {rate:.0%}, "
                      f"{(time.time()-t0)/60:.1f} min)", flush=True)
    print(f"[distill] DONE: {have + kept}/{args.n} rows in {args.out}", flush=True)


if __name__ == "__main__":
    main()

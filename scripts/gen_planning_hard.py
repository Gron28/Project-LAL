"""Planning SFT data — gold answers computed by construction, reasoning authored, no teacher.

Four task kinds (dependency ordering, shortest-processing-time scheduling, relative-order
logic, earliest-finish paths). Task instances are randomized; instruction phrasings are
varied so rows don't collapse to one template. Every response is verified against the
computed gold with the battery's planning matcher (check_planning) before inclusion.
build_mix.py's leak guard additionally drops anything too close to a live suite item.

Usage: python3 scripts/gen_planning_hard.py [--n 250] [--out data/planning_hard.jsonl]
"""
import argparse, json, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from distill_gemma import check_planning

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def g_deps(rng):
    n = rng.randint(4, 6)
    letters = rng.sample("EFGHJKMNUVWXYZ", n)  # avoids A-D/P-T used by suite items
    deps = {c: [] for c in letters}
    for i, c in enumerate(letters):
        for p in letters[:i]:
            if rng.random() < 0.4:
                deps[c].append(p)
    ready = lambda done: sorted(c for c in letters if c not in done and all(d in done for d in deps[c]))
    done, order, trace = set(), [], []
    while len(done) < n:
        avail = ready(done)
        nxt = avail[0]
        trace.append(f"Done so far: {''.join(order) or 'none'}. Available: {', '.join(avail)} -> pick {nxt}.")
        order.append(nxt); done.add(nxt)
    gold = "".join(order)
    dep_str = ", ".join(f"{c} ({'needs ' + ' and '.join(sorted(deps[c])) if deps[c] else 'no deps'})" for c in letters)
    prompt = rng.choice([
        f"You have these tasks: {dep_str}. Only one runs at a time; whenever several are available, run the alphabetically first one. What is the execution order? Answer with the {n} letters, no separators.",
        f"Given tasks and their prerequisites — {dep_str} — execute them one by one, always choosing the alphabetically first available task. Write the resulting order as {n} letters together.",
        f"Task list: {dep_str}. Process sequentially; ties go to alphabetical order. Final order ({n} letters, nothing between them)?",
    ])
    # planning suite runs think:true — reasoning goes INSIDE the think block so
    # training matches the inference format (the victory1/2 gsm8k lesson)
    resp = "<think>\n" + "\n".join(trace) + f"\n</think>\n\nExecution order: {gold}"
    return prompt, resp, gold


def g_schedule(rng):
    k = rng.randint(3, 4)
    durs = rng.sample([5, 10, 15, 20, 25, 30, 35, 40, 45, 50], k)
    names = rng.sample(["baking", "sanding", "priming", "painting", "wiring", "plumbing", "framing", "tiling"], k)
    pairs = sorted(zip(durs, names))
    gold = ", ".join(nm for _, nm in pairs)
    jobs = ", ".join(f"{nm} ({d} min)" for d, nm in zip(durs, names))
    prompt = rng.choice([
        f"Jobs to run one at a time: {jobs}. Order them to minimize the sum of completion times. Give the job names in order, comma-separated.",
        f"You must sequence these jobs on a single machine: {jobs}. Which order minimizes total (summed) completion time? List the names comma-separated.",
    ])
    steps = " < ".join(f"{nm} ({d})" for d, nm in pairs)
    resp = (f"<think>\nThe sum of completion times is minimized by running shorter jobs first "
            f"(shortest processing time rule). Sorted by duration: {steps}.\n</think>\n\nOrder: {gold}")
    return prompt, resp, gold


def g_order(rng):
    names = rng.sample(["Ana", "Ben", "Cleo", "Dev", "Ema", "Finn", "Gia", "Hugo", "Iris", "Jon"], 4)
    a, b, c, d = names
    # a<b, c>b, d<a  => finish order: d, a, b, c -> c is last, d is first
    ask_last = rng.random() < 0.5
    gold = c if ask_last else d
    q = "Who finished last?" if ask_last else "Who finished first?"
    prompt = (f"Four runners finish a race: {a}, {b}, {c}, and {d}. {a} finishes before {b}. "
              f"{c} finishes after {b}. {d} finishes before {a}. {q} Reply with just the name.")
    resp = (f"<think>\nChain the clues: {d} before {a}, {a} before {b}, {b} before {c}. "
            f"So the full order is {d}, {a}, {b}, {c}.\n</think>\n\n{'Last' if ask_last else 'First'}: {gold}")
    return prompt, resp, gold


def g_path(rng):
    # two-leg routes: earliest arrival with fixed leg times and a transfer wait
    legs = rng.sample([15, 20, 25, 30, 35, 40], 2)
    wait = rng.choice([5, 10, 15])
    total = legs[0] + wait + legs[1]
    gold = str(total)
    prompt = rng.choice([
        f"A trip has two legs: the first takes {legs[0]} minutes, then you wait {wait} minutes to transfer, then the second leg takes {legs[1]} minutes. How many minutes does the whole trip take? Answer with just the number.",
        f"Leg one of a journey lasts {legs[0]} min, the transfer wait is {wait} min, and leg two lasts {legs[1]} min. Total travel time in minutes (number only)?",
    ])
    resp = f"<think>\nAdd the segments: {legs[0]} + {wait} + {legs[1]} = {total}.\n</think>\n\nTotal: {total}"
    return prompt, resp, gold


GENS = [g_deps, g_deps, g_schedule, g_order, g_path]  # deps weighted 2x — the richest kind


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=250)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "planning_hard.jsonl"))
    ap.add_argument("--seed", type=int, default=31)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    rows, seen, fails = [], set(), 0
    while len(rows) < args.n:
        prompt, resp, gold = rng.choice(GENS)(rng)
        if prompt in seen:
            continue
        if not check_planning(resp, gold):
            fails += 1
            if fails > args.n:
                raise RuntimeError(f"authored response fails its own gold check: {prompt[:80]!r}")
            continue
        seen.add(prompt)
        rows.append({"messages": [{"role": "user", "content": prompt}, {"role": "assistant", "content": resp}]})

    with open(args.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(rows), "self_check_fails": fails, "out": args.out}, indent=2))


if __name__ == "__main__":
    main()

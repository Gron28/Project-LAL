"""Synthetic fractal-reasoning data generator (MS-FRG).

Three layers, each randomized so the model learns the STRUCTURE, not a fixed string:
  L1  symbolic L-systems      -> rewriting, state-tracking (randomized alphabets)
  L2  recursive execution     -> recurrence/stack tracing on fractal growth laws
  L3  discrete grid dynamics  -> coordinate reasoning (Sierpinski carpet/triangle)

Every sample is {instruction, thought_process, output} with a CHAIN-OF-THOUGHT that
is computed (so it is always correct), and the answer is verified by construction.
Anti-memorization: symbol alphabets and all numeric params are randomized per sample.

  python scripts/gen_fractal_data.py --n 2500 --out data/fractals_synth
Writes <out>.jsonl (instruction/thought/output) and <out>.txt (concatenated, for the
current next-token trainer).
"""
import argparse, json, random


def _digits(n, base, k):
    """k digits of n in `base`, most-significant first."""
    d = []
    for _ in range(k):
        d.append(n % base); n //= base
    return d[::-1]


# ---------- Layer 1: L-systems ----------
def gen_lsystem(rng):
    a, b = rng.choice([("A", "B"), ("X", "Y"), ("F", "G"), ("a", "b"),
                       ("0", "1"), ("L", "R"), ("p", "q"), ("S", "T")])
    rules = rng.choice([
        {a: a + b, b: a}, {a: a + b + a, b: b}, {a: b, b: a + b},
        {a: a + a + b, b: a}, {a: a + b, b: b + a},
    ])
    n = rng.randint(2, 4)
    cur, rounds = a, [a]
    for _ in range(n):
        cur = "".join(rules.get(c, c) for c in cur)
        rounds.append(cur)
    rules_str = ", ".join(f"{k} -> {v}" for k, v in rules.items())
    instr = (f"L-system over alphabet {{{a}, {b}}} with rules: {rules_str}. "
             f"Start from axiom '{a}' and rewrite every symbol simultaneously for {n} rounds. "
             f"Give the final string and its length.")
    thought = "\n".join([f"Round 0: {rounds[0]}"] +
                        [f"Round {i}: rewrite each symbol -> {rounds[i]}" for i in range(1, len(rounds))])
    return instr, thought, f"{rounds[-1]} (length {len(rounds[-1])})"


# ---------- Layer 2: recursive growth laws ----------
_REC = [
    ("Koch curve", "segments", 4, "each segment is replaced by 4"),
    ("Cantor set", "intervals", 2, "each interval splits into 2"),
    ("Sierpinski triangle", "triangles", 3, "each triangle becomes 3"),
    ("Sierpinski carpet", "filled squares", 8, "each square becomes 8"),
    ("Menger sponge", "sub-cubes", 20, "each cube becomes 20"),
    ("dragon curve", "segments", 2, "each segment becomes 2"),
]
def gen_recursion(rng):
    name, unit, ratio, why = rng.choice(_REC)
    base = rng.choice([1, 1, 1, 2, 3])
    n = rng.randint(2, 6)
    vals = [base]
    for _ in range(n):
        vals.append(vals[-1] * ratio)
    instr = (f"The {name} starts with {base} {unit} at level 0, and {why} at each level. "
             f"How many {unit} are at level {n}? Show the recurrence step by step.")
    thought = "\n".join([f"level 0: {base}"] +
                        [f"level {i}: {vals[i-1]} x {ratio} = {vals[i]}" for i in range(1, n + 1)])
    return instr, thought, f"{vals[-1]} {unit}  (= {base}*{ratio}^{n})"


# ---------- Layer 3: grid dynamics ----------
def gen_grid(rng):
    if rng.random() < 0.5:
        k = rng.randint(2, 4); size = 3 ** k
        r, c = rng.randint(0, size - 1), rng.randint(0, size - 1)
        rd, cd = _digits(r, 3, k), _digits(c, 3, k)
        hole = any(rr == 1 and cc == 1 for rr, cc in zip(rd, cd))
        instr = (f"Sierpinski carpet at level {k} (a {size}x{size} grid). Is cell "
                 f"(row={r}, col={c}) FILLED or a HOLE? A cell is a HOLE if at any base-3 "
                 f"digit position both row and col have digit 1. Work it out digit by digit.")
        lines = [f"row {r} in base 3 = {''.join(map(str, rd))}",
                 f"col {c} in base 3 = {''.join(map(str, cd))}"]
        for i, (rr, cc) in enumerate(zip(rd, cd)):
            lines.append(f"  digit {i}: ({rr},{cc})" + ("  <- both 1 => HOLE" if rr == 1 and cc == 1 else ""))
        return instr, "\n".join(lines), ("HOLE" if hole else "FILLED")
    bits = rng.randint(3, 6); mx = 2 ** bits - 1
    r, c = rng.randint(0, mx), rng.randint(0, mx)
    filled = (r & c) == 0
    instr = (f"Sierpinski-triangle bit rule: cell (row={r}, col={c}) is FILLED iff "
             f"(row AND col) == 0 in binary. Is it filled? Show the binary AND.")
    thought = (f"row = {format(r, f'0{bits}b')}\ncol = {format(c, f'0{bits}b')}\n"
               f"AND = {format(r & c, f'0{bits}b')}  (= {r & c})")
    return instr, thought, ("FILLED" if filled else "EMPTY")


LAYERS = [gen_lsystem, gen_recursion, gen_grid]


def to_text(instr, thought, out):
    return f"### Task\n{instr}\n\n### Reasoning\n{thought}\n\n### Answer\n{out}\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=2500)
    ap.add_argument("--out", default="data/fractals_synth")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    samples, seen = [], set()
    tries = 0
    while len(samples) < args.n and tries < args.n * 20:
        tries += 1
        instr, thought, out = rng.choice(LAYERS)(rng)
        if instr in seen:            # de-dup identical prompts -> force variety
            continue
        seen.add(instr)
        samples.append({"instruction": instr, "thought_process": thought, "output": out})
    rng.shuffle(samples)

    with open(args.out + ".jsonl", "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    with open(args.out + ".txt", "w", encoding="utf-8") as f:
        f.write("\n\n".join(to_text(s["instruction"], s["thought_process"], s["output"]) for s in samples))

    chars = sum(len(to_text(s["instruction"], s["thought_process"], s["output"])) for s in samples)
    print(json.dumps({"samples": len(samples), "unique_prompts": len(seen),
                      "approx_chars": chars, "approx_ktokens": round(chars / 4 / 1000),
                      "jsonl": args.out + ".jsonl", "txt": args.out + ".txt"}))


if __name__ == "__main__":
    main()

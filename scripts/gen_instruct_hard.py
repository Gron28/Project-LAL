"""Hard-constraint instruct SFT data, verified by construction — no teacher needed.

Targets the exact categories stock Qwen3-4B fails on the instruct suite:
  banword   avoid a *function* word ("the", "of", ...) in fluent prose — the hand-authored
            prose banks below are engineered to avoid all hard function words at once
  wordcount exact / at-least / at-most word counts, assembled from counted sentence banks
  nopunct   zero punctuation characters
  lines     exact line counts with per-line format (plain, numbered, dashed, ALL CAPS)
  combo     2-3 constraints stacked (the strongest training signal per IFEval findings)

Every row is checked with run_checks (the battery's grader logic) before writing — a template
bug fails loudly instead of poisoning the data. Rows carry their "checks" so verify_sft.py can
re-verify the file any time. Task pools are disjoint from the bench suite items.

Usage: python3 scripts/gen_instruct_hard.py [--n 300] [--out data/claude_instruct_hard.jsonl] [--seed 11]
"""
import argparse, json, os, random, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from distill_gemma import run_checks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------- authored prose banks ----------
# Every sentence below avoids ALL of: the, a, an, and, of, is, are, was, were, with, as, very, really.
# That makes any of those words safely bannable while the prose stays fluent.
SAFE_BANS = ["the", "a", "and", "of", "is", "with"]

TOPICS = {
    "a harbor at dawn": "Golden light spills across calm water. Fishing boats rock gently beside weathered docks while gulls wheel overhead.",
    "the night sky far from any city": "Countless stars scatter across velvet darkness. Faint moonlight silvers rooftops far below.",
    "a blacksmith's forge": "Hammer blows ring against glowing metal. Sparks leap upward, briefly bright, then gone.",
    "tide pools on a rocky shore": "Small worlds shimmer between rocks at low tide. Anemones sway; crabs scuttle beneath rippling reflections.",
    "a glacier": "Ancient ice groans under its own weight. Deep blue crevasses split slowly, century by century.",
    "a bamboo grove": "Tall green stalks sway in soft wind. Filtered sunlight paints shifting patterns on damp earth.",
    "city rooftops at dusk": "Chimneys crowd toward gray horizons. Laundry lines flutter between old brick buildings.",
    "a hillside vineyard": "Neat rows climb sunlit hillsides. Ripening grapes hang heavy beneath broad leaves.",
    "an owl hunting at night": "Silent wings sweep over moonlit fields. Sharp eyes catch every small movement below.",
    "a lantern festival": "Paper lanterns drift skyward, glowing softly. Crowds murmur, faces upturned, wonder everywhere.",
    "a subway platform late at night": "Fluorescent light hums over tiled walls. Commuters wait quietly, eyes fixed on dark tunnels.",
    "a wheat field in summer": "Amber stalks bend in warm wind. Far off, lone trees mark distant fences.",
    "a coral reef": "Bright fish dart through branching coral. Sunbeams ripple down through clear turquoise water.",
    "an old clock tower": "Iron hands crawl across its pale face. Each hour, deep chimes roll over sleepy streets.",
    "the desert at night": "Cold settles quickly once sun sets. Sand dunes glow faintly under sharp starlight.",
    "a rainforest canopy": "Layered leaves drip long after rain stops. Hidden birds call from impossible heights.",
    "a potter shaping clay": "Wet clay rises between steady palms. Slow circles shape smooth curves out from formless mud.",
    "a tense chess match": "Two minds circle each other silently. Carved pieces advance, retreat, then strike.",
    "a beehive in spring": "Workers stream through one narrow gate. Inside, golden cells fill drop by drop.",
    "a frozen lake": "Black ice stretches taut between snowy shores. Trapped bubbles hang like pale pearls beneath its surface.",
    "a street violinist": "Worn strings sing beneath quick fingers. Coins clink into velvet-lined wood while strangers pause mid-stride.",
    "a mountain pass": "Thin air bites at every breath. Stone paths wind upward between patient peaks.",
    "a monsoon downpour": "Heavy rain drums on tin roofs. Streets turn briefly into shallow silver rivers.",
    "an observatory at midnight": "One great dome opens toward infinite dark. Inside, quiet instruments track slow celestial fires.",
}
OPENERS = ["Dawn breaks slowly here.", "Look closely.", "Stillness reigns.", "Picture this scene.",
           "Few places feel so alive.", "Quiet rules this place."]
GENERIC = ["Soft light settles over everything.", "Time seems slower here.", "Details reward patient eyes.",
           "Small sounds carry far.", "Air feels clean, almost sweet.", "Shadows stretch, then fade.",
           "Colors deepen near dusk.", "Each moment feels quietly earned.", "Memory clings to such places.",
           "Wind carries faint, familiar scents.", "Light shifts; textures sharpen.",
           "Everything here rewards slow attention."]
CLOSERS_BY_LEN = {
    2: "Peace lingers.", 3: "Peace settles here.", 4: "Quiet beauty lingers on.",
    5: "Calm rests over it all.", 6: "Nothing seems hurried in such places.",
    7: "Every detail seems placed by patient hands.",
    8: "Every visitor leaves carrying some small quiet memory.",
    9: "Moments like these settle deep, then stay for years.",
    10: "Anyone standing here feels time widen, breathe, then settle down.",
    11: "Even restless minds grow calm when faced by so much stillness.",
    12: "Few sights in this wide world offer such deep, simple, honest peace.",
}

LISTS = {
    "planets of the solar system": ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"],
    "days of the week": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    "colors of the rainbow": ["Red", "Orange", "Yellow", "Green", "Blue", "Indigo", "Violet"],
    "chess pieces": ["King", "Queen", "Rook", "Bishop", "Knight", "Pawn"],
    "noble gases": ["Helium", "Neon", "Argon", "Krypton", "Xenon", "Radon"],
    "oceans": ["Pacific", "Atlantic", "Indian", "Arctic", "Southern"],
    "string instruments": ["Violin", "Viola", "Cello", "Harp", "Guitar", "Mandolin"],
}

QA = [("How many strings does a standard violin have?", "4|four", "A standard violin has four strings."),
      ("What color results from mixing blue and yellow?", "green", "Mixing blue and yellow makes green."),
      ("How many legs does a spider have?", "8|eight", "A spider has eight legs."),
      ("What is the capital of Japan?", "Tokyo", "The capital of Japan is Tokyo."),
      ("How many hours are in three days?", "72", "There are 72 hours in three days."),
      ("What planet is closest to the sun?", "Mercury", "Mercury is the planet closest to the sun."),
      ("How many sides does an octagon have?", "8|eight", "An octagon has eight sides."),
      ("What is the chemical symbol for iron?", "Fe", "The chemical symbol for iron is Fe."),
      ("How many weeks are in a year?", "52", "A year has 52 weeks."),
      ("What is the largest planet in the solar system?", "Jupiter", "Jupiter is the largest planet in the solar system."),
      ("How many keys does a standard piano have?", "88", "A standard piano has 88 keys."),
      ("What gas makes up most of Earth's atmosphere?", "nitrogen", "Nitrogen makes up most of Earth's atmosphere."),
      ("What is the freezing point of water in Fahrenheit?", "32", "Water freezes at 32 degrees Fahrenheit."),
      ("How many players are on a soccer team on the field?", "11|eleven", "A soccer team fields eleven players."),
      ("What is the tallest mountain on Earth?", "Everest", "Mount Everest is the tallest mountain on Earth."),
      ("How many colors are in a rainbow?", "7|seven", "A rainbow has seven colors."),
      ("What is the smallest prime number?", "2|two", "The smallest prime number is 2."),
      ("What metal is liquid at room temperature?", "mercury", "Mercury is the metal that is liquid at room temperature.")]
START_WORDS = ["Indeed", "Certainly", "Undoubtedly", "Interestingly", "Clearly", "Observe", "Granted"]


def prose(rng, topic, sentences=2):
    parts = TOPICS[topic].split(". ")
    parts = [p if p.endswith(".") else p + "." for p in parts]
    out = list(parts[:sentences]) if sentences <= len(parts) else list(parts)
    while len(out) < sentences:
        out.insert(0, rng.choice(OPENERS))
    return " ".join(out)


# ---------- generators: each returns (prompt, response, checks) ----------
def g_banword(rng):
    topic = rng.choice(list(TOPICS)); ban = rng.choice(SAFE_BANS)
    style = rng.choice([f"Describe {topic} in two or three sentences, but never use the word \"{ban}\".",
                        f"Write a short description (2-3 sentences) of {topic}. The word \"{ban}\" must not appear anywhere in your response.",
                        f"Without using the word \"{ban}\" even once, describe {topic} in a couple of sentences."])
    resp = prose(rng, topic, rng.randint(2, 3))
    return style, resp, [{"type": "not_regex", "pattern": r"\b" + ban + r"\b", "flags": "i"},
                         {"type": "min_words", "n": 12}]


def _exact_words(rng, topic, n):
    """Assemble prose with exactly n words: sentences from counted banks + one exact-length closer."""
    base = [s if s.endswith(".") else s + "." for s in TOPICS[topic].split(". ")]
    lo, hi = min(CLOSERS_BY_LEN), max(CLOSERS_BY_LEN)
    for _ in range(500):
        pool = GENERIC + OPENERS
        rng.shuffle(pool)
        first = rng.choice(base)  # response must actually be about the topic
        out, left = [first], n - len(first.split())
        for s in pool:
            if left <= hi:
                break
            w = len(s.split())
            if left - w >= lo:
                out.append(s); left -= w
        if left in CLOSERS_BY_LEN:
            return " ".join(out + [CLOSERS_BY_LEN[left]])
    raise RuntimeError(f"could not assemble {n} words for {topic}")


def g_wordcount(rng):
    topic = rng.choice(list(TOPICS))
    mode = rng.choice(["exact", "exact", "min", "max"])
    if mode == "exact":
        n = rng.randint(18, 55)
        prompt = rng.choice([f"Write exactly {n} words about {topic}. Not {n-1}, not {n+1} — exactly {n}.",
                             f"Describe {topic} using exactly {n} words."])
        resp = _exact_words(rng, topic, n)
        checks = [{"type": "min_words", "n": n}, {"type": "max_words", "n": n}]
    elif mode == "min":
        n = rng.randint(25, 45)
        prompt = f"Write at least {n} words describing {topic}."
        resp = _exact_words(rng, topic, n + rng.randint(2, 10))
        checks = [{"type": "min_words", "n": n}]
    else:
        sent = TOPICS[topic].split(". ")[rng.randint(0, 1)].rstrip(".") + "."
        n = len(sent.split()) + rng.randint(1, 4)
        prompt = f"In at most {n} words, describe {topic}."
        resp = sent
        checks = [{"type": "max_words", "n": n}]
    return prompt, resp, checks


def g_nopunct(rng):
    topic = rng.choice(list(TOPICS))
    prompt = rng.choice([f"In one single line with no punctuation characters at all, describe {topic}.",
                         f"Describe {topic} in a single line. Do not use any punctuation marks whatsoever — no periods, commas, or anything else.",
                         f"Reply with a single line that contains zero punctuation marks, describing {topic}.",
                         f"Give me one line about {topic} — and it must be completely free of punctuation characters.",
                         f"Describe {topic} on one line only, without a single punctuation symbol anywhere.",
                         f"One line, no punctuation of any kind: describe {topic}."])
    raw = prose(rng, topic, 2)
    resp = " ".join(re.sub(r"[^\w\s]", " ", raw).split())
    return prompt, resp, [{"type": "not_regex", "pattern": r"[^\w\s]"}, {"type": "min_words", "n": 8},
                          {"type": "line_count", "n": 1, "op": "eq"}]


def g_lines(rng):
    name = rng.choice(list(LISTS)); items = LISTS[name]
    n = rng.randint(3, min(6, len(items)))
    chosen = rng.sample(items, n) if rng.random() < 0.5 else items[:n]
    fmt = rng.choice(["plain", "numbered", "dashed", "caps"])
    if fmt == "plain":
        prompt = f"List exactly {n} {name}, one per line, each capitalized, with no numbering and no extra text."
        resp = "\n".join(chosen)
        checks = [{"type": "line_count", "n": n, "op": "eq"}, {"type": "not_regex", "pattern": r"\n[a-z]"},
                  {"type": "not_regex", "pattern": r"[0-9]"}]
    elif fmt == "numbered":
        prompt = f"List exactly {n} {name} as a numbered list: each line must start with its number followed by a period and a space."
        resp = "\n".join(f"{i+1}. {c}" for i, c in enumerate(chosen))
        checks = [{"type": "line_count", "n": n, "op": "eq"}, {"type": "starts_with", "s": "1. "},
                  {"type": "regex", "pattern": rf"\n{n}\. "}]
    elif fmt == "dashed":
        prompt = f"List exactly {n} {name}, one per line, each line starting with \"- \" and nothing else before it."
        resp = "\n".join(f"- {c}" for c in chosen)
        checks = [{"type": "line_count", "n": n, "op": "eq"}, {"type": "starts_with", "s": "- "},
                  {"type": "not_regex", "pattern": r"\n(?!- )"}]
    else:
        prompt = f"List exactly {n} {name} in ALL CAPITAL LETTERS, one per line, nothing else."
        resp = "\n".join(c.upper() for c in chosen)
        checks = [{"type": "line_count", "n": n, "op": "eq"}, {"type": "not_regex", "pattern": "[a-z]"}]
    return prompt, resp, checks


def g_combo(rng):
    kind = rng.choice(["start_qa", "start_maxwords", "ban_nopunct", "caps_exact_lines", "start_exact_words"])
    if kind == "start_qa":
        w = rng.choice(START_WORDS); q, gold, ans = rng.choice(QA)
        prompt = f"Start your response with the exact word '{w}'. Then answer: {q}"
        resp = f"{w} — {ans[0].lower() + ans[1:]}"
        return prompt, resp, [{"type": "starts_with", "s": w}, {"type": "regex", "pattern": gold, "flags": "i"}]
    if kind == "start_maxwords":
        w = rng.choice(START_WORDS); q, gold, ans = rng.choice(QA); n = rng.randint(9, 14)
        prompt = f"Answer in fewer than {n} words, and your first word must be '{w}': {q}"
        resp = f"{w}, {ans[0].lower() + ans[1:]}"
        if len(resp.split()) > n:
            resp = f"{w}, {gold.split('|')[0]}."
        return prompt, resp, [{"type": "starts_with", "s": w}, {"type": "max_words", "n": n},
                              {"type": "regex", "pattern": gold, "flags": "i"}]
    if kind == "ban_nopunct":
        topic = rng.choice(list(TOPICS)); ban = rng.choice(SAFE_BANS)
        prompt = (f"Describe {topic} in one single line using no punctuation characters at all, "
                  f"and never use the word \"{ban}\".")
        raw = prose(rng, topic, 2)
        resp = " ".join(re.sub(r"[^\w\s]", " ", raw).split())
        return prompt, resp, [{"type": "not_regex", "pattern": r"[^\w\s]"},
                              {"type": "not_regex", "pattern": r"\b" + ban + r"\b", "flags": "i"},
                              {"type": "line_count", "n": 1, "op": "eq"}, {"type": "min_words", "n": 8}]
    if kind == "caps_exact_lines":
        name = rng.choice(list(LISTS)); items = LISTS[name]; n = rng.randint(3, min(5, len(items)))
        prompt = f"Reply with exactly {n} lines, each line one of the {name} in ALL CAPITAL LETTERS, no punctuation, nothing else."
        resp = "\n".join(c.upper() for c in rng.sample(items, n))
        return prompt, resp, [{"type": "line_count", "n": n, "op": "eq"}, {"type": "not_regex", "pattern": "[a-z]"},
                              {"type": "not_regex", "pattern": r"[^\w\s]"}]
    topic = rng.choice(list(TOPICS)); w = rng.choice(START_WORDS); n = rng.randint(20, 40)
    prompt = f"Write exactly {n} words about {topic}, starting with the word '{w}'."
    body = _exact_words(rng, topic, n - 1)
    resp = f"{w}: {body}"
    return prompt, resp, [{"type": "starts_with", "s": w}, {"type": "min_words", "n": n}, {"type": "max_words", "n": n}]


GENS = {"banword": g_banword, "wordcount": g_wordcount, "nopunct": g_nopunct, "lines": g_lines, "combo": g_combo}
MIX = {"banword": 0.22, "wordcount": 0.18, "nopunct": 0.24, "lines": 0.16, "combo": 0.20}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "claude_instruct_hard.jsonl"))
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    rows, seen, cats = [], set(), {}
    fails = 0
    while len(rows) < args.n:
        cat = rng.choices(list(MIX), weights=list(MIX.values()))[0]
        prompt, resp, checks = GENS[cat](rng)
        if not run_checks(resp, checks):
            fails += 1
            if fails > args.n * 2:
                raise RuntimeError(f"too many self-check failures — template bug in {cat}: {prompt!r} -> {resp!r}")
            continue
        key = (prompt, resp)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"messages": [{"role": "user", "content": prompt}, {"role": "assistant", "content": resp}],
                     "checks": checks, "cat": cat})
        cats[cat] = cats.get(cat, 0) + 1

    with open(args.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"kept": len(rows), "cats": cats, "self_check_fails": fails, "out": args.out}, indent=2))


if __name__ == "__main__":
    main()

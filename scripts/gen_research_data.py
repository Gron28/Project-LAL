"""Synthetic research tool-use traces, verified by construction.

Trains a model to be GOOD at the agentic system's research tools
(web_search + web_fetch from web/src/lib/agent-tools.ts): search with a
sharp query, pick the right result to open, fetch it, then answer with
inline citations and a trailing Sources list — never asserting a
specific fact it didn't actually fetch.

Everything (entities, search results, fetched articles) is synthetic and
generated from a fictional word-pool, so facts are correct by construction
and there is zero chance of leaking into any future eval that touches real
entities. Five trace shapes:

  search_fetch    single query -> pick best result -> fetch -> cite
  multihop        two independent lookups synthesized into one answer
  conflict        two sources disagree -> answer reports both, weighs
                  the more authoritative domain, doesn't silently pick one
  snippet_insufficient  the search snippet alone lacks the specific figure
                  asked for -> model must fetch before answering
  no_tool         plain general-knowledge/arithmetic -> answer directly,
                  no tool call (teaches restraint, not reflexive searching)

  python scripts/gen_research_data.py --n 300 --out data/research_sft.jsonl
"""
import argparse, json, random

TOOLS = [
    {"type": "function", "function": {
        "name": "web_search", "description": "Search the web (DuckDuckGo). Returns the top results with titles, snippets and URLs.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "web_fetch", "description": "Fetch a URL and return its readable text content (HTML stripped, capped).",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
]

ADJ = ["Cobalt", "Meridian", "Solvent", "Fenwick", "Amber", "Cinder", "Halden", "Marrow",
       "Vesper", "Thistle", "Grayling", "Nether", "Coral", "Basalt", "Rowan", "Quill",
       "Kestrel", "Osprey", "Copperfield", "Windmere"]
NOUN = ["Systems", "Dynamics", "Labs", "Collective", "Institute", "Works", "Foundry",
        "Networks", "Robotics", "Biotech", "Observatory", "Guild", "Ventures", "Analytics",
        "Materials", "Expedition", "Festival", "Archive"]
KIND = ["startup", "research lab", "expedition", "festival", "satellite mission", "nonprofit"]
FIRST = ["Elena", "Marcus", "Priya", "Tobias", "Naomi", "Idris", "Freya", "Kenji",
         "Sofia", "Callum", "Amara", "Dmitri", "Lucia", "Hassan", "Ingrid", "Teo"]
LAST = ["Vance", "Okafor", "Lindqvist", "Rourke", "Castellan", "Mbeki", "Solberg",
        "Fairweather", "Duarte", "Kowalski", "Renner", "Achebe"]
PLACE = ["Port Halden", "Camden Ridge", "Lake Ordway", "Fenwick Bay", "Thornmoor",
         "Ashcombe", "Bellhaven", "Greywick", "Sutter's Crossing", "Ravenna Fields"]
METRIC_LABEL = ["annual funding", "headcount", "founding budget", "member count", "launch mass"]
BLURB_TEMPLATES = [
    "builds autonomous inspection drones for offshore wind farms",
    "develops a low-power sensor chip for soil moisture monitoring",
    "catalogs deep-sea vent ecosystems using remote submersibles",
    "runs a annual gathering for independent typeface designers",
    "studies migratory patterns of high-altitude bats",
    "maintains an open archive of pre-1950 shipping manifests",
    "designs modular greenhouse kits for arctic research stations",
    "tracks small-satellite debris using a ground telescope array",
]

AUTH_DOMAINS = ["gazette.example", "wiki-archive.example", "civic-record.example", "ledger.example"]
CASUAL_DOMAINS = ["randomblog.example", "forumtalk.example", "quicknotes.example", "aggregator.example"]


def make_entity(rng, idx):
    name = f"{rng.choice(ADJ)} {rng.choice(NOUN)}"
    kind = rng.choice(KIND)
    year = rng.randint(1978, 2023)
    founder = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    place = rng.choice(PLACE)
    mlabel = rng.choice(METRIC_LABEL)
    mval = rng.choice([f"${rng.randint(2, 900)}M", f"{rng.randint(4, 800)}",
                        f"{rng.randint(1, 40)}kg", f"{rng.randint(3, 250)}"])
    blurb = rng.choice(BLURB_TEMPLATES)
    slug = name.lower().replace(" ", "-") + f"-{idx}"
    return {"name": name, "kind": kind, "year": year, "founder": founder,
            "place": place, "mlabel": mlabel, "mval": mval, "blurb": blurb, "slug": slug}


def search_results(entity, rng, n=3, conflict_year=None):
    auth = rng.choice(AUTH_DOMAINS)
    casual = rng.choice(CASUAL_DOMAINS)
    items = [
        {"title": f"{entity['name']} — overview", "url": f"https://{auth}/{entity['slug']}",
         "snippet": f"{entity['name']} is a {entity['kind']} based in {entity['place']}. {entity['blurb'][:1].upper()}{entity['blurb'][1:]}."},
        {"title": f"{entity['name']} | community notes", "url": f"https://{casual}/{entity['slug']}-notes",
         "snippet": f"Some notes and rumors about {entity['name']}, a {entity['kind']}."},
        {"title": f"Directory listing: {entity['name']}", "url": f"https://directory.example/{entity['slug']}",
         "snippet": f"{entity['name']}, category: {entity['kind']}."},
    ]
    return items[:n], auth, casual


def fetch_article(entity, domain, year_override=None):
    year = year_override if year_override is not None else entity["year"]
    body = (f"{entity['name']}\n\n"
            f"{entity['name']} is a {entity['kind']} founded in {year} by {entity['founder']}, "
            f"headquartered in {entity['place']}. It {entity['blurb']}. "
            f"Its {entity['mlabel']} is reported at {entity['mval']}.")
    return body


def call(idx, name, args):
    return {"id": f"call_{idx}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def tool_result(idx, name, content):
    return {"role": "tool", "tool_call_id": f"call_{idx}", "name": name, "content": content}


def fmt_results(items):
    return "\n".join(f"- {it['title']} — {it['url']}\n  {it['snippet']}" for it in items)


def gen_search_fetch(rng, i):
    e = make_entity(rng, i)
    field = rng.choice(["year", "founder", "place", "metric", "blurb"])
    questions = {
        "year": f"What year was {e['name']} founded?",
        "founder": f"Who founded {e['name']}?",
        "place": f"Where is {e['name']} based?",
        "metric": f"What is {e['name']}'s {e['mlabel']}?",
        "blurb": f"What does {e['name']} actually do?",
    }
    answers = {
        "year": f"{e['name']} was founded in {e['year']}",
        "founder": f"{e['name']} was founded by {e['founder']}",
        "place": f"{e['name']} is based in {e['place']}",
        "metric": f"{e['name']}'s {e['mlabel']} is {e['mval']}",
        "blurb": f"{e['name']} {e['blurb']}",
    }
    items, auth, _ = search_results(e, rng)
    query = f"{e['name']} {e['kind']} {'founding year' if field == 'year' else field}"
    article = fetch_article(e, auth)
    url = items[0]["url"]
    return [
        {"role": "user", "content": questions[field]},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "web_search", {"query": query})]},
        tool_result(i, "web_search", fmt_results(items)),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 1, "web_fetch", {"url": url})]},
        tool_result(i + 1, "web_fetch", article),
        {"role": "assistant", "content": f"{answers[field]} (source: {items[0]['title']}, {url})."},
    ]


def gen_multihop(rng, i):
    e1, e2 = make_entity(rng, i), make_entity(rng, i + 100)
    items1, auth1, _ = search_results(e1, rng)
    items2, auth2, _ = search_results(e2, rng)
    a1 = fetch_article(e1, auth1)
    a2 = fetch_article(e2, auth2)
    earlier = e1 if e1["year"] < e2["year"] else e2
    later = e2 if earlier is e1 else e1
    return [
        {"role": "user", "content": f"Which was founded first: {e1['name']} or {e2['name']}?"},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "web_search", {"query": f"{e1['name']} founding year"})]},
        tool_result(i, "web_search", fmt_results(items1)),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 1, "web_fetch", {"url": items1[0]["url"]})]},
        tool_result(i + 1, "web_fetch", a1),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 2, "web_search", {"query": f"{e2['name']} founding year"})]},
        tool_result(i + 2, "web_search", fmt_results(items2)),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 3, "web_fetch", {"url": items2[0]["url"]})]},
        tool_result(i + 3, "web_fetch", a2),
        {"role": "assistant", "content": (
            f"{earlier['name']} came first, founded in {earlier['year']} "
            f"(source: {items1[0]['url'] if earlier is e1 else items2[0]['url']}), "
            f"versus {later['name']} in {later['year']} "
            f"(source: {items1[0]['url'] if later is e1 else items2[0]['url']}).")},
    ]


def gen_conflict(rng, i):
    e = make_entity(rng, i)
    items, auth, casual = search_results(e, rng)
    off_year = e["year"] + rng.choice([-3, -2, 2, 4])
    a_auth = fetch_article(e, auth)
    a_casual = fetch_article(e, casual, year_override=off_year)
    casual_item = {"title": f"{e['name']} | community notes", "url": f"https://{casual}/{e['slug']}-notes"}
    return [
        {"role": "user", "content": f"What year was {e['name']} founded?"},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "web_search", {"query": f"{e['name']} founding year"})]},
        tool_result(i, "web_search", fmt_results(items)),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 1, "web_fetch", {"url": items[0]["url"]})]},
        tool_result(i + 1, "web_fetch", a_auth),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 2, "web_fetch", {"url": casual_item["url"]})]},
        tool_result(i + 2, "web_fetch", a_casual),
        {"role": "assistant", "content": (
            f"Sources disagree: {items[0]['url']} (a directory-style record) says {e['year']}, while "
            f"{casual_item['url']} (an informal community post) says {off_year}. The former reads as the "
            f"more authoritative record, so {e['year']} is more likely correct, but I can't fully resolve "
            f"the discrepancy from these two sources alone.")},
    ]


def gen_snippet_insufficient(rng, i):
    e = make_entity(rng, i)
    items, auth, _ = search_results(e, rng)
    article = fetch_article(e, auth)
    return [
        {"role": "user", "content": f"What is {e['name']}'s {e['mlabel']}, exactly?"},
        {"role": "assistant", "content": None, "tool_calls": [call(i, "web_search", {"query": f"{e['name']} {e['mlabel']}"})]},
        tool_result(i, "web_search", fmt_results(items)),
        {"role": "assistant", "content": None, "tool_calls": [call(i + 1, "web_fetch", {"url": items[0]["url"]})]},
        tool_result(i + 1, "web_fetch", article),
        {"role": "assistant", "content": f"{e['name']}'s {e['mlabel']} is {e['mval']} (source: {items[0]['url']})."},
    ]


def gen_no_tool(rng, i):
    kind = rng.choice(["arith", "general"])
    if kind == "arith":
        a, b = rng.randint(15, 400), rng.randint(15, 400)
        op = rng.choice(["+", "-", "%"])
        if op == "+":
            q, ans = f"What is {a} + {b}?", str(a + b)
        elif op == "-":
            q, ans = f"What is {a} - {b}?", str(a - b)
        else:
            pct = rng.choice([5, 10, 15, 20, 25])
            q, ans = f"What is {pct}% of {a}?", str(round(a * pct / 100, 2))
        return [{"role": "user", "content": q}, {"role": "assistant", "content": ans}]
    facts = [
        ("How many days are in a leap year?", "366."),
        ("What is the boiling point of water at sea level in Celsius?", "100°C."),
        ("How many continents are there?", "Seven."),
        ("What is the chemical symbol for gold?", "Au."),
        ("How many minutes are in a day?", "1440."),
    ]
    q, a = rng.choice(facts)
    return [{"role": "user", "content": q},
            {"role": "assistant", "content": f"{a} That's general knowledge, no lookup needed."}]


GENS = [(gen_search_fetch, 40), (gen_multihop, 15), (gen_conflict, 12),
        (gen_snippet_insufficient, 13), (gen_no_tool, 20)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    pool, weights = zip(*GENS)
    with open(args.out, "w", encoding="utf-8") as f:
        for k in range(args.n):
            gen = rng.choices(pool, weights=weights, k=1)[0]
            msgs = gen(rng, k * 10)
            f.write(json.dumps({"messages": msgs, "tools": TOOLS, "source": "research_sft"}) + "\n")
    print(f"wrote {args.n} traces to {args.out}")


if __name__ == "__main__":
    main()

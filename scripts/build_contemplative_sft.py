#!/usr/bin/env python3
"""Build a small, source-attributed contemplative SFT dataset.

This is intentionally an *instruction* dataset, not a scraped book corpus.  It
uses public-domain source material only for direct textual study and writes
original answers that distinguish history, interpretation, and personal practice.
Modern translations/commentaries are not copied into the training set.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "contemplative_foundations_sft.jsonl"
MANIFEST = ROOT / "data" / "contemplative_foundations_sft.jsonl.manifest.json"

SOURCES = {
    "tao_legge_1891": {
        "title": "Tao Teh King, James Legge translation (1891)",
        "url": "https://www.gutenberg.org/ebooks/216",
        "status": "public domain in the United States",
        "use": "direct textual study and original paraphrase",
    },
    "anderson_1723": {
        "title": "The Constitutions of the Free-Masons, James Anderson (1723)",
        "url": "https://digitalcommons.unl.edu/zeaamericanstudies/27/",
        "status": "public domain historical work",
        "use": "historical study and original paraphrase",
    },
    "liber_al": {
        "title": "Liber AL vel Legis / The Book of the Law (1904)",
        "url": "https://bubastis.oto-usa.org/about/liber-al-the-book-of-the-law",
        "status": "bibliographic/reference only; no full text ingested",
        "use": "original high-level study prompts; no reproduction of the text",
    },
    "spare_pleasure": {
        "title": "The Book of Pleasure, Austin Osman Spare (1913)",
        "url": "https://dp.la/item/ba1e9ea14b9104f3ff9788c6a1e3267d",
        "status": "historical precursor reference; no full text ingested",
        "use": "original high-level study prompts; no reproduction of the text",
    },
    "vijnanabhairava": {
        "title": "Vijnanabhairava Tantra, Sanskrit reference text",
        "url": "https://gretil.sub.uni-goettingen.de/gretil/1_sanskr/6_sastra/3_phil/saiva/vijnbhau.htm",
        "status": "reference-only source; translations not ingested",
        "use": "original high-level study prompts; no translation copied",
    },
}

THEMES = [
    ("tao_legge_1891", "Taoist", "non-forcing, simplicity, and attention to conditions", "Treat wu-wei as skillful non-forcing, not passivity. Name the concrete constraint, take the smallest reversible action, and leave room for feedback."),
    ("anderson_1723", "Masonic historical", "ethical association, mutual obligation, and constitutional procedure", "Frame this as historical civic ethics, not a claim about modern Masonic practice. Emphasize consent, fairness, lawful process, and the difference between fraternity and secrecy."),
    ("liber_al", "Thelemic", "individual vocation and responsibility", "Treat 'will' as a disciplined question of vocation and consequence, never as permission to override consent, law, or care for others."),
    ("spare_pleasure", "chaos-magick precursor", "symbolic experimentation and reflective practice", "Present symbols as voluntary reflective tools, not mechanisms for controlling other people or guaranteeing external outcomes. Keep a record, test assumptions, and stop if the practice destabilizes you."),
    ("vijnanabhairava", "non-dual Śaiva/tantric", "attention, embodiment, and non-dual inquiry", "Offer only low-risk attention practices: notice breath, sound, or sensory transition without forcing an altered state. Do not claim initiation, medical benefit, or substitute for a qualified teacher."),
]

SITUATIONS = [
    ("a person faces a difficult decision", "separate what is known, what is wanted, and what can be tested this week"),
    ("a small group is stuck in conflict", "reduce escalation, state boundaries, and agree on one observable next step"),
    ("someone wants a daily reflective practice", "keep it brief, voluntary, and grounded in ordinary life"),
    ("a reader encounters a powerful spiritual claim", "distinguish textual meaning, personal interpretation, and factual evidence"),
    ("a community designs a shared ritual or meeting", "make consent, accessibility, and opt-out paths explicit"),
    ("someone wants to use symbols for motivation", "treat the symbol as a reminder attached to a measurable action"),
    ("a student compares traditions", "name genuine differences before drawing a limited comparison"),
    ("a practitioner feels overwhelmed by intense material", "de-intensify, return to sleep/food/social support, and seek appropriate professional help when needed"),
]


def answer(tradition: str, focus: str, guidance: str, situation: str, outcome: str, number: int) -> str:
    return (
        f"Approach this through a {tradition} lens, while keeping the lens in proportion. "
        f"The relevant theme is {focus}. For {situation}, begin by {outcome}.\n\n"
        f"{guidance}\n\n"
        "Do not turn a spiritual vocabulary into an authority claim. State what comes from the text or tradition, "
        "what is your own interpretation, and what remains uncertain. Preserve consent, ordinary responsibilities, "
        "and the other person's agency."
    )


def rows() -> list[dict]:
    out: list[dict] = []
    for theme_index, (source_id, tradition, focus, guidance) in enumerate(THEMES):
        for situation_index, (situation, outcome) in enumerate(SITUATIONS):
            prompt = (
                f"Give a careful, practical reading using a {tradition} source tradition: {situation}. "
                "Do not pretend this is universal fact or professional advice."
            )
            out.append({
                "messages": [{"role": "user", "content": prompt}, {"role": "assistant", "content": answer(tradition, focus, guidance, situation, outcome, theme_index * 8 + situation_index)}],
                "source": "contemplative-foundations-v1",
                "source_ids": [source_id],
                "license_note": SOURCES[source_id]["status"],
                "task_family": "comparative_contemplative_reasoning",
            })
    return out


def main() -> None:
    examples = rows()
    payload = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in examples)
    OUT.write_text(payload, encoding="utf-8")
    MANIFEST.write_text(json.dumps({
        "name": OUT.name,
        "version": 1,
        "examples": len(examples),
        "sha256": hashlib.sha256(payload.encode()).hexdigest(),
        "purpose": "Tiny, source-attributed contemplative LoRA smoke dataset.",
        "direct_text_policy": "No modern copyrighted commentary or translation is copied. The dataset consists of original instruction/response examples.",
        "sources": SOURCES,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(examples)} examples to {OUT}")


if __name__ == "__main__":
    main()

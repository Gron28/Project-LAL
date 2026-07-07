// Extract-and-dedupe fact loop (Mem0-mechanism-inspired — see
// docs/agent-memory-research.md §2 — not its Postgres/Neo4j infra, just the
// extract → add/update/skip decision loop). Targets the orchestrator's
// `_orchestrator/findings.md` specifically: of its three files, only findings.md is at
// real risk of unbounded growth across a long overnight run (repeatedly appended to by
// many spawn_agent calls) — plan.md is a single mutable document, log.md's growth is
// intentional and bounded by stage count.
import fs from "node:fs";
import path from "node:path";

function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function extractFacts(baseUrl: string, model: string, text: string): Promise<string[]> {
  try {
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, stream: false, temperature: 0, max_tokens: 400,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{
          role: "user",
          content: "Extract the atomic, standalone facts worth remembering from this report — things a coordinator would want to know later, not narration of what was done. Reply with ONLY a JSON array of short strings, no other text. If there's nothing worth remembering, reply with [].\n\nReport:\n" + text,
        }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    const raw = (j.choices?.[0]?.message?.content ?? "").trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter((s) => s.trim());
    } catch { /* fall through to naive split */ }
    // same defensive fallback pattern digestReport uses for its own failure mode
    return raw.split("\n").map((l: string) => l.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const DUPLICATE_THRESHOLD = 0.8; // near-identical wording -> skip
const RELATED_THRESHOLD = 0.4;   // meaningfully overlapping -> treat as an update, not a new entry

export function dedupeAndMerge(existing: string[], incoming: string[]): { facts: string[]; added: number; updated: number; skipped: number } {
  const facts = [...existing];
  let added = 0, updated = 0, skipped = 0;
  for (const fact of incoming) {
    const ft = tokenSet(fact);
    let bestIdx = -1, bestScore = 0;
    for (let i = 0; i < facts.length; i++) {
      const score = jaccard(ft, tokenSet(facts[i]));
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestScore >= DUPLICATE_THRESHOLD) { skipped++; continue; }
    if (bestScore >= RELATED_THRESHOLD) { facts[bestIdx] = fact; updated++; continue; }
    facts.push(fact); added++;
  }
  return { facts, added, updated, skipped };
}

function findingsPath(root: string): string {
  const dir = path.join(root, "_orchestrator");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "findings.md");
}

function parseBullets(content: string): string[] {
  return content.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

export async function recordFinding(root: string, baseUrl: string, model: string, rawText: string): Promise<string> {
  const facts = await extractFacts(baseUrl, model, rawText);
  if (!facts.length) return "no new findings extracted";
  const p = findingsPath(root);
  let existing: string[] = [];
  try { existing = parseBullets(fs.readFileSync(p, "utf8")); } catch { /* first finding */ }
  const merged = dedupeAndMerge(existing, facts);
  fs.writeFileSync(p, merged.facts.map((f) => "- " + f).join("\n") + "\n");
  return `findings: +${merged.added} added, ${merged.updated} updated, ${merged.skipped} duplicates skipped`;
}

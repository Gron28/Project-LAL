// Persistent memory for one conversational research session. It is what lets the
// researcher skip pages and facts it has already seen, and connect a new finding
// to earlier ones through shared entities (the "mind map"). Pure data + pure
// functions; persistence is a JSON file per session under the LAL data dir.
import fs from "node:fs";
import path from "node:path";

export type Fact = { id: string; text: string; entities: string[]; sourceUrl: string; sourceTitle: string; wave: number };
export type Source = { url: string; title: string; status: "read" | "duplicate" | "failed"; wave: number };
export type ImageRef = { src: string; title: string; pageUrl: string; query: string };
export type Turn = { role: "user" | "assistant"; text: string; ts: number };

export type ResearchMemory = {
  id: string;
  question: string;
  objective: string;
  language: "en" | "es";
  createdAt: number;
  updatedAt: number;
  wave: number;
  facts: Fact[];
  sources: Source[];
  /** Normalized URLs already fetched (or rejected) — never fetched twice. */
  seen: string[];
  queries: string[];
  images: ImageRef[];
  threads: string[];
  transcript: Turn[];
};

export function newMemory(id: string, question: string, language: "en" | "es"): ResearchMemory {
  const now = Date.now();
  return { id, question, objective: question, language, createdAt: now, updatedAt: now, wave: 0, facts: [], sources: [], seen: [], queries: [], images: [], threads: [], transcript: [] };
}

/** Canonical form of a URL for "have we read this": no fragment, no tracking
 * params, no trailing slash, no www, lower-case host. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src|mc_)/i.test(k)) u.searchParams.delete(k);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    const p = u.pathname.replace(/\/+$/, "");
    const q = u.searchParams.toString();
    return `${host}${p}${q ? "?" + q : ""}`;
  } catch { return raw.trim().toLowerCase(); }
}

const STOP = new Set("the a an and or of to in on for with by is are was were be been as at from that this it its their his her they them which who whom also into than then such these those can could may might not no".split(" "));
function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
/** Jaccard overlap of content words: ~1 = same claim reworded, 0 = unrelated. */
export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0; for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export const DUPLICATE_THRESHOLD = 0.55;

/** Adds facts that are genuinely new; returns the ones kept. A fact that restates
 * an existing one (from any source) is dropped, so narration never repeats. */
export function addFacts(mem: ResearchMemory, incoming: Omit<Fact, "id">[]): Fact[] {
  const kept: Fact[] = [];
  for (const f of incoming) {
    const text = f.text.trim();
    if (text.length < 12) continue;
    if ([...mem.facts, ...kept].some((g) => similarity(g.text, text) >= DUPLICATE_THRESHOLD)) continue;
    const fact: Fact = { ...f, text, entities: [...new Set(f.entities.map((e) => e.trim()).filter(Boolean))].slice(0, 8), id: `f${mem.facts.length + kept.length + 1}` };
    kept.push(fact);
  }
  mem.facts.push(...kept);
  mem.updatedAt = Date.now();
  return kept;
}

export function markSeen(mem: ResearchMemory, url: string) {
  const n = normalizeUrl(url);
  if (!mem.seen.includes(n)) mem.seen.push(n);
}
export function hasSeen(mem: ResearchMemory, url: string) { return mem.seen.includes(normalizeUrl(url)); }

/** Entity → how many facts mention it, most connected first: the mind map spine. */
export function entityIndex(mem: ResearchMemory): { name: string; count: number; factIds: string[] }[] {
  const map = new Map<string, { name: string; count: number; factIds: string[] }>();
  for (const f of mem.facts) for (const e of f.entities) {
    const key = e.toLowerCase();
    const row = map.get(key) ?? { name: e, count: 0, factIds: [] };
    row.count++; row.factIds.push(f.id); map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** Earlier facts that share an entity with the new ones — what a new finding
 * "connects to". Used to make the narrator correlate instead of list. */
export function relatedFacts(mem: ResearchMemory, fresh: Fact[], limit = 6): Fact[] {
  const ents = new Set(fresh.flatMap((f) => f.entities.map((e) => e.toLowerCase())));
  const freshIds = new Set(fresh.map((f) => f.id));
  return mem.facts
    .filter((f) => !freshIds.has(f.id) && f.entities.some((e) => ents.has(e.toLowerCase())))
    .slice(-limit);
}

/** A compact text view of what is known, for prompts: top entities with their
 * facts, bounded so it fits a small local model's context. */
export function mindMapDigest(mem: ResearchMemory, maxChars = 5000): string {
  const byId = new Map(mem.facts.map((f) => [f.id, f]));
  const lines: string[] = [];
  const used = new Set<string>();
  for (const ent of entityIndex(mem).slice(0, 14)) {
    const facts = ent.factIds.filter((id) => !used.has(id)).slice(0, 3);
    if (!facts.length) continue;
    lines.push(`• ${ent.name} (${ent.count})`);
    for (const id of facts) { used.add(id); lines.push(`   - ${byId.get(id)!.text}`); }
  }
  for (const f of mem.facts) if (!used.has(f.id)) lines.push(`- ${f.text}`);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n…";
  return out || "(nothing learned yet)";
}

// ---- persistence -----------------------------------------------------------

function dir() {
  const d = path.join(process.env.LAL_DATA_DIR || path.join(process.cwd(), ".data"), "research-sessions");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const safeId = (id: string) => /^[a-z0-9-]{6,64}$/i.test(id) ? id : null;

export function loadMemory(id: string): ResearchMemory | null {
  const s = safeId(id); if (!s) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir(), `${s}.json`), "utf8")) as ResearchMemory; } catch { return null; }
}
export function saveMemory(mem: ResearchMemory) {
  const s = safeId(mem.id); if (!s) throw new Error("invalid research session id");
  const file = path.join(dir(), `${s}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mem));
  fs.renameSync(tmp, file);
}

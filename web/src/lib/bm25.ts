// From-scratch BM25 (k1=1.5, b=0.75) — deliberately not a dependency. This keeps the
// "works on any machine" constraint airtight (no npm package to break across a Node
// version bump) and gives full control over tokenizing markdown/code content, where
// splitting `foo.bar()`-shaped identifiers apart would hurt retrieval quality. Used by
// the memory_search tool (Phase 5's session/daily/digest corpus) — a from-scratch
// implementation over a handful of markdown files, not a search-engine replacement.
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "to", "of", "in",
  "on", "at", "for", "and", "or", "but", "with", "as", "by", "it", "this", "that", "these",
  "those", "i", "you", "he", "she", "we", "they", "what", "which", "who", "will", "would",
  "there", "their", "its", "from", "into", "than", "then",
]);

// Split on whitespace, strip leading/trailing punctuation per token (keeps internal
// `.`/`_`/`/` so `agent-tools.ts` or `foo.bar()` survive as one token), lowercase, drop
// stopwords and empty tokens.
export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/^[^a-z0-9._/-]+|[^a-z0-9._/-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export type Bm25Doc = { id: string; text: string };
export type Bm25Hit = { id: string; score: number };

export function bm25Search(docs: Bm25Doc[], query: string, topK = 5): Bm25Hit[] {
  const k1 = 1.5, b = 0.75;
  const N = docs.length;
  if (N === 0) return [];

  const tokensByDoc = docs.map((d) => tokenize(d.text));
  const lenByDoc = tokensByDoc.map((toks) => toks.length);
  const avgdl = lenByDoc.reduce((a, x) => a + x, 0) / N || 1;

  const tfByDoc: Record<string, number>[] = tokensByDoc.map((toks) => {
    const tf: Record<string, number> = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    return tf;
  });

  const df: Record<string, number> = {};
  for (const tf of tfByDoc) for (const t of Object.keys(tf)) df[t] = (df[t] || 0) + 1;

  const queryTerms = Array.from(new Set(tokenize(query)));
  const idf: Record<string, number> = {};
  for (const t of queryTerms) {
    const n = df[t] || 0;
    idf[t] = Math.log((N - n + 0.5) / (n + 0.5) + 1); // +1 keeps IDF non-negative (BM25+)
  }

  const hits: Bm25Hit[] = docs.map((d, i) => {
    let score = 0;
    const dl = lenByDoc[i] || 1;
    for (const t of queryTerms) {
      const f = tfByDoc[i][t] || 0;
      if (f === 0) continue;
      score += idf[t] * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl)));
    }
    return { id: d.id, score };
  });

  return hits.filter((h) => h.score > 0).sort((a, b2) => b2.score - a.score).slice(0, topK);
}

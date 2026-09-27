// Web + image search for research mode. Primary backend is the local SearXNG
// container (deploy/searxng/, free and not rate-limited); if it is down, web
// search falls back to LAL's DuckDuckGo scraper so research still works.
import { webSearch } from "@/lib/lab";

export type SearchHit = { title: string; url: string; snippet: string; engine: string };
export type ImageHit = { src: string; title: string; pageUrl: string };

const BASE = () => (process.env.LAL_SEARXNG_URL || "http://127.0.0.1:8888").replace(/\/+$/, "");

async function searx(q: string, category: "general" | "images", language: string, signal?: AbortSignal) {
  const url = `${BASE()}/search?q=${encodeURIComponent(q)}&format=json&categories=${category}&language=${language}`;
  const r = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
  return (await r.json()) as { results?: Record<string, unknown>[] };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function searchWeb(q: string, language: "en" | "es", signal?: AbortSignal, limit = 6): Promise<SearchHit[]> {
  try {
    const j = await searx(q, "general", language, signal);
    return (j.results ?? [])
      .map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content).slice(0, 400), engine: str(r.engine) }))
      .filter((h) => /^https?:\/\//.test(h.url))
      .slice(0, limit);
  } catch (error) {
    if (signal?.aborted) throw error;
    // Fallback: parse the DuckDuckGo scraper's "[n] title\nsnippet\nurl" blocks.
    const text = await webSearch(q);
    return text.split(/\n\n/).map((block) => {
      const lines = block.split("\n");
      return { title: lines[0]?.replace(/^\[\d+\]\s*/, "") ?? "", snippet: lines[1] ?? "", url: lines[2] ?? "", engine: "duckduckgo" };
    }).filter((h) => /^https?:\/\//.test(h.url)).slice(0, limit);
  }
}

export async function searchImages(q: string, language: "en" | "es", signal?: AbortSignal, limit = 8): Promise<ImageHit[]> {
  try {
    const j = await searx(q, "images", language, signal);
    return (j.results ?? [])
      .map((r) => ({ src: str(r.img_src) || str(r.thumbnail_src), title: str(r.title).slice(0, 160), pageUrl: str(r.url) }))
      .filter((h) => /^https?:\/\//.test(h.src))
      .slice(0, limit);
  } catch (error) {
    if (signal?.aborted) throw error;
    return []; // images are an enhancement; no fallback engine
  }
}

export async function searxngAvailable(): Promise<boolean> {
  try { const r = await fetch(`${BASE()}/healthz`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}

// Fetches a page through the SSRF-safe research fetcher and reduces it to the
// readable text a model should see: title, lead image, and main-body paragraphs
// with navigation, scripts, footers and boilerplate stripped.
import { fetchResearchAsset, pagePreview } from "@/lib/research-media";
import { decodeEntities, extractText } from "./extract";

export type Page = { url: string; title: string; image: string; sourceName: string; text: string };

const MAX_BYTES = 600_000;

export async function readPage(url: string, signal?: AbortSignal): Promise<Page | null> {
  try {
    const r = await fetchResearchAsset(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) LAL-research", accept: "text/html,application/xhtml+xml" } });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "";
    if (!/html|xml|text\/plain/i.test(type)) return null;
    const reader = r.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0;
    while (size < MAX_BYTES) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
    try { await reader.cancel(); } catch {}
    const html = Buffer.concat(chunks).toString("utf8");
    const meta = pagePreview(html, url);
    const text = /text\/plain/i.test(type) ? html.slice(0, 6000) : extractText(html);
    if (text.length < 200) return null; // paywall, script-only page, or error page
    return { url, title: decodeEntities(meta.title) || url, image: meta.image, sourceName: decodeEntities(meta.sourceName), text };
  } catch {
    return null;
  }
}

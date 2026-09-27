// Pure HTML → readable text reduction (no I/O), shared by the page reader and tests.

export function decodeEntities(s: string) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Readable text from HTML: keep paragraph-like blocks, drop chrome. */
export function extractText(html: string, maxChars = 6000): string {
  const body = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const blocks = [...body.matchAll(/<(p|li|h[1-4]|blockquote|dd|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 40 && !/cookie|subscribe|sign up|newsletter|all rights reserved|javascript/i.test(t));
  const seen = new Set<string>();
  const out: string[] = [];
  let len = 0;
  for (const b of blocks) {
    if (seen.has(b)) continue;
    seen.add(b); out.push(b); len += b.length + 1;
    if (len > maxChars) break;
  }
  return out.join("\n").slice(0, maxChars);
}


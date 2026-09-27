import dns from "node:dns/promises";
import net from "node:net";

function privateAddress(address: string): boolean {
  if (address === "::1" || address === "::" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  if (!net.isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export async function safeResearchUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("unsupported URL");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new Error("local URLs are not allowed");
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error("private network URLs are not allowed");
  return url;
}

export async function fetchResearchAsset(raw: string, init: RequestInit = {}, redirects = 2): Promise<Response> {
  let url = await safeResearchUrl(raw);
  for (let attempt = 0; attempt <= redirects; attempt++) {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "user-agent": "Local-AI-Lab/1.0 research reader", ...(init.headers || {}) },
      signal: init.signal || AbortSignal.timeout(12_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || attempt === redirects) throw new Error("too many redirects");
    url = await safeResearchUrl(new URL(location, url).toString());
  }
  throw new Error("request failed");
}

export function pagePreview(html: string, pageUrl: string): { title: string; image: string; sourceName: string } {
  const attr = (property: string) => {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1]
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"))?.[1]
      || "";
  };
  const title = attr("og:title") || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "";
  const image = attr("og:image") || attr("twitter:image") || "";
  const sourceName = attr("og:site_name") || new URL(pageUrl).hostname.replace(/^www\./, "");
  return {
    title: title.replace(/\s+/g, " ").trim().slice(0, 180),
    image: image ? new URL(image, pageUrl).toString() : "",
    sourceName: sourceName.replace(/\s+/g, " ").trim().slice(0, 80),
  };
}

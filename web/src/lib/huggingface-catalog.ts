import { type AcquisitionFetch, type CatalogModel, type ModelFile } from "./model-acquisition.ts";

export type HuggingFaceSearchResult = { id: string; revision: string; licenseName?: string };

const repo = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha = /^[a-f0-9]{7,64}$/i;
const hash = /^[a-f0-9]{64}$/i;
function repoPath(id: string): string { if (!repo.test(id)) throw new Error("Hugging Face repository must be namespace/name"); return id.split("/").map(encodeURIComponent).join("/"); }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function licenseName(value: unknown): string | undefined { const card = asObject(value); const raw = card.license; return typeof raw === "string" && raw.trim() ? raw.trim() : undefined; }
async function json(fetchImpl: AcquisitionFetch, url: string): Promise<unknown> { const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`Hugging Face catalog request failed: HTTP ${response.status}`); return response.json(); }

/** Explicit catalog search. It never downloads a file and callers still need
 * to inspect a pinned commit before a plan can be built. */
export async function searchHuggingFaceModels(query: string, fetchImpl: AcquisitionFetch = fetch): Promise<HuggingFaceSearchResult[]> {
  const trimmed = query.trim(); if (trimmed.length < 2 || trimmed.length > 120) throw new Error("search query must be 2–120 characters");
  const searchTerms = /\bgguf\b/i.test(trimmed) ? trimmed : `${trimmed} gguf`;
  const raw = await json(fetchImpl, `https://huggingface.co/api/models?search=${encodeURIComponent(searchTerms)}&limit=20&full=true`);
  if (!Array.isArray(raw)) throw new Error("Hugging Face catalog returned an invalid response");
  return raw.flatMap((entry) => { const value = asObject(entry), id = typeof value.id === "string" ? value.id : "", revision = typeof value.sha === "string" ? value.sha : ""; return repo.test(id) && sha.test(revision) ? [{ id, revision, ...(licenseName(value.cardData) ? { licenseName: licenseName(value.cardData) } : {}) }] : []; });
}

/** Resolve only LFS files with an upstream SHA-256. Ordinary git blobs are not
 * model candidates because they cannot satisfy the byte-verification contract. */
export async function inspectHuggingFaceModel(id: string, revision: string, fetchImpl: AcquisitionFetch = fetch): Promise<CatalogModel> {
  const encoded = repoPath(id); if (!sha.test(revision)) throw new Error("Hugging Face revision must be a commit hash");
  const [metadata, tree] = await Promise.all([
    json(fetchImpl, `https://huggingface.co/api/models/${encoded}`),
    json(fetchImpl, `https://huggingface.co/api/models/${encoded}/tree/${encodeURIComponent(revision)}?recursive=true&expand=true`),
  ]);
  if (!Array.isArray(tree)) throw new Error("Hugging Face file listing is invalid");
  const files: ModelFile[] = tree.flatMap((entry) => {
    const value = asObject(entry), lfs = asObject(value.lfs), filePath = typeof value.path === "string" ? value.path : "", oid = typeof lfs.oid === "string" ? lfs.oid : "", size = typeof lfs.size === "number" ? lfs.size : typeof value.size === "number" ? value.size : undefined;
    if (!filePath.toLowerCase().endsWith(".gguf") || !hash.test(oid) || !Number.isSafeInteger(size) || size === undefined || size <= 0) return [] as ModelFile[];
    return [{ path: filePath, sizeBytes: size, sha256: oid.toLowerCase() }];
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!files.length) throw new Error("no hash-addressed GGUF files were found at this commit");
  const meta = asObject(metadata), card = asObject(meta.cardData), declaredLicense = licenseName(card) ?? "upstream license not declared";
  return { provider: "huggingface", id, revision, displayName: id, license: { name: declaredLicense, ...(declaredLicense !== "upstream license not declared" ? { spdx: declaredLicense } : {}), requiresAcceptance: true, redistributable: false }, files, capabilities: [] };
}

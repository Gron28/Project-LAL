import path from "node:path";
import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { runBench, SUITES, getSuite, listBench, saveBench, deleteBench, pinBench, HIVE_ADAPTER_DIR, type BenchOpts } from "@/lib/lab";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

// GET               -> every saved result WITHOUT per-question evidence (~60 KB)
// GET ?suite=gsm8k  -> that suite's results in full, evidence included
//
// The unfiltered full set is 1.27 MB — every suite × every model × every graded
// response — and the page only ever renders the evidence of the suite currently
// selected. The difficulty matrix and the per-question panel do need it, so it is
// fetched per suite on demand rather than dropped.
export async function GET(req: NextRequest) {
  const suite = new URL(req.url).searchParams.get("suite");
  const all = listBench();
  if (suite) return NextResponse.json({ results: all.filter((r) => r.suite === suite) });
  const slim = all.map((r) => {
    const { results, ...rest } = r as Record<string, unknown> & { results?: unknown[] };
    return { ...rest, evidenceCount: Array.isArray(results) ? results.length : 0 };
  });
  return NextResponse.json({ results: slim });
}

export async function POST(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const b = await req.json().catch(() => ({}));
  if (!b.model) return NextResponse.json({ error: "no model" }, { status: 400 });
  const suiteName = (b.suite as string) || "fractal";
  const stored = getSuite(suiteName);                       // editable file-backed suite
  const items = stored?.items?.length ? stored.items : (SUITES[suiteName] || SUITES.fractal);
  const opts: BenchOpts = { grade: stored?.grade, maxTokens: stored?.maxTokens, think: stored?.think };
  // Bench a base model + a specialist LoRA adapter together (e.g. is the trained
  // adapter actually better than the raw base at this suite?) — resolves under
  // HIVE_ADAPTER_DIR only, matching the same sanitization the train/serve paths use.
  let modelLabel = String(b.model);
  if (typeof b.loraAdapter === "string" && b.loraAdapter) {
    const safe = path.basename(b.loraAdapter).replace(/[^a-zA-Z0-9_.-]/g, "");
    const adapterPath = path.join(HIVE_ADAPTER_DIR, safe);
    if (!fs.existsSync(adapterPath)) return NextResponse.json({ error: "lora adapter not found: " + safe }, { status: 400 });
    opts.lora = { key: safe, path: adapterPath };
    modelLabel = `${b.model}+${safe.replace(/\.gguf$/, "")}`; // distinct save key — never overwrite the pure base model's saved bench
  }
  try {
    const result = { ...(await runBench(b.model, items, opts)), suite: suiteName, model: modelLabel };
    saveBench(suiteName, result);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const u = new URL(req.url);
  deleteBench(u.searchParams.get("suite") || "", u.searchParams.get("model") || "");
  return NextResponse.json({ ok: true });
}

// PATCH {suite, model, pinned} -> pin/unpin a saved result as a champion baseline
export async function PATCH(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const b = await req.json().catch(() => ({}));
  if (!b.suite || !b.model) return NextResponse.json({ error: "suite and model required" }, { status: 400 });
  const r = pinBench(b.suite, b.model, !!b.pinned);
  return r.ok ? NextResponse.json(r) : NextResponse.json(r, { status: 404 });
}

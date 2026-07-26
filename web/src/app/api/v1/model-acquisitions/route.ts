import { NextRequest, NextResponse } from "next/server";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { getJobRepository } from "@/lib/jobs";
import { currentModelDownloadHostEstimate, cancelModelDownload, recoverModelDownloadJobs, requestModelDownload } from "@/lib/model-downloads";
import { resolveModelAcquisition, type OfflineCatalog } from "@/lib/model-acquisition";

export const dynamic = "force-dynamic";

/** Explicit, pinned Hugging Face GGUF transfer jobs. A query never downloads;
 * the browser must submit exact revision, filename, byte count and SHA-256. */
export function GET() {
  recoverModelDownloadJobs();
  return NextResponse.json({ jobs: getJobRepository().list(200).filter((job) => job.kind === "model.download"), host: currentModelDownloadHostEstimate() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const authorization = authorizeBrowserMutation(request);
  if (!authorization.ok) return NextResponse.json({ error: authorization.code }, { status: authorization.status });
  const body = await request.json().catch(() => ({}));
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  const revision = typeof body.revision === "string" ? body.revision.trim() : "";
  const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
  const sha256 = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : Number(body.sizeBytes);
  const modelName = typeof body.modelName === "string" ? body.modelName.trim() : "";
  const licenseName = typeof body.licenseName === "string" && body.licenseName.trim() ? body.licenseName.trim() : "upstream license (review required)";
  if (!/^[a-f0-9]{7,64}$/i.test(revision)) return NextResponse.json({ error: "revision must be a pinned Hugging Face commit hash" }, { status: 400 });
  const catalog: OfflineCatalog = { protocolVersion: 1, generatedAt: new Date().toISOString(), providers: { huggingface: "available", ollama: "unconfigured" }, models: [{ provider: "huggingface", id: modelId, revision, displayName: modelName || modelId, license: { name: licenseName, ...(typeof body.licenseSpdx === "string" && body.licenseSpdx.trim() ? { spdx: body.licenseSpdx.trim() } : {}), requiresAcceptance: true, redistributable: body.redistributable === true }, files: [{ path: filePath, sizeBytes, sha256 }], capabilities: [] }] };
  try {
    const resolved = resolveModelAcquisition(catalog, { provider: "huggingface", id: modelId, revision, preferredFile: filePath, acceptedLicense: body.acceptedLicense === true }, currentModelDownloadHostEstimate());
    if (resolved.state !== "ready") return NextResponse.json(resolved, { status: 400 });
    const job = requestModelDownload({ plan: resolved.plan, modelName, requestedBy: "local-browser" });
    return NextResponse.json({ job, plan: resolved.plan }, { status: 202 });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
}

export async function DELETE(request: NextRequest) {
  const authorization = authorizeBrowserMutation(request);
  if (!authorization.ok) return NextResponse.json({ error: authorization.code }, { status: authorization.status });
  const id = new URL(request.url).searchParams.get("id") || "";
  const job = cancelModelDownload(id);
  return job ? NextResponse.json({ job }) : NextResponse.json({ error: "model download job not found" }, { status: 404 });
}

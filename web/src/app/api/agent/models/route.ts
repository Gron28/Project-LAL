import { NextRequest, NextResponse } from "next/server";
import { allModels, readSettings, writeSettings, servingModel, deleteModel, renameModel } from "@/lib/lab";

export const dynamic = "force-dynamic";

// Model list + LLM settings for the agent/chat UIs. Six client files fetch this
// (code page, chat, llm-settings, benchmark, library, dashboard widgets); it had
// no server route, so every model dropdown came up empty and every settings write
// silently 404'd. GET returns the model list + current selection + saved options
// + system prompt + serveIdleMinutes; PUT patches any subset.
export function GET() {
  const s = readSettings();
  const infos = allModels();
  return NextResponse.json({
    models: infos.map((m) => m.name),
    modelInfos: infos,              // name/source/gb — richer than names alone for the new UI
    detail: infos,                  // legacy alias used by older client code
    current: s.model,
    serving: servingModel(),
    options: s.options,
    system: s.system,
    web: s.web,
    groundDocs: s.groundDocs,
    serveIdleMinutes: s.serveIdleMinutes,
  });
}

export async function PUT(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const patch: Parameters<typeof writeSettings>[0] = {};
  if (typeof b.model === "string") patch.model = b.model;
  if (typeof b.system === "string") patch.system = b.system;
  if (typeof b.web === "boolean") patch.web = b.web;
  if (typeof b.groundDocs === "boolean") patch.groundDocs = b.groundDocs;
  if (typeof b.serveIdleMinutes === "number") patch.serveIdleMinutes = b.serveIdleMinutes;
  if (b.options && typeof b.options === "object") patch.options = b.options;
  const s = writeSettings(patch);
  return NextResponse.json({ ok: true, model: s.model });
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const from = typeof b.from === "string" ? b.from.trim() : "";
  const to = typeof b.to === "string" ? b.to.trim() : "";
  if (!from || !to) return NextResponse.json({ ok: false, error: "from and to required" }, { status: 400 });

  const existing = allModels().find((m) => m.name === from && m.source === "local");
  if (!existing) return NextResponse.json({ ok: false, error: "local model not found" }, { status: 404 });

  const result = renameModel(from, to);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

export async function DELETE(req: NextRequest) {
  const u = new URL(req.url);
  const name = (u.searchParams.get("name") || "").trim();
  const sourceRaw = u.searchParams.get("source") || "local";
  const source = sourceRaw === "ollama" ? "ollama" : "local";
  if (!name) return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });

  const existing = allModels().find((m) => m.name === name && m.source === source);
  if (!existing) return NextResponse.json({ ok: false, error: "model not found" }, { status: 404 });

  deleteModel(name, source);
  return NextResponse.json({ ok: true });
}

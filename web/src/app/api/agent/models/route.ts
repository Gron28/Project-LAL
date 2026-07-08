import { NextRequest, NextResponse } from "next/server";
import { allModels, readSettings, writeSettings, servingModel } from "@/lib/lab";

export const dynamic = "force-dynamic";

// Model list + LLM settings for the agent/chat UIs. Six client files fetch this
// (code page, chat, llm-settings, benchmark, library, dashboard widgets); it had
// no server route, so every model dropdown came up empty and every settings write
// silently 404'd. GET returns the model list + current selection + saved options
// + system prompt + serveIdleMinutes; PUT patches any subset.
export function GET() {
  const s = readSettings();
  return NextResponse.json({
    models: allModels().map((m) => m.name),
    modelInfos: allModels(),        // name/source/gb — richer than names alone for the new UI
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

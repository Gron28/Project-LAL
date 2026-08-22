import { NextRequest, NextResponse } from "next/server";
import { readSettings, writeSettings } from "@/lib/lab";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";

export const dynamic = "force-dynamic";

const PROTECTED_KEYS = new Set(["modelProviders"]);

function sanitize(settings: Record<string, unknown>) {
  const next = Object.fromEntries(Object.entries(settings).filter(([key]) => !PROTECTED_KEYS.has(key)));
  if (next.model && typeof next.model === "object" && !Array.isArray(next.model)) {
    const model = { ...(next.model as Record<string, unknown>) };
    delete model.name;
    next.model = model;
  }
  return next;
}

function publicCliSettings() {
  return sanitize(readSettings().cliSettings);
}

export async function GET() {
  return NextResponse.json({ cliSettings: publicCliSettings() });
}

export async function PUT(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) {
    return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  }
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body.cliSettings !== "object" || Array.isArray(body.cliSettings)) {
    return NextResponse.json({ error: "cliSettings must be a JSON object" }, { status: 400 });
  }
  const next = sanitize(body.cliSettings as Record<string, unknown>);
  writeSettings({ cliSettings: next });
  return NextResponse.json({ ok: true, cliSettings: next });
}

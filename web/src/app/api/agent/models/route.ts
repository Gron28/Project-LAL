import { NextRequest, NextResponse } from "next/server";
import { activatePublicModel, allModels, publicModels, readSettings, writeSettings, servingModel, deleteModel, renameModel, contextProfileForModel, probePublicModelContext, modelScanRoots, localRuntimeAvailability, allModelRuntimeSettings, modelSettingsRevision, writeModelRuntimeSettings } from "@/lib/lab";
import { stopAllRuns } from "@/lib/runs";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { readOrRefreshLiveCapabilityRegistry, refreshLiveCapabilityRegistry } from "@/lib/capability-registry-live";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

function deploymentBuildId(): string {
  try { return fs.readFileSync(path.join(process.cwd(), process.env.NEXT_DIST_DIR || ".next", "BUILD_ID"), "utf8").trim(); }
  catch { return process.env.LAL_BUILD_ID || process.env.npm_package_version || "development"; }
}

// Model list + LLM settings for the agent/chat UIs. Six client files fetch this
// (code page, chat, llm-settings, benchmark, library, dashboard widgets); it had
// no server route, so every model dropdown came up empty and every settings write
// silently 404'd. GET returns the model list + current selection + saved options
// + system prompt + serveIdleMinutes; PUT patches any subset.
async function inventoryResponse(req?: NextRequest) {
  const s = readSettings();
  const infos = publicModels();
  // Existing dropdowns still select by legacy display name, while callers can
  // now resolve that alias to immutable bytes/runtime identities.
  const catalog = await readOrRefreshLiveCapabilityRegistry();
  const roots = modelScanRoots();
  const unreadable = roots.filter((root) => !root.readable);
  const state = infos.length ? "ready" : unreadable.length ? "failed" : "empty";
  const runtimeAvailability = localRuntimeAvailability();
  return NextResponse.json({
    inventory: {
      state,
      models: infos,
      current: s.model,
      scannedAt: new Date().toISOString(),
      roots,
      diagnostics: unreadable.map((root) => `${root.kind} model root is unreadable: ${root.path}${root.detail ? ` (${root.detail})` : ""}`),
      backend: {
        serving: servingModel(),
        llamaServer: runtimeAvailability.llamaServer,
        ollamaStore: runtimeAvailability.ollamaStore,
      },
      server: {
        origin: req ? new URL(req.url).origin : "local",
        buildId: deploymentBuildId(),
      },
    },
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
    modelSettings: allModelRuntimeSettings(),
    settingsRevision: modelSettingsRevision(),
    catalog,
    contextProfiles: Object.fromEntries(infos.map((model) => [model.name, contextProfileForModel(model.name)])),
  });
}

export async function GET(req: NextRequest) {
  try { return await inventoryResponse(req); }
  catch (error) {
    return NextResponse.json({
      inventory: {
        state: "failed",
        models: [],
        current: "",
        scannedAt: new Date().toISOString(),
        roots: modelScanRoots(),
        diagnostics: [error instanceof Error ? error.message : String(error)],
        backend: { serving: null, llamaServer: "unknown", ollamaStore: "unknown" },
        server: { origin: new URL(req.url).origin, buildId: deploymentBuildId() },
      },
      error: "model inventory failed",
    }, { status: 503 });
  }
}

export async function PUT(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) {
    return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  }
  const b = await req.json().catch(() => ({}));
  const patch: Parameters<typeof writeSettings>[0] = {};
  const previous = readSettings();
  let runtime: Awaited<ReturnType<typeof activatePublicModel>> | undefined;
  if (typeof b.defaultModel === "string") {
    if (!publicModels().some((model) => model.name === b.defaultModel)) {
      return NextResponse.json({ ok: false, error: `unknown model: ${b.defaultModel}` }, { status: 400 });
    }
    patch.model = b.defaultModel;
  }
  let updatedModelSettings;
  if (b.modelSettings && typeof b.modelSettings === "object") {
    const modelSettings = b.modelSettings as { model?: unknown; values?: unknown };
    if (typeof modelSettings.model !== "string" || !modelSettings.values || typeof modelSettings.values !== "object") {
      return NextResponse.json({ ok: false, error: "modelSettings requires model and values" }, { status: 400 });
    }
    try {
      updatedModelSettings = writeModelRuntimeSettings(modelSettings.model, modelSettings.values as Record<string, unknown>);
    } catch (error) {
      return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }
  if (typeof b.model === "string") {
    if (!publicModels().some((model) => model.name === b.model)) {
      return NextResponse.json({ ok: false, error: `unknown or internal model: ${b.model}` }, { status: 400 });
    }
    patch.model = b.model;
    // `model` means an explicit Load now action. Saved default and resident
    // runtime are separate truths: setting a default first must not make this
    // request a no-op. Re-running activation is also how a changed context
    // profile reloads the same resident model when necessary.
    if (b.model !== previous.model || servingModel() !== b.model) {
      // A model switch is a single-GPU ownership handoff, not a settings-only
      // rename. Abort server and managed-client runs first, unload the old
      // backend, then persist the choice only after the requested runtime has
      // been observed resident with its context/offload state.
      stopAllRuns();
    }
    try {
      runtime = await activatePublicModel(b.model);
    } catch (error) {
      return NextResponse.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, { status: 503 });
    }
  }
  if (typeof b.system === "string") patch.system = b.system;
  if (typeof b.web === "boolean") patch.web = b.web;
  if (typeof b.groundDocs === "boolean") patch.groundDocs = b.groundDocs;
  if (typeof b.serveIdleMinutes === "number") patch.serveIdleMinutes = b.serveIdleMinutes;
  if (b.options && typeof b.options === "object") patch.options = b.options;
  const s = writeSettings(patch);
  return NextResponse.json({ ok: true, model: s.model, modelSettings: updatedModelSettings, settingsRevision: modelSettingsRevision(), ...(runtime ? { runtime } : {}) });
}

export async function POST(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const body = await req.json().catch(() => ({}));
  if (body.operation === "rescan") {
    await refreshLiveCapabilityRegistry();
    return inventoryResponse(req);
  }
  const model = typeof body.model === "string" ? body.model : "";
  if (!publicModels().some((item) => item.name === model)) return NextResponse.json({ ok: false, error: "model not found" }, { status: 404 });
  try { return NextResponse.json({ ok: true, contextProfile: await probePublicModelContext(model) }); }
  catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error), contextProfile: contextProfileForModel(model) }, { status: 503 }); }
}

export async function PATCH(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) {
    return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  }
  const b = await req.json().catch(() => ({}));
  const from = typeof b.from === "string" ? b.from.trim() : "";
  const to = typeof b.to === "string" ? b.to.trim() : "";
  if (!from || !to) return NextResponse.json({ ok: false, error: "from and to required" }, { status: 400 });

  const existing = allModels().find((m) => m.name === from && m.source === "local");
  if (!existing) return NextResponse.json({ ok: false, error: "local model not found" }, { status: 404 });

  const result = renameModel(from, to);
  if (result.ok) await refreshLiveCapabilityRegistry();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

export async function DELETE(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) {
    return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  }
  const u = new URL(req.url);
  const name = (u.searchParams.get("name") || "").trim();
  const sourceRaw = u.searchParams.get("source") || "local";
  const source = sourceRaw === "ollama" ? "ollama" : "local";
  if (!name) return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });

  const existing = allModels().find((m) => m.name === name && m.source === source);
  if (!existing) return NextResponse.json({ ok: false, error: "model not found" }, { status: 404 });

  deleteModel(name, source);
  await refreshLiveCapabilityRegistry();
  return NextResponse.json({ ok: true });
}

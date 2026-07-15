import { allModels, ensureServing, SERVE_PORT, touchServing } from "@/lib/lab";
import { appendHostObservationForClientDevice } from "@/lib/runs";
import { acquireCliGpuLease, cliAuthenticatedDeviceId, cliAuthorized, recordCliAccess, streamWithRelease, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "chat completion", authorized);
  if (!authorized) return unauthorizedResponse();
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });

  const model = typeof payload.model === "string" ? payload.model : "";
  const deviceId = cliAuthenticatedDeviceId(request);
  const available = allModels().some((item) => item.source === "local" && item.name === model);
  if (!available) {
    return Response.json(
      { error: { message: `Unknown or unsupported CLI model: ${model}`, type: "invalid_request_error" } },
      { status: 404 },
    );
  }

  appendHostObservationForClientDevice(deviceId, { k: "model_loading", v: { model, ctx: 32768 } });
  const release = await acquireCliGpuLease();
  try {
    await ensureServing(model, 32768);
    touchServing();
    appendHostObservationForClientDevice(deviceId, { k: "model_ready", v: { model, ctx: 32768, backend: "llama.cpp" } });
    const upstream = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: request.headers.get("accept") ?? "application/json" },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
    if (!upstream.body) {
      release();
      return new Response(null, { status: upstream.status, headers: upstream.headers });
    }
    const headers = new Headers(upstream.headers);
    headers.set("cache-control", "no-store");
    return new Response(streamWithRelease(upstream.body, release), { status: upstream.status, headers });
  } catch (error) {
    release();
    const message = error instanceof Error ? error.message : String(error);
    appendHostObservationForClientDevice(deviceId, { k: "error", v: message });
    return Response.json({ error: { message, type: "server_error" } }, { status: 503 });
  }
}

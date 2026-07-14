import { allModels, servingModel } from "@/lib/lab";
import { cliAuthorized, cliDeviceCustomHeaders, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";

const CONTEXT_WINDOW_SIZE = 32768;

// Cheap, local-only heuristics so the CLI's model picker can show
// "name · family/role · loaded · ctx" without a second round trip. These are
// display hints, not authoritative metadata — HIVE's own registry
// (web/src/lib/hive/model-registry.ts) remains the source of truth for
// anything that drives training/eval decisions.
function inferFamily(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("ministral")) return "Ministral-3";
  if (lower.includes("qwen3")) return "Qwen3";
  if (lower.includes("qwen")) return "Qwen";
  return "custom";
}

function inferRole(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.includes("coder") || lower.includes("repair")) return "coder_repairer";
  if (lower.includes("planner") || lower.includes("coordinator")) return "coordinator_planner";
  if (lower.includes("verifier")) return "verifier";
  return null;
}

export function GET(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "client settings", authorized);
  if (!authorized) return unauthorizedResponse();
  const requestUrl = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? requestUrl.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? requestUrl.protocol.replace(":", "");
  const origin = `${protocol}://${host}`;
  const customHeaders = cliDeviceCustomHeaders(request);
  const resident = servingModel();
  const models = allModels()
    .filter((model) => model.source === "local")
    .map((model) => {
      const family = inferFamily(model.name);
      const role = inferRole(model.name);
      const loaded = model.name === resident;
      const descriptionParts = [family, ...(role ? [role] : []), loaded ? "loaded" : "not loaded", `${Math.round(CONTEXT_WINDOW_SIZE / 1024)}k ctx`];
      return {
        id: model.name,
        // Plain model name only — no "LAL ·" prefix. Duplicating the LAL
        // mark on every row (the mark already appears once in the header)
        // was cosmetic clutter, and the middle-dot glyph it carried was the
        // root cause of the "LAL Â·" mojibake seen on Windows installs: the
        // installer's `Invoke-WebRequest(...).Content` decodes a
        // `Content-Type: application/json` response (no charset parameter)
        // as Windows-1252/Latin-1 on Windows PowerShell 5.1, so any non-ASCII
        // byte we emit here — not just this one — gets mangled client-side.
        // Removing the character is the durable fix; the explicit charset
        // below is defense in depth for any future field that isn't ASCII.
        name: model.name,
        description: descriptionParts.join(" · "),
        envKey: "LAL_API_KEY",
        baseUrl: `${origin}/api/llm/v1`,
        generationConfig: {
          timeout: 600000,
          maxRetries: 1,
          contextWindowSize: CONTEXT_WINDOW_SIZE,
          ...(Object.keys(customHeaders).length ? { customHeaders } : {}),
          samplingParams: { temperature: 0.2, max_tokens: 4096 },
          extra_body: { chat_template_kwargs: { enable_thinking: false } },
        },
      };
    });
  const preferred = models.find((model) => model.id === "qwen3-4b-stock")?.id ?? models[0]?.id ?? "";
  return Response.json(
    {
      $version: 4,
      general: { enableAutoUpdate: false },
      context: { fileName: ["LAL.md", "AGENTS.md", "QWEN.md"] },
      security: { auth: { selectedType: "openai" } },
      model: { name: preferred },
      modelProviders: { openai: models },
    },
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

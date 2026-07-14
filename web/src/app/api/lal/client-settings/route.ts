import { allModels } from "@/lib/lab";
import { cliAuthorized, cliDeviceCustomHeaders, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "client settings", authorized);
  if (!authorized) return unauthorizedResponse();
  const requestUrl = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? requestUrl.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? requestUrl.protocol.replace(":", "");
  const origin = `${protocol}://${host}`;
  const customHeaders = cliDeviceCustomHeaders(request);
  const models = allModels()
    .filter((model) => model.source === "local")
    .map((model) => ({
      id: model.name,
      name: `LAL · ${model.name}`,
      envKey: "LAL_API_KEY",
      baseUrl: `${origin}/api/llm/v1`,
      generationConfig: {
        timeout: 600000,
        maxRetries: 1,
        contextWindowSize: 32768,
        ...(Object.keys(customHeaders).length ? { customHeaders } : {}),
        samplingParams: { temperature: 0.2, max_tokens: 4096 },
        extra_body: { chat_template_kwargs: { enable_thinking: false } },
      },
    }));
  const preferred = models.find((model) => model.id === "qwen3-4b-stock")?.id ?? models[0]?.id ?? "";
  return Response.json({
    $version: 4,
    general: { enableAutoUpdate: false },
    context: { fileName: ["LAL.md", "AGENTS.md", "QWEN.md"] },
    security: { auth: { selectedType: "openai" } },
    model: { name: preferred },
    modelProviders: { openai: models },
  });
}

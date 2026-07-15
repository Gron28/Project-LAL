import { allModels, servingModel, servingRuntimeStatus } from "@/lib/lab";
import { cliAuthorized, cliDeviceCustomHeaders, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";

const CONTEXT_WINDOW_SIZE = 32768;

// Cheap, local-only heuristics so the CLI's model picker can show
// "name · family/role · loaded · context request" without a second round trip.
// The active runtime context is read below when a model is resident; otherwise
// this is explicitly the context LAL will request, not a claim about a model's
// theoretical maximum. HIVE's own registry
// (web/src/lib/hive/model-registry.ts) remains the source of truth for
// anything that drives training/eval decisions.
function inferFamily(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("ministral")) return "Ministral-3";
  if (lower.includes("gemma")) return "Gemma";
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
  const runtime = servingRuntimeStatus();
  // Both GGUF models served directly ("local") and Ollama-served models
  // (Gemma, etc.) belong in the CLI's catalog — excluding Ollama entirely
  // here hid every Gemma model from the picker even though they're legitimate,
  // selectable chat models. The web /chat route's silent image-attachment
  // auto-routing to a Gemma vision model is a separate, unrelated concern.
  const models = allModels()
    .map((model) => {
      const family = inferFamily(model.name);
      const role = inferRole(model.name);
      const loaded = model.name === resident;
      const activeContext = loaded ? runtime.context : null;
      const contextLabel = activeContext
        ? `${Math.round(activeContext / 1024)}k active context`
        : `requests ${Math.round(CONTEXT_WINDOW_SIZE / 1024)}k context`;
      const descriptionParts = [family, ...(role ? [role] : []), loaded ? "loaded" : "not loaded", contextLabel];
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
          // Local agents should act in short, observable turns. A 4k-token
          // default lets a small model spend minutes narrating instead of
          // making its first tool call; longer work continues across turns.
          samplingParams: { temperature: 0.2, max_tokens: 1024 },
          // Native /rc turns mirror visible model reasoning into the owner's
          // local run ledger. This is model-provided reasoning output, not a
          // claim to expose hidden provider internals.
          extra_body: { chat_template_kwargs: { enable_thinking: true } },
        },
      };
    });
  const preferred = models.find((model) => model.id === "qwen3-4b-stock")?.id ?? models[0]?.id ?? "";
  return Response.json(
    {
      $version: 4,
      general: { enableAutoUpdate: false },
      // LAL's observability stays on the owner's host and in the local run
      // ledger. Never opt a paired terminal into upstream usage collection or
      // outbound telemetry as part of managed setup.
      privacy: { usageStatisticsEnabled: false },
      telemetry: { enabled: false },
      // A small local model should not prefill the inherited Qwen tool catalog
      // (agents, teams, workflows, cron, MCP, browser, worktrees, etc.) before
      // every turn. Keep the complete daily coding loop and make every omitted
      // capability an explicit future product decision.
      tools: {
        core: [
          "list_directory",
          "read_file",
          "grep_search",
          "glob",
          "edit",
          "write_file",
          "run_shell_command",
          "todo_write",
          "ask_user_question",
        ],
      },
      context: { fileName: ["LAL.md", "AGENTS.md", "QWEN.md"] },
      security: { auth: { selectedType: "openai" } },
      model: { name: preferred },
      modelProviders: { openai: models },
    },
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

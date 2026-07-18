import { publicModels, servingModel, servingRuntimeStatus } from "@/lib/lab";
import { cliAuthorized, cliDeviceCustomHeaders, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";

const LOCAL_CONTEXT_WINDOW_SIZE = 32768;
const OLLAMA_CONTEXT_WINDOW_SIZE = 16384;

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
  const models = publicModels()
    .map((model) => {
      const family = inferFamily(model.name);
      const role = inferRole(model.name);
      const loaded = model.name === resident;
      const activeContext = loaded ? runtime.context : null;
      const contextWindowSize = model.source === "ollama" ? OLLAMA_CONTEXT_WINDOW_SIZE : LOCAL_CONTEXT_WINDOW_SIZE;
      const contextLabel = activeContext
        ? `${Math.round(activeContext / 1024)}k active context`
        : `requests ${Math.round(contextWindowSize / 1024)}k context`;
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
          contextWindowSize,
          ...(Object.keys(customHeaders).length ? { customHeaders } : {}),
          // Deliberately NO max_tokens here: a managed value is treated by the
          // CLI as an explicit user ceiling (min() with everything else wins),
          // which silently capped every reply at 8K and defeated /tokens. The
          // CLI's own window clamp (clampOutputTokensToWindow) already sizes
          // each request to the room left in the context window — that is the
          // honest budget for a locally-served model.
          samplingParams: { temperature: 0.2 },
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
        // Desktop automation contributes 35 schemas and exhausted Gemma's
        // effective request window before it could emit a useful token. A
        // coding project run does not need OS-level mouse/keyboard control.
        // Registered lazily behind tool_search. This gives the same agent an
        // in-context browser acceptance path without prefilling 35 schemas.
        computerUse: { enabled: true },
        core: [
          "read_file",
          "edit",
          "write_file",
          "run_shell_command",
          // Orientation tools: a model that cannot list or search the project
          // cannot ground its edits, and small models degrade into repeating
          // themselves instead of acting. Keep the discovery loop intact.
          "grep_search",
          "glob",
          "list_directory",
          "todo_write",
          // Keep orchestration available and keep research deferred behind
          // tool_search. The model pays for one coordinator schema up front,
          // not the full inherited automation catalog.
          "tool_search",
          "web_search",
          "web_fetch",
          "agent",
          "task_stop",
        ],
        // Some inherited synthetic tools intentionally bypass `tools.core`.
        // Exclude them explicitly so their schemas cannot consume most of a
        // 32k local-model turn before the user's first token is processed.
        exclude: [
          "send_message",
          "skill",
          "ask_user_question",
          "enter_plan_mode",
          "exit_plan_mode",
          "enter_worktree",
          "exit_worktree",
          "workflow",
          "artifact",
          "record_artifact",
          "read_mcp_resource",
        ],
      },
      context: { fileName: ["LAL.md", "AGENTS.md", "QWEN.md"] },
      security: { auth: { selectedType: "openai" } },
      // Broad project prompts need room for research -> plan -> implement ->
      // judge -> repair. Simple prompts still stop as soon as they are done.
      model: { name: preferred, maxSessionTurns: 120 },
      modelProviders: { openai: models },
    },
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

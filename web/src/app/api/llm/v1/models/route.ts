import { allModels } from "@/lib/lab";
import { cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "models", authorized);
  if (!authorized) return unauthorizedResponse();
  const data = allModels()
    .map((model) => ({
      id: model.name,
      object: "model",
      created: 0,
      owned_by: model.source === "ollama" ? "ollama" : "local-ai-lab",
      context_window: model.source === "ollama" ? 16384 : 32768,
    }));
  return Response.json({ object: "list", data });
}

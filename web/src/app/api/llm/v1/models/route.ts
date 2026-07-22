import { allModels, contextProfileForModel } from "@/lib/lab";
import { cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "models", authorized);
  if (!authorized) return unauthorizedResponse();
  const data = allModels()
    .map((model) => {
      const profile = contextProfileForModel(model.name);
      return {
      id: model.name,
      object: "model",
      created: 0,
      owned_by: model.source === "ollama" ? "ollama" : "local-ai-lab",
      context_window: profile.activeTokens ?? profile.verifiedTokens ?? profile.requestedTokens,
      context_profile: profile,
    }; });
  return Response.json({ object: "list", data });
}

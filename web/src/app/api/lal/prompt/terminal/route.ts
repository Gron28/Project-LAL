import { cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";
import { terminalPrompt } from "@/app/api/lal/prompts/route";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "terminal prompt", authorized);
  if (!authorized) return unauthorizedResponse();
  return new Response(terminalPrompt(), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
}

import { NextRequest, NextResponse } from "next/server";
import { getConvo, newId, saveConvo } from "@/lib/lab";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { workspaceGrantRepository } from "@/lib/workspace-grants";

export const dynamic = "force-dynamic";

const MAX_HANDOFF_CHARS = 12_000;

// Convert a conversation into a fresh code session without dumping an unlimited
// transcript into the coding agent. The handoff is visible, editable, persisted,
// and intentionally bounded so it remains useful inside a local model context.
export async function POST(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const b = await req.json().catch(() => ({}));
  const sourceId = typeof b.conversationId === "string" ? b.conversationId : "";
  const source = sourceId && !sourceId.startsWith("code-") ? getConvo(sourceId) : null;
  if (!source) return NextResponse.json({ error: "chat not found" }, { status: 404 });

  const messages = source.messages.slice(-12).map((message) => {
    const role = message.role === "assistant" ? "Assistant" : "User";
    return `${role}: ${(message.content || "").slice(0, 1800)}`;
  }).join("\n\n");
  const context = messages.slice(-MAX_HANDOFF_CHARS);
  const id = "code-" + newId();
  const requestedProject = typeof b.project === "string" && b.project.trim() ? b.project.trim() : undefined;
  const project = requestedProject ? workspaceGrantRepository.resolveGrantedDirectory(requestedProject) : undefined;
  if (requestedProject && !project) return NextResponse.json({ error: "project is not owner-granted or no longer exists" }, { status: 403 });
  saveConvo({
    id,
    title: "From chat: " + (source.title || "handoff").slice(0, 48),
    ts: Date.now(),
    ...(project ? { project } : {}),
    messages: [{
      role: "user",
      content: "Continue this chat as a coding task. Inspect the project before changing files. Use edit_file for targeted changes and verify the result.\n\n--- chat handoff ---\n" + context,
    }],
  });
  return NextResponse.json({ ok: true, conversationId: id });
}

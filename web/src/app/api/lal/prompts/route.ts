import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const BASE_PROMPT = path.join(process.cwd(), "public", "lal", "system.md");
const OVERRIDES = path.join(process.cwd(), ".data", "lal-prompts.json");
const TERMINAL_ID = "terminal-system";

type PromptOverrides = { version: 1; prompts: Record<string, string> };

function readOverrides(): PromptOverrides {
  try {
    const parsed = JSON.parse(fs.readFileSync(OVERRIDES, "utf8")) as Partial<PromptOverrides>;
    if (parsed.version === 1 && parsed.prompts && typeof parsed.prompts === "object") {
      return { version: 1, prompts: parsed.prompts };
    }
  } catch {}
  return { version: 1, prompts: {} };
}

function writeOverrides(value: PromptOverrides): void {
  fs.mkdirSync(path.dirname(OVERRIDES), { recursive: true });
  const temporary = `${OVERRIDES}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, OVERRIDES);
}

export function terminalPrompt(): string {
  const base = fs.readFileSync(BASE_PROMPT, "utf8");
  return readOverrides().prompts[TERMINAL_ID]?.trim() || base;
}

export function GET() {
  const overrides = readOverrides();
  const base = fs.readFileSync(BASE_PROMPT, "utf8");
  return Response.json({
    prompts: [{
      id: TERMINAL_ID,
      name: "LAL terminal system prompt",
      scope: "Every managed terminal turn",
      source: "Host-managed; owner-editable",
      prompt: overrides.prompts[TERMINAL_ID] ?? base,
      inherited: !overrides.prompts[TERMINAL_ID],
      activation: "Save, then run lal update on each terminal. A new terminal session uses it.",
    }],
  });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null) as { id?: unknown; prompt?: unknown } | null;
  if (body?.id !== TERMINAL_ID || typeof body.prompt !== "string") {
    return Response.json({ error: "Expected terminal-system prompt text." }, { status: 400 });
  }
  const prompt = body.prompt.trim();
  if (!prompt || prompt.length > 32_000) {
    return Response.json({ error: "Prompt must contain 1 to 32,000 characters." }, { status: 400 });
  }
  const overrides = readOverrides();
  overrides.prompts[TERMINAL_ID] = prompt;
  writeOverrides(overrides);
  return Response.json({ ok: true, prompt });
}

export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get("id");
  if (id !== TERMINAL_ID) return Response.json({ error: "Unknown prompt." }, { status: 404 });
  const overrides = readOverrides();
  delete overrides.prompts[TERMINAL_ID];
  writeOverrides(overrides);
  return Response.json({ ok: true, prompt: terminalPrompt() });
}

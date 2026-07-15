import { NextRequest } from "next/server";
import { PROMPTS, managedPrompt, readPromptOverrides, writePromptOverrides } from "@/lib/lal-prompts";
import { ROLE_PROFILES } from "@/lib/hive/presets";
import { getRoleOverrides, resetRoleOverride, setRoleOverride } from "@/lib/hive/store";

export const dynamic = "force-dynamic";
const roleId = (id: string) => id.startsWith("hive-role:") ? id.slice("hive-role:".length) : null;

export function GET() {
  const overrides = readPromptOverrides();
  const hiveOverrides = getRoleOverrides();
  return Response.json({ prompts: [
    ...PROMPTS.map((entry) => ({ ...entry, prompt: overrides.prompts[entry.id] ?? entry.base, inherited: !overrides.prompts[entry.id] })),
    ...Object.values(ROLE_PROFILES).map((role) => ({ id: `hive-role:${role.id}`, name: `Hive role · ${role.id}`, scope: "Every Hive stage assigned this role", source: "Hive role profile", prompt: hiveOverrides[role.id]?.prompt ?? role.prompt, inherited: !hiveOverrides[role.id]?.prompt, activation: "Applies to the next Hive workflow stage." })),
  ] });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null) as { id?: unknown; prompt?: unknown } | null;
  if (typeof body?.id !== "string" || typeof body.prompt !== "string") return Response.json({ error: "Expected a prompt id and prompt text." }, { status: 400 });
  const prompt = body.prompt.trim();
  if (!prompt || prompt.length > 32_000) return Response.json({ error: "Prompt must contain 1 to 32,000 characters." }, { status: 400 });
  const hiveRole = roleId(body.id);
  if (hiveRole) {
    if (!ROLE_PROFILES[hiveRole]) return Response.json({ error: "Unknown Hive role." }, { status: 404 });
    setRoleOverride(hiveRole, { ...getRoleOverrides()[hiveRole], prompt });
    return Response.json({ ok: true, prompt });
  }
  if (!PROMPTS.some((entry) => entry.id === body.id)) return Response.json({ error: "Unknown prompt." }, { status: 404 });
  const overrides = readPromptOverrides(); overrides.prompts[body.id] = prompt; writePromptOverrides(overrides);
  return Response.json({ ok: true, prompt });
}

export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get("id") || "";
  const hiveRole = roleId(id);
  if (hiveRole) { if (!ROLE_PROFILES[hiveRole]) return Response.json({ error: "Unknown Hive role." }, { status: 404 }); resetRoleOverride(hiveRole); return Response.json({ ok: true, prompt: ROLE_PROFILES[hiveRole].prompt }); }
  if (!PROMPTS.some((entry) => entry.id === id)) return Response.json({ error: "Unknown prompt." }, { status: 404 });
  const overrides = readPromptOverrides(); delete overrides.prompts[id]; writePromptOverrides(overrides);
  return Response.json({ ok: true, prompt: managedPrompt(id) });
}

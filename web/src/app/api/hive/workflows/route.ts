import { NextRequest, NextResponse } from "next/server";
import { discoverModelProfiles } from "@/lib/hive/model-registry";
import { recoverHiveWorkflows, startHiveWorkflow } from "@/lib/hive/engine";
import { BUDGETS, ROLE_PROFILES, codingWorkflow, researchWorkflow } from "@/lib/hive/presets";
import { HIVE_CONTRACT_VERSION, type TaskEnvelope } from "@/lib/hive/contracts";
import { getRoleOverrides, listWorkflows } from "@/lib/hive/store";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(req: NextRequest) {
  const recovered = recoverHiveWorkflows();
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;
  // roles is the EFFECTIVE (prompt-override-merged) profile each stage actually
  // runs with — engine.ts's effectiveRole() does the same merge at execution time.
  // roleOverrides is the raw saved override map, so the UI can tell what's been
  // customized (and offer to reset it) vs. what's still on the hardcoded default.
  const overrides = getRoleOverrides();
  const roles = Object.fromEntries(Object.entries(ROLE_PROFILES).map(([id, role]) => [id, overrides[id]?.prompt ? { ...role, prompt: overrides[id].prompt } : role]));
  return NextResponse.json({
    contractVersion: HIVE_CONTRACT_VERSION, workflows: listWorkflows(limit), recovered,
    templates: [researchWorkflow(), codingWorkflow()], budgets: BUDGETS, roles, roleOverrides: overrides, models: discoverModelProfiles(),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const kind = body.kind === "coding" ? "coding" : body.kind === "research" ? "research" : null;
  if (!kind) return NextResponse.json({ error: "kind must be research or coding" }, { status: 400 });
  const envelope: TaskEnvelope = body.envelope || {
    version: HIVE_CONTRACT_VERSION,
    objective: String(body.objective || ""), constraints: Array.isArray(body.constraints) ? body.constraints : [], artifactRefs: [],
    requiredOutput: String(body.requiredOutput || (kind === "coding" ? "Verified implementation and final report" : "Evidence-backed synthesis")),
    definitionOfDone: Array.isArray(body.definitionOfDone) && body.definitionOfDone.length ? body.definitionOfDone : [kind === "coding" ? "Deterministic checks pass and every requirement is audited" : "Every factual claim cites fetched-source evidence"],
    ...(typeof body.workspace === "string" ? { workspace: body.workspace } : {}),
  };
  try {
    const started = startHiveWorkflow({
      kind, envelope, budget: ["quick", "standard", "deep"].includes(body.budget) ? body.budget : "standard",
      preferredModel: typeof body.preferredModel === "string" ? body.preferredModel : undefined, autoApprove: !!body.autoApprove,
      spec: body.spec,
    });
    return NextResponse.json(started, { status: 202 });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

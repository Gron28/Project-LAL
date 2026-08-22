import { NextRequest, NextResponse } from "next/server";
import { readGuardianAdapters } from "@/lib/guardian-adapters";
import { GuardianEngagementStore, createOwnerLocalScanEngagement } from "@/lib/guardian-engagement";
import { readGuardianEvidence, runClamAvScan, runYaraScan } from "@/lib/guardian-evidence";
import { authorizeGuardianOwnerMutation, readGuardianOwnerSession } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";
const REQUIRED_ATTESTATION = "I own or am authorized to assess this file";
// The wider app has not yet established an owner-auth/session boundary. Keep an
// action endpoint off by default rather than treating a browser form's typed
// attestation as authentication. A local operator must opt in at server start.
const actionsEnabled = () => process.env.LAL_GUARDIAN_ACTIONS_ENABLED === "1";

export function GET(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return NextResponse.json({ error: "pair this browser as the LAL owner first" }, { status: 401 });
  const engagements = new GuardianEngagementStore().list();
  return NextResponse.json({ actionsEnabled: actionsEnabled(), adapters: readGuardianAdapters(), engagements, evidence: readGuardianEvidence() });
}

export async function POST(request: NextRequest) {
  const owner = authorizeGuardianOwnerMutation(request);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: 401 });
  if (!actionsEnabled()) return NextResponse.json({ error: "Guardian actions are disabled. Start LAL with LAL_GUARDIAN_ACTIONS_ENABLED=1 after confirming this is an owner-controlled deployment." }, { status: 403 });
  let body: { engine?: unknown; target?: unknown; ruleFile?: unknown; ownerAttestation?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }
  const target = typeof body.target === "string" ? body.target.trim() : "";
  const ruleFile = typeof body.ruleFile === "string" ? body.ruleFile.trim() : "";
  const ownerAttestation = typeof body.ownerAttestation === "string" ? body.ownerAttestation.trim() : "";
  const engine = body.engine === "clamav" ? "clamav" : body.engine === "yara" ? "yara" : null;
  if (!engine || !target || (engine === "yara" && !ruleFile)) return NextResponse.json({ error: engine === "yara" ? "target and ruleFile are required" : "engine and target are required" }, { status: 400 });
  if (ownerAttestation !== REQUIRED_ATTESTATION) {
    return NextResponse.json({ error: `type the attestation exactly: ${REQUIRED_ATTESTATION}` }, { status: 400 });
  }

  const store = new GuardianEngagementStore();
  const technique = engine === "yara" ? "yara_scan" : "clamav_scan";
  const engagement = createOwnerLocalScanEngagement({ target, ownerAttestation, technique });
  try { store.create(engagement); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "could not create engagement" }, { status: 400 }); }
  const now = Date.now();
  const scanId = `scan_${crypto.randomUUID().replace(/-/g, "")}`;
  const result = engine === "yara"
    ? runYaraScan({ engagement, target, ruleFile, scanId, now, priorActions: 0 })
    : runClamAvScan({ engagement, target, scanId, now, priorActions: 0 });
  const action = { id: result.scanId, target, technique, contactsTarget: false, mutatesTarget: false, approved: true, at: now };
  const ledger = store.record(engagement.id, action);
  if (!ledger) return NextResponse.json({ error: "could not record scan authorization outcome" }, { status: 500 });
  return NextResponse.json({ engagement: store.get(engagement.id), result, evidence: readGuardianEvidence() }, { status: result.state === "failed" ? 500 : 200 });
}

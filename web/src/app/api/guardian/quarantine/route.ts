import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { GuardianEngagementStore, createOwnerLocalScanEngagement } from "@/lib/guardian-engagement";
import { quarantineGuardianFile, readGuardianQuarantine, restoreGuardianFile } from "@/lib/guardian-remediation";
import { authorizeGuardianOwnerMutation, readGuardianOwnerSession } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";
const actionsEnabled = () => process.env.LAL_GUARDIAN_ACTIONS_ENABLED === "1";
const ATTESTATION = "I understand this moves the exact file and can disrupt software";
export function GET(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return NextResponse.json({ error: "pair this browser as the LAL owner first" }, { status: 401 });
  return NextResponse.json({ actionsEnabled: actionsEnabled(), attestation: ATTESTATION, ...readGuardianQuarantine() });
}
export async function POST(request: NextRequest) {
  const owner = authorizeGuardianOwnerMutation(request);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: 401 });
  if (!actionsEnabled()) return NextResponse.json({ error: "Guardian actions are disabled. Start LAL with LAL_GUARDIAN_ACTIONS_ENABLED=1 after confirming this is an owner-controlled deployment." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const kind = body.action === "restore" ? "restore" : body.action === "quarantine" ? "quarantine" : null;
  const attestation = typeof body.ownerAttestation === "string" ? body.ownerAttestation.trim() : "";
  if (!kind || attestation !== ATTESTATION) return NextResponse.json({ error: `type the attestation exactly: ${ATTESTATION}` }, { status: 400 });
  const store = new GuardianEngagementStore();
  const quarantine = readGuardianQuarantine();
  const restoreRecord = kind === "restore" && typeof body.id === "string" ? quarantine.records.find((record) => record.id === body.id && record.operation === "quarantined") : null;
  const target = kind === "quarantine" && typeof body.target === "string" ? body.target.trim() : restoreRecord ? `host:${restoreRecord.originalPath}` : "";
  if (!target) return NextResponse.json({ error: kind === "quarantine" ? "target is required" : "valid quarantine record is required" }, { status: 400 });
  const technique = kind === "quarantine" ? "quarantine_file" : "restore_file";
  const engagement = createOwnerLocalScanEngagement({ target, ownerAttestation: attestation, technique });
  store.create(engagement);
  const outcome = kind === "quarantine" ? quarantineGuardianFile({ engagement, target }) : restoreGuardianFile({ engagement, id: String(body.id) });
  store.record(engagement.id, { id: crypto.randomUUID(), target, technique, contactsTarget: false, mutatesTarget: true, approved: true, at: Date.now() });
  return NextResponse.json({ engagement: store.get(engagement.id), outcome, ...readGuardianQuarantine() }, { status: outcome.state === "failed" ? 500 : 200 });
}

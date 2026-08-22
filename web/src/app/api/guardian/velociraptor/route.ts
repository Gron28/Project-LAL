import { NextRequest, NextResponse } from "next/server";
import { collectVelociraptorArtifact, guardianVelociraptorArtifacts, readVelociraptorCollections } from "@/lib/guardian-velociraptor";
import { authorizeGuardianOwnerMutation, readGuardianOwnerSession } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";
const actionsEnabled = () => process.env.LAL_GUARDIAN_ACTIONS_ENABLED === "1";
export function GET(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return NextResponse.json({ error: "pair this browser as the LAL owner first" }, { status: 401 });
  return NextResponse.json({ actionsEnabled: actionsEnabled(), artifacts: guardianVelociraptorArtifacts(), collections: readVelociraptorCollections() });
}
export async function POST(request: NextRequest) {
  const owner = authorizeGuardianOwnerMutation(request);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: 401 });
  if (!actionsEnabled()) return NextResponse.json({ error: "Guardian actions are disabled. Start LAL with LAL_GUARDIAN_ACTIONS_ENABLED=1 after confirming this is an owner-controlled deployment." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const artifact = typeof body.artifact === "string" ? body.artifact : "";
  const collection = collectVelociraptorArtifact(artifact);
  return NextResponse.json({ collection, collections: readVelociraptorCollections() }, { status: collection.state === "failed" ? 500 : 200 });
}

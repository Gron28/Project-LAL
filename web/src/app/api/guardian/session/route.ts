import { NextRequest, NextResponse } from "next/server";
import { clearGuardianOwnerCookie, createGuardianOwnerSession, guardianOwnerCookie, refreshGuardianOwnerCsrf } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const session = refreshGuardianOwnerCsrf(request);
  return NextResponse.json({ paired: !!session, ...(session ? { csrf: session.csrf, expiresAt: session.expiresAt } : {}) });
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  const session = createGuardianOwnerSession(token);
  if (!session) return NextResponse.json({ error: "invalid LAL pairing token" }, { status: 401 });
  const response = NextResponse.json({ paired: true, csrf: session.csrf, expiresAt: session.expiresAt });
  response.headers.append("set-cookie", guardianOwnerCookie(session));
  return response;
}

export function DELETE() {
  const response = NextResponse.json({ paired: false });
  response.headers.append("set-cookie", clearGuardianOwnerCookie());
  return response;
}

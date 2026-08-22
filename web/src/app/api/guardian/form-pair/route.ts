import { NextRequest, NextResponse } from "next/server";
import { createGuardianOwnerSession, guardianOwnerCookie } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";
const destination = (request: NextRequest) => new URL("/guardian", request.headers.get("origin") || request.url);
export async function POST(request: NextRequest) {
  const body = await request.formData().catch(() => null);
  const token = typeof body?.get("token") === "string" ? String(body!.get("token")) : "";
  const session = createGuardianOwnerSession(token);
  if (!session) return NextResponse.redirect(new URL("/guardian?pair=failed", destination(request)), 303);
  const response = NextResponse.redirect(destination(request), 303);
  response.headers.append("set-cookie", guardianOwnerCookie(session));
  return response;
}

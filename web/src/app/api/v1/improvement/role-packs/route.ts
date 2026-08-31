import { NextResponse } from "next/server";
import { listRolePacks } from "@/lib/improvement/role-packs";
export const dynamic="force-dynamic";
export function GET(){return NextResponse.json({rolePacks:listRolePacks()},{headers:{"cache-control":"no-store"}});}

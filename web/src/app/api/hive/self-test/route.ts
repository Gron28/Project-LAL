import { NextResponse } from "next/server";
import { runHiveContractSelfTest } from "@/lib/hive/self-test";

export const dynamic = "force-dynamic";
export async function GET() {
  const result = runHiveContractSelfTest();
  return NextResponse.json(result, { status: result.passed ? 200 : 500 });
}

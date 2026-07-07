import { readSysInfo } from "@/lib/sysinfo";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readSysInfo());
}

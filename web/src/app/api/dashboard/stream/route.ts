// One shared data connection for every dashboard widget — a single ~2s SSE snapshot
// instead of N widgets each polling their own endpoint on their own interval.
import { readSysInfo } from "@/lib/sysinfo";
import { servingModel, trainStatus, listTrainRuns, listBench, getBattery, allModels, SERVE_PORT } from "@/lib/lab";
import { readRuntimeStatus } from "@/lib/runtime-status";
import { readLlamaRuntimeTelemetry, RuntimeTelemetryJournal } from "@/lib/runtime-telemetry";
import { readGuardianStatus } from "@/lib/guardian-observer";
import { readGuardianAdapters } from "@/lib/guardian-adapters";
import { readGuardianEvidence } from "@/lib/guardian-evidence";

export const dynamic = "force-dynamic";
const telemetryJournal = new RuntimeTelemetryJournal(`${process.cwd()}/.data/runtime/llama-telemetry.ndjson`);

async function snapshot() {
  const sys = await readSysInfo();
  const running = trainStatus("").running;
  const tail = running ? trainStatus(running).rows.slice(-40) : [];
  const runs = listTrainRuns();
  const bench = listBench() as Record<string, unknown>[];
  const benchSummaries = bench.map((r) => ({
    suite: r.suite, model: r.model, score: r.score, total: r.total, cats: r.cats,
    tokSec: r.tokSec, latencyMs: r.latencyMs, sizeGb: r.sizeGb, pinned: r.pinned, stale: r.stale,
  }));
  const battery = getBattery();
  const runtime = readRuntimeStatus();
  const guardian = readGuardianStatus();
  const telemetry = await readLlamaRuntimeTelemetry(
    `http://127.0.0.1:${SERVE_PORT}`,
    runtime.serving.backend === "llama.cpp" && runtime.serving.alive,
  );
  telemetryJournal.append(telemetry);
  return {
    sys, serving: servingModel(),
    train: { running, tail },
    runs, benchSummaries, battery,
    models: allModels(), runtime: { ...runtime, telemetry }, guardian, guardianAdapters: readGuardianAdapters(), guardianEvidence: readGuardianEvidence(),
  };
}

export async function GET() {
  const encoder = new TextEncoder();
  let closed = false;
  let t: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        if (closed) return;
        try {
          const data = await snapshot();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { closed = true; clearInterval(t); } // enqueue throws once the client has disconnected
      };
      await push();
      t = setInterval(push, 2000);
    },
    cancel() { closed = true; clearInterval(t); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}

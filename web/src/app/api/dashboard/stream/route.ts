// One shared data connection for every dashboard widget — a single ~2s SSE snapshot
// instead of N widgets each polling their own endpoint on their own interval.
import { readSysInfo } from "@/lib/sysinfo";
import { servingModel, trainStatus, listTrainRuns, listBench, getBattery, allModels } from "@/lib/lab";

export const dynamic = "force-dynamic";

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
  return {
    sys, serving: servingModel(),
    train: { running, tail },
    runs, benchSummaries, battery,
    models: allModels(),
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

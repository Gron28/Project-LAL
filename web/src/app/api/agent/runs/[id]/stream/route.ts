import { NextRequest } from "next/server";
import { getRun, isRunLive, openRunStream } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

const TERMINAL = new Set(["done", "error", "stopped", "interrupted"]);

// SSE attach point for a run: replays the event log from ?after=<seq> (0 = from the
// beginning), then tails live events until the run reaches a terminal status. Works
// mid-run, after completion (pure replay), and across app restarts. Any number of
// clients can hold this open at once; closing it affects nothing server-side.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = getRun(id);
  if (!meta) return new Response("no such run", { status: 404 });
  // EventSource auto-reconnect sends Last-Event-ID (we stamp every event's seq as
  // its SSE id below) — honoring it means a dropped-and-reconnected client resumes
  // exactly where it left off, no duplicates, no gaps. ?after= covers first attach.
  const after = Number(req.headers.get("last-event-id")) || Number(req.nextUrl.searchParams.get("after")) || 0;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let sub: { close: () => void } | null = null;
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        sub?.close();
        try { controller.close(); } catch {}
      };
      const send = (payload: string, seq?: number) => {
        if (closed) return;
        const idLine = seq ? `id: ${seq}\n` : "";
        try { controller.enqueue(enc.encode(idLine + "data: " + payload + "\n\n")); } catch { finish(); }
      };

      // Current meta first, so a client knows the run's status before any replay —
      // an already-finished run replays and closes without ever "looking live".
      send(JSON.stringify({ k: "run", v: getRun(id) ?? meta }));

      sub = openRunStream(id, after, (line) => {
        let seq: number | undefined;
        let terminal = false;
        try {
          const e = JSON.parse(line) as { seq?: number; k?: string; v?: string };
          seq = e.seq;
          terminal = e.k === "status" && TERMINAL.has(String(e.v));
        } catch {}
        send(line, seq);
        // The terminal status event is always the run's last line — once it's out,
        // there is nothing more to tail.
        if (terminal) finish();
      });

      // Replay finished and the run isn't live: it either ended before this client
      // attached (terminal line already replayed → finish() above fired) or its
      // process is simply gone; either way there's nothing to wait for.
      if (!closed && !isRunLive(id)) finish();

      // Proxies (tailscale serve) drop silent connections — keep-alive comments.
      if (!closed) heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(enc.encode(": ping\n\n")); } catch { finish(); }
      }, 15000);

      req.signal.addEventListener("abort", finish);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

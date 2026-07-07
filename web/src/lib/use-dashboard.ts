"use client";
// Module-level EventSource singleton so N dashboard widgets share one SSE
// connection instead of each opening/polling their own.
import { useEffect, useState } from "react";

export type Snapshot = {
  sys: { cpu: number; ramUsedGb: number; ramTotalGb: number; ramPct: number; gpu: number | null; vramUsedGb: number | null; vramTotalGb: number | null; vramPct: number | null; cpuTemp: number | null; gpuTemp: number | null; nvmeTemp: number | null; ollamaLoaded: string | null };
  serving: string | null;
  train: { running: string | null; tail: { event: string; step?: number; loss?: number; steps_s?: number; tok_s?: number; eta?: number | null; grad_norm?: number }[] };
  runs: { name: string; status: string; finalLoss: number | null; lastStep: number; ts: number }[];
  benchSummaries: {
    suite: string; model: string; score: number; total: number;
    cats: Record<string, { ok: number; total: number }>;
    tokSec: number | null; latencyMs: number | null; sizeGb?: number | null; pinned?: boolean; stale?: boolean;
  }[];
  battery: { suites: string[]; champion: string; challenger?: string };
  models: { name: string; source: "local" | "ollama"; path: string; gb: number }[];
};

const HISTORY_LEN = 60; // ~2min at 2s ticks — enough for a sparkline

let es: EventSource | null = null;
let latest: Snapshot | null = null;
let cpuHist: number[] = [];
let gpuHist: number[] = [];
const subscribers = new Set<(s: Snapshot) => void>();

function ensureConnected() {
  if (es) return;
  es = new EventSource("/api/dashboard/stream");
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as Snapshot;
      latest = data;
      cpuHist = [...cpuHist, data.sys.cpu].slice(-HISTORY_LEN);
      gpuHist = [...gpuHist, data.sys.gpu ?? 0].slice(-HISTORY_LEN);
      subscribers.forEach((fn) => fn(data));
    } catch { /* malformed frame — wait for the next one */ }
  };
  es.onerror = () => { /* EventSource auto-reconnects; nothing to do */ };
}

export function useDashboard() {
  const [snap, setSnap] = useState<Snapshot | null>(() => latest);
  useEffect(() => {
    ensureConnected();
    const fn = (s: Snapshot) => setSnap(s);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
      if (subscribers.size === 0 && es) { es.close(); es = null; }
    };
  }, []);
  return { snap, cpuHist, gpuHist };
}

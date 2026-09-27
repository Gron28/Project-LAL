"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RadarChart, MetricPanel, LossChart, Stat, PALETTE, pct, shortName } from "@/components/charts";
import type { Snapshot } from "@/lib/use-dashboard";
import type { GridWidget } from "@/components/grid";

export type Filters = { suite?: string };
export type WidgetCtx = { snap: Snapshot | null; cpuHist: number[]; gpuHist: number[]; filters: Filters };

function colour(p: number) { return p >= 90 ? "var(--accent-danger)" : p >= 70 ? "var(--accent-warn)" : "var(--accent-ai)"; }

function Bar({ label, pct: p, detail }: { label: string; pct: number | null; detail: string }) {
  const v = p ?? 0;
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span className="tracking-widest uppercase text-[var(--text-2)]">{label}</span>
        <span style={{ color: colour(v) }}>{p == null ? "—" : v + "%"} <span className="text-[var(--muted)]">{detail}</span></span>
      </div>
      <div className="h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: v + "%", background: colour(v) }} />
      </div>
    </div>
  );
}

function Spark({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1), w = 100, h = 24;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-6" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

const empty = <div className="text-[11px] text-[var(--muted)] text-center py-4">connecting…</div>;

export function GpuVramWidget({ ctx }: { ctx: WidgetCtx }) {
  const s = ctx.snap?.sys; if (!s) return empty;
  return (
    <div className="flex flex-col gap-2 h-full justify-center">
      <Bar label="GPU" pct={s.gpu} detail={s.gpuTemp != null ? `${s.gpuTemp}°C` : ""} />
      <Bar label="VRAM" pct={s.vramPct} detail={s.vramTotalGb ? `${s.vramUsedGb}/${s.vramTotalGb}GB` : ""} />
      <Spark data={ctx.gpuHist} color="var(--accent-ai)" />
    </div>
  );
}

export function CpuRamWidget({ ctx }: { ctx: WidgetCtx }) {
  const s = ctx.snap?.sys; if (!s) return empty;
  return (
    <div className="flex flex-col gap-2 h-full justify-center">
      <Bar label="CPU" pct={s.cpu} detail={s.cpuTemp != null ? `${s.cpuTemp}°C` : ""} />
      <Bar label="RAM" pct={s.ramPct} detail={`${s.ramUsedGb}/${s.ramTotalGb}GB`} />
      <Spark data={ctx.cpuHist} color="var(--accent-warn)" />
    </div>
  );
}

export function TempsWidget({ ctx }: { ctx: WidgetCtx }) {
  const s = ctx.snap?.sys; if (!s) return empty;
  const temp = (t: number | null) => t == null ? "—" : <span style={{ color: t >= 85 ? "var(--accent-danger)" : t >= 70 ? "var(--accent-warn)" : "var(--text-2)" }}>{t}°C</span>;
  return (
    <div className="flex flex-col gap-1.5 h-full justify-center text-[11px]">
      <div className="flex justify-between"><span className="text-[var(--muted)]">CPU</span><span>{temp(s.cpuTemp)}</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">GPU</span><span>{temp(s.gpuTemp)}</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">NVMe</span><span>{temp(s.nvmeTemp)}</span></div>
    </div>
  );
}

export function ServingStatusWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  return (
    <div className="flex flex-col gap-2 h-full justify-center text-[11px]">
      <div className="flex justify-between gap-2"><span className="text-[var(--muted)] shrink-0">llama</span>
        <span className="truncate" style={{ color: snap.serving ? "var(--accent-ai)" : "var(--muted)" }}>{snap.serving ? shortName(snap.serving) : "idle"}</span></div>
      <div className="flex justify-between gap-2"><span className="text-[var(--muted)] shrink-0">ollama</span>
        <span className="truncate" style={{ color: snap.sys.ollamaLoaded ? "var(--accent-warn)" : "var(--muted)" }}>{snap.sys.ollamaLoaded || "idle"}</span></div>
      <div className="flex justify-between gap-2"><span className="text-[var(--muted)] shrink-0">train</span>
        <span className="truncate" style={{ color: snap.train.running ? "var(--accent-warn)" : "var(--muted)" }}>{snap.train.running || "idle"}</span></div>
    </div>
  );
}

function rate(value: number | null) {
  return value == null ? "—" : `${value.toFixed(value >= 100 ? 0 : 1)} tok/s`;
}

/** Native llama.cpp counters, intentionally separate from request-ledger averages.
 * This makes a stalled prefill, lost slot, or disabled metrics endpoint visible
 * even before a request has reached LAL's own gateway. */
export function RuntimeTelemetryWidget({ ctx }: { ctx: WidgetCtx }) {
  const telemetry = ctx.snap?.runtime.telemetry;
  if (!telemetry) return empty;
  if (telemetry.state === "not-running") return <div className="h-full flex items-center justify-center text-[11px] text-[var(--muted)]">llama.cpp is idle</div>;
  if (telemetry.state !== "ready") return <div className="h-full flex flex-col items-center justify-center gap-1 text-[11px] text-[var(--accent-warn)]"><span>runtime telemetry unavailable</span><span className="text-[var(--muted)] truncate max-w-full">{telemetry.error || "waiting for metrics"}</span></div>;
  const active = telemetry.slots.find((slot) => slot.processing);
  const slotDetail = active
    ? `${active.cachedTokens ?? 0} cached · ${active.decodedTokens ?? 0} out`
    : telemetry.slotsAvailable ? `${telemetry.slots.length} slot${telemetry.slots.length === 1 ? "" : "s"} observed` : "slot endpoint unavailable";
  return (
    <div className="flex flex-col gap-1.5 h-full justify-center text-[11px]">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        <div className="flex justify-between gap-1"><span className="text-[var(--muted)]">prefill</span><span className="text-[var(--text)]">{rate(telemetry.promptTokensPerSecond)}</span></div>
        <div className="flex justify-between gap-1"><span className="text-[var(--muted)]">decode</span><span className="text-[var(--accent-ai)]">{rate(telemetry.predictedTokensPerSecond)}</span></div>
        <div className="flex justify-between gap-1"><span className="text-[var(--muted)]">KV cache</span><span>{telemetry.kvCacheUsagePct == null ? "—" : `${telemetry.kvCacheUsagePct}%`}</span></div>
        <div className="flex justify-between gap-1"><span className="text-[var(--muted)]">slots</span><span>{telemetry.busySlots == null ? "—" : `${telemetry.busySlots}/${telemetry.totalSlots ?? "?"}`}</span></div>
      </div>
      <div className="border-t border-[var(--border-soft)] pt-1 text-[var(--muted)] truncate" title={slotDetail}>{active ? "active · " : "idle · "}{slotDetail}</div>
      {telemetry.error && <div className="text-[var(--accent-warn)] truncate" title={telemetry.error}>partial: {telemetry.error}</div>}
    </div>
  );
}

export function GuardianStatusWidget({ ctx }: { ctx: WidgetCtx }) {
  const guardian = ctx.snap?.guardian;
  if (!guardian) return empty;
  const starts = guardian.events.filter((event) => event.kind === "process_started").length;
  const exits = guardian.events.filter((event) => event.kind === "process_exited").length;
  const networkOpens = guardian.events.filter((event) => event.kind === "network_opened").length;
  const latest = guardian.events[0];
  const latestText = !latest ? "passive observer · no events yet"
    : "process" in latest ? `${latest.kind === "process_started" ? "new" : "exit"} · ${latest.process.executable} · pid ${latest.process.pid}`
      : `${latest.kind === "network_opened" ? "open" : "closed"} · ${latest.connection.process || "unattributed"} → ${latest.connection.remoteAddress}:${latest.connection.remotePort ?? "*"}`;
  return (
    <div className="flex flex-col gap-1.5 h-full justify-center text-[11px]">
      <div className="flex justify-between"><span className="text-[var(--muted)]">processes</span><span className="text-[var(--accent-success)]">{guardian.processCount} observed</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">executable proof</span><span className={guardian.executableHashCount ? "text-[var(--accent-ai)]" : "text-[var(--muted)]"}>{guardian.executableHashCount}/{guardian.processCount} hashed</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">process guards</span><span className="text-[var(--text-2)]">{guardian.capabilityProcessCount} caps · {guardian.noNewPrivilegesProcessCount} NNP</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">network</span><span className={guardian.networkObserver === "available" ? "text-[var(--accent-success)]" : "text-[var(--accent-warn)]"}>{guardian.networkObserver === "available" ? `${guardian.connectionCount} sockets` : "unavailable"}</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">session events</span><span>+{starts} / −{exits} · {networkOpens} net</span></div>
      <div className="flex gap-1 text-[10px] text-[var(--muted)]"><span className="text-[var(--accent-ai)]">● processes</span><span className={guardian.coverage.network ? "text-[var(--accent-ai)]" : ""}>{guardian.coverage.network ? "●" : "○"} network</span><span>○ files</span><span>○ malware</span></div>
      <div className="border-t border-[var(--border-soft)] pt-1 text-[var(--muted)] truncate" title={latestText}>
        {latestText}
      </div>
      {guardian.error && <div className="text-[var(--accent-danger)] truncate" title={guardian.error}>process sensor: unavailable</div>}
      {guardian.networkError && <div className="text-[var(--accent-warn)] truncate" title={guardian.networkError}>network sensor: unavailable</div>}
    </div>
  );
}

function guardianEventText(event: NonNullable<Snapshot["guardian"]["events"][number]>) {
  if ("process" in event) return `${event.kind === "process_started" ? "+" : "−"} process · ${event.process.executable} · ${event.process.pid}`;
  return `${event.kind === "network_opened" ? "→" : "×"} ${event.connection.process || "unknown"} · ${event.connection.remoteAddress}:${event.connection.remotePort ?? "*"}`;
}

export function GuardianTimelineWidget({ ctx }: { ctx: WidgetCtx }) {
  const guardian = ctx.snap?.guardian;
  if (!guardian) return empty;
  if (!guardian.events.length) return <div className="h-full flex items-center justify-center text-[11px] text-[var(--muted)]">no Guardian events in this WebUI session</div>;
  return <div className="h-full overflow-auto text-[11px]">
    {guardian.events.slice(0, 30).map((event, index) => <div key={`${event.ts}-${index}`} className="flex gap-2 border-b border-[var(--border-soft)] py-1"><span className="shrink-0 text-[var(--muted)]">{new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><span className="truncate" title={guardianEventText(event)}>{guardianEventText(event)}</span></div>)}
  </div>;
}

export function GuardianAdaptersWidget({ ctx }: { ctx: WidgetCtx }) {
  const adapters = ctx.snap?.guardianAdapters;
  if (!adapters) return empty;
  const ready = adapters.filter((adapter) => adapter.state === "available").length;
  return <div className="flex h-full flex-col gap-1 text-[11px]">
    <div className="flex justify-between border-b border-[var(--border-soft)] pb-1"><span className="text-[var(--muted)]">existing local defenses</span><span className={ready ? "text-[var(--accent-success)]" : "text-[var(--muted)]"}>{ready}/{adapters.length} ready</span></div>
    <div className="min-h-0 flex-1 overflow-auto">
      {adapters.map((adapter) => <div key={adapter.id} className="flex items-center justify-between gap-2 py-0.5"><span className="truncate" title={adapter.capabilities.join(", ")}>{adapter.name}</span><span className={adapter.state === "available" ? "text-[var(--accent-success)]" : "text-[var(--muted)]"}>{adapter.state === "available" ? "detected" : "not installed"}</span></div>)}
    </div>
  </div>;
}

export function GuardianFindingsWidget({ ctx }: { ctx: WidgetCtx }) {
  const evidence = ctx.snap?.guardianEvidence;
  if (!evidence) return empty;
  if (!evidence.findings.length) return <div className="h-full flex flex-col items-center justify-center gap-1 text-[11px] text-[var(--muted)]"><span>no governed findings yet</span><span className="opacity-70">adapters are read-only until a scan is authorized</span></div>;
  const tone = (severity: string) => severity === "critical" || severity === "high" ? "var(--accent-danger)" : severity === "medium" ? "var(--accent-warn)" : "var(--accent-ai)";
  return <div className="h-full overflow-auto text-[11px]">
    {!evidence.integrity && <div className="mb-1 rounded border border-[var(--accent-danger)] px-1 py-0.5 text-[var(--accent-danger)]">finding ledger integrity failed</div>}
    {evidence.findings.map((finding) => <div key={finding.id} className="border-b border-[var(--border-soft)] py-1"><div className="flex gap-2"><span className="uppercase" style={{ color: tone(finding.severity) }}>{finding.severity}</span><span className="truncate" title={finding.title}>{finding.title}</span></div><div className="truncate text-[var(--muted)]" title={finding.target}>{finding.source} · {finding.target}</div></div>)}
  </div>;
}

export function TrainLiveWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  if (!snap.train.running) return <div className="h-full flex items-center justify-center text-[11px] text-[var(--muted)]">no training run active</div>;
  const last = [...snap.train.tail].reverse().find((r) => r.event === "step");
  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="text-[11px] text-[var(--accent-warn)] truncate">▸ {snap.train.running}</div>
      <div className="flex-1 min-h-0"><LossChart rows={snap.train.tail} /></div>
      <div className="grid grid-cols-3 gap-1.5 text-[10px] text-[var(--muted)]">
        <div>loss <span className="text-[var(--text)]">{last?.loss?.toFixed(3) ?? "—"}</span></div>
        <div>step <span className="text-[var(--text)]">{last?.step ?? "—"}</span></div>
        <div>gn <span className="text-[var(--text)]">{last?.grad_norm?.toFixed(2) ?? "—"}</span></div>
      </div>
    </div>
  );
}

function fmtEta(s?: number | null) {
  if (s == null || !isFinite(s)) return "—";
  return s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`;
}

export function TrainKpisWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  if (!snap.train.running) return <div className="h-full flex items-center justify-center text-[11px] text-[var(--muted)]">no training run active</div>;
  const last = [...snap.train.tail].reverse().find((r) => r.event === "step");
  return (
    <div className="grid grid-cols-2 gap-1.5 h-full content-center">
      <Stat label="steps/s" value={last?.steps_s?.toFixed(2) ?? "—"} />
      <Stat label="tok/s" value={last?.tok_s != null ? String(Math.round(last.tok_s)) : "—"} />
      <Stat label="ETA" value={fmtEta(last?.eta)} />
      <Stat label="grad norm" value={last?.grad_norm?.toFixed(2) ?? "—"} />
    </div>
  );
}

export function TrainHistoryWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  const statusColor = (s: string) => s === "running" ? "var(--accent-warn)" : s === "done" ? "var(--accent-success)" : s === "failed" ? "var(--accent-danger)" : "var(--muted)";
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      {snap.runs.slice(0, 20).map((r) => (
        <div key={r.name} className="flex justify-between gap-2">
          <span className="truncate" title={r.name}>{r.name}</span>
          <span style={{ color: statusColor(r.status) }} className="shrink-0">{r.status}</span>
          <span className="text-[var(--muted)] shrink-0 w-12 text-right">{r.finalLoss != null ? r.finalLoss.toFixed(3) : "—"}</span>
        </div>
      ))}
      {!snap.runs.length && <div className="text-[var(--muted)] text-center py-2">no runs yet</div>}
    </div>
  );
}

export function BenchComparisonTableWidget({ ctx, settings }: { ctx: WidgetCtx; settings?: Record<string, unknown> }) {
  const snap = ctx.snap; if (!snap) return empty;
  const suite = ctx.filters.suite || (settings?.suite as string) || snap.battery.suites[0] || "coding";
  const rows = snap.benchSummaries.filter((r) => r.suite === suite);
  if (!rows.length) return <div className="h-full flex items-center justify-center text-[11px] text-[var(--muted)]">no {suite} results yet</div>;
  const cats = [...new Set(rows.flatMap((r) => Object.keys(r.cats || {})))];
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-[10px] border-collapse">
        <thead>
          <tr className="text-[var(--muted)] uppercase tracking-wide">
            <th className="text-left font-normal pb-1">model</th>
            {cats.map((c) => <th key={c} className="text-right font-normal pb-1 pl-2">{c}</th>)}
            <th className="text-right font-normal pb-1 pl-2">tot</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.model} className="border-t border-[var(--border-soft)]">
              <td className="py-1 truncate max-w-[80px]" title={r.model}>
                <span className="inline-block w-1.5 h-1.5 rounded-sm mr-1" style={{ background: PALETTE[i % PALETTE.length] }} />
                {shortName(r.model)}
              </td>
              {cats.map((c) => <td key={c} className="text-right pl-2">{pct(r.cats?.[c]?.ok ?? 0, r.cats?.[c]?.total ?? 0)}%</td>)}
              <td className="text-right pl-2 text-[var(--accent-ai)]">{pct(r.score, r.total)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BenchRadarWidget({ ctx, settings }: { ctx: WidgetCtx; settings?: Record<string, unknown> }) {
  const snap = ctx.snap; if (!snap) return empty;
  const suite = ctx.filters.suite || (settings?.suite as string) || snap.battery.suites[0] || "coding";
  const rows = snap.benchSummaries.filter((r) => r.suite === suite);
  const cats = [...new Set(rows.flatMap((r) => Object.keys(r.cats || {})))];
  if (!rows.length || cats.length < 3) return <div className="h-full flex items-center justify-center text-[11px] text-[var(--muted)]">no {suite} results yet</div>;
  return <RadarChart runs={rows} cats={cats} colorOf={(i) => PALETTE[i % PALETTE.length]} />;
}

export function SpeedBarsWidget({ ctx, settings }: { ctx: WidgetCtx; settings?: Record<string, unknown> }) {
  const snap = ctx.snap; if (!snap) return empty;
  const suite = ctx.filters.suite || (settings?.suite as string) || snap.battery.suites[0] || "coding";
  const rows = snap.benchSummaries.filter((r) => r.suite === suite);
  if (!rows.length) return <div className="h-full flex items-center justify-center text-[11px] text-[var(--muted)]">no {suite} results yet</div>;
  return <MetricPanel title={`${suite} · tok/s`} runs={rows} value={(r) => r.tokSec} fmt={(v) => v.toFixed(1)} colorOf={(i) => PALETTE[i % PALETTE.length]} />;
}

export function ModelRegistryWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      {snap.models.map((m) => (
        <div key={m.name} className="flex justify-between gap-2">
          <span className="truncate" title={m.name}>{shortName(m.name)}</span>
          <span className="text-[var(--muted)] shrink-0">{m.gb.toFixed(1)}GB · {m.source}</span>
        </div>
      ))}
      {!snap.models.length && <div className="text-[var(--muted)] text-center py-2">no models found</div>}
    </div>
  );
}

export function QuickActionsWidget() {
  const btn = "text-[11px] tracking-widest uppercase text-center border border-[var(--border)] rounded-[var(--r-md)] py-2 hover:border-[var(--border-loud)] hover:text-[var(--accent-ai)] transition-colors";
  return (
    <div className="grid grid-cols-2 gap-2 h-full content-center">
      <Link href="/chat" className={btn}>Chat</Link>
      <Link href="/train" className={btn}>Train</Link>
      <Link href="/benchmark" className={btn}>Evaluation</Link>
      <Link href="/library" className={btn}>History</Link>
    </div>
  );
}

// ---- interactive "quick action" widgets: trigger real work without leaving the dashboard ----

type ChatMsg = { role: "user" | "assistant"; content: string };

export function QuickChatWidget({ ctx }: { ctx: WidgetCtx }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages]);
  useEffect(() => {
    fetch("/api/agent/models").then((r) => r.json()).then((j) => setModel(j.current || "")).catch(() => {});
  }, []);

  const changeModel = (m: string) => {
    setModel(m);
    fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m }) }).catch(() => {});
  };

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setText(""); setBusy(true);
    const next = [...messages, { role: "user", content: q } as ChatMsg];
    setMessages([...next, { role: "assistant", content: "" }]);
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text().catch(() => "error"));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", content = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try { const ev = JSON.parse(line) as { k?: string; v?: string }; if (ev.k === "text") content += ev.v ?? ""; } catch {}
        }
        setMessages([...next, { role: "assistant", content }]);
      }
    } catch (e) {
      setMessages([...next, { role: "assistant", content: "error: " + (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full gap-1.5">
      <select aria-label="Quick chat model" value={model} onChange={(e) => changeModel(e.target.value)}
        className="shrink-0 w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[10px] text-[var(--text)] outline-none">
        {model && !ctx.snap?.models.some((m) => m.name === model) && <option value={model}>{model}</option>}
        {(ctx.snap?.models || []).map((m) => <option key={m.name} value={m.name}>{shortName(m.name)}</option>)}
      </select>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 text-[11px]">
        {!messages.length && <div className="text-[var(--muted)] text-center py-4">ask something…</div>}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "self-end max-w-[85%] bg-[var(--accent-ai)]/15 rounded px-2 py-1" : "self-start max-w-[85%] bg-[var(--surface-2)] rounded px-2 py-1"}>
            {m.content || (m.role === "assistant" && busy ? "…" : "")}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-1 shrink-0">
        <input aria-label="Quick chat message" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="quick ask…" disabled={busy}
          className="flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)] outline-none focus:border-[var(--border-loud)]" />
        <button onClick={send} disabled={busy || !text.trim()}
          className="text-[10px] tracking-widest uppercase border border-[var(--border)] rounded px-2 disabled:opacity-40 hover:border-[var(--border-loud)]">→</button>
      </div>
    </div>
  );
}

type DataFile = { name: string; chars: number; kind: "raw" | "sft" };

export function QuickTrainWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap;
  const [bases, setBases] = useState<string[]>([]);
  const [dataFiles, setDataFiles] = useState<DataFile[]>([]);
  const [base, setBase] = useState("");
  const [dataFile, setDataFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch("/api/train?name=").then((r) => r.json()).then((j) => {
      setBases(j.bases || []);
      if (j.bases?.length) setBase((b) => b || j.bases[0]);
    }).catch(() => {});
    fetch("/api/train/data").then((r) => r.json()).then((j) => {
      const files: DataFile[] = (j.files || []).filter((f: DataFile) => f.kind === "sft");
      setDataFiles(files);
      if (files.length) setDataFile((d) => d || files[0].name);
    }).catch(() => {});
  }, []);

  const running = snap?.train.running;
  const last = running ? [...(snap?.train.tail || [])].reverse().find((r) => r.event === "step") : null;

  const start = async () => {
    if (!base || !dataFile || busy) return;
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/train", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "quick-" + Date.now().toString(36), base, mode: "sft", dataFile, steps: 150, lr: 0.0001, targetLoss: 0.1 }),
      }).then((x) => x.json());
      if (r.error) setMsg("✗ " + r.error);
    } catch (e) { setMsg("✗ " + (e as Error).message); }
    setBusy(false);
  };
  const stop = async () => {
    setBusy(true);
    await fetch("/api/train", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) }).catch(() => {});
    setBusy(false);
  };

  const sel = "flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[10px] text-[var(--text)] outline-none";

  if (running) {
    return (
      <div className="flex flex-col gap-1.5 h-full justify-center text-[11px]">
        <div className="text-[var(--accent-warn)] truncate">▸ {running}</div>
        <div className="text-[var(--muted)]">step {last?.step ?? "—"} · loss {last?.loss?.toFixed(3) ?? "—"}</div>
        <button onClick={stop} disabled={busy}
          className="text-[10px] tracking-widest uppercase border border-[var(--accent-danger)] text-[var(--accent-danger)] rounded px-2 py-1 disabled:opacity-40">■ stop</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 h-full justify-center">
      <select aria-label="Quick training base model" value={base} onChange={(e) => setBase(e.target.value)} className={sel}>
        {bases.map((b) => <option key={b} value={b}>{b.split("/").pop()}</option>)}
      </select>
      <select aria-label="Quick training dataset" value={dataFile} onChange={(e) => setDataFile(e.target.value)} className={sel}>
        {dataFiles.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
      </select>
      <button onClick={start} disabled={busy || !base || !dataFile}
        className="text-[10px] tracking-widest uppercase border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)] disabled:opacity-40">▸ quick start (150 steps)</button>
      {msg && <div className="text-[10px] text-[var(--accent-danger)] truncate">{msg}</div>}
    </div>
  );
}

export function QuickBenchWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap;
  const [suiteOverride, setSuiteOverride] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ score: number; total: number } | null>(null);
  const [err, setErr] = useState("");

  if (!snap) return empty;
  const suite = suiteOverride || ctx.filters.suite || snap.battery.suites[0] || "";
  const model = modelOverride || snap.models[0]?.name || "";

  const run = async () => {
    if (!suite || !model || busy) return;
    setBusy(true); setErr(""); setResult(null);
    try {
      const r = await fetch("/api/bench", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, suite }),
      }).then((x) => x.json());
      if (r.error) setErr(r.error); else setResult({ score: r.score, total: r.total });
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const sel = "flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[10px] text-[var(--text)] outline-none";
  return (
    <div className="flex flex-col gap-1.5 h-full justify-center">
      <select aria-label="Quick evaluation suite" value={suite} onChange={(e) => setSuiteOverride(e.target.value)} className={sel}>
        {snap.battery.suites.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <select aria-label="Quick evaluation model" value={model} onChange={(e) => setModelOverride(e.target.value)} className={sel}>
        {snap.models.map((m) => <option key={m.name} value={m.name}>{shortName(m.name)}</option>)}
      </select>
      <button onClick={run} disabled={busy || !suite || !model}
        className="text-[10px] tracking-widest uppercase border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)] disabled:opacity-40">
        {busy ? "running… (can take a while)" : "▸ run bench"}
      </button>
      {result && <div className="text-[10px] text-[var(--accent-ai)]">✓ {result.score}/{result.total}</div>}
      {err && <div className="text-[10px] text-[var(--accent-danger)] truncate">✗ {err}</div>}
    </div>
  );
}


/**
 * Token usage analytics, read from the ledger added 2026-07-25.
 *
 * A widget rather than a replacement dashboard: this grid is user-arranged and the
 * layout is persisted server-side (/api/dashboard), so overwriting page.tsx would
 * have thrown away the operator's configuration to show one new number. Extending
 * the registry is what the registry is for.
 *
 * Fetches on its own rather than riding `ctx.snap`, because usage is historical
 * (a 30-day scan) while snap is a live system poll — different cadence, different
 * lifetime.
 */
type UsageBucket = { key: string; total: number; requests: number };
type UsageSummary = {
  totals: { total: number; prompt: number; completion: number; requests: number };
  byHour: UsageBucket[];
  byWeekday: UsageBucket[];
  byModel: UsageBucket[];
  byDevice: UsageBucket[];
  busiestHour: UsageBucket | null;
  busiestWeekday: UsageBucket | null;
};

const compactTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

function UsageBars({ buckets }: { buckets: UsageBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div className="flex flex-col gap-[2px]">
      {buckets.map((b) => (
        <div key={b.key} className="flex items-center gap-1.5 text-[11px]">
          <span className="w-10 shrink-0 truncate text-[var(--muted)]" title={b.key}>{b.key}</span>
          <div className="h-1.5 flex-1 rounded-[var(--r-sm)] bg-[var(--surface-2)]">
            <div
              className="h-full rounded-[var(--r-sm)]"
              style={{ width: `${(b.total / max) * 100}%`, background: b.total ? "var(--accent-ai)" : "transparent" }}
            />
          </div>
          {/* An empty bucket shows a dash, not 0: "no activity" and "no data" must
              not look the same. */}
          <span className="w-10 shrink-0 text-right text-[var(--muted)] tabular-nums">
            {b.total ? compactTokens(b.total) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function UsageAnalyticsWidget({ settings }: { ctx: WidgetCtx; settings?: Record<string, unknown> }) {
  const days = typeof settings?.["days"] === "number" ? (settings["days"] as number) : 30;
  const view = typeof settings?.["view"] === "string" ? (settings["view"] as string) : "hour";
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/lal/usage?days=${days}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as UsageSummary;
      })
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      // Show the failure. A usage panel silently rendering zeroes is how the
      // previous telemetry drop stayed invisible for weeks.
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setData(null); } });
    return () => { cancelled = true; };
  }, [days]);

  if (error) return <div className="text-[11px] text-[var(--accent-danger)]">usage unavailable: {error}</div>;
  if (!data) return empty;
  if (!data.totals.requests) {
    return (
      <div className="py-2 text-center text-[11px] text-[var(--muted)]">
        no usage recorded yet
        <div className="mt-1 opacity-70">the ledger only collects from when it shipped</div>
      </div>
    );
  }

  const buckets =
    view === "weekday" ? data.byWeekday : view === "model" ? data.byModel.slice(0, 8) : view === "device" ? data.byDevice.slice(0, 8) : data.byHour;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-[var(--muted)]">{data.totals.requests} req · {days}d</span>
        <span className="font-semibold" style={{ color: "var(--accent-ai)" }}>{compactTokens(data.totals.total)} tok</span>
      </div>
      <div className="flex gap-2 text-[11px] text-[var(--muted)]">
        <span>peak {data.busiestHour ? `${data.busiestHour.key}:00` : "—"}</span>
        <span>·</span>
        <span>{data.busiestWeekday?.key ?? "—"}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <UsageBars buckets={buckets} />
      </div>
    </div>
  );
}

export type WidgetDef = {
  title: string; minW: number; minH: number; defW: number; defH: number;
  component: (p: { ctx: WidgetCtx; settings?: Record<string, unknown> }) => React.ReactNode;
  defaultSettings?: Record<string, unknown>;
};

export const WIDGETS: Record<string, WidgetDef> = {
  "gpu-vram": { title: "GPU / VRAM", minW: 3, minH: 1, defW: 3, defH: 3, component: GpuVramWidget },
  "cpu-ram": { title: "CPU / RAM", minW: 3, minH: 1, defW: 3, defH: 3, component: CpuRamWidget },
  temps: { title: "Temps", minW: 1, minH: 1, defW: 2, defH: 2, component: TempsWidget },
  "serving-status": { title: "Serving", minW: 1, minH: 1, defW: 3, defH: 2, component: ServingStatusWidget },
  "runtime-telemetry": { title: "Runtime telemetry", minW: 3, minH: 2, defW: 4, defH: 3, component: RuntimeTelemetryWidget },
  "guardian-status": { title: "Guardian coverage", minW: 3, minH: 2, defW: 4, defH: 3, component: GuardianStatusWidget },
  "guardian-timeline": { title: "Guardian timeline", minW: 4, minH: 3, defW: 5, defH: 5, component: GuardianTimelineWidget },
  "guardian-adapters": { title: "Guardian adapters", minW: 3, minH: 3, defW: 5, defH: 4, component: GuardianAdaptersWidget },
  "guardian-findings": { title: "Guardian findings", minW: 4, minH: 3, defW: 6, defH: 4, component: GuardianFindingsWidget },
  "train-live": { title: "Training (live)", minW: 4, minH: 2, defW: 6, defH: 4, component: TrainLiveWidget },
  "train-kpis": { title: "Training KPIs", minW: 2, minH: 1, defW: 3, defH: 2, component: TrainKpisWidget },
  "train-history": { title: "Train history", minW: 3, minH: 2, defW: 4, defH: 4, component: TrainHistoryWidget },
  "bench-radar": { title: "Bench radar", minW: 4, minH: 3, defW: 5, defH: 5, component: BenchRadarWidget, defaultSettings: { suite: "coding" } },
  "bench-comparison-table": { title: "Bench table", minW: 4, minH: 2, defW: 6, defH: 3, component: BenchComparisonTableWidget, defaultSettings: { suite: "coding" } },
  "speed-bars": { title: "Speed (tok/s)", minW: 3, minH: 2, defW: 4, defH: 3, component: SpeedBarsWidget, defaultSettings: { suite: "coding" } },
  "model-registry": { title: "Models", minW: 3, minH: 2, defW: 4, defH: 4, component: ModelRegistryWidget },
  "quick-actions": { title: "Quick actions", minW: 2, minH: 1, defW: 3, defH: 2, component: QuickActionsWidget },
  "quick-chat": { title: "Quick chat", minW: 3, minH: 3, defW: 4, defH: 5, component: QuickChatWidget },
  "quick-train": { title: "Quick train", minW: 3, minH: 2, defW: 3, defH: 3, component: QuickTrainWidget },
  "quick-bench": { title: "Quick bench", minW: 3, minH: 2, defW: 3, defH: 3, component: QuickBenchWidget },
  // Four instances can coexist with different `view` settings — hour / weekday /
  // model / device — which is why the breakdown is a setting and not four widgets.
  "usage-hours": { title: "Tokens by hour", minW: 3, minH: 3, defW: 3, defH: 5, component: UsageAnalyticsWidget, defaultSettings: { view: "hour", days: 30 } },
  "usage-models": { title: "Tokens by model", minW: 3, minH: 2, defW: 3, defH: 3, component: UsageAnalyticsWidget, defaultSettings: { view: "model", days: 30 } },
  "usage-weekdays": { title: "Tokens by weekday", minW: 3, minH: 2, defW: 3, defH: 3, component: UsageAnalyticsWidget, defaultSettings: { view: "weekday", days: 30 } },
  "usage-devices": { title: "Tokens by device", minW: 3, minH: 2, defW: 3, defH: 3, component: UsageAnalyticsWidget, defaultSettings: { view: "device", days: 30 } },
};

export function widgetMinSize(type: string) {
  const w = WIDGETS[type];
  return { minW: w?.minW ?? 2, minH: w?.minH ?? 2 };
}

export function renderWidgetBody(w: GridWidget, ctx: WidgetCtx) {
  const def = WIDGETS[w.type];
  if (!def) return <div className="text-[11px] text-[var(--accent-danger)]">unknown widget: {w.type}</div>;
  const Component = def.component;
  return <Component ctx={ctx} settings={w.settings} />;
}

// pct/shortName re-exported for pages that build widget settings pickers.
export { pct, shortName };

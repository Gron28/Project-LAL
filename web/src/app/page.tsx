"use client";
import { useCallback, useEffect, useState } from "react";
import { Grid, nextSlot, type GridLayout } from "@/components/grid";
import { WIDGETS, widgetMinSize, renderWidgetBody, type WidgetCtx, type Filters } from "@/components/widgets";
import { useDashboard } from "@/lib/use-dashboard";

const DEFAULT_LAYOUT: GridLayout = {
  cols: 12,
  widgets: [
    { id: "w1", type: "gpu-vram", x: 0, y: 0, w: 3, h: 3 },
    { id: "w2", type: "cpu-ram", x: 3, y: 0, w: 3, h: 3 },
    { id: "w3", type: "serving-status", x: 6, y: 0, w: 3, h: 3 },
    { id: "w4", type: "quick-actions", x: 9, y: 0, w: 3, h: 3 },
    { id: "w5", type: "train-live", x: 0, y: 3, w: 7, h: 4 },
    { id: "w6", type: "bench-radar", x: 7, y: 3, w: 5, h: 5, settings: { suite: "coding" } },
    { id: "w7", type: "speed-bars", x: 0, y: 7, w: 4, h: 3, settings: { suite: "coding" } },
    { id: "w8", type: "model-registry", x: 4, y: 7, w: 3, h: 3 },
  ],
};

export default function Dashboard() {
  const { snap, cpuHist, gpuHist } = useDashboard();
  const [filters, setFilters] = useState<Filters>({});
  const ctx: WidgetCtx = { snap, cpuHist, gpuHist, filters };
  const [layout, setLayout] = useState<GridLayout>(DEFAULT_LAYOUT);
  const [editing, setEditing] = useState(false);
  const [addType, setAddType] = useState(Object.keys(WIDGETS)[0]);

  useEffect(() => {
    fetch("/api/dashboard").then((r) => r.json()).then((j) => {
      if (j.layout?.widgets?.length) setLayout(j.layout);
    }).catch(() => {});
  }, []);

  const persist = useCallback((l: GridLayout) => {
    setLayout(l);
    fetch("/api/dashboard", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "default", layout: l }),
    }).catch(() => {});
  }, []);

  const addWidget = () => {
    const def = WIDGETS[addType];
    const { x, y } = nextSlot(layout.widgets, layout.cols, def.defW, def.defH);
    const id = "w" + Date.now().toString(36);
    persist({
      ...layout,
      widgets: [...layout.widgets, { id, type: addType, x, y, w: def.defW, h: def.defH, settings: def.defaultSettings }],
    });
  };

  return (
    <div className="font-chat min-h-dvh bg-[var(--bg)] text-[var(--text)] px-[12px] pt-4 pb-16">
      <div className="w-full flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-[var(--accent-ai)] tracking-widest font-bold">◉ DASHBOARD</h1>
          <div className="ml-2 flex items-center gap-1.5">
            <span className="text-[9px] tracking-widest uppercase text-[var(--muted)]">suite</span>
            <select value={filters.suite || ""} onChange={(e) => setFilters((f) => ({ ...f, suite: e.target.value || undefined }))}
              className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)]">
              <option value="">(per-widget)</option>
              {(snap?.battery.suites || []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {editing && (
              <>
                <select value={addType} onChange={(e) => setAddType(e.target.value)}
                  className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)]">
                  {Object.entries(WIDGETS).map(([k, w]) => <option key={k} value={k}>{w.title}</option>)}
                </select>
                <button onClick={addWidget} className="text-[11px] tracking-widest uppercase border border-[var(--border)] rounded px-3 py-1 hover:border-[var(--border-loud)]">+ add</button>
              </>
            )}
            <button onClick={() => setEditing((v) => !v)}
              className="text-[11px] tracking-widest uppercase rounded px-3 py-1"
              style={{ background: editing ? "var(--accent-ai)" : "transparent", color: editing ? "#05090c" : "var(--text-2)", border: "1px solid var(--border)" }}>
              {editing ? "done" : "edit layout"}
            </button>
          </div>
        </div>

        <Grid layout={layout} editable={editing} onChange={persist} minSize={widgetMinSize}
          renderWidget={(w) => renderWidgetBody(w, ctx)} />
      </div>
    </div>
  );
}

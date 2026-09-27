"use client";
import { useCallback, useEffect, useState } from "react";
import { Grid, nextSlot, type GridLayout } from "@/components/grid";
import { WIDGETS, widgetMinSize, renderWidgetBody, type WidgetCtx, type Filters } from "@/components/widgets";
import { useDashboard } from "@/lib/use-dashboard";
import { Button } from "@/components/ui/button";

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
    { id: "w9", type: "runtime-telemetry", x: 7, y: 8, w: 5, h: 2 },
    { id: "w10", type: "guardian-status", x: 7, y: 10, w: 5, h: 3 },
    { id: "w11", type: "guardian-timeline", x: 0, y: 10, w: 7, h: 4 },
    { id: "w12", type: "guardian-adapters", x: 7, y: 13, w: 5, h: 4 },
    { id: "w13", type: "guardian-findings", x: 0, y: 14, w: 7, h: 3 },
  ],
};

// The original customizable widget grid, kept intact as the "Widgets" view of
// Home for people who built their own layouts.
export function WidgetBoard() {
  const { snap, cpuHist, gpuHist } = useDashboard();
  const [filters, setFilters] = useState<Filters>({});
  const ctx: WidgetCtx = { snap, cpuHist, gpuHist, filters };
  const [layout, setLayout] = useState<GridLayout>(DEFAULT_LAYOUT);
  const [editing, setEditing] = useState(false);
  const [addType, setAddType] = useState(Object.keys(WIDGETS)[0]);

  const stopEverything = async () => {
    if (!confirm("Stop every active agent and release models from the GPU?")) return;
    await fetch("/api/agent/runs/stop-all", { method: "POST" }).catch(() => {});
  };

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
      <div className="flex flex-col gap-[var(--gutter)]">
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-2">
          <select value={filters.suite || ""} onChange={(e) => setFilters((f) => ({ ...f, suite: e.target.value || undefined }))}
            title="Global benchmark suite filter"
            aria-label="Global benchmark suite filter"
            className="control h-10 py-0 text-xs">
            <option value="">Suite: per-widget</option>
            {(snap?.battery.suites || []).map((s) => <option key={s} value={s}>Suite: {s}</option>)}
          </select>
          {editing && (
            <>
              <select value={addType} onChange={(e) => setAddType(e.target.value)} aria-label="Widget to add"
                className="control h-10 py-0 text-xs">
                {Object.entries(WIDGETS).map(([k, w]) => <option key={k} value={k}>{w.title}</option>)}
              </select>
              <Button size="sm" onClick={addWidget} className="uppercase border border-[var(--border)] hover:border-[var(--border-loud)]">Add widget</Button>
            </>
          )}
          <Button size="sm" active={editing} onClick={() => setEditing((v) => !v)} className="uppercase border border-[var(--border)] whitespace-nowrap">
            {editing ? "done" : "edit layout"}
          </Button>
          <Button size="sm" onClick={stopEverything} className="ml-auto uppercase border border-[var(--accent-danger)] text-[var(--accent-danger)] whitespace-nowrap">
            stop all agents
          </Button>
        </div>
        <Grid layout={layout} editable={editing} onChange={persist} minSize={widgetMinSize}
          renderWidget={(w) => renderWidgetBody(w, ctx)} />
      </div>
  );
}

"use client";
// Hand-rolled 12-column drag/resize grid — house style is zero-dep, and
// react-grid-layout's React 19 peer support is unverified. Pointer-events based;
// drag by header, resize by corner handle, snap-to-cell, push-down collision.
import { useCallback, useEffect, useRef, useState } from "react";

export type GridWidget = { id: string; type: string; x: number; y: number; w: number; h: number; settings?: Record<string, unknown> };
export type GridLayout = { cols: number; widgets: GridWidget[] };
type DragMode = "move" | "resize" | "resize-x" | "resize-y";

const ROW_H = 48;
const GAP = 8;

function collides(a: GridWidget, b: GridWidget) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
// BFS cascade from the active widget only: push whatever it now overlaps straight
// down below it, then treat each pushed widget as a new obstacle and repeat. Directed
// (active → descendants), so two widgets can never push each other back and forth.
function pushDown(widgets: GridWidget[], activeId: string): GridWidget[] {
  const out = widgets.map((w) => ({ ...w }));
  const active = out.find((w) => w.id === activeId);
  if (!active) return out;
  const settled = new Set([activeId]);
  const queue = [active];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const w of out) {
      if (settled.has(w.id) || !collides(cur, w)) continue;
      w.y = cur.y + cur.h;
      settled.add(w.id);
      queue.push(w);
    }
  }
  return out;
}

export function Grid({
  layout, editable, onChange, minSize, renderWidget, renderChrome,
}: {
  layout: GridLayout;
  editable: boolean;
  onChange: (l: GridLayout) => void;
  minSize: (type: string) => { minW: number; minH: number };
  renderWidget: (w: GridWidget) => React.ReactNode;
  renderChrome?: (w: GridWidget, remove: () => void) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [colW, setColW] = useState(80);
  const drag = useRef<{ id: string; mode: DragMode; startX: number; startY: number; orig: GridWidget } | null>(null);
  const [live, setLive] = useState<GridLayout>(layout);
  const [syncedLayout, setSyncedLayout] = useState(layout);
  if (layout !== syncedLayout) { setSyncedLayout(layout); setLive(layout); } // adjust state during render, not in an effect

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      setColW((w - GAP * (layout.cols - 1)) / layout.cols);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.cols]);

  const rows = Math.max(4, ...live.widgets.map((w) => w.y + w.h)) + (editable ? 2 : 0);

  const onPointerDown = useCallback((e: React.PointerEvent, id: string, mode: DragMode) => {
    if (!editable) return;
    e.preventDefault(); e.stopPropagation();
    const w = live.widgets.find((x) => x.id === id); if (!w) return;
    drag.current = { id, mode, startX: e.clientX, startY: e.clientY, orig: { ...w } };
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [editable, live]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    const cellX = Math.round(dx / (colW + GAP));
    const cellY = Math.round(dy / (ROW_H + GAP));
    setLive((prev) => {
      const cols = prev.cols;
      const widgets = prev.widgets.map((w) => {
        if (w.id !== d.id) return w;
        if (d.mode === "move") {
          const x = Math.max(0, Math.min(cols - w.w, d.orig.x + cellX));
          const y = Math.max(0, d.orig.y + cellY);
          return { ...w, x, y };
        } else {
          const { minW, minH } = minSize(w.type);
          const wNew = d.mode === "resize-y" ? w.w : Math.max(minW, Math.min(cols - w.x, d.orig.w + cellX));
          const hNew = d.mode === "resize-x" ? w.h : Math.max(minH, d.orig.h + cellY);
          return { ...w, w: wNew, h: hNew };
        }
      });
      return { ...prev, widgets: pushDown(widgets, d.id) };
    });
  }, [colW, minSize]);

  const onPointerUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    onChange(live);
  }, [live, onChange]);

  const remove = useCallback((id: string) => {
    const widgets = live.widgets.filter((w) => w.id !== id);
    setLive((p) => ({ ...p, widgets }));
    onChange({ ...live, widgets });
  }, [live, onChange]);

  const cellRect = useCallback((w: GridWidget) => ({
    left: w.x * (colW + GAP),
    top: w.y * (ROW_H + GAP),
    width: w.w * colW + (w.w - 1) * GAP,
    height: w.h * ROW_H + (w.h - 1) * GAP,
  }), [colW]);

  // Below md, drag/resize is disabled and widgets stack in a single column by y —
  // same layout data, no separate mobile config.
  return (
    <div ref={ref} className="relative w-full">
      <div
        className="hidden md:block relative"
        style={{ height: rows * ROW_H + (rows - 1) * GAP }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {live.widgets.map((w) => (
          <div key={w.id} className="absolute transition-[left,top,width,height] duration-100"
            style={{ ...cellRect(w), touchAction: editable ? "none" : undefined }}>
            <div className="h-full flex flex-col bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)] overflow-hidden">
              {editable && (
                <div className="flex items-center gap-1 px-2 h-5 bg-[var(--surface-2)] border-b border-[var(--border-soft)] cursor-move shrink-0"
                  onPointerDown={(e) => onPointerDown(e, w.id, "move")}>
                  <span className="text-[9px] tracking-widest uppercase text-[var(--muted)] flex-1 truncate">{w.type}</span>
                  {renderChrome?.(w, () => remove(w.id))}
                  <button onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(w.id)}
                    className="text-[var(--muted)] hover:text-[var(--accent-danger)] text-[11px] leading-none px-0.5">✕</button>
                </div>
              )}
              <div className="flex-1 min-h-0 overflow-auto p-1.5">{renderWidget(w)}</div>
              {editable && (
                <>
                  {/* right edge: width-only */}
                  <div onPointerDown={(e) => onPointerDown(e, w.id, "resize-x")}
                    className="absolute top-2 bottom-2 right-0 w-2.5 cursor-ew-resize hover:bg-[var(--accent-ai)]/20" />
                  {/* bottom edge: height-only */}
                  <div onPointerDown={(e) => onPointerDown(e, w.id, "resize-y")}
                    className="absolute left-2 right-2 bottom-0 h-2.5 cursor-ns-resize hover:bg-[var(--accent-ai)]/20" />
                  {/* corner: both — bigger grip, easier to grab */}
                  <div onPointerDown={(e) => onPointerDown(e, w.id, "resize")}
                    className="absolute right-0 bottom-0 w-6 h-6 cursor-nwse-resize opacity-60 hover:opacity-100"
                    style={{ background: "linear-gradient(135deg, transparent 45%, var(--border-loud) 45%)" }} />
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {/* mobile: stacked single column, read-only */}
      <div className="flex md:hidden flex-col gap-3">
        {[...live.widgets].sort((a, b) => a.y - b.y).map((w) => (
          <div key={w.id} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)] overflow-hidden">
            <div className="px-3 h-7 flex items-center bg-[var(--surface-2)] border-b border-[var(--border-soft)] text-[9px] tracking-widest uppercase text-[var(--muted)]">{w.type}</div>
            <div className="p-2">{renderWidget(w)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function nextSlot(widgets: GridWidget[], cols: number, w: number, h: number): { x: number; y: number } {
  // first free row where a w×h rect doesn't collide with anything
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x <= cols - w; x++) {
      const cand: GridWidget = { id: "__probe", type: "", x, y, w, h };
      if (!widgets.some((o) => collides(cand, o))) return { x, y };
    }
  }
  return { x: 0, y: Math.max(0, ...widgets.map((o) => o.y + o.h)) };
}

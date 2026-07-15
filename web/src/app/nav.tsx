"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, Cpu, LayoutDashboard, MessageSquare, TerminalSquare, GraduationCap, Library, Gauge, Network, Radio, X } from "lucide-react";
import { ICON_SIZE } from "@/components/ui/icon";
import { SignalTrace } from "@/components/ui/signal-trace";

// One place for the active/inactive link look, shared by the desktop rail and
// the mobile bottom bar instead of each copy-pasting its own ternary. Quiet by
// design: a subtle background tint + colored text/icon, no full-color fill, no
// glow — active should read as "selected," not "lit up."
function navItemStyle(isActive: boolean) {
  return {
    background: isActive ? "color-mix(in srgb, var(--accent-ai) 14%, transparent)" : "transparent",
    color: isActive ? "var(--accent-ai)" : "var(--text-2)",
    fontWeight: isActive ? 600 : 400,
  };
}

// Small truth-teller for the GPU: which model is resident and for how long it's
// been idle, with a manual unload. The server also auto-unloads after the
// serveIdleMinutes setting — this exists so the state is VISIBLE, not invisible
// power draw you only notice from the fan noise.
function GpuBadge() {
  const [info, setInfo] = useState<{ model: string | null; idleSec: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const j = await fetch("/api/sysinfo").then((r) => r.json());
        if (alive) setInfo(j.serving ?? null);
      } catch { /* server away — badge just goes quiet */ }
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!info?.model) return null;
  const idle = info.idleSec != null && info.idleSec >= 60 ? ` · idle ${Math.floor(info.idleSec / 60)}m` : "";
  return (
    <div className="mx-2 px-0 lg:px-3 py-1.5 flex items-center justify-center lg:justify-start gap-2 text-[10px] text-[var(--muted)]"
      title={`GPU model resident: ${info.model}${idle}`}>
      <Cpu size={ICON_SIZE.md} className="text-[var(--accent-ai)] shrink-0" />
      <span className="hidden lg:inline truncate max-w-[70px]">{info.model}{idle}</span>
      <SignalTrace size="sm" className="hidden lg:inline-flex" />
      <button title="unload model from GPU now"
        className="hidden lg:inline text-[var(--muted)] hover:text-[var(--accent-danger)]"
        onClick={async () => {
          try { const r = await fetch("/api/sysinfo", { method: "DELETE" }); if (r.ok) setInfo(null); } catch {}
        }}>
        <X size={ICON_SIZE.sm} />
      </button>
    </div>
  );
}

type ActiveRun = {
  id: string;
  kind: "chat" | "code" | "deliberate" | "hive";
  conversationId: string;
  model: string;
  status: string;
  executionLocation?: "host" | "client";
  ownerDeviceId?: string;
};

// The host has one practical model lease today, so an active host run must be
// visible from every page instead of being trapped in the surface that started it.
function ActiveRunNotice() {
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(() => {
    try { return typeof window === "undefined" ? null : sessionStorage.getItem("lal-dismissed-active-run"); } catch { return null; }
  });
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const runs = await fetch("/api/agent/runs?limit=10").then((r) => r.ok ? r.json() : []);
        const active = Array.isArray(runs) ? runs.find((item) => item?.status === "running") : null;
        if (alive) setRun(active ?? null);
      } catch { if (alive) setRun(null); }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!run || dismissedRunId === run.id) return null;
  const href = run.kind === "chat"
    ? `/chat?conv=${encodeURIComponent(run.conversationId)}`
    : run.kind === "code" || run.kind === "deliberate"
      ? `/code?conv=${encodeURIComponent(run.conversationId)}`
      : run.kind === "hive" ? "/hive" : "/library";
  const terminalLinked = run.executionLocation === "client";
  const label = terminalLinked
    ? "Terminal code"
    : run.kind === "deliberate" ? "Research" : run.kind[0].toUpperCase() + run.kind.slice(1);
  const device = terminalLinked && run.ownerDeviceId ? ` on ${run.ownerDeviceId}` : "";
  return (
    <div className="fixed z-[60] top-2 left-1/2 -translate-x-1/2 max-w-[calc(100vw-1rem)] rounded-full border border-[var(--border-loud)] bg-[var(--surface-1)] shadow-lg flex items-center text-[10px] text-[var(--text-2)]">
      <Link href={href} className="min-w-0 px-3 py-1.5 flex items-center gap-2 hover:text-[var(--accent-ai)] transition-colors" title={`Open active ${label.toLowerCase()} run ${run.id}${device}`}>
        <Radio size={12} className="text-[var(--accent-ai)] animate-pulse shrink-0" />
        <span className="font-medium text-[var(--text)] whitespace-nowrap">{label} active</span>
        <span className="truncate max-w-28 sm:max-w-48">{run.model}</span>
        <span className="text-[var(--accent-ai)]">open</span>
      </Link>
      <button
        type="button"
        aria-label="dismiss active-run notification"
        title="dismiss this notification until a different run starts"
        className="mr-1 p-1 rounded-full text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors"
        onClick={() => {
          setDismissedRunId(run.id);
          try { sessionStorage.setItem("lal-dismissed-active-run", run.id); } catch {}
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

// Monitor's sysinfo now lives in dashboard widgets, so it's dropped from nav to
// keep the mobile bottom bar (h-14) compact — the route itself still exists.
const items = [
  { href: "/", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/chat", label: "Chat", Icon: MessageSquare },
  { href: "/code", label: "Code", Icon: TerminalSquare },
  { href: "/hive", label: "Hive", Icon: Network },
  { href: "/train", label: "Train", Icon: GraduationCap },
  { href: "/monitor", label: "Monitor", Icon: Activity },
  { href: "/library", label: "Library", Icon: Library },
  { href: "/benchmark", label: "Bench", Icon: Gauge },
];

export default function Nav({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const p = usePathname();
  const active = (h: string) => (h === "/" ? p === "/" : p.startsWith(h));

  return (
    <>
      <ActiveRunNotice />
      {/* Desktop: left icon rail (expands to labels on lg) — collapsible to reclaim
          screen width; collapsed state takes NO layout space at all, with a small
          floating button left to bring it back. */}
      {!collapsed && (
        <nav className="hidden md:flex md:flex-col fixed left-0 top-0 h-dvh w-12 lg:w-36 bg-[var(--surface-1)] border-r border-[var(--border)] z-50 py-2 gap-0.5">
          <div className="px-0 lg:px-3 mb-2 text-center lg:text-left">
            <span className="text-[var(--text-2)] text-[11px] tracking-wide" style={{ fontFamily: "var(--font-display), monospace" }}>
              <span className="hidden lg:inline">Local AI Lab</span><span className="lg:hidden">LAL</span>
            </span>
          </div>
          {items.map(({ href, label, Icon }) => (
            <Link key={href} href={href}
              className="flex items-center justify-center lg:justify-start gap-2.5 mx-1.5 px-0 lg:px-2.5 py-2 rounded-[var(--r-md)] text-xs transition-colors"
              style={navItemStyle(active(href))}>
              <Icon size={ICON_SIZE.md} /><span className="hidden lg:inline">{label}</span>
            </Link>
          ))}
          <div className="mt-auto">
            <GpuBadge />
            <button onClick={onToggle} title="hide sidebar"
              className="flex items-center justify-center lg:justify-start gap-2 mx-2 px-0 lg:px-3 py-2 rounded-[var(--r-md)] text-[var(--muted)] hover:text-[var(--text-2)] transition-colors w-[calc(100%-1rem)]">
              <ChevronLeft size={ICON_SIZE.md} /><span className="hidden lg:inline text-xs">hide</span>
            </button>
          </div>
        </nav>
      )}
      {collapsed && (
        <button onClick={onToggle} title="show sidebar"
          className="hidden md:flex fixed left-2 bottom-3 z-50 items-center justify-center w-8 h-8 rounded-full bg-[var(--surface-1)] border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--accent-ai)] shadow-lg transition-colors">
          <ChevronRight size={ICON_SIZE.md} />
        </button>
      )}

      {/* Mobile: bottom tab bar (unaffected by the desktop rail's collapse state) */}
      <nav className="flex md:hidden fixed bottom-0 left-0 right-0 h-14 bg-[var(--surface-1)] border-t border-[var(--border)] z-50 pb-[env(safe-area-inset-bottom)]">
        {items.map(({ href, label, Icon }) => (
          <Link key={href} href={href} className="flex-1 flex flex-col items-center justify-center gap-0.5 text-[9px] tracking-wide"
            style={{ color: active(href) ? "var(--accent-ai)" : "var(--text-2)" }}>
            <Icon size={ICON_SIZE.md} /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}

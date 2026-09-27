"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, BarChart3, Boxes, ChevronLeft, ChevronRight, Database, Download, LayoutDashboard, MessageSquare, TerminalSquare, GraduationCap, Network, Radio, ShieldCheck, X } from "lucide-react";
import { ICON_SIZE } from "@/components/ui/icon";
import { SignalTrace } from "@/components/ui/signal-trace";

// One place for the active/inactive link look, shared by the desktop rail and
// the mobile bottom bar instead of each copy-pasting its own ternary. Quiet by
// design: a subtle background tint + colored text/icon, no full-color fill, no
// glow — active should read as "selected," not "lit up."
function navItemClass(isActive: boolean) {
  return "nav-item" + (isActive ? " nav-item-active" : "");
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
  const idle = info.idleSec != null && info.idleSec >= 60 ? `idle ${Math.floor(info.idleSec / 60)}m` : "serving";
  return (
    <div className="mx-1 mb-2 flex items-center justify-center lg:justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 lg:px-3 py-2"
      title={`GPU model resident: ${info.model} · ${idle}`}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="relative grid place-items-center w-2 h-2 shrink-0"><span className="w-2 h-2 rounded-full bg-[var(--status-success)]" /></span>
        <span className="hidden lg:flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[12px] text-[var(--text-primary)]">{info.model}</span>
          <span className="text-[11px] text-[var(--text-muted)]">Local · {idle}</span>
        </span>
      </span>
      <span className="hidden lg:flex items-center gap-2">
        <SignalTrace size="sm" />
        <button title="Unload model from GPU now" aria-label="Unload model from GPU"
          className="grid place-items-center w-6 h-6 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--status-error)] hover:bg-[var(--bg-interactive)]"
          onClick={async () => {
            try { const r = await fetch("/api/sysinfo", { method: "DELETE" }); if (r.ok) setInfo(null); } catch {}
          }}>
          <X size={ICON_SIZE.sm} />
        </button>
      </span>
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
    <div className="fixed z-[60] top-2 left-1/2 -translate-x-1/2 max-w-[calc(100vw-1rem)] rounded-full border border-[var(--border-default)] bg-[var(--bg-panel-raised)] shadow-[var(--shadow-panel)] flex items-center text-[11px] text-[var(--text-2)]">
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

/** Inventory failures used to become an indistinguishable empty dropdown in
 * every surface. Keep the actual state visible globally and route recovery to
 * the dedicated diagnostics/download page. */
function ModelInventoryNotice() {
  const [notice, setNotice] = useState<{ state: "empty" | "failed"; detail: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const response = await fetch("/api/agent/models", { cache: "no-store" });
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) throw new Error(`HTTP ${response.status} returned non-JSON content`);
        const body = await response.json();
        const inventory = body?.inventory;
        if (!response.ok || inventory?.state === "failed") {
          if (alive) setNotice({ state: "failed", detail: inventory?.diagnostics?.[0] || body?.error || `HTTP ${response.status}` });
        } else if (inventory?.state === "empty") {
          if (alive) setNotice({ state: "empty", detail: "No local models were found." });
        } else if (alive) setNotice(null);
      } catch (error) {
        if (alive) setNotice({ state: "failed", detail: error instanceof Error ? error.message : String(error) });
      }
    };
    void check(); const timer = setInterval(check, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!notice) return null;
  return <Link href="/models" className="fixed z-[59] top-11 left-1/2 -translate-x-1/2 max-w-[calc(100vw-1rem)] px-3 py-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-panel-raised)] shadow-[var(--shadow-panel)] flex items-center gap-2 text-[11px] text-[var(--text-2)] hover:text-[var(--accent-ai)]" title={notice.detail}>
    {notice.state === "failed" ? <AlertTriangle size={12} className="text-[var(--accent-danger)] shrink-0" /> : <Download size={12} className="text-[var(--accent-ai)] shrink-0" />}
    <span className="truncate">{notice.state === "failed" ? "Model inventory failed" : "No models installed"}</span><span className="text-[var(--accent-ai)] shrink-0">open Models</span>
  </Link>;
}

const primaryItems = [
  { href: "/", label: "Home", Icon: LayoutDashboard },
  { href: "/chat", label: "Chat", Icon: MessageSquare },
  { href: "/code", label: "Code", Icon: TerminalSquare },
  { href: "/hive", label: "Hive", Icon: Network },
  { href: "/guardian", label: "Guardian", Icon: ShieldCheck },
  { href: "/train", label: "Lab", Icon: GraduationCap },
];

const labPaths = ["/train", "/models", "/benchmark", "/library", "/lens", "/cli", "/install"];
const labItems = [
  { href: "/train", label: "Training", Icon: GraduationCap },
  { href: "/models", label: "Models", Icon: Boxes },
  { href: "/benchmark", label: "Evaluation", Icon: BarChart3 },
  { href: "/library", label: "History", Icon: Database },
  { href: "/cli", label: "CLI", Icon: TerminalSquare },
];


// User-supplied LAL mark, cropped to keep it legible in the navigation.
function BrandMark({ size = 32 }: { size?: number }) {
  // The user-supplied mark is an SVG asset, shared with all app icons.
  return <img src="/app-icons/lal-mark.svg?v=6" width={size} height={size} alt="" aria-hidden="true" className="object-contain w-full h-full" />;
}

export default function Nav({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const p = usePathname();
  const active = (h: string) => h === "/" ? p === "/" : h === "/train" ? labPaths.some((path) => p.startsWith(path)) : p.startsWith(h);

  return (
    <>
      <ActiveRunNotice />
      <ModelInventoryNotice />
      {/* Desktop: left icon rail (expands to labels on lg) — collapsible to reclaim
          screen width; collapsed state takes NO layout space at all, with a small
          floating button left to bring it back. */}
      {!collapsed && (
        <nav aria-label="Primary" className="hidden md:flex md:flex-col fixed left-0 top-0 h-dvh w-[var(--sidebar-rail)] lg:w-[var(--sidebar-width)] bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] z-50 px-2 lg:px-3 py-4 overflow-y-auto">
          <Link href="/" className="grid place-items-center mb-6 pt-1" aria-label="LAL home" title="LAL home">
            {/* The mark alone: it is the brand, and the wordmark only repeated it. */}
            <span className="block w-12 h-12 lg:w-[132px] lg:h-[110px]"><BrandMark /></span>
          </Link>
          <div className="nav-section">Workspace</div>
          <div className="flex flex-col gap-0.5">
            {primaryItems.filter((item) => item.href !== "/train").map(({ href, label, Icon }) => (
              <Link key={href} href={href} title={label} aria-current={active(href) ? "page" : undefined} className={navItemClass(active(href))}>
                <Icon size={18} strokeWidth={1.75} /><span className="hidden lg:inline">{label}</span>
              </Link>
            ))}
          </div>
          <div className="nav-section mt-5">Lab</div>
          <div className="flex flex-col gap-0.5">
            {labItems.map(({ href, label, Icon }) => {
              const selected = p.startsWith(href) || (href === "/benchmark" && p.startsWith("/lens"));
              return <Link key={href} href={href} title={label} aria-current={selected ? "page" : undefined} className={navItemClass(selected)}>
                <Icon size={18} strokeWidth={1.75} /><span className="hidden lg:inline">{label}</span>
              </Link>;
            })}
          </div>
          <div className="mt-auto pt-4 flex flex-col gap-0.5">
            <GpuBadge />
            <Link href="/install" title="Install LAL on desktop or phone" aria-current={p.startsWith("/install") ? "page" : undefined} className={navItemClass(p.startsWith("/install"))}>
              <Download size={18} strokeWidth={1.75} /><span className="hidden lg:inline">Install app</span>
            </Link>
            <button onClick={onToggle} title="Hide sidebar" className="nav-item w-full">
              <ChevronLeft size={18} strokeWidth={1.75} /><span className="hidden lg:inline">Hide sidebar</span>
            </button>
          </div>
        </nav>
      )}
      {collapsed && (
        <button onClick={onToggle} title="show sidebar"
          className="hidden md:flex fixed left-2 bottom-3 z-50 items-center justify-center w-9 h-9 rounded-full bg-[var(--bg-panel-raised)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-accent)] shadow-[var(--shadow-panel)] transition-colors">
          <ChevronRight size={ICON_SIZE.md} />
        </button>
      )}

      {/* Mobile: bottom tab bar (unaffected by the desktop rail's collapse state) */}
      <nav aria-label="Primary" className="grid grid-cols-6 md:hidden fixed bottom-0 left-0 right-0 min-h-16 bg-[color-mix(in_srgb,var(--bg-sidebar)_94%,transparent)] backdrop-blur-xl border-t border-[var(--border-subtle)] z-50 pb-[env(safe-area-inset-bottom)]">
        {primaryItems.map(({ href, label, Icon }) => (
          <Link key={href} href={href} aria-current={active(href) ? "page" : undefined} className="min-h-16 flex flex-col items-center justify-center gap-1 text-[11px] font-medium"
            style={{ color: active(href) ? "var(--text-accent)" : "var(--text-secondary)" }}>
            <Icon size={20} strokeWidth={1.75} /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}

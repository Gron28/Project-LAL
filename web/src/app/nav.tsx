"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, BarChart3, Boxes, ChevronLeft, ChevronRight, Cpu, Database, Download, LayoutDashboard, MessageSquare, TerminalSquare, GraduationCap, Network, Radio, ShieldCheck, X } from "lucide-react";
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
  return <Link href="/models" className="fixed z-[59] top-11 left-1/2 -translate-x-1/2 max-w-[calc(100vw-1rem)] px-3 py-1.5 rounded-full border border-[var(--border-loud)] bg-[var(--surface-1)] shadow-lg flex items-center gap-2 text-[10px] text-[var(--text-2)] hover:text-[var(--accent-ai)]" title={notice.detail}>
    {notice.state === "failed" ? <AlertTriangle size={12} className="text-[var(--accent-danger)] shrink-0" /> : <Download size={12} className="text-[var(--accent-ai)] shrink-0" />}
    <span className="truncate">{notice.state === "failed" ? "Model inventory failed" : "No models installed"}</span><span className="text-[var(--accent-ai)] shrink-0">open Models</span>
  </Link>;
}

const primaryItems = [
  { href: "/", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/chat", label: "Chat", Icon: MessageSquare },
  { href: "/code", label: "Code", Icon: TerminalSquare },
  { href: "/hive", label: "Hive", Icon: Network },
  { href: "/guardian", label: "Guardian", Icon: ShieldCheck },
  { href: "/train", label: "Lab", Icon: GraduationCap },
];

const labPaths = ["/train", "/models", "/benchmark", "/library", "/lens", "/cli"];
const labItems = [
  { href: "/train", label: "Training", Icon: GraduationCap },
  { href: "/models", label: "Models", Icon: Boxes },
  { href: "/benchmark", label: "Evaluation", Icon: BarChart3 },
  { href: "/library", label: "History", Icon: Database },
  { href: "/cli", label: "CLI", Icon: TerminalSquare },
];


/**
 * The CLI's mark, at nav scale.
 *
 * apps/cli/.../AsciiArt.ts draws it in 11 lines of block glyphs: an apex, two legs
 * descending, a wide crossbar through them, and small inverted legs below. That is
 * too tall for a 12px rail, so this is the same geometry as strokes rather than a
 * shrunken screenshot of the ASCII — it stays legible at 16px and shares the
 * accent colour, which is what makes the two surfaces read as one product.
 */
function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      aria-hidden="true"
    >
      {/* apex + legs */}
      <path d="M12 3 L4 17" />
      <path d="M12 3 L20 17" />
      {/* the crossbar, wider than the legs — the logo's defining stroke */}
      <path d="M2 13 L22 13" />
      {/* the small inverted legs beneath */}
      <path d="M8 21 L11 17" />
      <path d="M16 21 L13 17" />
    </svg>
  );
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
        <nav aria-label="Primary" className="hidden md:flex md:flex-col fixed left-0 top-0 h-dvh w-[72px] lg:w-[224px] bg-[color-mix(in_srgb,var(--surface-1)_96%,transparent)] backdrop-blur-xl border-r border-[var(--border)] z-50 px-2 lg:px-3 py-4 gap-1">
          <div className="px-1 lg:px-2 mb-5 text-center lg:text-left">
            <span className="flex items-center justify-center lg:justify-start gap-3 text-[var(--text)] text-sm font-semibold tracking-[-.01em]">
              <span className="w-9 h-9 grid place-items-center rounded-[var(--r-md)] bg-[var(--accent-ai)] text-[#071006]"><BrandMark size={19} /></span>
              {/* "LAL" everywhere, matching the CLI and the `lal` command, instead of
                  a longer name the terminal never uses. */}
              <span className="hidden lg:inline"><b className="block">Local AI Lab</b><small className="block mt-0.5 text-[10px] font-normal uppercase tracking-[.14em] text-[var(--text-3)]">Workstation</small></span>
            </span>
          </div>
          <div className="hidden lg:block px-2 mb-1 text-[10px] font-semibold uppercase tracking-[.15em] text-[var(--text-3)]">Workspace</div>
          {primaryItems.map(({ href, label, Icon }) => (
            <Link key={href} href={href}
              aria-current={active(href) ? "page" : undefined}
              className="min-h-11 flex items-center justify-center lg:justify-start gap-3 px-0 lg:px-3 rounded-[var(--r-md)] text-[13px] transition-colors"
              style={navItemStyle(active(href))}>
              <Icon size={18} /><span className="hidden lg:inline">{label}</span>
            </Link>
          ))}
          <div className="hidden lg:block mt-5 px-2 mb-1 text-[10px] font-semibold uppercase tracking-[.15em] text-[var(--text-3)]">Lab</div>
          <div className="hidden lg:flex flex-col gap-0.5">
            {labItems.map(({ href, label, Icon }) => {
              const selected = p.startsWith(href) || (href === "/benchmark" && p.startsWith("/lens"));
              return <Link key={href} href={href} aria-current={selected ? "page" : undefined}
                className="min-h-9 flex items-center gap-3 rounded-[var(--r-md)] px-3 text-xs transition-colors"
                style={{ color: selected ? "var(--accent-ai)" : "var(--text-3)", background: selected ? "color-mix(in srgb, var(--accent-ai) 8%, transparent)" : "transparent" }}>
                <Icon size={14} />{label}
              </Link>;
            })}
          </div>
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
      <nav aria-label="Primary" className="grid grid-cols-6 md:hidden fixed bottom-0 left-0 right-0 min-h-16 bg-[color-mix(in_srgb,var(--surface-1)_96%,transparent)] backdrop-blur-xl border-t border-[var(--border)] z-50 pb-[env(safe-area-inset-bottom)]">
        {primaryItems.map(({ href, label, Icon }) => (
          <Link key={href} href={href} aria-current={active(href) ? "page" : undefined} className="min-h-16 flex flex-col items-center justify-center gap-1 text-[10px] font-medium tracking-wide"
            style={{ color: active(href) ? "var(--accent-ai)" : "var(--text-2)" }}>
            <Icon size={19} /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}

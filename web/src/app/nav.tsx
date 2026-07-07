"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, LayoutDashboard, MessageSquare, TerminalSquare, GraduationCap, Library, Gauge } from "lucide-react";

// Monitor's sysinfo now lives in dashboard widgets, so it's dropped from nav to
// keep the mobile bottom bar (h-14) compact — the route itself still exists.
const items = [
  { href: "/", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/chat", label: "Chat", Icon: MessageSquare },
  { href: "/code", label: "Code", Icon: TerminalSquare },
  { href: "/train", label: "Train", Icon: GraduationCap },
  { href: "/library", label: "Library", Icon: Library },
  { href: "/benchmark", label: "Bench", Icon: Gauge },
];

export default function Nav({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const p = usePathname();
  const active = (h: string) => (h === "/" ? p === "/" : p.startsWith(h));

  return (
    <>
      {/* Desktop: left icon rail (expands to labels on lg) — collapsible to reclaim
          screen width; collapsed state takes NO layout space at all, with a small
          floating button left to bring it back. */}
      {!collapsed && (
        <nav className="hidden md:flex md:flex-col fixed left-0 top-0 h-dvh w-14 lg:w-44 bg-[var(--surface-1)] border-r border-[var(--border)] z-50 py-3 gap-1">
          <div className="flex items-center px-0 lg:px-4 mb-3 text-[var(--accent-ai)] font-bold tracking-widest text-sm">
            <span className="flex-1 text-center lg:text-left">◉<span className="hidden lg:inline"> LOCAL&nbsp;AI&nbsp;LAB</span></span>
          </div>
          {items.map(({ href, label, Icon }) => (
            <Link key={href} href={href}
              className="flex items-center justify-center lg:justify-start gap-3 mx-2 px-0 lg:px-3 py-2.5 rounded-[var(--r-md)] text-sm transition-colors"
              style={{ background: active(href) ? "var(--accent-ai)" : "transparent", color: active(href) ? "#05090c" : "var(--text-2)", fontWeight: active(href) ? 700 : 400 }}>
              <Icon size={18} /><span className="hidden lg:inline">{label}</span>
            </Link>
          ))}
          <button onClick={onToggle} title="hide sidebar"
            className="flex items-center justify-center lg:justify-start gap-2 mx-2 mt-auto px-0 lg:px-3 py-2 rounded-[var(--r-md)] text-[var(--muted)] hover:text-[var(--text-2)] transition-colors">
            <ChevronLeft size={16} /><span className="hidden lg:inline text-xs">hide</span>
          </button>
        </nav>
      )}
      {collapsed && (
        <button onClick={onToggle} title="show sidebar"
          className="hidden md:flex fixed left-2 top-3 z-50 items-center justify-center w-8 h-8 rounded-full bg-[var(--surface-1)] border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--accent-ai)] shadow-lg transition-colors">
          <ChevronRight size={15} />
        </button>
      )}

      {/* Mobile: bottom tab bar (unaffected by the desktop rail's collapse state) */}
      <nav className="flex md:hidden fixed bottom-0 left-0 right-0 h-14 bg-[var(--surface-1)] border-t border-[var(--border)] z-50 pb-[env(safe-area-inset-bottom)]">
        {items.map(({ href, label, Icon }) => (
          <Link key={href} href={href} className="flex-1 flex flex-col items-center justify-center gap-0.5 text-[9px] tracking-wide"
            style={{ color: active(href) ? "var(--accent-ai)" : "var(--text-2)" }}>
            <Icon size={19} /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}

"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, GraduationCap, Library, Gauge, Activity } from "lucide-react";

const items = [
  { href: "/", label: "Chat", Icon: MessageSquare },
  { href: "/train", label: "Train", Icon: GraduationCap },
  { href: "/library", label: "Library", Icon: Library },
  { href: "/benchmark", label: "Bench", Icon: Gauge },
  { href: "/monitor", label: "Monitor", Icon: Activity },
];

export default function Nav() {
  const p = usePathname();
  const active = (h: string) => (h === "/" ? p === "/" : p.startsWith(h));

  return (
    <>
      {/* Desktop: left icon rail (expands to labels on lg) */}
      <nav className="hidden md:flex md:flex-col fixed left-0 top-0 h-dvh w-14 lg:w-44 bg-[var(--surface-1)] border-r border-[var(--border)] z-50 py-3 gap-1">
        <div className="px-0 lg:px-4 mb-3 text-center lg:text-left text-[var(--accent-ai)] font-bold tracking-widest text-sm">
          ◉<span className="hidden lg:inline"> LOCAL&nbsp;AI&nbsp;LAB</span>
        </div>
        {items.map(({ href, label, Icon }) => (
          <Link key={href} href={href}
            className="flex items-center justify-center lg:justify-start gap-3 mx-2 px-0 lg:px-3 py-2.5 rounded-[var(--r-md)] text-sm transition-colors"
            style={{ background: active(href) ? "var(--accent-ai)" : "transparent", color: active(href) ? "#05090c" : "var(--text-2)", fontWeight: active(href) ? 700 : 400 }}>
            <Icon size={18} /><span className="hidden lg:inline">{label}</span>
          </Link>
        ))}
      </nav>

      {/* Mobile: bottom tab bar */}
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

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Boxes, Database, GraduationCap, TerminalSquare } from "lucide-react";

const items = [
  { href: "/train", label: "Training", Icon: GraduationCap },
  { href: "/models", label: "Models", Icon: Boxes },
  { href: "/benchmark", label: "Evaluation", Icon: BarChart3 },
  { href: "/library", label: "History", Icon: Database },
  { href: "/cli", label: "CLI", Icon: TerminalSquare },
];

export function LabNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Lab sections" className="mb-5 grid grid-cols-5 items-center gap-1 rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-1.5">
      {items.map(({ href, label, Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined}
            className="min-w-0 min-h-10 inline-flex items-center justify-center gap-1.5 rounded-[var(--r-md)] px-1.5 sm:px-3.5 text-[11px] sm:text-xs font-medium transition-colors"
            style={{ color: active ? "#071006" : "var(--text-2)", background: active ? "var(--accent-ai)" : "transparent" }}>
            <Icon size={15} />{label}
          </Link>
        );
      })}
    </nav>
  );
}

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
    // Desktop reaches these from the sidebar's Lab section; this bar only exists
    // for phones, where the bottom tab bar has a single "Lab" entry.
    <nav aria-label="Lab sections" className="seg md:hidden w-full">
      {items.map(({ href, label, Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined}
            className="flex-1 justify-center">
            <Icon size={15} />{label}
          </Link>
        );
      })}
    </nav>
  );
}

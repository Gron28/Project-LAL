"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Nav() {
  const p = usePathname();
  const link = (href: string, label: string) => (
    <Link
      href={href}
      style={{
        padding: "4px 10px", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
        borderRadius: 3, textDecoration: "none",
        color: p === href ? "#05090c" : "#a7d4c1",
        background: p === href ? "#34ffa6" : "#0b1318",
        border: "1px solid #26513f", fontWeight: p === href ? 700 : 400,
      }}
    >
      {label}
    </Link>
  );
  return (
    <div style={{ position: "fixed", bottom: 10, right: 10, zIndex: 100, display: "flex", gap: 6, fontFamily: "monospace" }}>
      {link("/", "▶ Chat")}
      {link("/train", "▣ Train")}
    </div>
  );
}

"use client";
// Wraps Nav + page content so both can share the desktop sidebar's collapsed state —
// layout.tsx renders Nav and the content padding as siblings, but collapsing the rail
// has to shrink BOTH the rail's own width and the content's left padding together.
import { useEffect, useState } from "react";
import Nav from "./nav";
import { NavCollapsedProvider } from "./nav-context";

export default function NavShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem("nav_collapsed") === "1"); } catch {}
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("nav_collapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  };

  return (
    <NavCollapsedProvider value={collapsed}>
      <Nav collapsed={collapsed} onToggle={toggle} />
      <div className={collapsed ? "" : "md:pl-14 lg:pl-44"}>{children}</div>
    </NavCollapsedProvider>
  );
}

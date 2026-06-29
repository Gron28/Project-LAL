"use client";
import { useEffect, useState } from "react";

export default function ChatModes() {
  const [web, setWeb] = useState(false);
  const [docs, setDocs] = useState(false);

  useEffect(() => { fetch("/api/modes").then((r) => r.json()).then((j) => { setWeb(!!j.web); setDocs(!!j.groundDocs); }); }, []);

  const save = (w: boolean, d: boolean) => { setWeb(w); setDocs(d); fetch("/api/modes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ web: w, groundDocs: d }) }); };

  const chip = (on: boolean, label: string, onClick: () => void, title: string) => (
    <button onClick={onClick} title={title} style={{
      padding: "4px 9px", fontSize: 10, letterSpacing: ".1em", borderRadius: 999, cursor: "pointer",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      color: on ? "#05090c" : "#a7d4c1", background: on ? "#34ffa6" : "#0b1318",
      border: `1px solid ${on ? "#34ffa6" : "#26513f"}`, fontWeight: on ? 700 : 400,
    }}>{label}</button>
  );

  return (
    <div style={{ position: "fixed", top: 10, right: 10, zIndex: 90, display: "flex", gap: 6 }}>
      {chip(web, "🌐 Web", () => save(!web, docs), "Ground every reply in live web search")}
      {chip(docs, "📄 Docs", () => save(web, !docs), "Ground every reply in your uploaded documents")}
    </div>
  );
}

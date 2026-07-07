"use client";
import { useEffect, useState } from "react";
import { RadarChart, MetricPanel, ScatterPlot, PALETTE, pct, shortName, type Res } from "@/components/charts";

const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";
const head = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";

const SUITES = [
  { id: "fractal", label: "Fractal (facts · logic · code)" },
  { id: "general", label: "General (math · lore)" },
];
const CAT_ORDER = ["fact", "logic", "code", "lore", "math"];

type Item = { cat: string; q: string; a: string[] };

// View / edit / add / delete / import the questions in a suite.
function TestManager({ suiteId, onClose, onSaved }: { suiteId: string; onClose: () => void; onSaved: () => void }) {
  const [sid, setSid] = useState(suiteId);
  const [label, setLabel] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [importText, setImportText] = useState("");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [msg, setMsg] = useState("");
  const [allSuites, setAllSuites] = useState<{ id: string; label: string; count: number }[]>([]);

  const loadList = () => fetch("/api/suites").then((r) => r.json()).then((j) => setAllSuites(j.suites || [])).catch(() => {});
  const load = (id: string) => fetch("/api/suites?id=" + id).then((r) => r.json()).then((j) => { if (j.items) { setItems(j.items); setLabel(j.label || id); setSid(id); } }).catch(() => {});
  useEffect(() => { loadList(); load(suiteId); }, [suiteId]);

  const set = (i: number, patch: Partial<Item>) => setItems((p) => p.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const add = () => setItems((p) => [...p, { cat: "fact", q: "", a: [""] }]);
  const del = (i: number) => setItems((p) => p.filter((_, j) => j !== i));

  const save = async () => {
    const r = await fetch("/api/suites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sid, label, items }) }).then((x) => x.json());
    setMsg(r.error ? "✗ " + r.error : `✓ saved ${r.count} questions`); loadList(); onSaved();
    setTimeout(() => setMsg(""), 2500);
  };
  const doImport = async () => {
    const r = await fetch("/api/suites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sid, label, importText, mode }) }).then((x) => x.json());
    if (r.error) { setMsg("✗ " + r.error); } else { setImportText(""); setMsg(`✓ imported → ${r.count} total`); load(sid); loadList(); onSaved(); }
    setTimeout(() => setMsg(""), 3000);
  };
  const newSuite = () => { const id = prompt("New suite id (letters/numbers/-_):"); if (!id) return; setSid(id); setLabel(id); setItems([]); };
  const delSuite = async () => { if (!confirm(`Delete suite "${sid}"?`)) return; await fetch("/api/suites?id=" + sid, { method: "DELETE" }).catch(() => {}); onSaved(); onClose(); };

  const inp = "bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)] outline-none";
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center overflow-auto p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)] my-4">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border-soft)] sticky top-0 bg-[var(--surface-1)]">
          <span className="text-sm font-semibold">Manage tests</span>
          <select value={sid} onChange={(e) => load(e.target.value)} className={inp + " ml-2"}>
            {allSuites.map((s) => <option key={s.id} value={s.id}>{s.id} ({s.count})</option>)}
            {!allSuites.some((s) => s.id === sid) && <option value={sid}>{sid} (new)</option>}
          </select>
          <button onClick={newSuite} className="text-xs text-[var(--accent-ai)] hover:underline">+ new suite</button>
          <button onClick={delSuite} className="text-xs text-[var(--accent-danger)] hover:underline">delete suite</button>
          <span className="ml-auto text-[10px] text-[var(--accent-ai)]">{msg}</span>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white text-lg leading-none px-1">×</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Label</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} className={inp + " flex-1"} />
            <span className="text-[10px] text-[var(--muted)]">{items.length} questions</span>
          </div>

          <div className="border border-[var(--border-soft)] rounded-[var(--r-md)] divide-y divide-[var(--border-soft)] max-h-[40vh] overflow-auto">
            {items.map((it, i) => (
              <div key={i} className="flex gap-2 p-2 items-start">
                <input value={it.cat} onChange={(e) => set(i, { cat: e.target.value })} className={inp + " w-16 shrink-0"} title="category" />
                <textarea value={it.q} onChange={(e) => set(i, { q: e.target.value })} rows={2} className={inp + " flex-1 resize-y"} placeholder="question" />
                <input value={it.a.join(" | ")} onChange={(e) => set(i, { a: e.target.value.split("|").map((s) => s.trim()).filter(Boolean) })} className={inp + " w-40 shrink-0"} placeholder="answers (a | b)" title="accepted answers, separated by |" />
                <button onClick={() => del(i)} className="text-[var(--accent-danger)] hover:opacity-80 text-sm px-1 shrink-0">×</button>
              </div>
            ))}
            {items.length === 0 && <div className="p-4 text-center text-xs text-[var(--muted)]">No questions. Add one or import below.</div>}
          </div>
          <div className="flex gap-2">
            <button onClick={add} className="text-xs border border-[var(--border)] rounded px-3 py-1.5 hover:border-[var(--border-loud)]">+ Add question</button>
            <button onClick={save} className="text-xs font-semibold bg-[var(--accent-ai)] text-[var(--bg)] rounded px-4 py-1.5 ml-auto">Save suite</button>
          </div>

          <div className="border-t border-[var(--border-soft)] pt-3">
            <div className="text-[10px] uppercase tracking-widest text-[var(--muted)] mb-1.5">Import questions (JSON array or JSONL)</div>
            <p className="text-[10px] text-[var(--muted)] mb-2 leading-snug">Accepts our format <code>{`{cat,q,a}`}</code> or common ones <code>{`{question, answer}`}</code> / <code>{`{prompt, output}`}</code> — paste GSM8K, HumanEval-style sets, etc.</p>
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={4} className={inp + " w-full font-mono resize-y"} placeholder='[{"cat":"math","q":"2+2?","a":["4"]}]  or  {"question":"...","answer":"..."} per line' />
            <div className="flex items-center gap-2 mt-2">
              <label className="text-[10px] text-[var(--muted)]">mode</label>
              <select value={mode} onChange={(e) => setMode(e.target.value as "append" | "replace")} className={inp}><option value="append">append</option><option value="replace">replace</option></select>
              <button onClick={doImport} disabled={!importText.trim()} className="text-xs font-semibold border border-[var(--accent-ai)]/50 text-[var(--accent-ai)] rounded px-4 py-1.5 ml-auto disabled:opacity-40">Import</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Benchmark() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [suite, setSuite] = useState("fractal");
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Res[]>([]);
  const [detail, setDetail] = useState<Res | null>(null);
  const [suiteList, setSuiteList] = useState<{ id: string; label: string; count: number }[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());

  useEffect(() => { fetch("/api/agent/models").then((r) => r.json()).then((j) => { setModels(j.models || []); setModel(j.current || j.models?.[0] || ""); }); }, []);
  // seed from persisted results so the dashboard shows every saved benchmark on load
  useEffect(() => { fetch("/api/bench").then((r) => r.json()).then((j) => { if (Array.isArray(j.results)) setRuns(j.results); }).catch(() => {}); }, []);
  const loadSuites = () => fetch("/api/suites").then((r) => r.json()).then((j) => setSuiteList(j.suites || [])).catch(() => {});
  useEffect(() => { loadSuites(); }, []);

  const run = async () => {
    setRunning(true);
    try {
      const r: Res = await fetch("/api/bench", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, suite }) }).then((x) => x.json());
      if (!("error" in r)) {
        setRuns((prev) => [...prev.filter((p) => !(p.model === r.model && p.suite === r.suite)), r]);
        setDetail(r);
      }
    } catch { /* ignore */ }
    setRunning(false);
  };

  const deleteResult = async (r: Res) => {
    await fetch(`/api/bench?suite=${encodeURIComponent(r.suite)}&model=${encodeURIComponent(r.model)}`, { method: "DELETE" }).catch(() => {});
    setRuns((prev) => prev.filter((p) => !(p.model === r.model && p.suite === r.suite)));
    if (detail?.model === r.model && detail?.suite === r.suite) setDetail(null);
  };

  const toggleModel = (m: string) => setHiddenModels((prev) => { const s = new Set(prev); if (s.has(m)) s.delete(m); else s.add(m); return s; });

  const allSuiteRuns = runs.filter((r) => r.suite === suite);
  const suiteRuns = allSuiteRuns.filter((r) => !hiddenModels.has(r.model));
  const colorOf = (i: number) => PALETTE[i % PALETTE.length];
  const cats = CAT_ORDER.filter((c) => suiteRuns.some((r) => r.cats[c]));
  const verdict = (() => {
    if (suiteRuns.length < 2) return null;
    const after = suiteRuns[suiteRuns.length - 1];
    const before = suiteRuns[suiteRuns.length - 2];
    const delta = (c: string) => pct(after.cats[c]?.ok ?? 0, after.cats[c]?.total ?? 0) - pct(before.cats[c]?.ok ?? 0, before.cats[c]?.total ?? 0);
    return { before, after, delta };
  })();

  return (
    <div className="font-chat min-h-dvh bg-[var(--bg)] text-[var(--text)] p-4 pb-16">
      <div className="max-w-5xl mx-auto flex flex-col gap-4">
        <h1 className="text-[var(--accent-ai)] tracking-widest font-bold">◉ BENCHMARK</h1>

        <div className={card + " p-4 flex flex-wrap items-end gap-3"}>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[10px] tracking-widest uppercase text-[var(--muted)] mb-1.5">Suite</label>
            <select className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-sm" value={suite} onChange={(e) => setSuite(e.target.value)}>
              {(suiteList.length ? suiteList : SUITES.map((s) => ({ id: s.id, label: s.label, count: 0 }))).map((s) => <option key={s.id} value={s.id}>{s.label || s.id}{s.count ? ` (${s.count})` : ""}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[10px] tracking-widest uppercase text-[var(--muted)] mb-1.5">Model</label>
            <select className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-sm" value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m}>{m}</option>)}</select>
          </div>
          <button onClick={() => setManageOpen(true)} className="border border-[var(--border)] text-[var(--text-2)] rounded-[var(--r-md)] px-4 py-2.5 text-sm font-bold tracking-widest uppercase hover:border-[var(--border-loud)]">⚙ Tests</button>
          <button onClick={run} disabled={running || !model} className="bg-[var(--accent-ai)] disabled:bg-[var(--border)] disabled:text-[var(--muted)] text-[var(--bg)] rounded-[var(--r-md)] px-5 py-2.5 text-sm font-bold tracking-widest uppercase">{running ? "running…" : "▶ Run"}</button>
        </div>
        {manageOpen && <TestManager suiteId={suite} onClose={() => setManageOpen(false)} onSaved={loadSuites} />}

        {/* Model filter + delete */}
        {allSuiteRuns.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Models:</span>
            {allSuiteRuns.map((r, i) => {
              const hidden = hiddenModels.has(r.model);
              return (
                <span key={r.model} className="inline-flex items-center rounded-[var(--r-md)] border overflow-hidden"
                  style={{ borderColor: hidden ? "var(--border)" : colorOf(i), opacity: hidden ? 0.5 : 1 }}>
                  <button onClick={() => toggleModel(r.model)}
                    className="inline-flex items-center gap-1.5 text-[10px] px-2.5 py-1"
                    style={{ background: hidden ? "var(--surface-1)" : colorOf(i) + "22", color: hidden ? "var(--muted)" : colorOf(i) }}
                    title={hidden ? "Show in charts" : "Hide from charts"}>
                    <span className="w-2 h-2 rounded-sm" style={{ background: colorOf(i) }} />
                    {shortName(r.model)}
                  </button>
                  <button onClick={() => deleteResult(r)}
                    className="px-2 py-1 text-[11px] border-l hover:bg-[var(--accent-danger)] hover:text-white transition-colors"
                    style={{ borderColor: hidden ? "var(--border)" : colorOf(i), color: "var(--muted)", background: hidden ? "var(--surface-1)" : colorOf(i) + "11" }}
                    title="Delete this benchmark result">✕</button>
                </span>
              );
            })}
          </div>
        )}

        {/* Visual dashboard */}
        {suiteRuns.length > 0 && (
          <div className={card + " p-4"}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] tracking-widest uppercase text-[var(--text-2)]">Visual dashboard · {suite}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 justify-end">
                {suiteRuns.map((r, i) => (
                  <span key={r.model} className="inline-flex items-center gap-1 text-[10px] text-[var(--text-2)]">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(i) }} />{shortName(r.model)}
                  </span>
                ))}
              </div>
            </div>
            <div className="text-[11px] uppercase tracking-widest text-[var(--muted)] mb-2 text-center">Intelligence by dimension</div>
            <RadarChart runs={suiteRuns} cats={cats} colorOf={colorOf} />
            <div className="grid sm:grid-cols-3 gap-4 mt-5">
              <MetricPanel title="Intelligence (overall %)" runs={suiteRuns} value={(r) => pct(r.score, r.total)} fmt={(v) => v + "%"} colorOf={colorOf} />
              <MetricPanel title="Speed (tok/s)" runs={suiteRuns} value={(r) => r.tokSec ?? null} fmt={(v) => String(v)} colorOf={colorOf} />
              <MetricPanel title="Weight (GB)" runs={suiteRuns} value={(r) => r.sizeGb ?? null} fmt={(v) => v.toFixed(1)} colorOf={colorOf} />
            </div>
            <div className="mt-5 border-t border-[var(--border-soft)] pt-4">
              <div className="text-[10px] uppercase tracking-widest text-[var(--muted)] mb-1">Efficiency · smarter↑ faster→ (bubble = weight)</div>
              <ScatterPlot runs={suiteRuns} colorOf={colorOf} />
            </div>
          </div>
        )}

        {/* Verdict: did training improve logic & code while math held? */}
        {verdict && (
          <div className={card + " p-4"}>
            <div className="text-[11px] tracking-widest uppercase text-[var(--text-2)] mb-3">Verdict · {shortName(verdict.before.model)} → {shortName(verdict.after.model)}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {cats.map((c) => {
                const d = verdict.delta(c);
                const colr = c === "math" ? (Math.abs(d) <= 5 ? "var(--accent-ai)" : "var(--accent-danger)") : d > 0 ? "var(--accent-ai)" : d < 0 ? "var(--accent-danger)" : "var(--text-2)";
                return (
                  <div key={c} className="bg-[var(--surface-2)] rounded-[var(--r-md)] p-3">
                    <div className="text-[10px] uppercase tracking-widest text-[var(--muted)]">{c}{c === "math" ? " (control)" : ""}</div>
                    <div className="text-lg font-bold" style={{ color: colr }}>{d > 0 ? "+" : ""}{d}%</div>
                    <div className="text-[10px] text-[var(--muted)]">{pct(verdict.before.cats[c]?.ok ?? 0, verdict.before.cats[c]?.total ?? 0)}% → {pct(verdict.after.cats[c]?.ok ?? 0, verdict.after.cats[c]?.total ?? 0)}%</div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-[var(--muted)] mt-3 leading-relaxed">Green = improved. <b>logic</b> and <b>code</b> rising means training taught transferable skill, not just memorized facts. <b>math (control)</b> should stay flat — a big drop means the model degraded.</p>
          </div>
        )}

        {/* Comparison table */}
        {suiteRuns.length > 0 && (
          <div className={card}>
            <div className={head}><span className="text-[var(--accent-ai)]">◆</span> Comparison · {suite}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[var(--muted)] uppercase tracking-widest text-[10px]">
                    <th className="text-left px-4 py-2">Model</th>
                    {cats.map((c) => <th key={c} className="px-3 py-2">{c}</th>)}
                    <th className="px-3 py-2">total</th>
                    <th className="px-3 py-2">tok/s</th>
                    <th className="px-3 py-2">GB</th>
                  </tr>
                </thead>
                <tbody>
                  {suiteRuns.map((r, ri) => (
                    <tr key={r.model} className="border-t border-[var(--border-soft)] cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => setDetail(r)}>
                      <td className="text-left px-4 py-2 font-medium"><span className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: colorOf(ri) }} />{shortName(r.model)}</td>
                      {cats.map((c) => {
                        const p = pct(r.cats[c]?.ok ?? 0, r.cats[c]?.total ?? 0);
                        return <td key={c} className="px-3 py-2 text-center" style={{ color: p >= 67 ? "var(--accent-ai)" : p >= 34 ? "var(--accent-warn)" : "var(--accent-danger)" }}>{r.cats[c] ? `${p}%` : "—"}</td>;
                      })}
                      <td className="px-3 py-2 text-center font-bold text-[var(--accent-ai)]">{r.score}/{r.total}</td>
                      <td className="px-3 py-2 text-center text-[var(--text-2)]">{r.tokSec ?? "—"}</td>
                      <td className="px-3 py-2 text-center text-[var(--text-2)]">{r.sizeGb?.toFixed(1) ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-[var(--muted)] px-4 py-2 border-t border-[var(--border-soft)]">Run the base model first, then your trained one — rows stack for before/after. Click a row for per-question detail.</p>
          </div>
        )}

        {/* Per-question detail */}
        {detail && (
          <div className={card}>
            <div className={head}><span className="text-[var(--accent-ai)]">◆</span> {shortName(detail.model)} <span className="ml-auto text-[var(--accent-ai)]">{detail.score}/{detail.total} · {detail.tokSec} tok/s{detail.sizeGb ? ` · ${detail.sizeGb.toFixed(1)}GB` : ""}</span></div>
            <div className="max-h-[50vh] overflow-auto text-xs">
              {(detail.results || []).map((r, i) => (
                <div key={i} className="px-4 py-2 border-b border-[var(--border-soft)] last:border-0 flex gap-2">
                  <span style={{ color: r.ok ? "var(--accent-ai)" : "var(--accent-danger)" }}>{r.ok ? "✓" : "✗"}</span>
                  <span className="text-[9px] uppercase tracking-widest text-[var(--muted)] w-10 shrink-0 pt-0.5">{r.cat}</span>
                  <span className="flex-1">
                    <span className="text-[var(--text-2)]">{r.q}</span><br />
                    <span className="text-[var(--muted)]">→ {r.got || "(empty)"}</span>
                    {r.detail && <><br /><span className="text-[10px] text-[var(--muted)] italic">{r.detail}</span></>}
                    {r.shot && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <a href={`/api/webshot?id=${r.shot}`} target="_blank" rel="noreferrer" className="block mt-1.5">
                        <img src={`/api/webshot?id=${r.shot}`} alt="rendered app" className="max-h-40 rounded border border-[var(--border-soft)]" />
                      </a>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-[10px] text-[var(--muted)] leading-relaxed">
          Splits intelligence into <b>fact</b> (recall), <b>logic</b> (predicting fractal behavior for new variables), and <b>code</b>, with <b>math</b> as a control. Benchmark the base, train, then benchmark the trained model — the radar and verdict show whether logic & code actually improved while the model held its general ability.
        </p>
      </div>
    </div>
  );
}

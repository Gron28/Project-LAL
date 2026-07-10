"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Clock3, Database, Gauge, Pin, PinOff, Play, Settings2, Sparkles, Trash2 } from "lucide-react";
import { ScatterPlot, PALETTE, pct, shortName, type Res } from "@/components/charts";
import { BenchmarkTimeline, CapabilityProfile, DeltaChart, MetricBars, QuestionDifficultyMatrix } from "@/components/benchmark-visuals";
import LensWorkbench from "@/components/lens-workbench";
import { Panel } from "@/components/ui/panel";

const head = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";

const SUITES = [
  { id: "gsm8k", label: "GSM8K (grade-school math reasoning)" },
  { id: "fractal", label: "Fractal (facts · logic · code)" },
  { id: "general", label: "General (math · lore)" },
];
const CAT_ORDER = ["gsm8k", "math", "fact", "logic", "code", "lore"];
const SUITE_PRIORITY = ["gsm8k", "capability", "coding", "planning", "agentic", "instruct", "webgen", "orchestrator", "general", "fractal"];

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
  const [view, setView] = useState<"scores" | "lens">("scores");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [suite, setSuite] = useState("gsm8k");
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Res[]>([]);
  const [detail, setDetail] = useState<Res | null>(null);
  const [suiteList, setSuiteList] = useState<{ id: string; label: string; count: number }[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "lens") queueMicrotask(() => setView("lens"));
    fetch("/api/agent/models").then((r) => r.json()).then((j) => { setModels(j.models || []); setModel(j.current || j.models?.[0] || ""); });
    fetch("/api/bench").then((r) => r.json()).then((j) => { if (Array.isArray(j.results)) setRuns(j.results); }).catch(() => {});
  }, []);
  const loadSuites = () => fetch("/api/suites").then((r) => r.json()).then((j) => {
    const suites = (j.suites || []) as { id: string; label: string; count: number }[];
    suites.sort((a, b) => {
      const ai = SUITE_PRIORITY.indexOf(a.id), bi = SUITE_PRIORITY.indexOf(b.id);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.label.localeCompare(b.label);
    });
    setSuiteList(suites);
  }).catch(() => {});
  useEffect(() => { loadSuites(); }, []);

  const switchView = (next: "scores" | "lens") => {
    setView(next);
    window.history.replaceState(null, "", next === "lens" ? "/benchmark?view=lens" : "/benchmark");
  };
  const run = async () => {
    setRunning(true);
    try {
      const result: Res & { error?: string } = await fetch("/api/bench", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, suite }) }).then((x) => x.json());
      if (!result.error) {
        setRuns((prev) => [...prev.filter((item) => !(item.model === result.model && item.suite === result.suite)), result]);
        setDetail(result);
      }
    } finally { setRunning(false); }
  };
  const deleteResult = async (result: Res) => {
    if (!confirm(`Delete ${shortName(result.model)} from ${result.suite}?`)) return;
    await fetch(`/api/bench?suite=${encodeURIComponent(result.suite)}&model=${encodeURIComponent(result.model)}`, { method: "DELETE" }).catch(() => {});
    setRuns((prev) => prev.filter((item) => !(item.model === result.model && item.suite === result.suite)));
    if (detail?.model === result.model && detail?.suite === result.suite) setDetail(null);
  };
  const togglePin = async (result: Res) => {
    const pinned = !result.pinned;
    const response = await fetch("/api/bench", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ suite: result.suite, model: result.model, pinned }) });
    if (response.ok) setRuns((prev) => prev.map((item) => item.model === result.model && item.suite === result.suite ? { ...item, pinned, stale: false } : item));
  };
  const toggleModel = (name: string) => setHiddenModels((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });

  const allSuiteRuns = runs.filter((result) => result.suite === suite);
  const suiteRuns = allSuiteRuns.filter((result) => !hiddenModels.has(result.model));
  const cats = CAT_ORDER.filter((cat) => suiteRuns.some((result) => result.cats[cat]));
  const selectedSuite = suiteList.find((item) => item.id === suite);
  const ranked = [...suiteRuns].sort((a, b) => pct(b.score, b.total) - pct(a.score, a.total));
  const leader = ranked[0];
  const before = suiteRuns.length >= 2 ? suiteRuns[suiteRuns.length - 2] : null;
  const after = suiteRuns.length >= 2 ? suiteRuns[suiteRuns.length - 1] : null;
  const failures = detail?.results?.filter((item) => !item.ok).length ?? 0;
  const suitesCovered = new Set(runs.map((result) => result.suite)).size;
  const totalQuestions = runs.reduce((sum, result) => sum + result.total, 0);
  const suiteAttempts = allSuiteRuns.reduce((sum, result) => sum + result.total, 0);
  const colorOf = (i: number) => PALETTE[i % PALETTE.length];

  const gsmDifficulty = (() => {
    if (suite !== "gsm8k") return null;
    const questions = new Map<string, boolean[]>();
    for (const result of suiteRuns) for (const item of result.results || []) {
      const outcomes = questions.get(item.q) || [];
      outcomes.push(item.ok); questions.set(item.q, outcomes);
    }
    const rates = [...questions.values()].map((outcomes) => outcomes.filter(Boolean).length / outcomes.length);
    if (!rates.length) return null;
    const hard = rates.filter((rate) => rate <= 0.25).length;
    const contested = rates.filter((rate) => rate > 0.25 && rate < 0.75).length;
    const solved = rates.filter((rate) => rate >= 0.75).length;
    return { total: rates.length, hard, contested, solved, mean: rates.reduce((sum, rate) => sum + rate, 0) / rates.length };
  })();

  const health = (() => {
    if (!after || !before || !cats.length) return null;
    const deltas = cats.map((cat) => pct(after.cats[cat]?.ok ?? 0, after.cats[cat]?.total ?? 0) - pct(before.cats[cat]?.ok ?? 0, before.cats[cat]?.total ?? 0));
    const avg = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
    const regressions = deltas.filter((delta) => delta < 0).length;
    return { avg, regressions };
  })();

  return (
    <main className="min-h-dvh bg-[var(--bg)] text-[var(--text)] px-3 py-4 pb-20">
      <div className="max-w-[1500px] mx-auto flex flex-col gap-4">
        {view === "lens" ? <LensWorkbench toolbar={<ViewSwitch view={view} onChange={switchView} />} /> : (
          <>
            <Panel className="grid sm:grid-cols-[auto_1fr] lg:grid-cols-[auto_1fr_1fr_auto_auto] gap-3 items-end">
              <ViewSwitch view={view} onChange={switchView} />
              <div>
                <label className="block text-[9px] tracking-[0.16em] uppercase text-[var(--muted)] mb-1.5">Evaluation suite</label>
                <select className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2.5 text-sm outline-none focus:border-[var(--border-loud)]" value={suite} onChange={(e) => { setSuite(e.target.value); setDetail(null); }}>
                  {(suiteList.length ? suiteList : SUITES.map((item) => ({ ...item, count: 0 }))).map((item) => <option key={item.id} value={item.id}>{item.label || item.id}{item.count ? ` · ${item.count} questions` : ""}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[9px] tracking-[0.16em] uppercase text-[var(--muted)] mb-1.5">Model under test</label>
                <select className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2.5 text-sm outline-none focus:border-[var(--border-loud)]" value={model} onChange={(e) => setModel(e.target.value)}>{models.map((name) => <option key={name}>{name}</option>)}</select>
              </div>
              <button onClick={() => setManageOpen(true)} className="h-[42px] inline-flex items-center justify-center gap-2 border border-[var(--border)] text-[var(--text-2)] rounded-[var(--r-md)] px-4 text-[11px] font-semibold uppercase tracking-[0.12em] hover:border-[var(--border-loud)]"><Settings2 size={14} /> Tests</button>
              <button onClick={run} disabled={running || !model} className="h-[42px] inline-flex items-center justify-center gap-2 bg-[var(--accent-ai)] disabled:bg-[var(--border)] disabled:text-[var(--muted)] text-[var(--bg)] rounded-[var(--r-md)] px-5 text-[11px] font-bold uppercase tracking-[0.12em]"><Play size={14} fill="currentColor" /> {running ? "Running…" : "Run suite"}</button>
            </Panel>
            {manageOpen && <TestManager suiteId={suite} onClose={() => setManageOpen(false)} onSaved={loadSuites} />}

            <Panel className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Summary label="Models evaluated" value={String(allSuiteRuns.length)} note={`${suiteAttempts.toLocaleString()} scored responses in ${suite}`} Icon={Database} />
              <Summary label="Problems per run" value={String(selectedSuite?.count || leader?.total || "—")} note={suite === "gsm8k" ? "complete GSM8K reasoning set" : `${totalQuestions.toLocaleString()} answers across ${suitesCovered} suites`} Icon={CheckCircle2} />
              <Summary label="Current leader" value={leader ? `${pct(leader.score, leader.total)}%` : "—"} note={leader ? shortName(leader.model) : "run a model to begin"} Icon={Sparkles} />
              <Summary label={suite === "gsm8k" ? "Score spread" : "Latest movement"}
                value={suite === "gsm8k" && ranked.length ? `${pct(ranked[0].score, ranked[0].total) - pct(ranked[ranked.length - 1].score, ranked[ranked.length - 1].total)} pts` : health ? `${health.avg >= 0 ? "+" : ""}${health.avg.toFixed(1)} pts` : "—"}
                note={suite === "gsm8k" && ranked.length ? `${pct(ranked[ranked.length - 1].score, ranked[ranked.length - 1].total)}–${pct(ranked[0].score, ranked[0].total)}% across the model field` : health ? `${health.regressions} regressions across ${cats.length} dimensions` : "needs two visible models"} Icon={Activity} />
            </Panel>

            {allSuiteRuns.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-1">
                <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--muted)] mr-1">Visible models</span>
                {allSuiteRuns.map((result, i) => {
                  const hidden = hiddenModels.has(result.model);
                  return <button key={result.model} onClick={() => toggleModel(result.model)} className="inline-flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded-full border transition-opacity" style={{ borderColor: hidden ? "var(--border)" : colorOf(i), color: hidden ? "var(--muted)" : colorOf(i), background: hidden ? "var(--surface-1)" : `${colorOf(i)}14`, opacity: hidden ? 0.55 : 1 }}><span className="w-1.5 h-1.5 rounded-full" style={{ background: colorOf(i) }} />{shortName(result.model)}{hidden ? " · hidden" : ""}</button>;
                })}
              </div>
            )}

            {!suiteRuns.length ? (
              <Panel className="min-h-64 grid place-items-center text-center">
                <div className="max-w-sm"><Gauge size={30} className="mx-auto text-[var(--accent-ai)] mb-3" /><h2 className="text-base font-semibold">No visible results for this suite</h2><p className="text-[11px] text-[var(--muted)] mt-2">Run the base model, then the trained checkpoint. Results persist here and become a before/after evaluation.</p></div>
              </Panel>
            ) : (
              <>
                <div className="grid min-w-0 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,.55fr)] gap-4 items-start">
                  <Panel>
                    <SectionTitle eyebrow="Capability profile" title={suite === "gsm8k" ? "Model accuracy across 60 reasoning problems" : "Exact performance by dimension"} note={`${selectedSuite?.count || leader?.total || 0} questions in ${suite}`} />
                    <CapabilityProfile runs={suiteRuns} cats={cats} />
                    <Legend runs={suiteRuns} />
                  </Panel>
                  <Panel className="xl:sticky xl:top-4">
                    <SectionTitle eyebrow="Leaderboard" title="Ranked by overall score" note="Click to open every response" />
                    <div className="space-y-2 mt-4 max-h-[560px] overflow-auto pr-1">
                      {ranked.map((result, i) => (
                        <button key={result.model} onClick={() => setDetail(result)} className="w-full text-left p-3 rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-2)] hover:border-[var(--border-loud)]">
                          <div className="flex items-start gap-3"><span className="text-[10px] text-[var(--muted)] pt-0.5">{String(i + 1).padStart(2, "0")}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><span className="text-xs font-semibold truncate">{shortName(result.model)}</span>{result.pinned && <Pin size={11} className="text-[var(--accent-highlight)]" />}{result.stale && <span className="text-[8px] uppercase tracking-wide text-[var(--accent-warn)]">stale baseline</span>}</div><div className="text-[9px] text-[var(--muted)] mt-1">{result.score}/{result.total} correct · {result.tokSec ?? "—"} tok/s</div></div><span className="text-xl font-semibold" style={{ color: i === 0 ? "var(--accent-success)" : "var(--text)" }}>{pct(result.score, result.total)}%</span></div>
                          <div className="h-1 bg-[var(--surface-3)] rounded-full mt-3 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${pct(result.score, result.total)}%`, background: PALETTE[suiteRuns.indexOf(result) % PALETTE.length] }} /></div>
                        </button>
                      ))}
                    </div>
                  </Panel>
                </div>

                {suite === "gsm8k" && (
                  <>
                    <div className="grid xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)] gap-4">
                      <Panel>
                        <SectionTitle eyebrow="GSM8K model history" title="Reasoning performance across every checkpoint" note={`${suiteRuns.length} timestamped model evaluations`} />
                        <BenchmarkTimeline runs={suiteRuns} />
                      </Panel>
                      <Panel className="flex flex-col">
                        <SectionTitle eyebrow="Problem landscape" title="How discriminating is this set?" note="aggregated from per-question grades" />
                        {gsmDifficulty ? (
                          <>
                            <div className="grid grid-cols-2 gap-px bg-[var(--border-soft)] border border-[var(--border-soft)] rounded-[var(--r-md)] overflow-hidden mt-4">
                              <LandscapeStat label="Hard problems" value={gsmDifficulty.hard} note="≤25% of models passed" color="var(--accent-danger)" />
                              <LandscapeStat label="Contested" value={gsmDifficulty.contested} note="26–74% passed" color="var(--accent-warn)" />
                              <LandscapeStat label="Broadly solved" value={gsmDifficulty.solved} note="≥75% passed" color="var(--accent-success)" />
                              <LandscapeStat label="Mean pass rate" value={`${Math.round(gsmDifficulty.mean * 100)}%`} note={`${gsmDifficulty.total} problems observed`} color="var(--accent-ai)" />
                            </div>
                            <div className="mt-auto pt-5">
                              <div className="h-3 flex rounded-full overflow-hidden bg-[var(--surface-3)]">
                                <span style={{ width: `${100 * gsmDifficulty.hard / gsmDifficulty.total}%`, background: "var(--accent-danger)" }} />
                                <span style={{ width: `${100 * gsmDifficulty.contested / gsmDifficulty.total}%`, background: "var(--accent-warn)" }} />
                                <span style={{ width: `${100 * gsmDifficulty.solved / gsmDifficulty.total}%`, background: "var(--accent-success)" }} />
                              </div>
                              <div className="flex justify-between text-[8px] text-[var(--muted)] mt-2"><span>hard</span><span>model-separating</span><span>solved</span></div>
                            </div>
                          </>
                        ) : <div className="flex-1 grid place-items-center text-[10px] text-[var(--muted)]">Per-question evidence populates after the first complete run.</div>}
                      </Panel>
                    </div>

                    <Panel>
                      <SectionTitle eyebrow="GSM8K reasoning matrix" title="Every problem × every model" note="hardest first · green correct · red incorrect · scroll for all 60" />
                      <div className="flex flex-wrap gap-4 text-[8px] text-[var(--muted)] mb-3"><span><i className="inline-block w-2 h-2 rounded-sm bg-[var(--accent-success)] mr-1" />correct</span><span><i className="inline-block w-2 h-2 rounded-sm bg-[var(--accent-danger)] mr-1" />incorrect</span><span>Rows are ranked by observed pass rate, not hand-labeled difficulty.</span></div>
                      <QuestionDifficultyMatrix runs={suiteRuns} />
                    </Panel>
                  </>
                )}

                <Panel>
                  <SectionTitle eyebrow="Serving characteristics" title="Quality is only one part of the model" note="All bars use the saved run measurements" />
                  <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3 mt-4">
                    <MetricBars title="Overall accuracy" unit="%" runs={suiteRuns} value={(result) => pct(result.score, result.total)} />
                    <MetricBars title="Generation speed" unit=" tok/s" runs={suiteRuns} value={(result) => result.tokSec} />
                    <MetricBars title="Average latency" unit=" ms" runs={suiteRuns} value={(result) => result.latencyMs} lowerIsBetter />
                    <MetricBars title="Time to first token" unit=" ms" runs={suiteRuns} value={(result) => result.ttftMs} lowerIsBetter />
                  </div>
                </Panel>

                <div className="grid xl:grid-cols-2 gap-4">
                  {before && after && <Panel><SectionTitle eyebrow="Training delta" title={`${shortName(before.model)} → ${shortName(after.model)}`} note="Points gained or lost by capability" /><DeltaChart before={before} after={after} cats={cats} /><div className="flex gap-4 justify-center text-[9px] text-[var(--muted)]"><span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-[var(--muted)]" />before</span><span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2 border-[var(--accent-ai)]" />after</span></div></Panel>}
                  <Panel><SectionTitle eyebrow="Efficiency frontier" title="Smarter ↑ and faster →" note="Bubble area represents checkpoint size" /><div className="mt-2"><ScatterPlot runs={suiteRuns} colorOf={colorOf} /></div></Panel>
                </div>

                <Panel padding="none">
                  <div className={head}><span className="text-[var(--accent-ai)]">◆</span> Full measurement matrix <span className="ml-auto normal-case tracking-normal text-[9px] text-[var(--muted)]">percent · exact count · runtime telemetry</span></div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead><tr className="text-[var(--muted)] uppercase tracking-[0.12em]"><th className="text-left px-4 py-3">Model</th>{cats.map((cat) => <th key={cat} className="px-3 py-3">{cat}</th>)}<th className="px-3 py-3">Overall</th><th className="px-3 py-3">tok/s</th><th className="px-3 py-3">latency</th><th className="px-3 py-3">TTFT</th><th className="px-3 py-3">size</th><th className="px-3 py-3">saved</th><th className="px-3 py-3">actions</th></tr></thead>
                      <tbody>{suiteRuns.map((result, ri) => <tr key={result.model} className="border-t border-[var(--border-soft)] hover:bg-[var(--surface-2)] cursor-pointer" onClick={() => setDetail(result)}><td className="px-4 py-3 min-w-44"><div className="flex items-center gap-2 font-medium"><span className="w-2 h-2 rounded-full" style={{ background: colorOf(ri) }} />{shortName(result.model)}{result.pinned && <Pin size={10} className="text-[var(--accent-highlight)]" />}</div>{result.stale && <div className="text-[8px] text-[var(--accent-warn)] mt-1">suite changed since pinning</div>}</td>{cats.map((cat) => { const value = result.cats[cat]; const score = pct(value?.ok ?? 0, value?.total ?? 0); return <td key={cat} className="px-3 py-3 text-center"><div style={{ color: score >= 67 ? "var(--accent-success)" : score >= 34 ? "var(--accent-warn)" : "var(--accent-danger)" }}>{value ? `${score}%` : "—"}</div><div className="text-[8px] text-[var(--muted)]">{value ? `${value.ok}/${value.total}` : ""}</div></td>; })}<td className="px-3 py-3 text-center font-semibold">{pct(result.score, result.total)}%<div className="text-[8px] text-[var(--muted)]">{result.score}/{result.total}</div></td><td className="px-3 py-3 text-center">{result.tokSec ?? "—"}</td><td className="px-3 py-3 text-center">{result.latencyMs ? `${result.latencyMs}ms` : "—"}</td><td className="px-3 py-3 text-center">{result.ttftMs ? `${result.ttftMs}ms` : "—"}</td><td className="px-3 py-3 text-center">{result.sizeGb != null ? `${result.sizeGb.toFixed(1)}GB` : "—"}</td><td className="px-3 py-3 text-center whitespace-nowrap">{result.ts ? new Date(result.ts).toLocaleDateString() : "—"}</td><td className="px-3 py-3" onClick={(e) => e.stopPropagation()}><div className="flex justify-center gap-1"><button onClick={() => togglePin(result)} title={result.pinned ? "Unpin baseline" : "Pin as baseline"} className="p-1.5 rounded hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-[var(--accent-highlight)]">{result.pinned ? <PinOff size={13} /> : <Pin size={13} />}</button><button onClick={() => deleteResult(result)} title="Delete result" className="p-1.5 rounded hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-[var(--accent-danger)]"><Trash2 size={13} /></button></div></td></tr>)}</tbody>
                    </table>
                  </div>
                </Panel>

                <Panel padding="none">
                  <div className={head}><span className="text-[var(--accent-ai)]">◆</span> Question-level evidence <span className="ml-auto normal-case tracking-normal text-[9px] text-[var(--muted)]">{detail ? `${detail.results?.length ?? 0} responses · ${failures} failures` : "select a model row"}</span></div>
                  {detail ? <div className="max-h-[58vh] overflow-auto text-xs">{(detail.results || []).map((item, i) => <div key={i} className="px-4 py-3 border-b border-[var(--border-soft)] last:border-0 grid grid-cols-[20px_48px_1fr] gap-2"><span style={{ color: item.ok ? "var(--accent-success)" : "var(--accent-danger)" }}>{item.ok ? "✓" : "✗"}</span><span className="text-[8px] uppercase tracking-widest text-[var(--muted)] pt-0.5">{item.cat}</span><span className="min-w-0"><span className="text-[var(--text-2)]">{item.q}</span><br /><span className="text-[var(--muted)]">→ {item.got || "(empty)"}</span>{item.detail && <><br /><span className="text-[10px] text-[var(--muted)] italic">{item.detail}</span></>}{item.shot && <a href={`/api/webshot?id=${item.shot}`} target="_blank" rel="noreferrer" className="block mt-2"><img src={`/api/webshot?id=${item.shot}`} alt="rendered benchmark output" className="max-h-44 rounded border border-[var(--border-soft)]" /></a>}</span></div>)}</div> : <div className="h-28 grid place-items-center text-[11px] text-[var(--muted)]">Select any leaderboard card or matrix row to inspect every prompt, response, grade, and rendered artifact.</div>}
                </Panel>
              </>
            )}

            {runs.length > 0 && <Panel padding="none"><div className={head}><Clock3 size={13} className="text-[var(--accent-ai)]" /> Complete evaluation archive <span className="ml-auto normal-case tracking-normal text-[9px] text-[var(--muted)]">all suites · nothing omitted by the current filter</span></div><div className="overflow-auto max-h-[540px]"><table className="w-full text-[10px]"><thead className="sticky top-0 z-10 bg-[var(--surface-1)]"><tr className="text-[var(--muted)] uppercase tracking-[0.12em]"><th className="text-left px-4 py-2.5">Suite</th><th className="text-left px-3 py-2.5">Model</th><th className="px-3 py-2.5">Score</th><th className="px-3 py-2.5">Speed</th><th className="px-3 py-2.5">Latency</th><th className="px-3 py-2.5">Saved</th></tr></thead><tbody>{[...runs].reverse().map((result) => <tr key={`${result.suite}-${result.model}`} onClick={() => { setSuite(result.suite); setDetail(result); }} className="border-t border-[var(--border-soft)] hover:bg-[var(--surface-2)] cursor-pointer"><td className="px-4 py-2.5 text-[var(--text-2)]">{result.suite}</td><td className="px-3 py-2.5">{shortName(result.model)}</td><td className="px-3 py-2.5 text-center">{result.score}/{result.total} · {pct(result.score, result.total)}%</td><td className="px-3 py-2.5 text-center">{result.tokSec ?? "—"} tok/s</td><td className="px-3 py-2.5 text-center">{result.latencyMs ? `${result.latencyMs}ms` : "—"}</td><td className="px-3 py-2.5 text-center">{result.ts ? new Date(result.ts).toLocaleString() : "—"}</td></tr>)}</tbody></table></div></Panel>}
          </>
        )}
      </div>
    </main>
  );
}

function Summary({ label, value, note, Icon }: { label: string; value: string; note: string; Icon: typeof Gauge }) {
  return <div className="flex items-start gap-3 min-w-0"><div className="w-8 h-8 rounded-[var(--r-md)] bg-[var(--surface-3)] text-[var(--accent-ai)] grid place-items-center shrink-0"><Icon size={15} /></div><div className="min-w-0"><div className="text-[9px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div><div className="text-xl font-semibold tracking-tight mt-0.5 truncate">{value}</div><div className="text-[9px] text-[var(--muted)] truncate">{note}</div></div></div>;
}

function SectionTitle({ eyebrow, title, note }: { eyebrow: string; title: string; note: string }) {
  return <div className="flex flex-wrap items-end justify-between gap-2 mb-2"><div><div className="text-[9px] uppercase tracking-[0.18em] text-[var(--accent-ai)]">{eyebrow}</div><h2 className="text-sm font-semibold mt-1">{title}</h2></div><div className="text-[9px] text-[var(--muted)]">{note}</div></div>;
}

function Legend({ runs }: { runs: Res[] }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-1">{runs.map((result, i) => <span key={result.model} className="inline-flex items-center gap-1.5 text-[9px] text-[var(--text-2)]"><span className="w-2 h-2 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />{shortName(result.model)}</span>)}</div>;
}

function LandscapeStat({ label, value, note, color }: { label: string; value: string | number; note: string; color: string }) {
  return <div className="bg-[var(--surface-2)] p-3"><div className="text-[8px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div><div className="text-2xl font-semibold mt-1" style={{ color }}>{value}</div><div className="text-[8px] text-[var(--muted)] mt-0.5">{note}</div></div>;
}

function ViewSwitch({ view, onChange }: { view: "scores" | "lens"; onChange: (view: "scores" | "lens") => void }) {
  return <div className="inline-flex p-0.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] self-end"><button onClick={() => onChange("scores")} className="px-2.5 h-9 rounded-[6px] text-[10px] whitespace-nowrap" style={{ color: view === "scores" ? "var(--bg)" : "var(--text-2)", background: view === "scores" ? "var(--accent-ai)" : "transparent", fontWeight: view === "scores" ? 700 : 400 }}>Bench</button><button onClick={() => onChange("lens")} className="px-2.5 h-9 rounded-[6px] text-[10px] whitespace-nowrap" style={{ color: view === "lens" ? "var(--bg)" : "var(--text-2)", background: view === "lens" ? "var(--accent-ai)" : "transparent", fontWeight: view === "lens" ? 700 : 400 }}>Lens</button></div>;
}

"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Code2, FlaskConical, MessageSquare, Network, TerminalSquare, X } from "lucide-react";
import { useDashboard } from "@/lib/use-dashboard";
import { Badge } from "@/components/ui/badge";
import { SystemCard } from "@/components/home/system-card";
import { WidgetBoard } from "@/components/home/widget-board";

type Conversation = { id: string; title: string; updatedAt: number; kind: "chat" | "code" | string; model?: string };
type Run = { id: string; conversationId: string; status: string; kind: string };

// Where a question typed on Home should go. Each target reads ?q= into its
// composer instead of auto-sending, so the user keeps control of the model.
const ASK_TARGETS = [
  { id: "chat", label: "Chat", href: "/chat", hint: "Talk it through" },
  { id: "code", label: "Code", href: "/code", hint: "Work in a project" },
] as const;

const ACTIONS = [
  { href: "/chat", title: "Chat", body: "Ask, summarize and think with a local model, grounded in the web or your documents.", Icon: MessageSquare },
  { href: "/code", title: "Code", body: "An agent with files, shell and Git over a project folder, with approvals.", Icon: Code2 },
  { href: "/hive", title: "Hive", body: "Run a multi-agent research or coding mission with evidence and review.", Icon: Network },
  { href: "/train", title: "Train", body: "Fine-tune a model on your data, then prove it improved in Evaluation.", Icon: FlaskConical },
];

function greeting(hour: number) {
  return hour < 5 ? "Working late." : hour < 12 ? "Good morning." : hour < 19 ? "Good afternoon." : "Good evening.";
}

function ago(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_TONE: Record<string, { tone: "success" | "ai" | "danger" | "default"; label: string }> = {
  done: { tone: "success", label: "Completed" },
  running: { tone: "ai", label: "In progress" },
  error: { tone: "danger", label: "Failed" },
  stopped: { tone: "default", label: "Stopped" },
};

export default function Home() {
  const router = useRouter();
  const { snap, cpuHist, gpuHist } = useDashboard();
  const [view, setView] = useState<"overview" | "widgets">("overview");
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<(typeof ASK_TARGETS)[number]["id"]>("chat");
  const [convos, setConvos] = useState<Conversation[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [hour, setHour] = useState(12);
  const [guideHidden, setGuideHidden] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setHour(new Date().getHours());
      try {
        setGuideHidden(localStorage.getItem("lal-home-guide-hidden") === "1");
        if (localStorage.getItem("lal-home-view") === "widgets") setView("widgets");
      } catch { setGuideHidden(false); }
    }, 0);
    fetch("/api/agent/conversations").then((r) => r.json()).then((j) => setConvos(Array.isArray(j) ? j : [])).catch(() => setConvos([]));
    fetch("/api/agent/runs?limit=40").then((r) => r.json()).then((j) => setRuns(Array.isArray(j) ? j : [])).catch(() => {});
    return () => clearTimeout(t);
  }, []);

  const switchView = (v: "overview" | "widgets") => {
    setView(v);
    try { localStorage.setItem("lal-home-view", v); } catch {}
  };

  const statusOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runs) if (!m.has(r.conversationId)) m.set(r.conversationId, r.status);
    return m;
  }, [runs]);

  // Onboarding checklist, derived from real state rather than a stored flag, so
  // it stays truthful: a step is done only when the thing actually exists.
  const steps = [
    { title: "Install a model", body: "Download or import a GGUF / Ollama model.", href: "/models", done: (snap?.models.length ?? 0) > 0 },
    { title: "Have a first conversation", body: "Ask anything in Chat. Everything stays on this machine.", href: "/chat", done: (convos?.length ?? 0) > 0 },
    { title: "Measure a model", body: "Run a benchmark suite to get a baseline score.", href: "/benchmark", done: (snap?.benchSummaries.length ?? 0) > 0 },
    { title: "Train your own", body: "Fine-tune on your data and compare against the baseline.", href: "/train", done: (snap?.runs.length ?? 0) > 0 },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const showGuide = !guideHidden && snap != null && convos != null && doneCount < steps.length;

  const ask = () => {
    const q = draft.trim();
    const dest = ASK_TARGETS.find((t) => t.id === target)!;
    router.push(q ? `${dest.href}?q=${encodeURIComponent(q)}` : dest.href);
  };

  const stopEverything = async () => {
    if (!confirm("Stop every active agent and release models from the GPU?")) return;
    await fetch("/api/agent/runs/stop-all", { method: "POST" }).catch(() => {});
  };

  const serving = snap?.runtime.serving;
  const model = serving?.model ?? snap?.serving ?? null;

  return (
    <main id="main-content" className="page-shell text-[var(--text)]">
      <div className="page-frame min-h-[calc(100dvh-2*var(--gutter))]">
        <header className="flex flex-wrap items-start justify-between gap-[var(--gutter)]">
          <div>
            <h1 className="text-[32px] lg:text-[var(--fs-hero)] font-bold leading-[var(--lh-tight)] tracking-[var(--ls-tight)]">{greeting(hour)}</h1>
            <p className="mt-1 text-[18px] text-[var(--text-secondary)]">What shall we build today?</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/models" className="btn btn-secondary px-3 min-h-9 text-xs" title={model ? `Resident on the GPU: ${model}` : "No model is loaded right now"}>
              <span className="w-2 h-2 rounded-full" style={{ background: model ? "var(--status-success)" : "var(--text-muted)" }} />
              <span className="text-[var(--text-secondary)]">Local</span>
              <span className="max-w-[180px] truncate">{model ?? "No model loaded"}</span>
            </Link>
            <div role="tablist" aria-label="Home view" className="seg">
              <button role="tab" aria-selected={view === "overview"} onClick={() => switchView("overview")}>Overview</button>
              <button role="tab" aria-selected={view === "widgets"} onClick={() => switchView("widgets")}>Widgets</button>
            </div>
          </div>
        </header>

        {view === "widgets" ? <WidgetBoard /> : <>
          <form onSubmit={(e) => { e.preventDefault(); ask(); }}
            className="control flex items-center gap-2 min-h-[var(--input-height)] rounded-[var(--radius-lg)] pl-4 pr-2 py-2">
            <label htmlFor="home-ask" className="sr-only">Ask LAL anything</label>
            <input id="home-ask" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask LAL anything…" autoComplete="off"
              className="flex-1 min-w-0 bg-transparent text-[15px] outline-none placeholder:text-[var(--text-muted)]" />
            <div className="hidden sm:flex seg border-0 bg-transparent" role="radiogroup" aria-label="Send to">
              {ASK_TARGETS.map((t) => (
                <button type="button" key={t.id} role="radio" aria-checked={target === t.id} data-active={target === t.id} title={t.hint} onClick={() => setTarget(t.id)}>{t.label}</button>
              ))}
            </div>
            <button type="submit" aria-label={`Open ${target}`} className="btn btn-primary w-10 h-10 shrink-0 p-0"><ArrowRight size={18} /></button>
          </form>

          {showGuide && (
            <section aria-label="Getting started" className="surface p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[15px] font-semibold">Getting started <span className="ml-2 text-[13px] font-normal text-[var(--text-muted)]">{doneCount} of {steps.length} done</span></h2>
                  <p className="text-[13px] text-[var(--text-secondary)]">LAL runs models on this computer. These four steps take you from nothing to a model you trained yourself.</p>
                </div>
                <button onClick={() => { setGuideHidden(true); try { localStorage.setItem("lal-home-guide-hidden", "1"); } catch {} }}
                  aria-label="Hide getting started" className="grid place-items-center w-8 h-8 shrink-0 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-interactive)]"><X size={16} /></button>
              </div>
              <ol className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {steps.map((step, i) => (
                  <li key={step.title}>
                    <Link href={step.href} className="interactive-card flex h-full gap-3 rounded-[var(--radius-md)] border border-transparent bg-[var(--bg-panel-raised)] p-3">
                      <span className="grid place-items-center w-6 h-6 shrink-0 rounded-full text-[12px]"
                        style={step.done ? { background: "var(--status-success-bg)", color: "var(--status-success)" } : { border: "1px solid var(--border-strong)", color: "var(--text-accent)" }}>
                        {step.done ? <Check size={14} /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className={"block text-[13px] font-medium " + (step.done ? "text-[var(--text-muted)] line-through" : "")}>{step.title}</span>
                        <span className="block mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]">{step.body}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <nav aria-label="Start something" className="grid gap-[var(--gutter)] sm:grid-cols-2 xl:grid-cols-4">
            {ACTIONS.map(({ href, title, body, Icon }) => (
              <Link key={href} href={href} className="surface interactive-card group flex flex-col gap-3 p-5">
                <span className="flex items-center justify-between">
                  <span className="brand-tile w-10 h-10"><Icon size={20} strokeWidth={1.75} /></span>
                  <ArrowUpRight size={18} className="text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-accent)]" />
                </span>
                <span>
                  <span className="block text-[18px] font-semibold">{title}</span>
                  <span className="block mt-1 text-[13px] leading-snug text-[var(--text-secondary)]">{body}</span>
                </span>
              </Link>
            ))}
          </nav>

          <div className="grid flex-1 min-h-[280px] gap-[var(--gutter)] lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
            <section aria-label="Recent activity" className="surface flex min-h-0 flex-col p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-semibold">Recent activity</h2>
                <Link href="/library" className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-accent)]">View all →</Link>
              </div>
              <ul className="mt-2 flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--border-subtle)]">
                {convos == null && <li className="py-6 text-center text-[13px] text-[var(--text-muted)]">Loading…</li>}
                {convos?.length === 0 && <li className="py-6 text-center text-[13px] text-[var(--text-muted)]">Nothing yet. Ask something above to start.</li>}
                {convos?.slice(0, 8).map((c) => {
                  const st = STATUS_TONE[statusOf.get(c.id) ?? ""];
                  const KindIcon = c.kind === "code" ? TerminalSquare : MessageSquare;
                  return (
                    <li key={c.id}>
                      <Link href={`/${c.kind === "code" ? "code" : "chat"}?conv=${encodeURIComponent(c.id)}`} className="flex items-center gap-3 py-2.5 -mx-2 px-2 rounded-[var(--radius-sm)] hover:bg-[var(--bg-panel-raised)]">
                        <KindIcon size={16} className="shrink-0 text-[var(--text-accent)]" />
                        <span className="flex-1 min-w-0 truncate text-[13px]">{c.title || "Untitled"}</span>
                        {st && <Badge tone={st.tone} className="hidden sm:inline-flex">{st.label}</Badge>}
                        <span className="w-16 shrink-0 text-right text-[12px] text-[var(--text-muted)]">{ago(c.updatedAt)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>

            <SystemCard snap={snap} cpuHist={cpuHist} gpuHist={gpuHist} onStopAll={stopEverything} />
          </div>
        </>}
      </div>
    </main>
  );
}

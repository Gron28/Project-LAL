"use client";

import { PALETTE, pct, shortName, type Res } from "@/components/charts";

const axis = "var(--muted)";
const grid = "var(--border-soft)";

export function CapabilityProfile({ runs, cats }: { runs: Res[]; cats: string[] }) {
  const width = 760;
  const left = 88;
  const right = 44;
  const top = 34;
  const rowH = Math.max(58, runs.length * 18 + 30);
  const height = top + cats.length * rowH + 28;
  const plotW = width - left - right;

  if (!runs.length || !cats.length) return <EmptyChart label="No capability data for this suite" />;

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[620px]" role="img" aria-label="Capability scores by model and category">
        {[0, 25, 50, 75, 100].map((tick) => {
          const x = left + (tick / 100) * plotW;
          return (
            <g key={tick}>
              <line x1={x} y1={top - 8} x2={x} y2={height - 25} stroke={grid} strokeWidth="1" />
              <text x={x} y={16} fill={axis} fontSize="10" textAnchor="middle">{tick}%</text>
            </g>
          );
        })}
        {cats.map((cat, ci) => {
          const groupY = top + ci * rowH;
          return (
            <g key={cat}>
              <text x={left - 12} y={groupY + rowH / 2} fill="var(--text-2)" fontSize="11" fontWeight="700" textAnchor="end" dominantBaseline="middle">{cat.toUpperCase()}</text>
              {runs.map((run, ri) => {
                const score = pct(run.cats[cat]?.ok ?? 0, run.cats[cat]?.total ?? 0);
                const y = groupY + 10 + ri * 18;
                const barW = (score / 100) * plotW;
                return (
                  <g key={run.model}>
                    <rect x={left} y={y} width={plotW} height="10" rx="5" fill="var(--surface-3)" />
                    <rect x={left} y={y} width={barW} height="10" rx="5" fill={PALETTE[ri % PALETTE.length]} opacity="0.88" />
                    <circle cx={left + barW} cy={y + 5} r="4" fill={PALETTE[ri % PALETTE.length]} />
                    <text x={width - 4} y={y + 6} fill="var(--text-2)" fontSize="9" textAnchor="end">
                      {score}% · {run.cats[cat]?.ok ?? 0}/{run.cats[cat]?.total ?? 0}
                    </text>
                  </g>
                );
              })}
              {ci < cats.length - 1 && <line x1="8" x2={width - 4} y1={groupY + rowH - 5} y2={groupY + rowH - 5} stroke={grid} />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function DeltaChart({ before, after, cats }: { before: Res; after: Res; cats: string[] }) {
  const width = 620;
  const height = 250;
  const left = 52;
  const right = 32;
  const top = 28;
  const bottom = 42;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const x = (i: number) => left + (cats.length === 1 ? plotW / 2 : (i / (cats.length - 1)) * plotW);
  const y = (v: number) => top + plotH * (1 - v / 100);
  const values = (r: Res) => cats.map((cat) => pct(r.cats[cat]?.ok ?? 0, r.cats[cat]?.total ?? 0));
  const beforeVals = values(before);
  const afterVals = values(after);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={`Score change from ${shortName(before.model)} to ${shortName(after.model)}`}>
      {[0, 25, 50, 75, 100].map((tick) => (
        <g key={tick}>
          <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke={grid} />
          <text x={left - 8} y={y(tick) + 3} fill={axis} fontSize="9" textAnchor="end">{tick}</text>
        </g>
      ))}
      <path d={line(beforeVals)} fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="5 5" />
      <path d={line(afterVals)} fill="none" stroke="var(--accent-ai)" strokeWidth="2.5" />
      {cats.map((cat, i) => {
        const delta = afterVals[i] - beforeVals[i];
        return (
          <g key={cat}>
            <line x1={x(i)} x2={x(i)} y1={y(beforeVals[i])} y2={y(afterVals[i])} stroke={delta >= 0 ? "var(--accent-success)" : "var(--accent-danger)"} strokeWidth="6" opacity="0.18" />
            <circle cx={x(i)} cy={y(beforeVals[i])} r="4" fill="var(--surface-1)" stroke="var(--muted)" strokeWidth="2" />
            <circle cx={x(i)} cy={y(afterVals[i])} r="4" fill="var(--accent-ai)" />
            <text x={x(i)} y={Math.min(y(beforeVals[i]), y(afterVals[i])) - 9} fill={delta > 0 ? "var(--accent-success)" : delta < 0 ? "var(--accent-danger)" : "var(--text-2)"} fontSize="10" fontWeight="700" textAnchor="middle">{delta > 0 ? "+" : ""}{delta}</text>
            <text x={x(i)} y={height - 17} fill="var(--text-2)" fontSize="10" textAnchor="middle">{cat.toUpperCase()}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function MetricBars({ title, unit, runs, value, lowerIsBetter = false }: {
  title: string;
  unit: string;
  runs: Res[];
  value: (run: Res) => number | null | undefined;
  lowerIsBetter?: boolean;
}) {
  const values = runs.map(value);
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const max = Math.max(...finite, 1);
  const best = finite.length ? (lowerIsBetter ? Math.min(...finite) : Math.max(...finite)) : null;
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-2)] p-3 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{title}</div>
        <div className="text-[9px] text-[var(--muted)]">{lowerIsBetter ? "lower is better" : "higher is better"}</div>
      </div>
      <div className="space-y-2.5">
        {runs.map((run, i) => {
          const v = values[i];
          const width = typeof v === "number" ? Math.max(2, (v / max) * 100) : 0;
          return (
            <div key={run.model}>
              <div className="flex items-center justify-between gap-2 text-[10px] mb-1">
                <span className="truncate text-[var(--text-2)]">{shortName(run.model)}</span>
                <span className="font-mono" style={{ color: v === best ? "var(--accent-success)" : "var(--text)" }}>{v == null ? "—" : `${v.toLocaleString()}${unit}`}</span>
              </div>
              <div className="h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${width}%`, background: PALETTE[i % PALETTE.length] }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BenchmarkTimeline({ runs }: { runs: Res[] }) {
  const ordered = [...runs].filter((run) => run.ts).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const width = 760;
  const height = 280;
  const left = 44;
  const right = 18;
  const top = 22;
  const bottom = 52;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const x = (i: number) => left + (ordered.length <= 1 ? plotW / 2 : (i / (ordered.length - 1)) * plotW);
  const y = (v: number) => top + plotH * (1 - v / 100);
  const scores = ordered.map((run) => pct(run.score, run.total));
  const line = scores.map((score, i) => `${i ? "L" : "M"}${x(i)},${y(score)}`).join(" ");

  if (!ordered.length) return <EmptyChart label="No timestamped GSM8K runs yet" />;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[620px]" role="img" aria-label="GSM8K model scores in benchmark order">
        <defs>
          <linearGradient id="timeline-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent-ai)" stopOpacity="0.26" />
            <stop offset="1" stopColor="var(--accent-ai)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke={grid} />
            <text x={left - 8} y={y(tick) + 3} fill={axis} fontSize="9" textAnchor="end">{tick}</text>
          </g>
        ))}
        {ordered.length > 1 && <path d={`${line} L${x(ordered.length - 1)},${height - bottom} L${x(0)},${height - bottom} Z`} fill="url(#timeline-fill)" />}
        <path d={line} fill="none" stroke="var(--accent-ai)" strokeWidth="2.5" />
        {ordered.map((run, i) => {
          const score = scores[i];
          const leader = score === Math.max(...scores);
          return (
            <g key={`${run.model}-${run.ts}`}>
              <circle cx={x(i)} cy={y(score)} r={leader ? 5 : 3.5} fill={leader ? "var(--accent-highlight)" : PALETTE[i % PALETTE.length]} stroke="var(--surface-1)" strokeWidth="2">
                <title>{shortName(run.model)} · {run.score}/{run.total} · {run.ts ? new Date(run.ts).toLocaleString() : ""}</title>
              </circle>
              <text transform={`translate(${x(i) - 2},${height - bottom + 10}) rotate(55)`} fill="var(--muted)" fontSize="8" textAnchor="start">{shortName(run.model)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function QuestionDifficultyMatrix({ runs }: { runs: Res[] }) {
  const withResults = runs.filter((run) => run.results?.length);
  const questions = new Map<string, { q: string; outcomes: Map<string, boolean> }>();
  for (const run of withResults) {
    for (const result of run.results || []) {
      const row = questions.get(result.q) || { q: result.q, outcomes: new Map<string, boolean>() };
      row.outcomes.set(run.model, result.ok);
      questions.set(result.q, row);
    }
  }
  const rows = [...questions.values()].map((row) => {
    const attempts = [...row.outcomes.values()];
    const passed = attempts.filter(Boolean).length;
    return { ...row, passed, attempts: attempts.length, rate: attempts.length ? passed / attempts.length : 0 };
  }).sort((a, b) => a.rate - b.rate || a.q.localeCompare(b.q));

  if (!withResults.length || !rows.length) return <EmptyChart label="No per-question GSM8K outcomes in these runs" />;

  return (
    <div className="overflow-auto max-h-[620px] rounded-[var(--r-md)] border border-[var(--border-soft)]">
      <div className="inline-grid min-w-full" style={{ gridTemplateColumns: `minmax(260px, 1fr) 70px repeat(${withResults.length}, 28px)` }}>
        <div className="sticky top-0 left-0 z-30 bg-[var(--surface-1)] px-3 py-2 text-[8px] uppercase tracking-[0.14em] text-[var(--muted)] border-b border-r border-[var(--border-soft)]">Problem · hardest first</div>
        <div className="sticky top-0 z-20 bg-[var(--surface-1)] px-2 py-2 text-[8px] uppercase tracking-[0.14em] text-center text-[var(--muted)] border-b border-r border-[var(--border-soft)]">Pass rate</div>
        {withResults.map((run) => (
          <div key={run.model} className="sticky top-0 z-20 h-28 bg-[var(--surface-1)] border-b border-r border-[var(--border-soft)] relative" title={run.model}>
            <span className="absolute bottom-2 left-1/2 text-[8px] text-[var(--muted)] whitespace-nowrap" style={{ transform: "translateX(-50%) rotate(-64deg)", transformOrigin: "center" }}>{shortName(run.model)}</span>
          </div>
        ))}
        {rows.map((row, rowIndex) => (
          <div key={row.q} className="contents">
            <div className="sticky left-0 z-10 bg-[var(--surface-1)] px-3 py-2 border-b border-r border-[var(--border-soft)] text-[9px] text-[var(--text-2)] truncate" title={row.q}><span className="text-[var(--muted)] mr-2">{String(rowIndex + 1).padStart(2, "0")}</span>{row.q}</div>
            <div className="px-2 py-2 border-b border-r border-[var(--border-soft)] text-center text-[9px] font-mono" style={{ color: row.rate >= 0.75 ? "var(--accent-success)" : row.rate >= 0.4 ? "var(--accent-warn)" : "var(--accent-danger)" }}>{Math.round(row.rate * 100)}%<div className="text-[7px] text-[var(--muted)]">{row.passed}/{row.attempts}</div></div>
            {withResults.map((run) => {
              const outcome = row.outcomes.get(run.model);
              return <div key={run.model} className="border-b border-r border-[var(--border-soft)] grid place-items-center" style={{ background: outcome == null ? "var(--surface-2)" : outcome ? "color-mix(in srgb, var(--accent-success) 52%, var(--surface-1))" : "color-mix(in srgb, var(--accent-danger) 42%, var(--surface-1))" }} title={`${shortName(run.model)} · ${outcome == null ? "not run" : outcome ? "correct" : "incorrect"}`}><span className="text-[8px]" style={{ color: outcome == null ? "var(--muted)" : outcome ? "var(--accent-success)" : "var(--accent-danger)" }}>{outcome == null ? "·" : outcome ? "✓" : "×"}</span></div>;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return <div className="h-48 grid place-items-center text-xs text-[var(--muted)] border border-dashed border-[var(--border)] rounded-[var(--r-md)]">{label}</div>;
}
